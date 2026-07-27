#!/usr/bin/env python3
"""Regenerate the README screenshots from the popup's real output.

These are not hand-taken screenshots. This script runs bin/popup.mjs on a real
pseudo-terminal, sends real keystrokes, keeps the ANSI it actually emitted, and
renders that to SVG. Regenerate whenever the popup's layout or copy changes, or
the README quietly starts lying.

    python3 tools/screenshots.py        # writes docs/*.svg and docs/.frames/*.txt

Then convert to PNG with any SVG renderer. Headless Chrome needs no install; use
each SVG's own width/height attributes for the window size:

    CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "$CHROME" --headless --disable-gpu --hide-scrollbars \
      --force-device-scale-factor=2 --window-size=1656,846 \
      --screenshot=docs/popup-list.png docs/popup-list.svg
"""
import os
import pty
import select
import signal
import subprocess
import sys
import time
import pathlib
import json
import html
import re
import unicodedata

REPO = pathlib.Path(__file__).resolve().parent.parent
WORK = REPO / 'docs' / '.frames'
COLS = 120

DEMO = """schema_version = 1
editor = ["code --new-window", "nvim"]

# 자주 쓰는 것들
[[commands]]
slot = "1"
label = "Open in VS Code"
type = "shell"
command = "code ."
cwd = "focused"
description = "포커스된 페인의 디렉터리를 VS Code로 열기"

[[commands]]
slot = "2"
label = "Open repo on GitHub"
type = "shell"
command = "gh browse"
description = "현재 저장소를 브라우저로 열기"

[[commands]]
slot = "3"
label = "Open pull request"
type = "shell"
command = "gh pr view --web"
description = "이 브랜치의 PR을 브라우저로 열기"

[[commands]]
slot = "4"
label = "브랜치 정리"
type = "shell"
command = "git branch --merged | grep -v main | xargs -r git branch -d"
cwd = "workspace"
description = "이미 병합된 로컬 브랜치 삭제"

[[commands]]
slot = "5"
label = "Lazygit in a split"
type = "shell"
command = "herdr pane split --cwd ."
description = "git TUI를 옆 페인에서 열기"

[[commands]]
slot = "6"
label = "서버 로그"
type = "shell"
command = "tail -f ~/.config/herdr/herdr-server.log"
description = "herdr 서버 로그 따라가기"

[[commands]]
slot = "7"
label = "워크트리 목록"
type = "shell"
command = "herdr worktree list"
description = "열려 있는 worktree 확인"

[[commands]]
slot = "8"
label = "Reload herdr config"
type = "shell"
command = "herdr server reload-config"
description = "설정 다시 불러오기"

[[commands]]
slot = "9"
label = "Open changelog"
type = "shell"
command = "code CHANGELOG.md"
description = "체인지로그 열기"

[[commands]]
slot = "0"
label = "Reinstall dependencies"
type = "shell"
command = "rm -rf node_modules && npm ci"
cwd = "workspace"
description = "의존성 재설치"

[[commands]]
slot = "s"
label = "git status"
type = "pane"
command = "git status --short --branch"
description = "포커스된 페인에서 git status 실행"

[[commands]]
slot = "f"
label = "File explorer"
type = "plugin_action"
command = "ray.file-explorer.open"
description = "Yazi를 split으로 열기"

[[commands]]
slot = "g"
label = "Agent tool history"
type = "plugin_action"
command = "cdragon.agent-tool-history.show"
description = "에이전트가 쓴 도구 기록 보기"

[[commands]]
slot = "t"
label = "Run tests"
type = "pane"
command = "npm test"
cwd = "workspace"
description = "워크스페이스 루트에서 테스트 실행"
"""

# A herdr config for the import shot: a handful of [[keys.command]] entries the
# way a real ~/.config/herdr/config.toml would have them. One duplicates a DEMO
# command exactly (already added), one uses a herdr type this plugin has no
# equivalent for (unsupported), and the binding that opens this very popup is in
# there too, to prove the importer filters it out rather than offering it back.
HERDR_CONFIG = """[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "cdragon.command-center.open"
description = "Open Command Center"

[[keys.command]]
key = "prefix+d"
type = "shell"
command = "code ."
description = "Open in VS Code"

[[keys.command]]
key = "prefix+l"
type = "popup"
command = "lazygit"
description = "Open lazygit in a popup"

[[keys.command]]
key = "prefix+w"
type = "focus_pane"
command = "focus-west"
description = "Focus the west pane"

[[keys.command]]
key = "prefix+r"
type = "shell"
command = "npm run build"
description = "Build the project"
"""


def capture(name, config_text, keys, rows, settle=0.75):
    """Run the popup on a pty, send keys, return the last full frame it painted."""
    cfg = WORK / name
    cfg.mkdir(parents=True, exist_ok=True)
    (cfg / 'commands.toml').write_text(config_text, encoding='utf8')
    (cfg / 'herdr-config.toml').write_text(HERDR_CONFIG, encoding='utf8')

    env = dict(os.environ)
    env.update({
        'HERDR_PLUGIN_CONFIG_DIR': str(cfg),
        'HERDR_PLUGIN_STATE_DIR': str(cfg / 'state'),
        'HERDR_CONFIG_PATH': str(cfg / 'herdr-config.toml'),
        'COMMAND_CENTER_CONTEXT_JSON': json.dumps(
            {'focusedPaneCwd': '/Users/cdragon/dev/herdr', 'workspaceCwd': '/Users/cdragon/dev'}),
        'TERM': 'xterm-256color',
        'COLUMNS': str(COLS),
        'LINES': str(rows),
    })
    env.pop('NO_COLOR', None)

    primary, secondary = pty.openpty()
    import fcntl
    import termios
    import struct
    fcntl.ioctl(secondary, termios.TIOCSWINSZ, struct.pack('HHHH', rows, COLS, 0, 0))

    proc = subprocess.Popen(
        ['node', 'bin/popup.mjs'], cwd=REPO, env=env,
        stdin=secondary, stdout=secondary, stderr=subprocess.DEVNULL,
        preexec_fn=os.setsid)
    os.close(secondary)

    out = b''

    def drain(seconds):
        nonlocal out
        deadline = time.time() + seconds
        while time.time() < deadline:
            r, _, _ = select.select([primary], [], [], 0.05)
            if r:
                try:
                    chunk = os.read(primary, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                out += chunk

    drain(settle)
    for key in keys:
        os.write(primary, key.encode())
        drain(0.45)

    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except ProcessLookupError:
        pass
    proc.wait(timeout=5)
    os.close(primary)

    text = out.decode('utf8', errors='replace')
    # every frame starts with the clear-screen sequence; keep the last one
    marker = '\x1b[2J\x1b[H'
    frame = text.rsplit(marker, 1)[-1] if marker in text else text
    return frame.replace('\r\n', '\n').rstrip('\n')


BROKEN = 'schema_version = 1\neditor = ["code"]\n\n[[commands]]\nlabel = \n'

# rows chosen so each view fills its frame: these are genuine renders at that
# terminal height, not crops of a taller one.
SHOTS = [
    ('popup-list', DEMO, [], 18, 'the command list'),
    ('popup-form', DEMO, ['A', '배포 스크립트', '\t\t\t', './scripts/deploy.sh'], 13,
     'adding a command, caret on the Command field'),
    ('popup-error', BROKEN, [], 10, 'a config file with a typo'),
    ('popup-import', DEMO, ['I'], 14, 'importing from the herdr config'),
]



# --------------------------------------------------------------- SVG rendering
# tokyo-night-ish, legible on both GitHub themes
BG = '#16161e'
FG = '#c0caf5'
CYAN = '#7dcfff'
YELLOW = '#e0af68'
DIM_OPACITY = '0.55'

FONT = ("ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, "
        "'DejaVu Sans Mono', 'Apple SD Gothic Neo', monospace")
FONT_SIZE = 15.0
CELL_W = 9.0
LINE_H = 23.0
PAD_X = 18.0
PAD_Y = 16.0
RADIUS = 10.0

SGR = re.compile(r'\x1b\[([0-9;]*)m')
# The popup parks the real terminal cursor on a focused text field by emitting an
# explicit row;column address. That is the only place it does so, which makes the
# escape itself the signal that a caret belongs in the picture.
CURSOR_AT = re.compile(r'\x1b\[(\d+);(\d+)H')
CURSOR_NOISE = re.compile(r'\x1b\[\?25[hl]|\x1b\[[0-9]* q|\x1b\[[0-9]+;[0-9]+H')
CURSOR_COLOR = CYAN
WIDE_RANGES = (
    (0x1100, 0x115f), (0x2329, 0x232a), (0x2e80, 0xa4cf), (0xac00, 0xd7a3),
    (0xf900, 0xfaff), (0xfe10, 0xfe19), (0xfe30, 0xfe6f), (0xff00, 0xff60),
    (0xffe0, 0xffe6), (0x1f300, 0x1faff),
)


def cell_width(ch):
    if unicodedata.category(ch).startswith('M'):
        return 0
    code = ord(ch)
    if code < 0x1100 or code == 0x303f:
        return 1
    return 2 if any(lo <= code <= hi for lo, hi in WIDE_RANGES) else 1


def display_width(text):
    return sum(cell_width(c) for c in text)


def runs(line):
    """Split a line into (text, style) runs, tracking SGR state."""
    out = []
    style = {'bold': False, 'dim': False, 'color': None}
    pos = 0
    for m in SGR.finditer(line):
        if m.start() > pos:
            out.append((line[pos:m.start()], dict(style)))
        for code in (m.group(1) or '0').split(';'):
            code = code or '0'
            if code == '0':
                style = {'bold': False, 'dim': False, 'color': None}
            elif code == '1':
                style['bold'] = True
            elif code == '2':
                style['dim'] = True
            elif code == '36':
                style['color'] = CYAN
            elif code == '33':
                style['color'] = YELLOW
            elif code == '32':
                style['color'] = '#9ece6a'
        pos = m.end()
    if pos < len(line):
        out.append((line[pos:], dict(style)))
    return [(t, s) for t, s in out if t]


def render(frame, cols=88):
    caret = None
    addressed = CURSOR_AT.findall(frame)
    if addressed:
        row, col = addressed[-1]
        caret = (int(row) - 1, int(col) - 1)  # the terminal counts from one
    frame = CURSOR_NOISE.sub('', frame)
    lines = frame.split('\n')
    rows = len(lines)
    width = cols * CELL_W + PAD_X * 2
    height = rows * LINE_H + PAD_Y * 2

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" '
        f'height="{height:.0f}" viewBox="0 0 {width:.0f} {height:.0f}" '
        f'font-family="{html.escape(FONT)}" font-size="{FONT_SIZE}">',
        f'<rect width="{width:.0f}" height="{height:.0f}" rx="{RADIUS}" fill="{BG}"/>',
    ]
    for row, line in enumerate(lines):
        y = PAD_Y + row * LINE_H + FONT_SIZE * 0.82
        col = 0
        for text, style in runs(line):
            stripped = text
            if stripped.strip():
                x = PAD_X + col * CELL_W
                attrs = [f'x="{x:.2f}"', f'y="{y:.2f}"']
                attrs.append(f'fill="{style["color"] or FG}"')
                if style['bold']:
                    attrs.append('font-weight="600"')
                if style['dim']:
                    attrs.append(f'opacity="{DIM_OPACITY}"')
                attrs.append('xml:space="preserve"')
                parts.append(f'<text {" ".join(attrs)}>{html.escape(text)}</text>')
            col += display_width(text)
    if caret is not None:
        crow, ccol = caret
        x = PAD_X + ccol * CELL_W
        y = PAD_Y + crow * LINE_H + 2.0
        parts.append(
            f'<rect x="{x:.2f}" y="{y:.2f}" width="2.2" height="{FONT_SIZE * 1.2:.1f}" '
            f'rx="1" fill="{CURSOR_COLOR}"/>')
    parts.append('</svg>')
    return '\n'.join(parts)



if __name__ == '__main__':
    WORK.mkdir(parents=True, exist_ok=True)
    for name, config, keys, rows, label in SHOTS:
        frame = capture(name, config, keys, rows)
        (WORK / f'{name}.txt').write_text(frame, encoding='utf8')
        target = REPO / 'docs' / f'{name}.svg'
        target.write_text(render(frame, cols=COLS), encoding='utf8')
        print(f'{target.relative_to(REPO)}  ({label}, {len(frame.split(chr(10)))} rows)')
