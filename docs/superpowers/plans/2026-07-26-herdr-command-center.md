# Herdr Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `cdragon.command-center`, a herdr plugin whose popup lists every command the user registered, runs the highlighted one on Enter (or by its number badge) **after the popup has closed**, and supports add/edit/delete in the popup plus direct hand-editing of its JSON config file.

**Architecture:** A herdr popup pane (`node bin/popup.mjs`) renders a pure view model over `commands.json` in the plugin config dir. Because herdr rejects UI operations while a popup is open (`ui_busy`) and resolves plugin-action context from the *currently focused* pane, the popup never executes anything itself: on Enter it spawns a **detached runner** (`node bin/run.mjs`), passes it the chosen command plus the invocation context, and exits — which tears the popup down. The runner waits for the popup PID to die, lets herdr settle, then executes (shell command detached in the resolved cwd, or `herdr plugin action invoke` with a `ui_busy` retry loop).

**Tech Stack:** Node.js 22+ ESM (`.mjs`), zero runtime dependencies, `node --test` for tests, herdr 0.7.5+ plugin manifest (`herdr-plugin.toml`).

## Global Constraints

- Plugin id is exactly `cdragon.command-center`; popup entrypoint id is exactly `palette`.
- `min_herdr_version = "0.7.5"`; `platforms = ["macos", "linux"]`.
- Node.js `>=22` (`engines.node`), and the manifest's first build step must fail loudly on older Node.
- **Zero runtime dependencies.** Validation is hand-rolled in `src/schema.mjs` rather than Zod: the plugin is installed and built on the user's machine by `herdr plugin install`, the popup must open instantly, and every other herdr plugin entrypoint in this family is dependency-free. `package.json` has no `dependencies` and no `devDependencies`.
- No `console.log` anywhere. Diagnostics go to `stderr` (popup only, prefixed `command-center:`) or to the JSONL run log via `src/logger.mjs`.
- All state updates are immutable (spread), matching the repo's coding-style rules.
- Config file lives at `<plugin config dir>/commands.json`, where the config dir comes from `HERDR_PLUGIN_CONFIG_DIR` or `herdr plugin config-dir cdragon.command-center`.
- Default editor for the "open the config file" key is `["code"]` (VS Code), overridable via the `editor` field in `commands.json`.
- Command types are exactly `shell` and `plugin_action`. Anything else (opening panes, tabs, popups) is expressed as a `shell` command that calls the `herdr` CLI.
- Number badges: items 1–9 get badges and can be run by pressing that digit; items 10+ are reachable by arrow keys only.
- Every commit message follows `<type>: <description>` (feat/fix/refactor/docs/test/chore).

---

## Reference: verified herdr facts

These were verified against herdr 0.7.5 on this machine. Do not re-derive them.

| Fact | Value |
| --- | --- |
| Popup placement | `placement = "popup"` in `[[panes]]`, or `--placement popup` on `herdr plugin pane open`. Valid placements: `overlay`, `popup`, `split`, `tab`, `zoomed`. The CLI `--help` omits `popup`; the API schema includes it. |
| Popup size | `width` / `height` are **only** valid when placement is `popup`. Integers (cells) or `"NN%"` strings. |
| `plugin pane open` blocking | Returns as soon as the popup is spawned. It does **not** wait for the popup to close. |
| Popup pane lifetime | The popup closes when its command process exits. |
| Busy UI | herdr returns `{"error":{"code":"ui_busy", ...}}` on stdout (non-zero exit) for UI operations attempted while a popup owns the screen. |
| `plugin action invoke` context | The server fills `context` itself for CLI invocations (`invocation_source: "cli"`), resolving `focused_pane_id` / `focused_pane_cwd` from the **live** focused pane. This is why the popup must be gone before we invoke. |
| CLI shape | `herdr plugin action invoke <ACTION_ID> --plugin <PLUGIN_ID>` |
| Env in a plugin **pane** | `HERDR_ENV`, `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ENTRYPOINT_ID`, `HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID` |
| Env in a plugin **action** | The above plus `HERDR_PLUGIN_ACTION_ID`, and `HERDR_ACTIVE_PANE_CWD` / `HERDR_ACTIVE_PANE_ID` / `HERDR_ACTIVE_WORKSPACE_ID` / `HERDR_ACTIVE_TAB_ID` |
| `HERDR_PLUGIN_CONTEXT_JSON` fields | `workspace_id`, `workspace_label`, `workspace_cwd`, `tab_id`, `tab_label`, `focused_pane_id`, `focused_pane_cwd`, `focused_pane_agent`, `focused_pane_status`, `selected_text`, `invocation_source`, `correlation_id`, `clicked_url`, `link_handler_id` |
| `keys.command` types in `config.toml` | `shell` (runs detached in the background), `pane`, `popup`, `plugin_action` |
| `herdr pane split` | Cannot take a command; it opens a shell. So "run X in a split" is a `shell` command that calls `herdr plugin pane open` or `herdr pane split` + `herdr pane run`. |

---

## File Structure

```
herdr-command-center/
├── herdr-plugin.toml          # plugin manifest: build steps, popup pane, actions
├── package.json               # ESM, node>=22, `npm test` → node --test
├── .gitignore
├── LICENSE
├── README.md                  # English operator docs
├── README.ko.md               # Korean operator docs
├── docs/superpowers/plans/    # this plan
├── bin/
│   ├── open.mjs               # `open` action → opens the popup, forwarding context
│   ├── popup.mjs              # popup entrypoint: TTY loop, effects, detached handoff
│   ├── run.mjs                # detached runner: wait for popup exit → execute
│   └── edit-config.mjs        # `edit-config` action → open commands.json in the editor
└── src/
    ├── plugin.mjs             # plugin/entrypoint ids and shared limits
    ├── paths.mjs              # resolve config dir, commands.json path, run-log path
    ├── schema.mjs             # config + command validation, normalization, defaults
    ├── store.mjs              # load/seed/atomically-save commands.json
    ├── context.mjs            # read herdr invocation context; resolve a command's cwd
    ├── text.mjs               # CJK-safe cell width, wrap, clip
    ├── keys.mjs               # raw stdin bytes → canonical key names
    ├── view.mjs               # view state machine + reducer (list/form/confirm/error)
    ├── render.mjs             # pure view state + terminal size → lines
    ├── executor.mjs           # build argv per command type; run; ui_busy retry
    ├── editor.mjs             # open a path in the configured editor
    ├── logger.mjs             # append-only JSONL run log that never throws
    └── wait.mjs               # wait for a pid to exit
```

Responsibility split worth calling out: `view.mjs` owns **state transitions only** and `render.mjs` owns **presentation only**, so the whole keyboard contract is testable without a terminal, and every layout change is testable without simulating keys.

---

## Task 1: Repository scaffold and manifest

**Files:**
- Create: `.gitignore`, `LICENSE`, `package.json`, `herdr-plugin.toml`, `src/plugin.mjs`
- Create: `bin/open.mjs`, `bin/popup.mjs`, `bin/run.mjs`, `bin/edit-config.mjs` (placeholder entrypoints, filled in later tasks)
- Test: `test/manifest.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `src/plugin.mjs` exporting `PLUGIN_ID: string` (`'cdragon.command-center'`), `POPUP_ENTRYPOINT_ID: string` (`'palette'`), `CONFIG_FILE_NAME: string` (`'commands.json'`), `RUN_LOG_FILE_NAME: string` (`'run.log'`), `MAX_PATH_BYTES: number` (`16384`).

- [ ] **Step 1: Initialize the repository**

```bash
cd /Users/cdragon/Desktop/Programming/side/herdr-command-center
git init
git branch -M main
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
.DS_Store
```

- [ ] **Step 3: Write `LICENSE`**

Use the MIT license text with:

```
MIT License

Copyright (c) 2026 speardragon
```

(the rest is the standard, unmodified MIT body).

- [ ] **Step 4: Write `package.json`**

```json
{
  "name": "@ray/command-center",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "herdr plugin — one popup that lists and runs every command you registered",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "test": "node --test \"test/**/*.test.mjs\""
  }
}
```

The test glob is explicit rather than bare `node --test`: Node's default
discovery treats **every** `.mjs` file under `test/` as a test file, so
`test/helpers/fake-tty.mjs` (added in Task 10) would be executed and counted as
a phantom passing test. Naming `*.test.mjs` keeps the counts in this plan true.

- [ ] **Step 5: Write `src/plugin.mjs`**

```js
export const PLUGIN_ID = 'cdragon.command-center';
export const POPUP_ENTRYPOINT_ID = 'palette';
export const CONFIG_FILE_NAME = 'commands.json';
export const RUN_LOG_FILE_NAME = 'run.log';
// Config/state paths come from herdr or from the CLI; bound them so a hostile or
// corrupted value can never be spliced into a spawn.
export const MAX_PATH_BYTES = 16_384;
```

- [ ] **Step 6: Create the four entrypoint placeholders**

Each is a runnable stub so the manifest test's `access()` checks pass. `bin/open.mjs`:

```js
#!/usr/bin/env node
// Implemented in Task 11.
process.exitCode = 0;
```

Write the same three-line stub to the other three, each naming the task that
replaces it: `bin/run.mjs` (Task 9), `bin/popup.mjs` (Task 10), and
`bin/edit-config.mjs` (Task 11).

- [ ] **Step 7: Write `herdr-plugin.toml`**

```toml
id = "cdragon.command-center"
name = "Command Center"
version = "1.0.0"
min_herdr_version = "0.7.5"
description = "One keybinding, every command. A herdr popup that lists the commands you registered, runs them by arrow key or number, and closes itself before the command fires."
platforms = ["macos", "linux"]

[[build]]
command = ["node", "-e", "const major = Number(process.versions.node.split('.')[0]); if (major < 22) { console.error('Node.js >= 22 required'); process.exit(1); }"]

[[build]]
command = ["npm", "test"]

[[panes]]
id = "palette"
title = "Command Center"
placement = "popup"
width = 88
height = 24
command = ["node", "bin/popup.mjs"]

[[actions]]
id = "open"
title = "Command Center: Open the command palette"
contexts = ["global", "workspace", "pane"]
command = ["node", "bin/open.mjs"]

[[actions]]
id = "edit-config"
title = "Command Center: Edit commands.json"
contexts = ["global", "workspace"]
command = ["node", "bin/edit-config.mjs"]
```

- [ ] **Step 8: Write the failing test `test/manifest.test.mjs`**

```js
import assert from 'node:assert/strict';
import { access, constants, readFile } from 'node:fs/promises';
import test from 'node:test';

import { CONFIG_FILE_NAME, PLUGIN_ID, POPUP_ENTRYPOINT_ID } from '../src/plugin.mjs';

const manifestUrl = new URL('../herdr-plugin.toml', import.meta.url);

test('manifest identity matches the shared plugin constants', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  assert.match(text, new RegExp(`^id = "${PLUGIN_ID}"$`, 'mu'));
  assert.match(text, new RegExp(`^id = "${POPUP_ENTRYPOINT_ID}"$`, 'mu'));
  assert.match(text, /^min_herdr_version = "0\.7\.5"$/mu);
  assert.match(text, /^platforms = \["macos", "linux"\]$/mu);
  assert.equal(CONFIG_FILE_NAME, 'commands.json');
});

test('manifest declares a popup pane with an explicit size', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  assert.match(text, /^placement = "popup"$/mu);
  assert.match(text, /^width = \d+$/mu);
  assert.match(text, /^height = \d+$/mu);
});

test('manifest entrypoints exist and are plain node invocations', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  for (const file of ['bin/open.mjs', 'bin/popup.mjs', 'bin/edit-config.mjs']) {
    assert.match(text, new RegExp(`command = \\["node", "${file.replace('.', '\\.')}"\\]`));
    await access(new URL(`../${file}`, import.meta.url), constants.R_OK);
  }
  // bin/run.mjs is spawned by the popup, not by herdr, so it is intentionally
  // absent from the manifest — but it must still exist.
  await access(new URL('../bin/run.mjs', import.meta.url), constants.R_OK);
  assert.doesNotMatch(text, /\["bash", "-c"/);
});

test('manifest declares both operator actions', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  for (const action of ['open', 'edit-config']) {
    assert.match(text, new RegExp(`^id = "${action}"$`, 'mu'));
  }
});

test('manifest build pipeline checks Node and runs the tests', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  assert.match(text, /Node\.js >= 22 required/);
  assert.match(text, /command = \["npm", "test"\]/);
});
```

- [ ] **Step 9: Run the tests**

Run: `npm test`
Expected: PASS — 5 tests. (Write the manifest before the test only if you prefer; if you follow the step order above, run the test after Step 7 and it passes immediately because the manifest is already correct. If you write the test first, expect `ENOENT` on `../src/plugin.mjs`.)

- [ ] **Step 10: Commit**

```bash
git add .gitignore LICENSE package.json herdr-plugin.toml src/plugin.mjs bin test/manifest.test.mjs
git commit -m "feat: scaffold cdragon.command-center plugin manifest and entrypoints

herdr 0.7.5+ plugin skeleton: a popup pane entrypoint (palette) plus the
open/edit-config actions, with a manifest test that pins the plugin id,
popup placement, explicit popup size, and the Node/test build gates.
Entrypoint files are placeholders so the manifest is verifiable from the
first commit."
```

---

## Task 2: Terminal primitives — cell width, wrapping, key decoding

**Files:**
- Create: `src/text.mjs`, `src/keys.mjs`
- Test: `test/text.test.mjs`, `test/keys.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/text.mjs`: `cellWidth(character: string): number`, `displayWidth(text: string): number`, `wrap(text: string, width: number): string[]`, `clipLine(text: string, width: number): string`
  - `src/keys.mjs`: `decodeKeys(text: string): string[]`, `createKeyDecoder(): { push(chunk: Buffer | string): string[] }`, `KEY_NAMES: ReadonlySet<string>`

Canonical key names produced by the decoder: `up`, `down`, `left`, `right`, `enter`, `escape`, `tab`, `backtab`, `backspace`, `space`, `interrupt`, plus any single printable grapheme as itself.

- [ ] **Step 1: Write the failing test `test/text.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { cellWidth, clipLine, displayWidth, wrap } from '../src/text.mjs';

test('cellWidth counts CJK and emoji as two cells', () => {
  assert.equal(cellWidth('a'), 1);
  assert.equal(cellWidth('한'), 2);
  assert.equal(cellWidth('。'), 2);
  assert.equal(cellWidth('🚀'), 2);
});

test('cellWidth counts combining marks as zero', () => {
  assert.equal(cellWidth('́'), 0);
});

test('displayWidth sums cells rather than code points', () => {
  assert.equal(displayWidth('ab'), 2);
  assert.equal(displayWidth('브랜치'), 6);
  assert.equal(displayWidth(''), 0);
});

test('wrap breaks on cell width and never exceeds the budget', () => {
  assert.deepEqual(wrap('abcdef', 3), ['abc', 'def']);
  assert.deepEqual(wrap('한글테스트', 4), ['한글', '테스', '트']);
  for (const line of wrap('브랜치 정리하고 푸시하기', 7)) {
    assert.ok(displayWidth(line) <= 7, `"${line}" is ${displayWidth(line)} cells`);
  }
});

test('wrap collapses newlines and returns one empty line for empty input', () => {
  assert.deepEqual(wrap('a\nb', 10), ['a b']);
  assert.deepEqual(wrap('', 10), ['']);
  assert.deepEqual(wrap('anything', 0), []);
});

test('clipLine truncates with an ellipsis and respects wide characters', () => {
  assert.equal(clipLine('abcdef', 10), 'abcdef');
  assert.equal(clipLine('abcdef', 4), 'abc…');
  assert.ok(displayWidth(clipLine('한글테스트입니다', 7)) <= 7);
  assert.ok(clipLine('한글테스트입니다', 7).endsWith('…'));
});

test('clipLine renders control characters visibly instead of moving the cursor', () => {
  assert.equal(clipLine('a\u0007b', 20), 'a<U+0007>b');
  assert.equal(clipLine('a\u001b[31mb', 40), 'a<U+001B>[31mb');
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/text.test.mjs`
Expected: FAIL — `Cannot find module '.../src/text.mjs'`.

- [ ] **Step 3: Write `src/text.mjs`**

```js
// Terminal text measurement. Everything the popup prints goes through here so a
// Korean label or an emoji can never overflow the popup and corrupt the frame.

const WIDE_RANGES = Object.freeze([
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
]);

export function cellWidth(character) {
  if (/\p{Mark}/u.test(character)) return 0;
  const code = character.codePointAt(0);
  if (code === undefined || code < 0x1100) return 1;
  if (code === 0x303f) return 1;
  return WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
}

function visibleCodePoint(character) {
  const code = character.codePointAt(0);
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(character)) {
    return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
  }
  return character;
}

function sanitized(value) {
  return [...String(value ?? '')].map(visibleCodePoint).join('');
}

export function displayWidth(text) {
  let total = 0;
  for (const character of String(text ?? '')) total += cellWidth(character);
  return total;
}

export function wrap(value, width) {
  if (!Number.isFinite(width) || width <= 0) return [];
  // Collapse newlines to spaces BEFORE sanitizing, or a newline would be printed
  // as the literal <U+000A> instead of becoming a space.
  const text = sanitized(String(value ?? '').replace(/\r?\n/gu, ' '));
  if (text.length === 0) return [''];
  const lines = [];
  let line = '';
  let used = 0;
  for (const character of text) {
    const characterWidth = cellWidth(character);
    if (characterWidth > width) continue;
    if (used > 0 && used + characterWidth > width) {
      lines.push(line);
      line = '';
      used = 0;
    }
    line += character;
    used += characterWidth;
  }
  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}

export function clipLine(value, width) {
  const lines = wrap(value, width);
  if (lines.length <= 1) return lines[0] ?? '';
  const marker = width >= 3 ? '…' : '.';
  const markerWidth = cellWidth(marker);
  let clipped = '';
  let used = 0;
  for (const character of lines[0] ?? '') {
    const characterWidth = cellWidth(character);
    if (used + characterWidth + markerWidth > width) break;
    clipped += character;
    used += characterWidth;
  }
  return `${clipped}${marker}`;
}
```

- [ ] **Step 4: Run the text tests**

Run: `node --test test/text.test.mjs`
Expected: PASS — 7 tests.

- [ ] **Step 5: Write the failing test `test/keys.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createKeyDecoder, decodeKeys, KEY_NAMES } from '../src/keys.mjs';

test('decodeKeys maps arrow escape sequences', () => {
  assert.deepEqual(decodeKeys('\u001b[A'), ['up']);
  assert.deepEqual(decodeKeys('\u001b[B'), ['down']);
  assert.deepEqual(decodeKeys('\u001b[C'), ['right']);
  assert.deepEqual(decodeKeys('\u001b[D'), ['left']);
  assert.deepEqual(decodeKeys('\u001b[Z'), ['backtab']);
});

test('decodeKeys maps editing and control keys', () => {
  assert.deepEqual(decodeKeys('\r'), ['enter']);
  assert.deepEqual(decodeKeys('\n'), ['enter']);
  assert.deepEqual(decodeKeys('\t'), ['tab']);
  assert.deepEqual(decodeKeys('\u007f'), ['backspace']);
  assert.deepEqual(decodeKeys('\b'), ['backspace']);
  assert.deepEqual(decodeKeys(' '), ['space']);
  assert.deepEqual(decodeKeys('\u0003'), ['interrupt']);
  assert.deepEqual(decodeKeys('\u001b'), ['escape']);
});

test('decodeKeys passes printable graphemes through, including Korean', () => {
  assert.deepEqual(decodeKeys('a'), ['a']);
  assert.deepEqual(decodeKeys('7'), ['7']);
  assert.deepEqual(decodeKeys('한글'), ['한', '글']);
  assert.deepEqual(decodeKeys('🚀'), ['🚀']);
});

test('decodeKeys drops unhandled control characters', () => {
  assert.deepEqual(decodeKeys('\u0001'), []);
  assert.deepEqual(decodeKeys('a\u0000b'), ['a', 'b']);
});

test('decodeKeys handles several keys in one chunk', () => {
  assert.deepEqual(decodeKeys('\u001b[Bj\r'), ['down', 'j', 'enter']);
});

test('createKeyDecoder reassembles UTF-8 split across chunks', () => {
  const decoder = createKeyDecoder();
  const bytes = Buffer.from('한', 'utf8');
  assert.deepEqual(decoder.push(bytes.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(bytes.subarray(2)), ['한']);
});

test('KEY_NAMES lists every canonical named key', () => {
  for (const name of ['up', 'down', 'left', 'right', 'enter', 'escape', 'tab', 'backtab', 'backspace', 'space', 'interrupt']) {
    assert.ok(KEY_NAMES.has(name), `${name} missing`);
  }
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `node --test test/keys.test.mjs`
Expected: FAIL — `Cannot find module '.../src/keys.mjs'`.

- [ ] **Step 7: Write `src/keys.mjs`**

```js
import { StringDecoder } from 'node:string_decoder';

export const KEY_NAMES = Object.freeze(new Set([
  'up',
  'down',
  'left',
  'right',
  'enter',
  'escape',
  'tab',
  'backtab',
  'backspace',
  'space',
  'interrupt',
]));

const ESCAPES = Object.freeze({
  '\u001b[A': 'up',
  '\u001b[B': 'down',
  '\u001b[C': 'right',
  '\u001b[D': 'left',
  '\u001b[Z': 'backtab',
});

// Decoding is per-chunk with no pending-escape buffer on purpose: terminals
// deliver an escape sequence in a single read, and holding a lone ESC byte back
// to wait for more bytes would make Esc feel broken (it would only fire on the
// next keypress). A bare ESC is therefore Escape.
export function decodeKeys(value) {
  const text = String(value);
  const keys = [];
  for (let index = 0; index < text.length;) {
    const rest = text.slice(index);
    const escape = Object.keys(ESCAPES).find((sequence) => rest.startsWith(sequence));
    if (escape) {
      keys.push(ESCAPES[escape]);
      index += escape.length;
      continue;
    }
    const head = rest[0];
    if (head === '\u001b') {
      keys.push('escape');
      index += 1;
    } else if (head === '\r' || head === '\n') {
      keys.push('enter');
      index += 1;
    } else if (head === '\t') {
      keys.push('tab');
      index += 1;
    } else if (head === '\u007f' || head === '\b') {
      keys.push('backspace');
      index += 1;
    } else if (head === ' ') {
      keys.push('space');
      index += 1;
    } else if (head === '\u0003') {
      keys.push('interrupt');
      index += 1;
    } else {
      const character = String.fromCodePoint(text.codePointAt(index));
      const printable = !/[\p{Cc}\p{Cf}]/u.test(character)
        || character === '\u200c'
        || character === '\u200d';
      if (printable) keys.push(character);
      index += character.length;
    }
  }
  return keys;
}

export function createKeyDecoder() {
  const decoder = new StringDecoder('utf8');
  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      return decodeKeys(decoder.write(bytes));
    },
  };
}
```

- [ ] **Step 8: Run the key tests**

Run: `node --test test/keys.test.mjs`
Expected: PASS — 7 tests.

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS — 19 tests total.

- [ ] **Step 10: Commit**

```bash
git add src/text.mjs src/keys.mjs test/text.test.mjs test/keys.test.mjs
git commit -m "feat: add CJK-safe text measurement and raw-key decoding

The popup renders user-supplied labels that are frequently Korean, so every
line goes through cellWidth/wrap/clipLine to guarantee it fits the popup in
terminal cells rather than code points, and control characters are printed as
<U+XXXX> so a pasted escape sequence cannot corrupt the frame.

decodeKeys deliberately treats a bare ESC byte as Escape instead of buffering
it: waiting for a possible sequence tail would delay Esc until the next
keypress, which reads as a hung popup."
```

---

## Task 3: Config schema — validation, normalization, defaults

**Files:**
- Create: `src/schema.mjs`
- Test: `test/schema.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SCHEMA_VERSION: 1`
  - `COMMAND_TYPES: readonly ['shell', 'plugin_action']`
  - `CWD_MODES: readonly ['focused', 'workspace']`
  - `DEFAULT_EDITOR: readonly ['code']`
  - `class ConfigError extends Error` with `name === 'ConfigError'`
  - `slugify(label: string): string`
  - `uniqueId(base: string, existingIds: string[]): string`
  - `parsePluginActionTarget(target: string): { pluginId: string, actionId: string }`
  - `normalizeCommand(value: unknown, options?: { existingIds?: string[] }): Command`
  - `normalizeConfig(value: unknown): ConfigDoc`
  - `defaultConfig(): ConfigDoc`
  - `serializeConfig(doc: ConfigDoc): string`

`Command` is exactly `{ id: string, label: string, type: 'shell' | 'plugin_action', command: string, cwd: string, description: string }` — every field always present, `cwd` defaulting to `'focused'` and `description` to `''`.

`ConfigDoc` is exactly `{ schema_version: 1, editor: string[], commands: Command[] }`.

- [ ] **Step 1: Write the failing test `test/schema.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMAND_TYPES,
  CWD_MODES,
  ConfigError,
  DEFAULT_EDITOR,
  defaultConfig,
  normalizeCommand,
  normalizeConfig,
  parsePluginActionTarget,
  SCHEMA_VERSION,
  serializeConfig,
  slugify,
  uniqueId,
} from '../src/schema.mjs';

test('exported vocabularies are frozen and complete', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual([...COMMAND_TYPES], ['shell', 'plugin_action']);
  assert.deepEqual([...CWD_MODES], ['focused', 'workspace']);
  assert.deepEqual([...DEFAULT_EDITOR], ['code']);
  assert.ok(Object.isFrozen(COMMAND_TYPES));
});

test('slugify keeps unicode letters so Korean labels get readable ids', () => {
  assert.equal(slugify('Open in VS Code'), 'open-in-vs-code');
  assert.equal(slugify('브랜치 정리'), '브랜치-정리');
  assert.equal(slugify('  ---  '), 'command');
  assert.equal(slugify('gh pr view --web'), 'gh-pr-view-web');
});

test('uniqueId suffixes collisions', () => {
  assert.equal(uniqueId('open', []), 'open');
  assert.equal(uniqueId('open', ['open']), 'open-2');
  assert.equal(uniqueId('open', ['open', 'open-2']), 'open-3');
});

test('parsePluginActionTarget splits on the final dot', () => {
  assert.deepEqual(parsePluginActionTarget('ray.file-explorer.open'), {
    pluginId: 'ray.file-explorer',
    actionId: 'open',
  });
  assert.deepEqual(parsePluginActionTarget('cdragon.ask-inbox.hook-status'), {
    pluginId: 'cdragon.ask-inbox',
    actionId: 'hook-status',
  });
});

test('parsePluginActionTarget rejects targets without a plugin and an action', () => {
  for (const target of ['open', '.open', 'ray.file-explorer.', '']) {
    assert.throws(() => parsePluginActionTarget(target), ConfigError, target);
  }
});

test('normalizeCommand fills defaults and derives an id from the label', () => {
  assert.deepEqual(normalizeCommand({ label: 'Open in VS Code', type: 'shell', command: 'code .' }), {
    id: 'open-in-vs-code',
    label: 'Open in VS Code',
    type: 'shell',
    command: 'code .',
    cwd: 'focused',
    description: '',
  });
});

test('normalizeCommand trims text and keeps an explicit id', () => {
  const command = normalizeCommand({
    id: 'my-id',
    label: '  Tidy branches  ',
    type: 'shell',
    command: '  git branch --merged  ',
    cwd: 'workspace',
    description: '  cleanup  ',
  });
  assert.equal(command.id, 'my-id');
  assert.equal(command.label, 'Tidy branches');
  assert.equal(command.command, 'git branch --merged');
  assert.equal(command.cwd, 'workspace');
  assert.equal(command.description, 'cleanup');
});

test('normalizeCommand dedupes generated ids against existing ones', () => {
  const command = normalizeCommand(
    { label: 'Open in VS Code', type: 'shell', command: 'code .' },
    { existingIds: ['open-in-vs-code'] },
  );
  assert.equal(command.id, 'open-in-vs-code-2');
});

test('normalizeCommand accepts an absolute cwd path', () => {
  const command = normalizeCommand({
    label: 'Notes',
    type: 'shell',
    command: 'ls',
    cwd: '/Users/cdragon/notes',
  });
  assert.equal(command.cwd, '/Users/cdragon/notes');
});

test('normalizeCommand validates plugin_action targets', () => {
  const command = normalizeCommand({
    label: 'File explorer',
    type: 'plugin_action',
    command: 'ray.file-explorer.open',
  });
  assert.equal(command.type, 'plugin_action');
  assert.throws(
    () => normalizeCommand({ label: 'Broken', type: 'plugin_action', command: 'nope' }),
    (error) => error instanceof ConfigError && /plugin_id\.action_id/u.test(error.message),
  );
});

test('normalizeCommand rejects every malformed field with a readable message', () => {
  const cases = [
    [{}, /label/u],
    [{ label: '   ', type: 'shell', command: 'ls' }, /label/u],
    [{ label: 'a', type: 'nope', command: 'ls' }, /type/u],
    [{ label: 'a', type: 'shell', command: '   ' }, /command/u],
    [{ label: 'a', type: 'shell', command: 'ls', cwd: 'relative/path' }, /cwd/u],
    [{ label: 'a', type: 'shell', command: 'ls \u0000 ls' }, /command/u],
    [{ label: 'a'.repeat(81), type: 'shell', command: 'ls' }, /label/u],
    [{ id: 'Bad Id', label: 'a', type: 'shell', command: 'ls' }, /id/u],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => normalizeCommand(value), (error) => {
      assert.ok(error instanceof ConfigError, `${JSON.stringify(value)} threw ${error.name}`);
      assert.match(error.message, pattern);
      return true;
    });
  }
});

test('normalizeCommand rejects a multi-line command', () => {
  assert.throws(
    () => normalizeCommand({ label: 'a', type: 'shell', command: 'ls\nrm -rf /' }),
    (error) => error instanceof ConfigError && /single line/u.test(error.message),
  );
});

test('defaultConfig is valid and normalizes to itself', () => {
  const doc = defaultConfig();
  assert.equal(doc.schema_version, 1);
  assert.deepEqual(doc.editor, ['code']);
  assert.ok(doc.commands.length >= 1);
  assert.deepEqual(normalizeConfig(doc), doc);
});

test('normalizeConfig fills missing schema_version, editor, and commands', () => {
  assert.deepEqual(normalizeConfig({}), { schema_version: 1, editor: ['code'], commands: [] });
});

test('normalizeConfig assigns unique ids across the whole list', () => {
  const doc = normalizeConfig({
    commands: [
      { label: 'Same', type: 'shell', command: 'a' },
      { label: 'Same', type: 'shell', command: 'b' },
    ],
  });
  assert.deepEqual(doc.commands.map((command) => command.id), ['same', 'same-2']);
});

test('normalizeConfig reports the offending index', () => {
  assert.throws(
    () => normalizeConfig({ commands: [{ label: 'ok', type: 'shell', command: 'a' }, { label: 'x', type: 'nope', command: 'b' }] }),
    (error) => error instanceof ConfigError && /commands\[1\]/u.test(error.message),
  );
});

test('normalizeConfig rejects unsupported shapes and versions', () => {
  assert.throws(() => normalizeConfig(null), ConfigError);
  assert.throws(() => normalizeConfig([]), ConfigError);
  assert.throws(() => normalizeConfig({ schema_version: 2 }), (error) => (
    error instanceof ConfigError && /schema_version/u.test(error.message)
  ));
  assert.throws(() => normalizeConfig({ editor: [] }), (error) => (
    error instanceof ConfigError && /editor/u.test(error.message)
  ));
  assert.throws(() => normalizeConfig({ editor: 'code' }), ConfigError);
  assert.throws(() => normalizeConfig({ commands: {} }), ConfigError);
});

test('normalizeConfig rejects duplicate explicit ids', () => {
  assert.throws(
    () => normalizeConfig({
      commands: [
        { id: 'dupe', label: 'a', type: 'shell', command: 'a' },
        { id: 'dupe', label: 'b', type: 'shell', command: 'b' },
      ],
    }),
    (error) => error instanceof ConfigError && /duplicate/u.test(error.message),
  );
});

test('serializeConfig writes stable indented JSON with a trailing newline', () => {
  const text = serializeConfig(defaultConfig());
  assert.ok(text.endsWith('\n'));
  assert.match(text, /^\{\n {2}"schema_version": 1,/u);
  assert.deepEqual(normalizeConfig(JSON.parse(text)), defaultConfig());
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/schema.test.mjs`
Expected: FAIL — `Cannot find module '.../src/schema.mjs'`.

- [ ] **Step 3: Write `src/schema.mjs`**

```js
import { isAbsolute } from 'node:path';

export const SCHEMA_VERSION = 1;
export const COMMAND_TYPES = Object.freeze(['shell', 'plugin_action']);
export const CWD_MODES = Object.freeze(['focused', 'workspace']);
export const DEFAULT_EDITOR = Object.freeze(['code']);

const MAX_LABEL_LENGTH = 80;
const MAX_COMMAND_LENGTH = 2_000;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_ID_LENGTH = 64;
const MAX_COMMANDS = 200;
const MAX_EDITOR_ARGS = 8;
// Unicode-aware so a Korean label yields a readable id instead of "command-7".
const ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireText(value, field, maxLength) {
  if (typeof value !== 'string') throw new ConfigError(`${field} must be a string`);
  const text = value.trim();
  if (text.length === 0) throw new ConfigError(`${field} must not be empty`);
  if (text.length > maxLength) throw new ConfigError(`${field} must be at most ${maxLength} characters`);
  if (text.includes('\u0000')) throw new ConfigError(`${field} must not contain NUL bytes`);
  return text;
}

export function slugify(label) {
  const slug = String(label ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug.length > 0 ? slug.slice(0, MAX_ID_LENGTH) : 'command';
}

export function uniqueId(base, existingIds = []) {
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ConfigError(`could not derive a unique id for "${base}"`);
}

export function parsePluginActionTarget(target) {
  const text = typeof target === 'string' ? target.trim() : '';
  const lastDot = text.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === text.length - 1) {
    throw new ConfigError(
      `command "${text}" must be a plugin action target of the form plugin_id.action_id`,
    );
  }
  return { pluginId: text.slice(0, lastDot), actionId: text.slice(lastDot + 1) };
}

function normalizeCwd(value) {
  if (value === undefined || value === null || value === '') return 'focused';
  if (typeof value !== 'string') throw new ConfigError('cwd must be a string');
  const text = value.trim();
  if (CWD_MODES.includes(text)) return text;
  if (!isAbsolute(text) || text.includes('\u0000')) {
    throw new ConfigError(`cwd must be ${CWD_MODES.join(', ')}, or an absolute path`);
  }
  return text;
}

function normalizeDescription(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ConfigError('description must be a string');
  const text = value.trim();
  if (text.length > MAX_DESCRIPTION_LENGTH) {
    throw new ConfigError(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return text.replace(/[\u0000\r\n]/gu, ' ');
}

export function normalizeCommand(value, { existingIds = [] } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('a command must be an object');
  }
  const label = requireText(value.label, 'label', MAX_LABEL_LENGTH);
  const type = value.type;
  if (!COMMAND_TYPES.includes(type)) {
    throw new ConfigError(`type must be one of ${COMMAND_TYPES.join(', ')}`);
  }
  const command = requireText(value.command, 'command', MAX_COMMAND_LENGTH);
  if (/[\r\n]/u.test(command)) throw new ConfigError('command must be a single line');
  if (type === 'plugin_action') parsePluginActionTarget(command);
  let id;
  if (value.id === undefined || value.id === null || value.id === '') {
    id = uniqueId(slugify(label), existingIds);
  } else {
    id = requireText(value.id, 'id', MAX_ID_LENGTH);
    if (!ID_PATTERN.test(id)) {
      throw new ConfigError(`id "${id}" must contain only letters, digits, "-", and "_"`);
    }
  }
  return {
    id,
    label,
    type,
    command,
    cwd: normalizeCwd(value.cwd),
    description: normalizeDescription(value.description),
  };
}

function normalizeEditor(value) {
  if (value === undefined || value === null) return [...DEFAULT_EDITOR];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EDITOR_ARGS) {
    throw new ConfigError(`editor must be an array of 1 to ${MAX_EDITOR_ARGS} strings`);
  }
  return value.map((entry, index) => requireText(entry, `editor[${index}]`, 512));
}

export function normalizeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('commands.json must contain a JSON object');
  }
  const version = value.schema_version ?? SCHEMA_VERSION;
  if (version !== SCHEMA_VERSION) {
    throw new ConfigError(`schema_version must be ${SCHEMA_VERSION} (found ${JSON.stringify(version)})`);
  }
  const rawCommands = value.commands ?? [];
  if (!Array.isArray(rawCommands)) throw new ConfigError('commands must be an array');
  if (rawCommands.length > MAX_COMMANDS) {
    throw new ConfigError(`commands must contain at most ${MAX_COMMANDS} entries`);
  }
  const commands = [];
  const existingIds = [];
  rawCommands.forEach((entry, index) => {
    let normalized;
    try {
      normalized = normalizeCommand(entry, { existingIds });
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      throw new ConfigError(`commands[${index}]: ${error.message}`);
    }
    if (existingIds.includes(normalized.id)) {
      throw new ConfigError(`commands[${index}]: duplicate id "${normalized.id}"`);
    }
    existingIds.push(normalized.id);
    commands.push(normalized);
  });
  return { schema_version: SCHEMA_VERSION, editor: normalizeEditor(value.editor), commands };
}

export function defaultConfig() {
  return {
    schema_version: SCHEMA_VERSION,
    editor: [...DEFAULT_EDITOR],
    commands: [
      {
        id: 'open-in-vs-code',
        label: 'Open in VS Code',
        type: 'shell',
        command: 'code .',
        cwd: 'focused',
        description: "Open the focused pane's directory in VS Code",
      },
      {
        id: 'open-repo-on-github',
        label: 'Open repo on GitHub',
        type: 'shell',
        command: 'gh browse',
        cwd: 'focused',
        description: 'Open the current repository in the browser',
      },
      {
        id: 'open-pull-request',
        label: 'Open pull request',
        type: 'shell',
        command: 'gh pr view --web',
        cwd: 'focused',
        description: "Open this branch's pull request in the browser",
      },
    ],
  };
}

export function serializeConfig(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
```

- [ ] **Step 4: Run the schema tests**

Run: `node --test test/schema.test.mjs`
Expected: PASS — 19 tests.

- [ ] **Step 5: Commit**

```bash
git add src/schema.mjs test/schema.test.mjs
git commit -m "feat: validate and normalize the commands.json config document

commands.json is a first-class hand-editable surface, so a typo must produce a
readable message ('commands[1]: type must be one of shell, plugin_action')
rather than a crash or a silently ignored entry. normalizeCommand always
returns every field populated, which lets the popup form and the renderer treat
cwd and description as present without null checks.

Ids are slugified with unicode letter classes so Korean labels keep readable
ids, and are deduped so two commands can share a label. Validation is
hand-rolled rather than Zod to keep the plugin dependency-free: herdr builds it
on the user's machine at install time and the popup must open instantly."
```

---

## Task 4: Config paths and the commands store

**Files:**
- Create: `src/paths.mjs`, `src/store.mjs`
- Test: `test/paths.test.mjs`, `test/store.test.mjs`

**Interfaces:**
- Consumes: `src/plugin.mjs` (`PLUGIN_ID`, `CONFIG_FILE_NAME`, `RUN_LOG_FILE_NAME`, `MAX_PATH_BYTES`), `src/schema.mjs` (`ConfigError`, `defaultConfig`, `normalizeConfig`, `serializeConfig`).
- Produces:
  - `src/paths.mjs`: `resolveConfigDir(env?: object, execFile?: Function): Promise<string>`, `resolveStateDir(configDir: string, env?: object): string`, `commandsPath(configDir: string): string`, `runLogPath(stateDir: string): string`
  - `src/store.mjs`: `loadStore(file: string): Promise<{ doc: ConfigDoc, raw: string | null }>`, `ensureStore(file: string): Promise<{ doc: ConfigDoc, raw: string }>`, `saveStore(file: string, doc: ConfigDoc, options?: { expectedRaw?: string | null }): Promise<{ raw: string }>`

`loadStore` returns `raw: null` when the file does not exist (with `doc` = `defaultConfig()`), and throws `ConfigError` when the file exists but is unreadable, is not JSON, or fails validation. `saveStore` writes atomically and, when `expectedRaw` is a string, refuses to write if the on-disk text no longer matches it.

- [ ] **Step 1: Write the failing test `test/paths.test.mjs`**

```js
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { commandsPath, resolveConfigDir, resolveStateDir, runLogPath } from '../src/paths.mjs';

test('resolveConfigDir prefers the env herdr injects', async () => {
  const dir = await resolveConfigDir({ HERDR_PLUGIN_CONFIG_DIR: '/tmp/cc-config' }, async () => {
    throw new Error('execFile must not be called');
  });
  assert.equal(dir, '/tmp/cc-config');
});

test('resolveConfigDir asks herdr when the env is absent', async () => {
  const calls = [];
  const dir = await resolveConfigDir({ HERDR_BIN_PATH: '/opt/homebrew/bin/herdr' }, async (bin, args) => {
    calls.push({ bin, args });
    return { stdout: '/tmp/from-cli\n', stderr: '' };
  });
  assert.equal(dir, '/tmp/from-cli');
  assert.deepEqual(calls, [{
    bin: '/opt/homebrew/bin/herdr',
    args: ['plugin', 'config-dir', 'cdragon.command-center'],
  }]);
});

test('resolveConfigDir falls back to the herdr on PATH', async () => {
  let seenBin = null;
  await resolveConfigDir({}, async (bin) => {
    seenBin = bin;
    return { stdout: '/tmp/x', stderr: '' };
  });
  assert.equal(seenBin, 'herdr');
});

test('resolveConfigDir rejects relative, NUL-bearing, and oversized paths', async () => {
  await assert.rejects(resolveConfigDir({ HERDR_PLUGIN_CONFIG_DIR: 'relative' }, async () => {}), /invalid/u);
  await assert.rejects(resolveConfigDir({ HERDR_PLUGIN_CONFIG_DIR: '/a\u0000b' }, async () => {}), /invalid/u);
  await assert.rejects(
    resolveConfigDir({ HERDR_PLUGIN_CONFIG_DIR: `/${'a'.repeat(20_000)}` }, async () => {}),
    /invalid/u,
  );
});

test('resolveConfigDir rejects an unusable CLI answer', async () => {
  await assert.rejects(resolveConfigDir({}, async () => ({ stdout: '   ', stderr: '' })), /could not be resolved/u);
  await assert.rejects(resolveConfigDir({}, async () => { throw new Error('socket down'); }), /could not be resolved/u);
});

test('resolveStateDir prefers HERDR_PLUGIN_STATE_DIR and falls back beside the config', () => {
  assert.equal(resolveStateDir('/tmp/cfg', { HERDR_PLUGIN_STATE_DIR: '/tmp/state' }), '/tmp/state');
  assert.equal(resolveStateDir('/tmp/cfg', {}), join('/tmp/cfg', 'state'));
  assert.equal(resolveStateDir('/tmp/cfg', { HERDR_PLUGIN_STATE_DIR: 'relative' }), join('/tmp/cfg', 'state'));
});

test('path helpers append the known file names', () => {
  assert.equal(commandsPath('/tmp/cfg'), join('/tmp/cfg', 'commands.json'));
  assert.equal(runLogPath('/tmp/state'), join('/tmp/state', 'run.log'));
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/paths.test.mjs`
Expected: FAIL — `Cannot find module '.../src/paths.mjs'`.

- [ ] **Step 3: Write `src/paths.mjs`**

```js
import { execFile as execFileCallback } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import { CONFIG_FILE_NAME, MAX_PATH_BYTES, PLUGIN_ID, RUN_LOG_FILE_NAME } from './plugin.mjs';

const execFileAsync = promisify(execFileCallback);

function usablePath(path) {
  return typeof path === 'string'
    && path.length > 0
    && isAbsolute(path)
    && !path.includes('\u0000')
    && Buffer.byteLength(path) <= MAX_PATH_BYTES;
}

// herdr injects HERDR_PLUGIN_CONFIG_DIR into plugin panes and actions. The CLI
// lookup is the fallback for running an entrypoint by hand outside herdr.
export async function resolveConfigDir(env = process.env, execFile = execFileAsync) {
  const configured = env.COMMAND_CENTER_CONFIG_DIR || env.HERDR_PLUGIN_CONFIG_DIR;
  if (configured) {
    if (!usablePath(configured)) throw new Error('plugin config directory is invalid');
    return configured;
  }
  let stdout;
  try {
    const result = await execFile(env.HERDR_BIN_PATH || 'herdr', ['plugin', 'config-dir', PLUGIN_ID], {
      env,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1_048_576,
      shell: false,
    });
    stdout = result?.stdout;
  } catch {
    throw new Error('plugin config directory could not be resolved');
  }
  const path = typeof stdout === 'string' ? stdout.trim() : '';
  if (!usablePath(path)) throw new Error('plugin config directory could not be resolved');
  return path;
}

export function resolveStateDir(configDir, env = process.env) {
  const configured = env.HERDR_PLUGIN_STATE_DIR;
  if (usablePath(configured)) return configured;
  return join(configDir, 'state');
}

export function commandsPath(configDir) {
  return join(configDir, CONFIG_FILE_NAME);
}

export function runLogPath(stateDir) {
  return join(stateDir, RUN_LOG_FILE_NAME);
}
```

- [ ] **Step 4: Run the path tests**

Run: `node --test test/paths.test.mjs`
Expected: PASS — 7 tests.

- [ ] **Step 5: Write the failing test `test/store.test.mjs`**

```js
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConfigError, defaultConfig, serializeConfig } from '../src/schema.mjs';
import { ensureStore, loadStore, saveStore } from '../src/store.mjs';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-store-'));
  return { dir, file: join(dir, 'commands.json') };
}

test('loadStore returns the seeded default when the file is absent', async () => {
  const { file } = await scratch();
  const loaded = await loadStore(file);
  assert.deepEqual(loaded.doc, defaultConfig());
  assert.equal(loaded.raw, null);
});

test('loadStore reads and normalizes an existing file', async () => {
  const { file } = await scratch();
  await writeFile(file, JSON.stringify({ commands: [{ label: 'Ls', type: 'shell', command: 'ls' }] }), 'utf8');
  const loaded = await loadStore(file);
  assert.equal(loaded.doc.commands.length, 1);
  assert.equal(loaded.doc.commands[0].id, 'ls');
  assert.equal(loaded.doc.commands[0].cwd, 'focused');
  assert.deepEqual(loaded.doc.editor, ['code']);
  assert.equal(typeof loaded.raw, 'string');
});

test('loadStore reports invalid JSON as a ConfigError naming the file', async () => {
  const { file } = await scratch();
  await writeFile(file, '{ not json', 'utf8');
  await assert.rejects(loadStore(file), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /commands\.json/u);
    assert.match(error.message, /not valid JSON/u);
    return true;
  });
});

test('loadStore surfaces schema failures with the file name', async () => {
  const { file } = await scratch();
  await writeFile(file, JSON.stringify({ commands: [{ label: 'a', type: 'nope', command: 'b' }] }), 'utf8');
  await assert.rejects(loadStore(file), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /commands\.json/u);
    assert.match(error.message, /commands\[0\]/u);
    return true;
  });
});

test('ensureStore writes the seed file exactly once', async () => {
  const { file } = await scratch();
  const first = await ensureStore(file);
  assert.deepEqual(first.doc, defaultConfig());
  assert.equal(await readFile(file, 'utf8'), serializeConfig(defaultConfig()));
  assert.equal(first.raw, serializeConfig(defaultConfig()));

  await writeFile(file, serializeConfig({ schema_version: 1, editor: ['code'], commands: [] }), 'utf8');
  const second = await ensureStore(file);
  assert.deepEqual(second.doc.commands, []);
});

test('saveStore writes atomically and leaves no temp files behind', async () => {
  const { dir, file } = await scratch();
  const doc = { schema_version: 1, editor: ['code'], commands: [] };
  const saved = await saveStore(file, doc);
  assert.equal(saved.raw, serializeConfig(doc));
  assert.equal(await readFile(file, 'utf8'), serializeConfig(doc));
  assert.deepEqual(await readdir(dir), ['commands.json']);
});

test('saveStore normalizes before writing', async () => {
  const { file } = await scratch();
  await saveStore(file, { commands: [{ label: '  Ls  ', type: 'shell', command: 'ls' }] });
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.commands[0].label, 'Ls');
  assert.equal(written.schema_version, 1);
});

test('saveStore refuses to clobber an external edit', async () => {
  const { file } = await scratch();
  const first = await saveStore(file, { commands: [] });
  await writeFile(file, `${first.raw}\n`, 'utf8');
  await assert.rejects(
    saveStore(file, { commands: [{ label: 'New', type: 'shell', command: 'ls' }] }, { expectedRaw: first.raw }),
    (error) => error instanceof ConfigError && /changed on disk/u.test(error.message),
  );
});

test('saveStore accepts expectedRaw null for a first write', async () => {
  const { file } = await scratch();
  const saved = await saveStore(file, { commands: [] }, { expectedRaw: null });
  assert.equal(await readFile(file, 'utf8'), saved.raw);
});

test('saveStore rejects an invalid document without touching the file', async () => {
  const { file } = await scratch();
  const good = await saveStore(file, { commands: [] });
  await assert.rejects(
    saveStore(file, { commands: [{ label: 'a', type: 'nope', command: 'b' }] }, { expectedRaw: good.raw }),
    ConfigError,
  );
  assert.equal(await readFile(file, 'utf8'), good.raw);
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `node --test test/store.test.mjs`
Expected: FAIL — `Cannot find module '.../src/store.mjs'`.

- [ ] **Step 7: Write `src/store.mjs`**

```js
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { ConfigError, defaultConfig, normalizeConfig, serializeConfig } from './schema.mjs';

async function readRaw(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ConfigError(`${basename(file)} could not be read (${error?.code ?? 'unknown error'})`);
  }
}

export async function loadStore(file) {
  const raw = await readRaw(file);
  if (raw === null) return { doc: defaultConfig(), raw: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${basename(file)} is not valid JSON`);
  }
  try {
    return { doc: normalizeConfig(parsed), raw };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new ConfigError(`${basename(file)}: ${error.message}`);
  }
}

export async function saveStore(file, doc, { expectedRaw = null } = {}) {
  const normalized = normalizeConfig(doc);
  const raw = serializeConfig(normalized);
  if (typeof expectedRaw === 'string') {
    const current = await readRaw(file);
    if (current !== null && current !== expectedRaw) {
      throw new ConfigError(
        `${basename(file)} changed on disk since it was loaded; reopen Command Center to pick up the new file`,
      );
    }
  }
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  // Write-then-rename so a crash mid-write can never leave a half-written
  // config that the next popup would refuse to load.
  const temporary = join(directory, `.${basename(file)}.${process.pid}.tmp`);
  await writeFile(temporary, raw, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
  return { raw };
}

export async function ensureStore(file) {
  const loaded = await loadStore(file);
  if (loaded.raw !== null) return { doc: loaded.doc, raw: loaded.raw };
  const saved = await saveStore(file, loaded.doc);
  return { doc: loaded.doc, raw: saved.raw };
}
```

- [ ] **Step 8: Run the store tests**

Run: `node --test test/store.test.mjs`
Expected: PASS — 10 tests.

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS — 55 tests total.

- [ ] **Step 10: Commit**

```bash
git add src/paths.mjs src/store.mjs test/paths.test.mjs test/store.test.mjs
git commit -m "feat: resolve plugin paths and read/write commands.json safely

The popup and the runner both need the same three paths, so resolution lives in
one place: HERDR_PLUGIN_CONFIG_DIR when herdr injects it, otherwise
'herdr plugin config-dir'. Every resolved path is checked for absoluteness, NUL
bytes, and length before it can reach a spawn.

saveStore writes to a temp file and renames, so an interrupted save cannot leave
a half-written config that the next popup would reject. It also takes the raw
text the popup loaded and refuses to write when the file changed underneath —
the config file is meant to be edited in VS Code at the same time, and silently
overwriting those edits would be the worst possible failure."
```

---

## Task 5: Invocation context and cwd resolution

**Files:**
- Create: `src/context.mjs`
- Test: `test/context.test.mjs`

**Interfaces:**
- Consumes: nothing (reads `env` only).
- Produces:
  - `readContext(env?: object): { focusedPaneCwd: string | null, workspaceCwd: string | null }`
  - `serializeContext(context: { focusedPaneCwd: string | null, workspaceCwd: string | null }): string`
  - `resolveCwd(command: Command, context: { focusedPaneCwd, workspaceCwd }, options?: { homedir?: () => string }): string`

`readContext` prefers `COMMAND_CENTER_CONTEXT_JSON` (what the `open` action forwards) over `HERDR_PLUGIN_CONTEXT_JSON`, then falls back to `HERDR_ACTIVE_PANE_CWD`. It never reads `HERDR_PANE_ID`: inside the popup that is the *popup's own* pane, not the pane the user came from.

- [ ] **Step 1: Write the failing test `test/context.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { readContext, resolveCwd, serializeContext } from '../src/context.mjs';

const HOME = () => '/Users/cdragon';

test('readContext prefers the forwarded context over the pane context', () => {
  const context = readContext({
    COMMAND_CENTER_CONTEXT_JSON: JSON.stringify({ focusedPaneCwd: '/a', workspaceCwd: '/b' }),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: '/c', workspace_cwd: '/d' }),
  });
  assert.deepEqual(context, { focusedPaneCwd: '/a', workspaceCwd: '/b' });
});

test('readContext reads herdr snake_case fields', () => {
  const context = readContext({
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      focused_pane_cwd: '/Users/cdragon/repo',
      workspace_cwd: '/Users/cdragon',
      focused_pane_id: 'wE:p3',
    }),
  });
  assert.deepEqual(context, { focusedPaneCwd: '/Users/cdragon/repo', workspaceCwd: '/Users/cdragon' });
});

test('readContext falls back to the active pane cwd env', () => {
  const context = readContext({ HERDR_ACTIVE_PANE_CWD: '/Users/cdragon/fallback' });
  assert.deepEqual(context, { focusedPaneCwd: '/Users/cdragon/fallback', workspaceCwd: null });
});

test('readContext tolerates missing, malformed, and non-object JSON', () => {
  for (const env of [
    {},
    { HERDR_PLUGIN_CONTEXT_JSON: 'not json' },
    { HERDR_PLUGIN_CONTEXT_JSON: '[]' },
    { HERDR_PLUGIN_CONTEXT_JSON: 'null' },
    { HERDR_PLUGIN_CONTEXT_JSON: `"${'a'.repeat(200_000)}"` },
  ]) {
    assert.deepEqual(readContext(env), { focusedPaneCwd: null, workspaceCwd: null });
  }
});

test('readContext drops relative and NUL-bearing paths', () => {
  const context = readContext({
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: 'rel/ative', workspace_cwd: '/ok\u0000' }),
  });
  assert.deepEqual(context, { focusedPaneCwd: null, workspaceCwd: null });
});

test('serializeContext round-trips through readContext', () => {
  const context = { focusedPaneCwd: '/a', workspaceCwd: '/b' };
  assert.deepEqual(readContext({ COMMAND_CENTER_CONTEXT_JSON: serializeContext(context) }), context);
});

test('resolveCwd honours the focused mode', () => {
  const command = { cwd: 'focused' };
  assert.equal(resolveCwd(command, { focusedPaneCwd: '/a', workspaceCwd: '/b' }, { homedir: HOME }), '/a');
  assert.equal(resolveCwd(command, { focusedPaneCwd: null, workspaceCwd: '/b' }, { homedir: HOME }), '/b');
  assert.equal(resolveCwd(command, { focusedPaneCwd: null, workspaceCwd: null }, { homedir: HOME }), '/Users/cdragon');
});

test('resolveCwd honours the workspace mode', () => {
  const command = { cwd: 'workspace' };
  assert.equal(resolveCwd(command, { focusedPaneCwd: '/a', workspaceCwd: '/b' }, { homedir: HOME }), '/b');
  assert.equal(resolveCwd(command, { focusedPaneCwd: '/a', workspaceCwd: null }, { homedir: HOME }), '/a');
});

test('resolveCwd returns an explicit absolute path unchanged', () => {
  assert.equal(
    resolveCwd({ cwd: '/Users/cdragon/notes' }, { focusedPaneCwd: '/a', workspaceCwd: '/b' }, { homedir: HOME }),
    '/Users/cdragon/notes',
  );
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/context.test.mjs`
Expected: FAIL — `Cannot find module '.../src/context.mjs'`.

- [ ] **Step 3: Write `src/context.mjs`**

```js
import { homedir as osHomedir } from 'node:os';
import { isAbsolute } from 'node:path';

const MAX_CONTEXT_BYTES = 64_000;

function usableDir(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!isAbsolute(value) || value.includes('\u0000')) return null;
  return value;
}

function parseContextJson(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CONTEXT_BYTES) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

// Only cwds are carried. The popup does not need pane ids: shell commands need a
// directory, and `herdr plugin action invoke` resolves the focused pane itself —
// which is exactly why the runner waits for the popup to close first.
export function readContext(env = process.env) {
  const forwarded = parseContextJson(env.COMMAND_CENTER_CONTEXT_JSON);
  const injected = parseContextJson(env.HERDR_PLUGIN_CONTEXT_JSON);
  const source = forwarded ?? injected ?? {};
  return {
    focusedPaneCwd: usableDir(source.focusedPaneCwd)
      ?? usableDir(source.focused_pane_cwd)
      ?? usableDir(env.HERDR_ACTIVE_PANE_CWD),
    workspaceCwd: usableDir(source.workspaceCwd) ?? usableDir(source.workspace_cwd),
  };
}

export function serializeContext(context) {
  return JSON.stringify({
    focusedPaneCwd: usableDir(context?.focusedPaneCwd),
    workspaceCwd: usableDir(context?.workspaceCwd),
  });
}

export function resolveCwd(command, context, { homedir = osHomedir } = {}) {
  // 'focused' and 'workspace' are not absolute paths, so usableDir rejects them
  // here and the mode branches below decide.
  const explicit = usableDir(command?.cwd);
  if (explicit) return explicit;
  const focused = usableDir(context?.focusedPaneCwd);
  const workspace = usableDir(context?.workspaceCwd);
  if (command?.cwd === 'workspace') return workspace ?? focused ?? homedir();
  return focused ?? workspace ?? homedir();
}
```

- [ ] **Step 4: Run the context tests**

Run: `node --test test/context.test.mjs`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/context.mjs test/context.test.mjs
git commit -m "feat: read the herdr invocation context and resolve a command's cwd

A shell command like 'code .' is only useful if it runs in the directory the
user was looking at, so the 'open' action captures HERDR_PLUGIN_CONTEXT_JSON
and forwards it into the popup, which forwards it to the runner. Reading it
back accepts both the herdr snake_case shape and our own camelCase shape so a
single reader covers both hops.

Pane ids are deliberately not carried: HERDR_PANE_ID inside the popup is the
popup's own pane, and 'herdr plugin action invoke' resolves the focused pane
server-side — which only gives the right answer once the popup is gone."
```

---

## Task 6: View state machine — list, form, confirm, error

**Files:**
- Create: `src/view.mjs`
- Test: `test/view.test.mjs`

**Interfaces:**
- Consumes: `src/schema.mjs` (`COMMAND_TYPES`, `CWD_MODES`, `ConfigError`, `normalizeCommand`).
- Produces:
  - `MODES: readonly ['list', 'form', 'confirm-delete', 'error']`
  - `FORM_FIELDS: readonly ['label', 'type', 'command', 'cwd', 'description']`
  - `CHOICE_FIELDS: ReadonlySet<'type' | 'cwd'>`
  - `CHOICE_VALUES: Readonly<{ type: readonly string[], cwd: readonly string[] }>`
  - `createView(options: { doc: ConfigDoc, error?: string | null, cursor?: number }): View`
  - `reduceKey(view: View, key: string): View`

`View` shape (every field always present):

```
{
  mode: 'list' | 'form' | 'confirm-delete' | 'error',
  doc: ConfigDoc,
  error: string | null,          // config load/save failure, shown in 'error' mode
  formError: string | null,      // validation failure, shown under the form
  cursor: number,                // index into doc.commands
  form: null | {
    commandId: string | null,    // null when adding
    fieldIndex: number,
    fields: { label: string, type: string, command: string, cwd: string, description: string }
  },
  effect: null | Effect
}
```

`Effect` is exactly one of:
- `{ type: 'run', command: Command }` — popup hands the command to the runner and exits
- `{ type: 'open-config' }` — popup hands "open commands.json" to the runner and exits
- `{ type: 'save', doc: ConfigDoc, cursor: number }` — popup persists and stays open
- `{ type: 'close' }` — popup exits, running nothing

Key contract:

| Mode | Key | Result |
| --- | --- | --- |
| list | `up` / `k` | move cursor up, wrapping |
| list | `down` / `j` | move cursor down, wrapping |
| list | `enter` | `run` effect for the command under the cursor |
| list | `1`–`9` | move the cursor to that absolute index and `run` it |
| list | `a` | enter `form` mode, empty fields |
| list | `e` | enter `form` mode prefilled from the command under the cursor |
| list | `d` | enter `confirm-delete` mode |
| list | `o` | `open-config` effect |
| list | `escape` / `q` | `close` effect |
| form | `tab` / `down` | next field, wrapping |
| form | `backtab` / `up` | previous field, wrapping |
| form | `left` / `right` / `space` on `type` or `cwd` | cycle the choice |
| form | printable / `space` / `backspace` on a text field | edit that field |
| form | `enter` | validate; on success `save` effect and back to list; on failure set `formError` |
| form | `escape` | discard and return to list |
| confirm-delete | `y` | `save` effect with the command removed |
| confirm-delete | anything else | return to list |
| error | `o` | `open-config` effect |
| error | `escape` / `q` | `close` effect |
| any | `interrupt` | `close` effect |

- [ ] **Step 1: Write the failing test `test/view.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { CHOICE_FIELDS, createView, FORM_FIELDS, MODES, reduceKey } from '../src/view.mjs';

function doc(labels = ['One', 'Two', 'Three']) {
  return {
    schema_version: 1,
    editor: ['code'],
    commands: labels.map((label, index) => ({
      id: `id-${index}`,
      label,
      type: 'shell',
      command: `run-${index}`,
      cwd: 'focused',
      description: '',
    })),
  };
}

function press(view, ...keys) {
  return keys.reduce((current, key) => reduceKey(current, key), view);
}

test('exports the mode and field vocabularies', () => {
  assert.deepEqual([...MODES], ['list', 'form', 'confirm-delete', 'error']);
  assert.deepEqual([...FORM_FIELDS], ['label', 'type', 'command', 'cwd', 'description']);
  assert.deepEqual([...CHOICE_FIELDS].sort(), ['cwd', 'type']);
});

test('createView starts in list mode with the cursor clamped', () => {
  const view = createView({ doc: doc() });
  assert.equal(view.mode, 'list');
  assert.equal(view.cursor, 0);
  assert.equal(view.form, null);
  assert.equal(view.effect, null);
  assert.equal(createView({ doc: doc(), cursor: 99 }).cursor, 2);
  assert.equal(createView({ doc: doc([]) , cursor: 5 }).cursor, 0);
});

test('createView with an error starts in error mode', () => {
  const view = createView({ doc: doc(), error: 'commands.json is not valid JSON' });
  assert.equal(view.mode, 'error');
  assert.equal(view.error, 'commands.json is not valid JSON');
});

test('reduceKey rejects a non-object view', () => {
  assert.throws(() => reduceKey(null, 'enter'), TypeError);
});

test('arrow keys and vim keys move the cursor and wrap', () => {
  const view = createView({ doc: doc() });
  assert.equal(press(view, 'down').cursor, 1);
  assert.equal(press(view, 'j', 'j').cursor, 2);
  assert.equal(press(view, 'down', 'down', 'down').cursor, 0);
  assert.equal(press(view, 'up').cursor, 2);
  assert.equal(press(view, 'k').cursor, 2);
});

test('moving the cursor never emits an effect', () => {
  assert.equal(press(createView({ doc: doc() }), 'down').effect, null);
});

test('enter runs the command under the cursor', () => {
  const view = press(createView({ doc: doc() }), 'down', 'enter');
  assert.deepEqual(view.effect, { type: 'run', command: doc().commands[1] });
});

test('digits run the command at that absolute index', () => {
  const view = createView({ doc: doc(['a', 'b', 'c']) });
  const pressed = press(view, '3');
  assert.equal(pressed.cursor, 2);
  assert.equal(pressed.effect.type, 'run');
  assert.equal(pressed.effect.command.label, 'c');
});

test('digits beyond the list are ignored', () => {
  const view = createView({ doc: doc(['a', 'b']) });
  const pressed = press(view, '9');
  assert.equal(pressed.effect, null);
  assert.equal(pressed.cursor, 0);
});

test('digits address absolute positions even when the list has scrolled', () => {
  const labels = Array.from({ length: 20 }, (unused, index) => `cmd-${index}`);
  const view = press(createView({ doc: doc(labels) }), 'up');
  assert.equal(view.cursor, 19);
  const pressed = reduceKey(view, '1');
  assert.equal(pressed.cursor, 0);
  assert.equal(pressed.effect.command.label, 'cmd-0');
});

test('escape, q, and interrupt close the popup', () => {
  const view = createView({ doc: doc() });
  for (const key of ['escape', 'q', 'interrupt']) {
    assert.deepEqual(reduceKey(view, key).effect, { type: 'close' });
  }
});

test('o asks to open the config file', () => {
  assert.deepEqual(reduceKey(createView({ doc: doc() }), 'o').effect, { type: 'open-config' });
});

test('an empty list still closes and still opens the config', () => {
  const view = createView({ doc: doc([]) });
  assert.deepEqual(reduceKey(view, 'enter').effect, null);
  assert.deepEqual(reduceKey(view, 'e').effect, null);
  assert.equal(reduceKey(view, 'e').mode, 'list');
  assert.deepEqual(reduceKey(view, 'd').effect, null);
  assert.equal(reduceKey(view, 'd').mode, 'list');
  assert.deepEqual(reduceKey(view, 'o').effect, { type: 'open-config' });
  assert.deepEqual(reduceKey(view, 'escape').effect, { type: 'close' });
});

test('a opens an empty add form', () => {
  const view = reduceKey(createView({ doc: doc() }), 'a');
  assert.equal(view.mode, 'form');
  assert.equal(view.form.commandId, null);
  assert.equal(view.form.fieldIndex, 0);
  assert.deepEqual(view.form.fields, {
    label: '', type: 'shell', command: '', cwd: 'focused', description: '',
  });
});

test('e prefills the form from the selected command', () => {
  const view = press(createView({ doc: doc() }), 'down', 'e');
  assert.equal(view.mode, 'form');
  assert.equal(view.form.commandId, 'id-1');
  assert.equal(view.form.fields.label, 'Two');
  assert.equal(view.form.fields.command, 'run-1');
});

test('tab and backtab cycle form fields', () => {
  const form = reduceKey(createView({ doc: doc() }), 'a');
  assert.equal(press(form, 'tab').form.fieldIndex, 1);
  assert.equal(press(form, 'down', 'down').form.fieldIndex, 2);
  assert.equal(press(form, 'backtab').form.fieldIndex, 4);
  assert.equal(press(form, 'up').form.fieldIndex, 4);
});

test('typing edits the focused text field, including Korean and spaces', () => {
  let view = reduceKey(createView({ doc: doc() }), 'a');
  view = press(view, 'a', 'b', 'space', '한');
  assert.equal(view.form.fields.label, 'ab 한');
  view = reduceKey(view, 'backspace');
  assert.equal(view.form.fields.label, 'ab ');
});

test('digits are literal text inside the form', () => {
  const view = press(reduceKey(createView({ doc: doc() }), 'a'), '3', '7');
  assert.equal(view.form.fields.label, '37');
  assert.equal(view.form.effect, undefined);
});

test('named keys are never inserted as text', () => {
  const view = press(reduceKey(createView({ doc: doc() }), 'a'), 'left', 'right');
  assert.equal(view.form.fields.label, '');
});

test('left, right, and space cycle the type and cwd choices', () => {
  let view = press(reduceKey(createView({ doc: doc() }), 'a'), 'tab');
  assert.equal(view.form.fields.type, 'shell');
  view = reduceKey(view, 'right');
  assert.equal(view.form.fields.type, 'plugin_action');
  view = reduceKey(view, 'space');
  assert.equal(view.form.fields.type, 'shell');
  view = reduceKey(view, 'left');
  assert.equal(view.form.fields.type, 'plugin_action');

  let cwdView = press(reduceKey(createView({ doc: doc() }), 'a'), 'tab', 'tab', 'tab');
  assert.equal(cwdView.form.fields.cwd, 'focused');
  cwdView = reduceKey(cwdView, 'right');
  assert.equal(cwdView.form.fields.cwd, 'workspace');
});

test('escape discards the form without saving', () => {
  const view = press(reduceKey(createView({ doc: doc() }), 'a'), 'x', 'escape');
  assert.equal(view.mode, 'list');
  assert.equal(view.form, null);
  assert.equal(view.effect, null);
  assert.equal(view.doc.commands.length, 3);
});

test('enter appends a new command and asks for a save', () => {
  let view = reduceKey(createView({ doc: doc() }), 'a');
  for (const key of [...'Tidy']) view = reduceKey(view, key);
  view = reduceKey(view, 'tab');
  view = reduceKey(view, 'tab');
  for (const key of [...'ls']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');

  assert.equal(view.mode, 'list');
  assert.equal(view.form, null);
  assert.equal(view.doc.commands.length, 4);
  assert.equal(view.cursor, 3);
  assert.deepEqual(view.doc.commands[3], {
    id: 'tidy', label: 'Tidy', type: 'shell', command: 'ls', cwd: 'focused', description: '',
  });
  assert.deepEqual(view.effect, { type: 'save', doc: view.doc, cursor: 3 });
});

test('enter updates the edited command in place and keeps its id', () => {
  let view = press(createView({ doc: doc() }), 'down', 'e');
  view = reduceKey(view, 'backspace');
  view = reduceKey(view, 'backspace');
  view = reduceKey(view, 'backspace');
  for (const key of [...'Zwei']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');

  assert.equal(view.doc.commands.length, 3);
  assert.equal(view.doc.commands[1].id, 'id-1');
  assert.equal(view.doc.commands[1].label, 'Zwei');
  assert.equal(view.cursor, 1);
  assert.equal(view.effect.type, 'save');
});

test('enter on an invalid form reports the reason and stays in the form', () => {
  const view = reduceKey(reduceKey(createView({ doc: doc() }), 'a'), 'enter');
  assert.equal(view.mode, 'form');
  assert.match(view.formError, /label/u);
  assert.equal(view.effect, null);
});

test('a plugin_action form rejects a bare action id', () => {
  let view = reduceKey(createView({ doc: doc() }), 'a');
  for (const key of [...'Explorer']) view = reduceKey(view, key);
  view = press(view, 'tab', 'right', 'tab');
  for (const key of [...'open']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');
  assert.equal(view.mode, 'form');
  assert.match(view.formError, /plugin_id\.action_id/u);
});

test('a duplicate label gets a deduped id rather than an error', () => {
  let view = reduceKey(createView({ doc: doc(['One']) }), 'a');
  for (const key of [...'One']) view = reduceKey(view, key);
  view = press(view, 'tab', 'tab');
  for (const key of [...'ls']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');
  assert.deepEqual(view.doc.commands.map((command) => command.id), ['id-0', 'one']);
});

test('editing a command keeps its own id available to itself', () => {
  const single = {
    schema_version: 1,
    editor: ['code'],
    commands: [{ id: 'keep', label: 'Keep', type: 'shell', command: 'ls', cwd: 'focused', description: '' }],
  };
  let view = reduceKey(createView({ doc: single }), 'e');
  view = press(view, 'tab', 'tab');
  for (const key of [...'!']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');
  assert.equal(view.doc.commands[0].id, 'keep');
});

test('d then y removes the command and asks for a save', () => {
  const confirm = press(createView({ doc: doc() }), 'down', 'd');
  assert.equal(confirm.mode, 'confirm-delete');
  assert.equal(confirm.effect, null);
  const deleted = reduceKey(confirm, 'y');
  assert.equal(deleted.mode, 'list');
  assert.deepEqual(deleted.doc.commands.map((command) => command.label), ['One', 'Three']);
  assert.deepEqual(deleted.effect, { type: 'save', doc: deleted.doc, cursor: 1 });
});

test('deleting the last row clamps the cursor', () => {
  const deleted = press(createView({ doc: doc() }), 'up', 'd', 'y');
  assert.equal(deleted.cursor, 1);
  assert.equal(deleted.doc.commands.length, 2);
});

test('deleting the only command leaves an empty list at cursor zero', () => {
  const deleted = press(createView({ doc: doc(['Only']) }), 'd', 'y');
  assert.deepEqual(deleted.doc.commands, []);
  assert.equal(deleted.cursor, 0);
});

test('any key other than y cancels the delete', () => {
  const confirm = reduceKey(createView({ doc: doc() }), 'd');
  for (const key of ['n', 'escape', 'enter', 'Y']) {
    const cancelled = reduceKey(confirm, key);
    assert.equal(cancelled.mode, 'list', key);
    assert.equal(cancelled.effect, null, key);
    assert.equal(cancelled.doc.commands.length, 3, key);
  }
});

test('error mode only offers open-config and close', () => {
  const view = createView({ doc: doc(), error: 'broken' });
  assert.deepEqual(reduceKey(view, 'o').effect, { type: 'open-config' });
  assert.deepEqual(reduceKey(view, 'escape').effect, { type: 'close' });
  assert.deepEqual(reduceKey(view, 'q').effect, { type: 'close' });
  assert.deepEqual(reduceKey(view, 'interrupt').effect, { type: 'close' });
  assert.equal(reduceKey(view, 'enter').effect, null);
  assert.equal(reduceKey(view, 'a').mode, 'error');
});

test('reduceKey never mutates the view it was given', () => {
  const view = createView({ doc: doc() });
  const snapshot = JSON.parse(JSON.stringify({ ...view, doc: view.doc }));
  reduceKey(view, 'down');
  reduceKey(view, 'a');
  reduceKey(view, 'enter');
  assert.deepEqual(JSON.parse(JSON.stringify({ ...view, doc: view.doc })), snapshot);
});

test('a stale effect is cleared by the next key', () => {
  const ran = reduceKey(createView({ doc: doc() }), 'enter');
  assert.equal(ran.effect.type, 'run');
  assert.equal(reduceKey(ran, 'down').effect, null);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/view.test.mjs`
Expected: FAIL — `Cannot find module '.../src/view.mjs'`.

- [ ] **Step 3: Write `src/view.mjs`**

```js
import { COMMAND_TYPES, ConfigError, CWD_MODES, normalizeCommand } from './schema.mjs';

export const MODES = Object.freeze(['list', 'form', 'confirm-delete', 'error']);
export const FORM_FIELDS = Object.freeze(['label', 'type', 'command', 'cwd', 'description']);
export const CHOICE_FIELDS = Object.freeze(new Set(['type', 'cwd']));
export const CHOICE_VALUES = Object.freeze({ type: COMMAND_TYPES, cwd: CWD_MODES });

function clampCursor(index, length) {
  if (length <= 0) return 0;
  const value = Number.isSafeInteger(index) ? index : 0;
  return Math.max(0, Math.min(value, length - 1));
}

function step(index, delta, length) {
  if (length <= 0) return 0;
  return (index + delta + length) % length;
}

function removeLastGrapheme(value) {
  if (value.length === 0) return '';
  if (typeof Intl.Segmenter === 'function') {
    const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
    if (segments.length === 0) return '';
    return value.slice(0, segments.at(-1).index);
  }
  return [...value].slice(0, -1).join('');
}

function emptyForm() {
  return {
    commandId: null,
    fieldIndex: 0,
    fields: { label: '', type: 'shell', command: '', cwd: 'focused', description: '' },
  };
}

function formFor(command) {
  return {
    commandId: command.id,
    fieldIndex: 0,
    fields: {
      label: command.label,
      type: command.type,
      command: command.command,
      cwd: command.cwd,
      description: command.description,
    },
  };
}

export function createView({ doc, error = null, cursor = 0 } = {}) {
  if (!doc || typeof doc !== 'object') throw new TypeError('a config document is required');
  return {
    mode: error ? 'error' : 'list',
    doc,
    error: error ?? null,
    formError: null,
    cursor: clampCursor(cursor, doc.commands?.length ?? 0),
    form: null,
    effect: null,
  };
}

function reduceError(view, key) {
  if (key === 'o') return { ...view, effect: { type: 'open-config' } };
  if (key === 'escape' || key === 'q') return { ...view, effect: { type: 'close' } };
  return view;
}

function reduceList(view, key) {
  const commands = view.doc.commands ?? [];
  if (key === 'escape' || key === 'q') return { ...view, effect: { type: 'close' } };
  if (key === 'o') return { ...view, effect: { type: 'open-config' } };
  if (key === 'a') return { ...view, mode: 'form', formError: null, form: emptyForm() };
  if (key === 'up' || key === 'k') return { ...view, cursor: step(view.cursor, -1, commands.length) };
  if (key === 'down' || key === 'j') return { ...view, cursor: step(view.cursor, 1, commands.length) };

  const selected = commands[view.cursor] ?? null;
  if (key === 'e') {
    if (!selected) return view;
    return { ...view, mode: 'form', formError: null, form: formFor(selected) };
  }
  if (key === 'd') {
    if (!selected) return view;
    return { ...view, mode: 'confirm-delete' };
  }
  if (key === 'enter') {
    if (!selected) return view;
    return { ...view, effect: { type: 'run', command: selected } };
  }
  // Badges are absolute positions, not viewport offsets, so the digit next to a
  // row always runs that row no matter how far the list has scrolled.
  if (/^[1-9]$/u.test(key)) {
    const index = Number(key) - 1;
    const target = commands[index];
    if (!target) return view;
    return { ...view, cursor: index, effect: { type: 'run', command: target } };
  }
  return view;
}

function reduceConfirm(view, key) {
  if (key !== 'y') return { ...view, mode: 'list' };
  const commands = (view.doc.commands ?? []).filter((unused, index) => index !== view.cursor);
  const doc = { ...view.doc, commands };
  const cursor = clampCursor(view.cursor, commands.length);
  return { ...view, mode: 'list', doc, cursor, effect: { type: 'save', doc, cursor } };
}

function setField(view, field, value) {
  return {
    ...view,
    formError: null,
    form: { ...view.form, fields: { ...view.form.fields, [field]: value } },
  };
}

function cycleChoice(view, field, delta) {
  const values = CHOICE_VALUES[field];
  const current = values.indexOf(view.form.fields[field]);
  const next = values[step(current < 0 ? 0 : current, delta, values.length)];
  return setField(view, field, next);
}

function submitForm(view) {
  const { form } = view;
  const commands = view.doc.commands ?? [];
  const index = commands.findIndex((entry) => entry.id === form.commandId);
  const existingIds = commands
    .filter((entry) => entry.id !== form.commandId)
    .map((entry) => entry.id);
  let command;
  try {
    command = normalizeCommand({
      id: form.commandId ?? undefined,
      label: form.fields.label,
      type: form.fields.type,
      command: form.fields.command,
      cwd: form.fields.cwd,
      description: form.fields.description,
    }, { existingIds });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { ...view, formError: error.message };
  }
  const nextCommands = index >= 0
    ? commands.map((entry, position) => (position === index ? command : entry))
    : [...commands, command];
  const doc = { ...view.doc, commands: nextCommands };
  const cursor = index >= 0 ? index : nextCommands.length - 1;
  return {
    ...view,
    mode: 'list',
    form: null,
    formError: null,
    doc,
    cursor,
    effect: { type: 'save', doc, cursor },
  };
}

function reduceForm(view, key) {
  const { form } = view;
  if (key === 'escape') return { ...view, mode: 'list', form: null, formError: null };
  if (key === 'enter') return submitForm(view);
  if (key === 'tab' || key === 'down') {
    return { ...view, form: { ...form, fieldIndex: step(form.fieldIndex, 1, FORM_FIELDS.length) } };
  }
  if (key === 'backtab' || key === 'up') {
    return { ...view, form: { ...form, fieldIndex: step(form.fieldIndex, -1, FORM_FIELDS.length) } };
  }
  const field = FORM_FIELDS[form.fieldIndex];
  if (CHOICE_FIELDS.has(field)) {
    if (key === 'left') return cycleChoice(view, field, -1);
    if (key === 'right' || key === 'space') return cycleChoice(view, field, 1);
    return view;
  }
  if (key === 'backspace') return setField(view, field, removeLastGrapheme(form.fields[field]));
  if (key === 'space') return setField(view, field, `${form.fields[field]} `);
  // Every canonical key name is longer than one grapheme, so this admits
  // printable input only — including Korean syllables and emoji.
  if (typeof key === 'string' && [...key].length === 1) {
    return setField(view, field, `${form.fields[field]}${key}`);
  }
  return view;
}

export function reduceKey(view, key) {
  if (!view || typeof view !== 'object') throw new TypeError('view state is required');
  const cleared = { ...view, effect: null };
  if (key === 'interrupt') return { ...cleared, effect: { type: 'close' } };
  if (cleared.mode === 'error') return reduceError(cleared, key);
  if (cleared.mode === 'confirm-delete') return reduceConfirm(cleared, key);
  if (cleared.mode === 'form') return reduceForm(cleared, key);
  return reduceList(cleared, key);
}
```

- [ ] **Step 4: Run the view tests**

Run: `node --test test/view.test.mjs`
Expected: PASS — 34 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — 98 tests total.

- [ ] **Step 6: Commit**

```bash
git add src/view.mjs test/view.test.mjs
git commit -m "feat: add the Command Center keyboard state machine

The whole popup contract lives in one pure reducer so it can be tested without
a terminal: arrow/vim navigation, enter to run, 1-9 to run by badge, a/e/d for
add/edit/delete, o to open commands.json, and a dedicated error mode for a
config file that failed to load.

Number badges address absolute list positions rather than viewport offsets.
Addressing visible rows would silently change what '3' does as the list
scrolls, which is exactly the memorization problem this plugin exists to remove.

Nothing is executed or written here. The reducer only emits an effect
('run' / 'open-config' / 'save' / 'close') and the popup decides what to do
with it, which is what keeps 'close the popup before running' enforceable in
one place."
```

---

## Task 7: Renderer

**Files:**
- Create: `src/render.mjs`
- Test: `test/render.test.mjs`

**Interfaces:**
- Consumes: `src/text.mjs` (`clipLine`, `displayWidth`, `wrap`), `src/view.mjs` (`CHOICE_FIELDS`, `FORM_FIELDS`).
- Produces:
  - `renderLines(view: View, size?: { columns?: number, rows?: number, color?: boolean }): string[]`
  - `renderView(view: View, size?: object): string` — `renderLines(...).join('\n')`

Guarantees the tests pin down: the returned array is exactly `size.rows` lines long, no line exceeds `size.columns` display cells (ANSI styling excluded, because styling is applied only after clipping), and the footer is always the last visible content row.

- [ ] **Step 1: Write the failing test `test/render.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { displayWidth } from '../src/text.mjs';
import { createView, reduceKey } from '../src/view.mjs';
import { renderLines, renderView } from '../src/render.mjs';

const SIZE = { columns: 78, rows: 24 };

function doc(labels = ['Open in VS Code', 'Open repo on GitHub', 'File explorer']) {
  return {
    schema_version: 1,
    editor: ['code'],
    commands: labels.map((label, index) => ({
      id: `id-${index}`,
      label,
      type: index === 2 ? 'plugin_action' : 'shell',
      command: index === 2 ? 'ray.file-explorer.open' : `cmd-${index}`,
      cwd: 'focused',
      description: index === 0 ? 'Open the focused directory' : '',
    })),
  };
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/gu, '');
}

test('renderLines fills the terminal exactly and never overflows the width', () => {
  const lines = renderLines(createView({ doc: doc() }), SIZE);
  assert.equal(lines.length, SIZE.rows);
  for (const line of lines) {
    assert.ok(displayWidth(line) <= SIZE.columns, `"${line}" is ${displayWidth(line)} cells`);
  }
});

test('renderLines keeps the width budget with long Korean labels', () => {
  const long = '브랜치를 정리하고 원격에 푸시한 다음 알림까지 보내는 아주 긴 커맨드 이름';
  const lines = renderLines(createView({ doc: doc([long, long, long]) }), { columns: 40, rows: 16 });
  assert.equal(lines.length, 16);
  for (const line of lines) assert.ok(displayWidth(line) <= 40, line);
});

test('renderLines survives an absurdly small and an absurdly large terminal', () => {
  for (const size of [{ columns: 1, rows: 1 }, { columns: 4, rows: 3 }, { columns: 500, rows: 400 }]) {
    const lines = renderLines(createView({ doc: doc() }), size);
    assert.ok(lines.length >= 1);
    for (const line of lines) assert.ok(displayWidth(line) <= Math.min(size.columns, 240), line);
  }
});

test('renderLines defaults a missing size to the manifest popup size', () => {
  const lines = renderLines(createView({ doc: doc() }));
  assert.equal(lines.length, 24);
});

test('the list shows a header with the command count', () => {
  const text = renderView(createView({ doc: doc() }), SIZE);
  assert.match(text, /Command Center · 3 commands/u);
  assert.match(renderView(createView({ doc: doc(['One']) }), SIZE), /1 command\b/u);
});

test('the list numbers the first nine commands and marks the cursor', () => {
  const text = renderView(createView({ doc: doc() }), SIZE);
  assert.match(text, /› 1\. Open in VS Code/u);
  assert.match(text, / {2}2\. Open repo on GitHub/u);
  const moved = renderView(reduceKey(createView({ doc: doc() }), 'down'), SIZE);
  assert.match(moved, /› 2\. Open repo on GitHub/u);
});

test('commands past the ninth have no badge', () => {
  const labels = Array.from({ length: 12 }, (unused, index) => `cmd-${index}`);
  const text = renderView(createView({ doc: doc(labels), cursor: 11 }), { columns: 78, rows: 40 });
  assert.match(text, /9\. cmd-8/u);
  assert.doesNotMatch(text, /10\. cmd-9/u);
  assert.match(text, /cmd-11/u);
});

test('the list shows the selected command type, command, and description', () => {
  const text = renderView(createView({ doc: doc() }), SIZE);
  assert.match(text, /shell · cmd-0/u);
  assert.match(text, /Open the focused directory/u);
  const plugin = renderView(createView({ doc: doc(), cursor: 2 }), SIZE);
  assert.match(plugin, /plugin_action · ray\.file-explorer\.open/u);
});

test('the list footer advertises every key', () => {
  const text = renderView(createView({ doc: doc() }), SIZE);
  for (const fragment of ['enter run', '1-9 run', 'a add', 'e edit', 'd delete', 'o edit file', 'esc close']) {
    assert.ok(text.includes(fragment), `footer is missing "${fragment}"`);
  }
});

test('a long list scrolls around the cursor and shows the direction hints', () => {
  const labels = Array.from({ length: 40 }, (unused, index) => `cmd-${index}`);
  const view = createView({ doc: doc(labels), cursor: 20 });
  const text = renderView(view, SIZE);
  assert.match(text, /↑ more/u);
  assert.match(text, /↓ more/u);
  assert.match(text, /cmd-20/u);
  assert.doesNotMatch(text, /cmd-0\b/u);
  const top = renderView(createView({ doc: doc(labels), cursor: 0 }), SIZE);
  assert.doesNotMatch(top, /↑ more/u);
  assert.match(top, /↓ more/u);
});

test('an empty list explains how to add a command', () => {
  const text = renderView(createView({ doc: doc([]) }), SIZE);
  assert.match(text, /Command Center · 0 commands/u);
  assert.match(text, /Press a to add one/u);
  assert.match(text, /commands\.json/u);
});

test('the form labels every field and marks the focused one', () => {
  const view = reduceKey(createView({ doc: doc() }), 'a');
  const text = renderView(view, SIZE);
  assert.match(text, /Command Center · Add command/u);
  for (const label of ['Label', 'Type', 'Command', 'Cwd', 'Description']) {
    assert.ok(text.includes(label), `form is missing the ${label} field`);
  }
  assert.match(text, /› Label/u);
  const moved = reduceKey(view, 'tab');
  assert.match(renderView(moved, SIZE), /› Type/u);
});

test('the edit form is titled and prefilled', () => {
  const view = reduceKey(createView({ doc: doc() }), 'e');
  const text = renderView(view, SIZE);
  assert.match(text, /Command Center · Edit command/u);
  assert.match(text, /Open in VS Code/u);
});

test('choice fields advertise that arrows change them', () => {
  const text = renderView(reduceKey(createView({ doc: doc() }), 'a'), SIZE);
  assert.match(text, /shell\s+\(←→\)/u);
  assert.match(text, /focused\s+\(←→\)/u);
});

test('a form validation failure is rendered', () => {
  const view = reduceKey(reduceKey(createView({ doc: doc() }), 'a'), 'enter');
  assert.match(renderView(view, SIZE), /label must not be empty/u);
});

test('the form footer advertises its keys', () => {
  const text = renderView(reduceKey(createView({ doc: doc() }), 'a'), SIZE);
  for (const fragment of ['tab', 'enter save', 'esc cancel']) {
    assert.ok(text.includes(fragment), `form footer is missing "${fragment}"`);
  }
});

test('the delete confirmation names the command', () => {
  const view = reduceKey(createView({ doc: doc() }), 'd');
  const text = renderView(view, SIZE);
  assert.match(text, /Delete "Open in VS Code"\?/u);
  assert.match(text, /y delete/u);
});

test('error mode shows the config error and only its own keys', () => {
  const view = createView({ doc: doc(), error: 'commands.json is not valid JSON' });
  const text = renderView(view, SIZE);
  assert.match(text, /Command Center · config error/u);
  assert.match(text, /commands\.json is not valid JSON/u);
  assert.match(text, /o edit file/u);
  assert.ok(!text.includes('a add'));
});

test('color mode adds ANSI styling without changing the layout width', () => {
  const view = createView({ doc: doc() });
  const plain = renderLines(view, SIZE);
  const colored = renderLines(view, { ...SIZE, color: true });
  assert.equal(colored.length, plain.length);
  assert.deepEqual(colored.map(stripAnsi), plain);
  assert.ok(colored.some((line) => line.includes('\u001b[')));
});

test('color is off unless requested', () => {
  assert.ok(!renderView(createView({ doc: doc() }), SIZE).includes('\u001b['));
});

test('a command label containing an escape sequence cannot corrupt the frame', () => {
  const hostile = doc(['\u001b[31mred\u001b[0m label']);
  const lines = renderLines(createView({ doc: hostile }), SIZE);
  assert.ok(lines.some((line) => line.includes('<U+001B>')));
  assert.ok(!lines.some((line) => /\u001b\[31m/u.test(line)));
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/render.test.mjs`
Expected: FAIL — `Cannot find module '.../src/render.mjs'`.

- [ ] **Step 3: Write `src/render.mjs`**

```js
import { clipLine, wrap } from './text.mjs';
import { CHOICE_FIELDS, FORM_FIELDS } from './view.mjs';

// Matches the popup size declared in herdr-plugin.toml, used when a caller has
// no TTY dimensions to offer.
const DEFAULT_COLUMNS = 78;
const DEFAULT_ROWS = 24;
const MAX_COLUMNS = 240;
const MAX_ROWS = 100;
const PADDING_X = 2;
const PADDING_Y = 1;

const LIST_FOOTER = '↑↓ move · enter run · 1-9 run · a add · e edit · d delete · o edit file · esc close';
const FORM_FOOTER = 'tab/↑↓ field · ←→ change · enter save · esc cancel';
const CONFIRM_FOOTER = 'y delete · any other key cancels';
const ERROR_FOOTER = 'o edit file · esc close';

const FIELD_LABELS = Object.freeze({
  label: 'Label',
  type: 'Type',
  command: 'Command',
  cwd: 'Cwd',
  description: 'Description',
});
const FIELD_LABEL_WIDTH = 12;

// Styling is applied only after clipping so an escape code can never be counted
// as a visible cell.
const RESET = '\u001b[0m';
const styles = {
  bold: (text) => `\u001b[1m${text}${RESET}`,
  dim: (text) => `\u001b[2m${text}${RESET}`,
  cyan: (text) => `\u001b[36m${text}${RESET}`,
  yellow: (text) => `\u001b[33m${text}${RESET}`,
};

function boundedSize(size) {
  const columns = Number.isFinite(size?.columns) ? Math.floor(size.columns) : DEFAULT_COLUMNS;
  const rows = Number.isFinite(size?.rows) ? Math.floor(size.rows) : DEFAULT_ROWS;
  return {
    outerWidth: Math.max(1, Math.min(MAX_COLUMNS, columns)),
    outerHeight: Math.max(1, Math.min(MAX_ROWS, rows)),
  };
}

function viewportRange(cursor, length, budget) {
  const safeCursor = Math.max(0, Math.min(length - 1, cursor));
  let start = safeCursor;
  let end = safeCursor;
  const rows = (nextStart, nextEnd) => (
    nextEnd - nextStart + 1
    + (nextStart > 0 ? 1 : 0)
    + (nextEnd < length - 1 ? 1 : 0)
  );
  for (;;) {
    const candidates = safeCursor - start <= end - safeCursor
      ? [[start - 1, end], [start, end + 1]]
      : [[start, end + 1], [start - 1, end]];
    const next = candidates.find(([nextStart, nextEnd]) => (
      nextStart >= 0 && nextEnd < length && rows(nextStart, nextEnd) <= budget
    ));
    if (!next) return { start, end };
    [start, end] = next;
  }
}

function commandRow(view, command, index, width, color) {
  const marker = index === view.cursor ? '›' : ' ';
  const badge = index < 9 ? `${index + 1}.` : '  ';
  const line = clipLine(`${marker} ${badge} ${command.label}`, width);
  if (!color) return line;
  return index === view.cursor ? styles.bold(styles.cyan(line)) : line;
}

function listBody(view, width, budget, color) {
  const commands = view.doc.commands ?? [];
  const count = commands.length;
  const header = clipLine(`Command Center · ${count} command${count === 1 ? '' : 's'}`, width);
  const lines = [color ? styles.bold(header) : header, ''];
  if (count === 0) {
    lines.push(...wrap('Press a to add one, or o to open commands.json in your editor.', width));
    return lines;
  }
  const selected = commands[Math.max(0, Math.min(count - 1, view.cursor))];
  const detail = [
    clipLine(`${selected.type} · ${selected.command}`, width),
    ...(selected.description.length > 0 ? [clipLine(selected.description, width)] : []),
  ];
  // Reserve the header, the blank line, the blank separator, and the detail
  // block; whatever is left is how many rows the scrolling list may use.
  const listBudget = Math.max(1, budget - lines.length - 1 - detail.length);
  const { start, end } = viewportRange(view.cursor, count, listBudget);
  if (start > 0) lines.push(clipLine('↑ more', width));
  for (let index = start; index <= end; index += 1) {
    lines.push(commandRow(view, commands[index], index, width, color));
  }
  if (end < count - 1) lines.push(clipLine('↓ more', width));
  lines.push('');
  lines.push(...(color ? detail.map((line) => styles.dim(line)) : detail));
  return lines;
}

function formBody(view, width, budget, color) {
  const { form } = view;
  const title = clipLine(`Command Center · ${form.commandId ? 'Edit' : 'Add'} command`, width);
  const lines = [color ? styles.bold(title) : title, ''];
  FORM_FIELDS.forEach((field, index) => {
    const focused = index === form.fieldIndex;
    const value = CHOICE_FIELDS.has(field)
      ? `${form.fields[field]}  (←→)`
      : form.fields[field];
    const line = clipLine(
      `${focused ? '›' : ' '} ${FIELD_LABELS[field].padEnd(FIELD_LABEL_WIDTH)} ${value}`,
      width,
    );
    lines.push(color && focused ? styles.bold(styles.cyan(line)) : line);
  });
  if (view.formError) {
    lines.push('');
    const wrapped = wrap(view.formError, width);
    lines.push(...(color ? wrapped.map((line) => styles.yellow(line)) : wrapped));
  }
  return lines.slice(0, Math.max(1, budget));
}

function confirmBody(view, width, budget, color) {
  const command = (view.doc.commands ?? [])[view.cursor];
  const title = clipLine('Command Center · Delete command', width);
  return [
    color ? styles.bold(title) : title,
    '',
    ...wrap(`Delete "${command?.label ?? ''}"?`, width),
  ].slice(0, Math.max(1, budget));
}

function errorBody(view, width, budget, color) {
  const title = clipLine('Command Center · config error', width);
  return [
    color ? styles.bold(title) : title,
    '',
    ...wrap(view.error ?? 'commands.json could not be loaded', width),
  ].slice(0, Math.max(1, budget));
}

const BODIES = Object.freeze({
  list: listBody,
  form: formBody,
  'confirm-delete': confirmBody,
  error: errorBody,
});

const FOOTERS = Object.freeze({
  list: LIST_FOOTER,
  form: FORM_FOOTER,
  'confirm-delete': CONFIRM_FOOTER,
  error: ERROR_FOOTER,
});

export function renderLines(view, size = {}) {
  const { outerWidth, outerHeight } = boundedSize(size);
  const width = Math.max(1, outerWidth - PADDING_X * 2);
  const height = Math.max(1, outerHeight - PADDING_Y * 2);
  const color = size?.color === true;

  const footerLines = wrap(FOOTERS[view.mode] ?? LIST_FOOTER, width);
  const footer = color ? footerLines.map((line) => styles.dim(line)) : footerLines;
  const bodyBudget = Math.max(1, height - footer.length);
  const body = (BODIES[view.mode] ?? listBody)(view, width, bodyBudget, color).slice(0, bodyBudget);
  const fill = Array.from({ length: Math.max(0, bodyBudget - body.length) }, () => '');

  const indent = ' '.repeat(PADDING_X);
  const content = [...body, ...fill, ...footer]
    .slice(0, height)
    .map((line) => (line.length === 0 ? line : `${indent}${line}`));
  const vertical = Array.from({ length: PADDING_Y }, () => '');
  const lines = [...vertical, ...content, ...vertical].slice(0, outerHeight);
  // Pad short frames so callers always get exactly the rows they asked for.
  while (lines.length < outerHeight) lines.push('');
  return lines;
}

export function renderView(view, size = {}) {
  return renderLines(view, size).join('\n');
}
```

- [ ] **Step 4: Run the render tests**

Run: `node --test test/render.test.mjs`
Expected: PASS — 21 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — 119 tests total.

- [ ] **Step 6: Commit**

```bash
git add src/render.mjs test/render.test.mjs
git commit -m "feat: render the Command Center popup frame

Presentation is separated from the state machine so layout can be tested
without simulating keys: renderLines returns exactly the rows it was asked for,
clips every line to the width in terminal cells, and always puts the footer on
the last content row so the key hints never scroll away.

Styling is applied after clipping, so ANSI codes can never be counted as
visible cells, and every user-supplied label goes through clipLine — a label
containing an escape sequence is printed as <U+001B> instead of repainting the
popup."
```

---

## Task 8: Execution — run log, editor launch, command execution

**Files:**
- Create: `src/logger.mjs`, `src/editor.mjs`, `src/executor.mjs`
- Test: `test/logger.test.mjs`, `test/editor.test.mjs`, `test/executor.test.mjs`

**Interfaces:**
- Consumes: `src/schema.mjs` (`parsePluginActionTarget`), `src/context.mjs` (`resolveCwd`).
- Produces:
  - `src/logger.mjs`: `createLogger(logFilePath: string, options?: { appendFile?: Function, mkdir?: Function, now?: () => number }): { write(event: string, detail?: object): Promise<void> }`
  - `src/editor.mjs`: `editorSpawn(editor: string[], filePath: string): { file: string, args: string[] }`, `openInEditor(filePath: string, deps: { editor: string[], spawn: Function, env?: object, log?: Function }): Promise<{ status: 'started' }>`
  - `src/executor.mjs`: `UI_BUSY_CODE: 'ui_busy'`, `class ExecutionError extends Error` (with `.code`), `buildShellSpawn(command, options): { file, args, options }`, `buildPluginActionArgs(command): string[]`, `executeCommand(command, deps): Promise<{ status: 'started' | 'invoked' }>`

`executeCommand` deps: `{ context, herdrBin?, shell?, env?, spawn, execFile, log?, sleep?, attempts? }`.

Why the retry loop exists: `herdr plugin action invoke` fails with `ui_busy` while a popup owns the screen. The runner already waits for the popup process to exit, but herdr's own teardown is not instantaneous, so a bounded retry converts a millisecond-scale race into a reliable invocation instead of a mysterious no-op.

- [ ] **Step 1: Write the failing test `test/logger.test.mjs`**

```js
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLogger } from '../src/logger.mjs';

test('createLogger appends one JSON line per event and creates the directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-log-'));
  const file = join(dir, 'nested', 'run.log');
  const logger = createLogger(file, { now: () => 1_700_000_000_000 });
  await logger.write('shell', { id: 'open-in-vs-code', cwd: '/tmp' });
  await logger.write('failed', { message: 'nope' });

  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), {
    at: '2023-11-14T22:13:20.000Z',
    event: 'shell',
    id: 'open-in-vs-code',
    cwd: '/tmp',
  });
  assert.equal(JSON.parse(lines[1]).event, 'failed');
});

test('createLogger swallows write failures so logging can never break a run', async () => {
  const logger = createLogger('/tmp/cc-unused.log', {
    mkdir: async () => { throw new Error('read-only'); },
    appendFile: async () => { throw new Error('read-only'); },
  });
  await logger.write('shell', { id: 'x' });
});

test('createLogger tolerates a detail object that cannot be serialized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-log-'));
  const file = join(dir, 'run.log');
  const logger = createLogger(file);
  const cyclic = {};
  cyclic.self = cyclic;
  await logger.write('shell', { cyclic });
  await logger.write('shell', { id: 'ok' });
  assert.match(await readFile(file, 'utf8'), /"id":"ok"/u);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/logger.test.mjs`
Expected: FAIL — `Cannot find module '.../src/logger.mjs'`.

- [ ] **Step 3: Write `src/logger.mjs`**

```js
import { appendFile as appendFileAsync, mkdir as mkdirAsync } from 'node:fs/promises';
import { dirname } from 'node:path';

// The runner is detached with no terminal, so this JSONL file is the only place a
// failed command can explain itself. It must never throw: a logging problem must
// not stop the command the user actually asked for.
export function createLogger(logFilePath, {
  appendFile = appendFileAsync,
  mkdir = mkdirAsync,
  now = Date.now,
} = {}) {
  return {
    async write(event, detail = {}) {
      try {
        const line = JSON.stringify({ at: new Date(now()).toISOString(), event, ...detail });
        await mkdir(dirname(logFilePath), { recursive: true });
        await appendFile(logFilePath, `${line}\n`, 'utf8');
      } catch {
        // Intentionally silent.
      }
    },
  };
}
```

- [ ] **Step 4: Run the logger tests**

Run: `node --test test/logger.test.mjs`
Expected: PASS — 3 tests.

- [ ] **Step 5: Write the failing test `test/editor.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { editorSpawn, openInEditor } from '../src/editor.mjs';

test('editorSpawn appends the file path to the editor argv', () => {
  assert.deepEqual(editorSpawn(['code'], '/tmp/commands.json'), {
    file: 'code',
    args: ['/tmp/commands.json'],
  });
  assert.deepEqual(editorSpawn(['code', '--new-window', '-g'], '/tmp/commands.json'), {
    file: 'code',
    args: ['--new-window', '-g', '/tmp/commands.json'],
  });
});

test('editorSpawn rejects an unusable editor argv', () => {
  for (const editor of [null, [], 'code', [''], [123]]) {
    assert.throws(() => editorSpawn(editor, '/tmp/x'), TypeError);
  }
});

test('openInEditor spawns detached and unrefs so the runner can exit', async () => {
  const calls = [];
  let unrefs = 0;
  const result = await openInEditor('/tmp/commands.json', {
    editor: ['code'],
    env: { PATH: '/usr/bin' },
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return { unref: () => { unrefs += 1; } };
    },
  });
  assert.deepEqual(result, { status: 'started' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'code');
  assert.deepEqual(calls[0].args, ['/tmp/commands.json']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.env, { PATH: '/usr/bin' });
  assert.equal(unrefs, 1);
});

test('openInEditor logs what it launched', async () => {
  const events = [];
  await openInEditor('/tmp/commands.json', {
    editor: ['code'],
    spawn: () => ({ unref: () => {} }),
    log: async (event, detail) => { events.push([event, detail]); },
  });
  assert.equal(events[0][0], 'open-config');
  assert.deepEqual(events[0][1], { editor: 'code', path: '/tmp/commands.json' });
});

test('openInEditor surfaces a spawn failure', async () => {
  await assert.rejects(
    openInEditor('/tmp/commands.json', {
      editor: ['nope'],
      spawn: () => { throw new Error('ENOENT'); },
    }),
    /ENOENT/u,
  );
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `node --test test/editor.test.mjs`
Expected: FAIL — `Cannot find module '.../src/editor.mjs'`.

- [ ] **Step 7: Write `src/editor.mjs`**

```js
export function editorSpawn(editor, filePath) {
  if (
    !Array.isArray(editor)
    || editor.length === 0
    || editor.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new TypeError('editor must be a non-empty array of non-empty strings');
  }
  const [file, ...rest] = editor;
  return { file, args: [...rest, filePath] };
}

// Detached and unref'd: the runner exits immediately after launching the editor,
// and VS Code must survive that exit.
export async function openInEditor(filePath, { editor, spawn, env = process.env, log } = {}) {
  const { file, args } = editorSpawn(editor, filePath);
  const child = spawn(file, args, { detached: true, stdio: 'ignore', shell: false, env });
  child?.unref?.();
  if (typeof log === 'function') await log('open-config', { editor: file, path: filePath });
  return { status: 'started' };
}
```

- [ ] **Step 8: Run the editor tests**

Run: `node --test test/editor.test.mjs`
Expected: PASS — 5 tests.

- [ ] **Step 9: Write the failing test `test/executor.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPluginActionArgs,
  buildShellSpawn,
  executeCommand,
  ExecutionError,
  UI_BUSY_CODE,
} from '../src/executor.mjs';

const CONTEXT = { focusedPaneCwd: '/Users/cdragon/repo', workspaceCwd: '/Users/cdragon' };

function shellCommand(overrides = {}) {
  return {
    id: 'open-in-vs-code',
    label: 'Open in VS Code',
    type: 'shell',
    command: 'code .',
    cwd: 'focused',
    description: '',
    ...overrides,
  };
}

function actionCommand(overrides = {}) {
  return {
    id: 'file-explorer',
    label: 'File explorer',
    type: 'plugin_action',
    command: 'ray.file-explorer.open',
    cwd: 'focused',
    description: '',
    ...overrides,
  };
}

const noSleep = async () => {};

test('UI_BUSY_CODE is the herdr error code we retry on', () => {
  assert.equal(UI_BUSY_CODE, 'ui_busy');
});

test('buildShellSpawn runs the command through a login shell in the resolved cwd', () => {
  const built = buildShellSpawn(shellCommand(), { cwd: '/Users/cdragon/repo', shell: '/bin/zsh' });
  assert.equal(built.file, '/bin/zsh');
  assert.deepEqual(built.args, ['-lc', 'code .']);
  assert.equal(built.options.cwd, '/Users/cdragon/repo');
  assert.equal(built.options.detached, true);
  assert.equal(built.options.stdio, 'ignore');
  assert.equal(built.options.shell, false);
});

test('buildShellSpawn falls back to /bin/sh', () => {
  assert.equal(buildShellSpawn(shellCommand(), { cwd: '/tmp' }).file, '/bin/sh');
});

test('buildPluginActionArgs produces the herdr 0.7.5 argument order', () => {
  assert.deepEqual(buildPluginActionArgs(actionCommand()), [
    'plugin', 'action', 'invoke', 'open', '--plugin', 'ray.file-explorer',
  ]);
});

test('executeCommand spawns a shell command detached in the focused cwd', async () => {
  const calls = [];
  let unrefs = 0;
  const result = await executeCommand(shellCommand(), {
    context: CONTEXT,
    shell: '/bin/zsh',
    env: { PATH: '/usr/bin' },
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return { unref: () => { unrefs += 1; } };
    },
    execFile: async () => { throw new Error('execFile must not be used for shell commands'); },
    sleep: noSleep,
  });
  assert.deepEqual(result, { status: 'started' });
  assert.equal(calls[0].file, '/bin/zsh');
  assert.deepEqual(calls[0].args, ['-lc', 'code .']);
  assert.equal(calls[0].options.cwd, '/Users/cdragon/repo');
  assert.equal(calls[0].options.detached, true);
  assert.deepEqual(calls[0].options.env, { PATH: '/usr/bin' });
  assert.equal(unrefs, 1);
});

test('executeCommand honours the workspace cwd mode and an explicit path', async () => {
  const seen = [];
  const spawn = (file, args, options) => {
    seen.push(options.cwd);
    return { unref: () => {} };
  };
  await executeCommand(shellCommand({ cwd: 'workspace' }), { context: CONTEXT, spawn, execFile: async () => {}, sleep: noSleep });
  await executeCommand(shellCommand({ cwd: '/tmp/explicit' }), { context: CONTEXT, spawn, execFile: async () => {}, sleep: noSleep });
  assert.deepEqual(seen, ['/Users/cdragon', '/tmp/explicit']);
});

test('executeCommand logs the shell command it started', async () => {
  const events = [];
  await executeCommand(shellCommand(), {
    context: CONTEXT,
    spawn: () => ({ unref: () => {} }),
    execFile: async () => {},
    log: async (event, detail) => { events.push([event, detail]); },
    sleep: noSleep,
  });
  assert.equal(events[0][0], 'shell');
  assert.equal(events[0][1].id, 'open-in-vs-code');
  assert.equal(events[0][1].cwd, '/Users/cdragon/repo');
});

test('executeCommand invokes a plugin action through the herdr CLI', async () => {
  const calls = [];
  const result = await executeCommand(actionCommand(), {
    context: CONTEXT,
    herdrBin: '/opt/homebrew/bin/herdr',
    env: { PATH: '/usr/bin' },
    spawn: () => { throw new Error('spawn must not be used for plugin actions'); },
    execFile: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return { stdout: '{"result":{"type":"plugin_action_invoked"}}', stderr: '' };
    },
    sleep: noSleep,
  });
  assert.deepEqual(result, { status: 'invoked' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/opt/homebrew/bin/herdr');
  assert.deepEqual(calls[0].args, ['plugin', 'action', 'invoke', 'open', '--plugin', 'ray.file-explorer']);
  assert.equal(calls[0].options.shell, false);
});

test('executeCommand retries a plugin action while herdr reports ui_busy', async () => {
  const delays = [];
  let attempts = 0;
  const result = await executeCommand(actionCommand(), {
    context: CONTEXT,
    spawn: () => {},
    execFile: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('exit 1');
        error.stdout = JSON.stringify({ error: { code: 'ui_busy', message: 'popup is open' } });
        throw error;
      }
      return { stdout: '{}', stderr: '' };
    },
    sleep: async (ms) => { delays.push(ms); },
  });
  assert.deepEqual(result, { status: 'invoked' });
  assert.equal(attempts, 3);
  assert.equal(delays.length, 2);
  assert.ok(delays.every((ms) => ms > 0));
});

test('executeCommand gives up on ui_busy after the attempt budget', async () => {
  let attempts = 0;
  await assert.rejects(
    executeCommand(actionCommand(), {
      context: CONTEXT,
      spawn: () => {},
      execFile: async () => {
        attempts += 1;
        const error = new Error('exit 1');
        error.stdout = JSON.stringify({ error: { code: 'ui_busy' } });
        throw error;
      },
      sleep: noSleep,
      attempts: 4,
    }),
    (error) => {
      assert.ok(error instanceof ExecutionError);
      assert.equal(error.code, UI_BUSY_CODE);
      assert.match(error.message, /ray\.file-explorer\.open/u);
      return true;
    },
  );
  assert.equal(attempts, 4);
});

test('executeCommand does not retry a non-busy failure', async () => {
  let attempts = 0;
  await assert.rejects(
    executeCommand(actionCommand(), {
      context: CONTEXT,
      spawn: () => {},
      execFile: async () => {
        attempts += 1;
        const error = new Error('exit 1');
        error.stdout = JSON.stringify({ error: { code: 'plugin_action_not_found' } });
        throw error;
      },
      sleep: noSleep,
    }),
    (error) => error instanceof ExecutionError && error.code === null,
  );
  assert.equal(attempts, 1);
});

test('executeCommand treats unparseable and oversized CLI output as non-busy', async () => {
  for (const stdout of [undefined, 'not json', 'x'.repeat(20_000)]) {
    let attempts = 0;
    await assert.rejects(
      executeCommand(actionCommand(), {
        context: CONTEXT,
        spawn: () => {},
        execFile: async () => {
          attempts += 1;
          const error = new Error('exit 1');
          error.stdout = stdout;
          throw error;
        },
        sleep: noSleep,
      }),
      ExecutionError,
    );
    assert.equal(attempts, 1);
  }
});

test('executeCommand logs a failed plugin action', async () => {
  const events = [];
  await assert.rejects(executeCommand(actionCommand(), {
    context: CONTEXT,
    spawn: () => {},
    execFile: async () => { throw new Error('down'); },
    log: async (event, detail) => { events.push([event, detail]); },
    sleep: noSleep,
  }), ExecutionError);
  assert.equal(events.at(-1)[0], 'plugin_action_failed');
  assert.equal(events.at(-1)[1].id, 'file-explorer');
});

test('executeCommand rejects an unknown command type', async () => {
  await assert.rejects(
    executeCommand({ ...shellCommand(), type: 'nope' }, {
      context: CONTEXT,
      spawn: () => {},
      execFile: async () => {},
      sleep: noSleep,
    }),
    (error) => error instanceof ExecutionError && /nope/u.test(error.message),
  );
});
```

- [ ] **Step 10: Run it to confirm it fails**

Run: `node --test test/executor.test.mjs`
Expected: FAIL — `Cannot find module '.../src/executor.mjs'`.

- [ ] **Step 11: Write `src/executor.mjs`**

```js
import { resolveCwd } from './context.mjs';
import { parsePluginActionTarget } from './schema.mjs';

export const UI_BUSY_CODE = 'ui_busy';

const DEFAULT_ATTEMPTS = 10;
const RETRY_DELAY_MS = 120;
const CLI_TIMEOUT_MS = 5_000;
const MAX_BUFFER_BYTES = 1_048_576;
const MAX_ERROR_STDOUT_BYTES = 16_384;

export class ExecutionError extends Error {
  constructor(message, { code = null } = {}) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function buildShellSpawn(command, { cwd, shell } = {}) {
  // No implicit process.env read: bin/run.mjs passes the user's SHELL through, so
  // the fallback here stays deterministic and testable.
  const file = shell || '/bin/sh';
  return {
    file,
    // -lc matches herdr's own `type = "shell"` keybindings: a login shell so the
    // user's PATH and aliases from their profile are available.
    args: ['-lc', command.command],
    options: { cwd, detached: true, stdio: 'ignore', shell: false },
  };
}

export function buildPluginActionArgs(command) {
  const { pluginId, actionId } = parsePluginActionTarget(command.command);
  return ['plugin', 'action', 'invoke', actionId, '--plugin', pluginId];
}

function isUiBusy(error) {
  const stdout = error?.stdout;
  if (typeof stdout !== 'string' || stdout.length > MAX_ERROR_STDOUT_BYTES) return false;
  try {
    return JSON.parse(stdout)?.error?.code === UI_BUSY_CODE;
  } catch {
    return false;
  }
}

async function runShell(command, { context, shell, env, spawn, log }) {
  const cwd = resolveCwd(command, context);
  const { file, args, options } = buildShellSpawn(command, { cwd, shell });
  const child = spawn(file, args, { ...options, env });
  child?.unref?.();
  if (typeof log === 'function') await log('shell', { id: command.id, cwd, command: command.command });
  return { status: 'started' };
}

async function runPluginAction(command, { herdrBin, env, execFile, log, sleep, attempts }) {
  const args = buildPluginActionArgs(command);
  let lastBusy = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await execFile(herdrBin, args, {
        env,
        encoding: 'utf8',
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        shell: false,
      });
      if (typeof log === 'function') await log('plugin_action', { id: command.id, attempt });
      return { status: 'invoked' };
    } catch (error) {
      lastBusy = isUiBusy(error);
      // herdr refuses UI work while a popup owns the screen. The popup process
      // has already exited by the time we get here, but herdr's teardown is not
      // instantaneous — so a bounded retry turns a millisecond race into a
      // reliable invocation instead of a silent no-op.
      if (attempt < attempts && lastBusy) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      if (typeof log === 'function') {
        await log('plugin_action_failed', { id: command.id, attempt, busy: lastBusy });
      }
      throw new ExecutionError(
        `plugin action ${command.command} could not be invoked`,
        { code: lastBusy ? UI_BUSY_CODE : null },
      );
    }
  }
  throw new ExecutionError(`plugin action ${command.command} could not be invoked`, {
    code: lastBusy ? UI_BUSY_CODE : null,
  });
}

export async function executeCommand(command, {
  context,
  herdrBin = 'herdr',
  shell,
  env = process.env,
  spawn,
  execFile,
  log,
  sleep = defaultSleep,
  attempts = DEFAULT_ATTEMPTS,
} = {}) {
  if (typeof spawn !== 'function') throw new TypeError('spawn is required');
  if (typeof execFile !== 'function') throw new TypeError('execFile is required');
  if (command?.type === 'shell') {
    return runShell(command, { context, shell, env, spawn, log });
  }
  if (command?.type === 'plugin_action') {
    return runPluginAction(command, { herdrBin, env, execFile, log, sleep, attempts });
  }
  throw new ExecutionError(`unsupported command type ${JSON.stringify(command?.type)}`);
}
```

- [ ] **Step 12: Run the executor tests**

Run: `node --test test/executor.test.mjs`
Expected: PASS — 14 tests.

- [ ] **Step 13: Run the whole suite**

Run: `npm test`
Expected: PASS — 141 tests total.

- [ ] **Step 14: Commit**

```bash
git add src/logger.mjs src/editor.mjs src/executor.mjs test/logger.test.mjs test/editor.test.mjs test/executor.test.mjs
git commit -m "feat: execute registered commands and log what happened

Shell commands are spawned detached through a login shell in the resolved cwd,
mirroring herdr's own 'type = shell' keybindings, so 'code .' opens the
directory the user was actually looking at and survives the runner exiting.

Plugin actions go through 'herdr plugin action invoke', which herdr resolves
against the live focused pane. That call fails with ui_busy while a popup owns
the screen; the popup process is already gone by the time the runner invokes,
but herdr's teardown is not instantaneous, so a bounded retry turns a
millisecond race into a reliable invocation rather than a silent no-op.

The runner is detached with no terminal, so a JSONL run log is the only way a
failure can explain itself. The logger swallows its own errors: a read-only
state directory must not stop the command the user asked for."
```

---

## Task 9: The detached runner

**Files:**
- Create: `src/wait.mjs`
- Modify: `bin/run.mjs` (replaces the Task 1 placeholder)
- Test: `test/wait.test.mjs`, `test/run.test.mjs`

**Interfaces:**
- Consumes: `src/wait.mjs`, `src/schema.mjs` (`ConfigError`, `normalizeCommand`), `src/executor.mjs` (`executeCommand`), `src/editor.mjs` (`openInEditor`), `src/logger.mjs` (`createLogger`).
- Produces:
  - `src/wait.mjs`: `waitForProcessExit(pid: number, options?: { timeoutMs?: number, intervalMs?: number, kill?: Function, sleep?: Function }): Promise<boolean>` — resolves `true` when the process is gone, `false` on timeout.
  - `bin/run.mjs`: `runPending(deps?: { env?, spawn?, execFile?, waitForExit?, sleep?, createLogger? }): Promise<number>` — exit code `0` on success, `1` on execution failure, `2` on a malformed task.

The runner's contract, and the reason this plugin has a runner at all:

1. Read the task from `COMMAND_CENTER_TASK_JSON` and the popup's pid from `COMMAND_CENTER_POPUP_PID`.
2. Wait for that pid to disappear (bounded at 3s so a wedged popup cannot strand the command forever).
3. Sleep `SETTLE_MS` (120ms) so herdr finishes tearing the popup down and restoring focus.
4. Execute — either the command or "open commands.json in the editor".

Task JSON shape (produced by the popup in Task 10):

```json
{
  "kind": "run",
  "command": { "id": "...", "label": "...", "type": "shell", "command": "code .", "cwd": "focused", "description": "" },
  "context": { "focusedPaneCwd": "/Users/cdragon/repo", "workspaceCwd": "/Users/cdragon" },
  "editor": ["code"],
  "commandsPath": "/Users/cdragon/.config/herdr/plugins/config/cdragon.command-center/commands.json",
  "logPath": "/Users/cdragon/.config/herdr/plugins/config/cdragon.command-center/state/run.log"
}
```

`kind` is `"run"` or `"open-config"`; `command` is required only for `"run"`.

- [ ] **Step 1: Write the failing test `test/wait.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForProcessExit } from '../src/wait.mjs';

test('waitForProcessExit returns true as soon as the process is gone', async () => {
  let probes = 0;
  const exited = await waitForProcessExit(4242, {
    kill: () => {
      probes += 1;
      if (probes >= 3) {
        const error = new Error('no such process');
        error.code = 'ESRCH';
        throw error;
      }
    },
    sleep: async () => {},
    intervalMs: 10,
    timeoutMs: 1_000,
  });
  assert.equal(exited, true);
  assert.equal(probes, 3);
});

test('waitForProcessExit gives up after the timeout', async () => {
  let slept = 0;
  const exited = await waitForProcessExit(4242, {
    kill: () => {},
    sleep: async () => { slept += 1; },
    intervalMs: 25,
    timeoutMs: 100,
  });
  assert.equal(exited, false);
  assert.ok(slept >= 4 && slept <= 6, `slept ${slept} times`);
});

test('waitForProcessExit treats a missing or invalid pid as already exited', async () => {
  for (const pid of [undefined, null, 0, -1, Number.NaN, 1.5]) {
    assert.equal(await waitForProcessExit(pid, {
      kill: () => { throw new Error('kill must not be called'); },
      sleep: async () => {},
    }), true);
  }
});

test('waitForProcessExit really observes a live process ending', async () => {
  const exited = await waitForProcessExit(process.pid, { timeoutMs: 60, intervalMs: 20 });
  assert.equal(exited, false, 'our own process is still alive');
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/wait.test.mjs`
Expected: FAIL — `Cannot find module '.../src/wait.mjs'`.

- [ ] **Step 3: Write `src/wait.mjs`**

```js
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// signal 0 probes for existence without delivering a signal. This is how the
// detached runner knows the popup is really gone before it touches herdr's UI —
// it depends on nothing but the OS process table.
export async function waitForProcessExit(pid, {
  timeoutMs = 3_000,
  intervalMs = 25,
  kill = process.kill.bind(process),
  sleep = defaultSleep,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  let waited = 0;
  for (;;) {
    try {
      kill(pid, 0);
    } catch {
      return true;
    }
    if (waited >= timeoutMs) return false;
    await sleep(intervalMs);
    waited += intervalMs;
  }
}
```

- [ ] **Step 4: Run the wait tests**

Run: `node --test test/wait.test.mjs`
Expected: PASS — 4 tests.

- [ ] **Step 5: Write the failing test `test/run.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { runPending, SETTLE_MS } from '../bin/run.mjs';

const COMMAND = {
  id: 'open-in-vs-code',
  label: 'Open in VS Code',
  type: 'shell',
  command: 'code .',
  cwd: 'focused',
  description: '',
};

function task(overrides = {}) {
  return {
    kind: 'run',
    command: COMMAND,
    context: { focusedPaneCwd: '/Users/cdragon/repo', workspaceCwd: '/Users/cdragon' },
    editor: ['code'],
    commandsPath: '/tmp/cc/commands.json',
    logPath: '/tmp/cc/state/run.log',
    ...overrides,
  };
}

function deps(overrides = {}) {
  const events = [];
  const spawns = [];
  return {
    events,
    spawns,
    options: {
      env: {
        COMMAND_CENTER_TASK_JSON: JSON.stringify(task()),
        COMMAND_CENTER_POPUP_PID: '4242',
        SHELL: '/bin/zsh',
      },
      spawn: (file, args, options) => {
        spawns.push({ file, args, options });
        return { unref: () => {} };
      },
      execFile: async () => ({ stdout: '{}', stderr: '' }),
      waitForExit: async () => true,
      sleep: async () => {},
      createLogger: () => ({ write: async (event, detail) => { events.push([event, detail]); } }),
      ...overrides,
    },
  };
}

test('SETTLE_MS gives herdr time to tear the popup down', () => {
  assert.ok(SETTLE_MS >= 50 && SETTLE_MS <= 500);
});

test('runPending waits for the popup pid before executing', async () => {
  const order = [];
  const { options, spawns } = deps({
    waitForExit: async (pid) => { order.push(`wait:${pid}`); return true; },
    spawn: (file, args, spawnOptions) => { order.push('spawn'); return { unref: () => {} }; },
  });
  const code = await runPending(options);
  assert.equal(code, 0);
  assert.deepEqual(order, ['wait:4242', 'spawn']);
});

test('runPending settles after the popup exits and before it executes', async () => {
  const order = [];
  const { options } = deps({
    waitForExit: async () => { order.push('wait'); return true; },
    sleep: async (ms) => { order.push(`sleep:${ms}`); },
    spawn: () => { order.push('spawn'); return { unref: () => {} }; },
  });
  await runPending(options);
  assert.deepEqual(order, ['wait', `sleep:${SETTLE_MS}`, 'spawn']);
});

test('runPending runs a shell command in the forwarded cwd', async () => {
  const { options, spawns } = deps();
  assert.equal(await runPending(options), 0);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, '/bin/zsh');
  assert.deepEqual(spawns[0].args, ['-lc', 'code .']);
  assert.equal(spawns[0].options.cwd, '/Users/cdragon/repo');
});

test('runPending invokes a plugin action through the herdr CLI', async () => {
  const calls = [];
  const { options } = deps({
    env: {
      COMMAND_CENTER_TASK_JSON: JSON.stringify(task({
        command: { ...COMMAND, id: 'fx', type: 'plugin_action', command: 'ray.file-explorer.open' },
      })),
      COMMAND_CENTER_POPUP_PID: '4242',
      HERDR_BIN_PATH: '/opt/homebrew/bin/herdr',
    },
    execFile: async (bin, args) => { calls.push({ bin, args }); return { stdout: '{}', stderr: '' }; },
  });
  assert.equal(await runPending(options), 0);
  assert.deepEqual(calls, [{
    bin: '/opt/homebrew/bin/herdr',
    args: ['plugin', 'action', 'invoke', 'open', '--plugin', 'ray.file-explorer'],
  }]);
});

test('runPending opens the config file for an open-config task', async () => {
  const { options, spawns } = deps({
    env: {
      COMMAND_CENTER_TASK_JSON: JSON.stringify(task({ kind: 'open-config', command: undefined })),
      COMMAND_CENTER_POPUP_PID: '4242',
    },
  });
  assert.equal(await runPending(options), 0);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, 'code');
  assert.deepEqual(spawns[0].args, ['/tmp/cc/commands.json']);
});

test('runPending waits for the popup before opening the editor too', async () => {
  const order = [];
  const { options } = deps({
    env: {
      COMMAND_CENTER_TASK_JSON: JSON.stringify(task({ kind: 'open-config', command: undefined })),
      COMMAND_CENTER_POPUP_PID: '4242',
    },
    waitForExit: async () => { order.push('wait'); return true; },
    spawn: () => { order.push('spawn'); return { unref: () => {} }; },
  });
  await runPending(options);
  assert.deepEqual(order, ['wait', 'spawn']);
});

test('runPending executes even when the popup outlives the wait timeout', async () => {
  const { options, spawns, events } = deps({ waitForExit: async () => false });
  assert.equal(await runPending(options), 0);
  assert.equal(spawns.length, 1);
  assert.deepEqual(events[0], ['popup-closed', { exited: false }]);
});

test('runPending logs the popup-closed observation first', async () => {
  const { options, events } = deps();
  await runPending(options);
  assert.deepEqual(events[0], ['popup-closed', { exited: true }]);
});

test('runPending returns 2 for a missing or malformed task', async () => {
  for (const value of [undefined, '', 'not json', '[]', 'null', JSON.stringify({ kind: 'nope' })]) {
    const { options, spawns } = deps({
      env: { COMMAND_CENTER_TASK_JSON: value, COMMAND_CENTER_POPUP_PID: '4242' },
    });
    assert.equal(await runPending(options), 2, JSON.stringify(value));
    assert.equal(spawns.length, 0);
  }
});

test('runPending returns 2 when a run task has no valid command', async () => {
  for (const command of [undefined, {}, { label: 'a', type: 'nope', command: 'b' }]) {
    const { options } = deps({
      env: {
        COMMAND_CENTER_TASK_JSON: JSON.stringify(task({ command })),
        COMMAND_CENTER_POPUP_PID: '4242',
      },
    });
    assert.equal(await runPending(options), 2);
  }
});

test('runPending returns 2 when the paths or editor are unusable', async () => {
  for (const overrides of [
    { commandsPath: 'relative/commands.json' },
    { logPath: 'relative/run.log' },
    { editor: [] },
    { editor: 'code' },
  ]) {
    const { options } = deps({
      env: {
        COMMAND_CENTER_TASK_JSON: JSON.stringify(task(overrides)),
        COMMAND_CENTER_POPUP_PID: '4242',
      },
    });
    assert.equal(await runPending(options), 2, JSON.stringify(overrides));
  }
});

test('runPending returns 1 and logs when execution fails', async () => {
  const { options, events } = deps({
    spawn: () => { throw new Error('ENOENT'); },
  });
  assert.equal(await runPending(options), 1);
  assert.equal(events.at(-1)[0], 'failed');
  assert.match(events.at(-1)[1].message, /ENOENT/u);
});

test('runPending tolerates a missing popup pid', async () => {
  const { options, spawns } = deps({
    env: { COMMAND_CENTER_TASK_JSON: JSON.stringify(task()) },
    waitForExit: async (pid) => {
      assert.equal(pid, 0);
      return true;
    },
  });
  assert.equal(await runPending(options), 0);
  assert.equal(spawns.length, 1);
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `node --test test/run.test.mjs`
Expected: FAIL — `SETTLE_MS` and `runPending` are not exported from the placeholder `bin/run.mjs`.

- [ ] **Step 7: Write `bin/run.mjs`**

```js
#!/usr/bin/env node

// The detached half of Command Center. The popup spawns this, then exits, which
// is what closes the popup. Everything here happens after the popup is gone —
// which is the whole point: `herdr plugin action invoke` resolves the focused
// pane server-side and refuses UI work while a popup owns the screen.

import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { openInEditor } from '../src/editor.mjs';
import { executeCommand } from '../src/executor.mjs';
import { createLogger as createDefaultLogger } from '../src/logger.mjs';
import { ConfigError, normalizeCommand } from '../src/schema.mjs';
import { waitForProcessExit } from '../src/wait.mjs';

const execFileAsync = promisify(execFileCallback);

export const SETTLE_MS = 120;
const MAX_TASK_BYTES = 64_000;
const TASK_KINDS = new Set(['run', 'open-config']);

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function usablePath(value) {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value) && !value.includes('\u0000');
}

function parseTask(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_TASK_BYTES) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!TASK_KINDS.has(value.kind)) return null;
  if (!usablePath(value.commandsPath) || !usablePath(value.logPath)) return null;
  if (
    !Array.isArray(value.editor)
    || value.editor.length === 0
    || value.editor.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    return null;
  }
  const context = value.context && typeof value.context === 'object' && !Array.isArray(value.context)
    ? value.context
    : {};
  if (value.kind === 'open-config') {
    return { ...value, context, command: null };
  }
  let command;
  try {
    command = normalizeCommand(value.command);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return null;
  }
  return { ...value, context, command };
}

export async function runPending({
  env = process.env,
  spawn = spawnChild,
  execFile = execFileAsync,
  waitForExit = waitForProcessExit,
  sleep = defaultSleep,
  createLogger = createDefaultLogger,
} = {}) {
  const task = parseTask(env.COMMAND_CENTER_TASK_JSON);
  if (!task) return 2;
  const logger = createLogger(task.logPath);

  const popupPid = Number.parseInt(env.COMMAND_CENTER_POPUP_PID ?? '', 10);
  const exited = await waitForExit(Number.isSafeInteger(popupPid) ? popupPid : 0, { sleep });
  await logger.write('popup-closed', { exited });
  // Even if the popup somehow outlived the wait, go ahead: the ui_busy retry in
  // the executor is the second line of defence, and refusing to run would leave
  // the user's keypress with no visible result at all.
  await sleep(SETTLE_MS);

  try {
    if (task.kind === 'open-config') {
      await openInEditor(task.commandsPath, {
        editor: task.editor,
        spawn,
        env,
        log: logger.write,
      });
      return 0;
    }
    await executeCommand(task.command, {
      context: task.context,
      herdrBin: env.HERDR_BIN_PATH || 'herdr',
      shell: env.SHELL,
      env,
      spawn,
      execFile,
      log: logger.write,
      sleep,
    });
    return 0;
  } catch (error) {
    await logger.write('failed', { message: error?.message ?? 'unknown failure' });
    return 1;
  }
}

async function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await invokedAsMain()) {
  process.exitCode = await runPending();
}
```

- [ ] **Step 8: Run the run tests**

Run: `node --test test/run.test.mjs`
Expected: PASS — 14 tests.

- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: PASS — 159 tests total.

- [ ] **Step 10: Commit**

```bash
git add src/wait.mjs bin/run.mjs test/wait.test.mjs test/run.test.mjs
git commit -m "feat: add the detached runner that executes after the popup closes

This is the piece that makes 'the popup must close before the command runs' an
enforced property rather than a hope. The popup spawns this runner detached and
then exits — its own exit is what closes the popup — and the runner blocks on
the popup pid disappearing (probed with signal 0, so it depends on nothing but
the OS process table) before touching anything.

After the pid is gone it still sleeps 120ms, because herdr's popup teardown and
focus restoration are not instantaneous and 'herdr plugin action invoke'
resolves the focused pane server-side. The wait is bounded at 3s and a timeout
does not abort the run: the executor's ui_busy retry is the second line of
defence, and refusing to run would leave the user's keypress with no result.

A malformed task exits 2 without executing anything, so a corrupted env handoff
can never spawn something unintended."
```

---

## Task 10: The popup entrypoint

**Files:**
- Modify: `bin/popup.mjs` (replaces the Task 1 placeholder)
- Create: `test/helpers/fake-tty.mjs`
- Test: `test/popup.test.mjs`

**Interfaces:**
- Consumes: `src/paths.mjs` (`commandsPath`, `resolveConfigDir`, `resolveStateDir`, `runLogPath`), `src/store.mjs` (`ensureStore`, `saveStore`), `src/schema.mjs` (`ConfigError`, `DEFAULT_EDITOR`), `src/context.mjs` (`readContext`, `serializeContext`), `src/keys.mjs` (`createKeyDecoder`), `src/view.mjs` (`createView`, `reduceKey`), `src/render.mjs` (`renderView`).
- Produces: `bin/popup.mjs` exporting `runPopup(deps?): Promise<number>`.

Exit codes: `0` normal close (including after handing a task to the runner), `1` input ended unexpectedly or a runtime failure, `2` no interactive terminal or the config directory could not be resolved, `130`/`143`/`129`/`131` for SIGINT/SIGTERM/SIGHUP/SIGQUIT.

The one invariant this file exists to hold: **it never executes a command.** On a `run` or `open-config` effect it spawns the detached runner and returns, and its own return is what closes the popup.

- [ ] **Step 1: Write `test/helpers/fake-tty.mjs`**

```js
// Minimal stand-ins for a raw-mode TTY pair, so the popup loop can be driven
// key-by-key from a test without a real terminal.

export function createFakeStdin(chunks = [], { endAfterQueue = true } = {}) {
  const queue = [...chunks];
  const listeners = new Map();
  let finished = false;
  let pending = null;

  const settle = (result) => {
    const resolve = pending;
    pending = null;
    resolve(result);
  };

  return {
    isTTY: true,
    rawModeHistory: [],
    destroyed: false,
    setRawMode(value) {
      this.rawModeHistory.push(value);
      return this;
    },
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    removeListener(event) {
      listeners.delete(event);
      return this;
    },
    emit(event, payload) {
      listeners.get(event)?.(payload);
    },
    destroy() {
      this.destroyed = true;
      finished = true;
      if (pending) settle({ value: undefined, done: true });
    },
    push(chunk) {
      if (pending) settle({ value: Buffer.from(chunk), done: false });
      else queue.push(chunk);
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (queue.length > 0) {
            return Promise.resolve({ value: Buffer.from(queue.shift()), done: false });
          }
          if (finished || endAfterQueue) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { pending = resolve; });
        },
        return: () => {
          finished = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

export function createFakeStdout({ columns = 78, rows = 24 } = {}) {
  const frames = [];
  return {
    isTTY: true,
    columns,
    rows,
    frames,
    write(text, callback) {
      frames.push(String(text));
      if (typeof callback === 'function') callback(null);
      return true;
    },
    on() { return this; },
    removeListener() { return this; },
    get lastFrame() { return frames.at(-1) ?? ''; },
  };
}

export function createFakeStderr() {
  const lines = [];
  return {
    lines,
    write(text) { lines.push(String(text)); return true; },
    on() { return this; },
    removeListener() { return this; },
  };
}

export function createFakeProcess(pid = 4242) {
  const handlers = [];
  return {
    pid,
    handlers,
    once(event, handler) { handlers.push([event, handler]); return this; },
    on(event, handler) { handlers.push([event, handler]); return this; },
    removeListener(event, handler) {
      const index = handlers.findIndex(([name, fn]) => name === event && fn === handler);
      if (index >= 0) handlers.splice(index, 1);
      return this;
    },
    fire(event) {
      for (const [name, handler] of [...handlers]) if (name === event) handler();
    },
  };
}
```

- [ ] **Step 2: Write the failing test `test/popup.test.mjs`**

```js
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPopup } from '../bin/popup.mjs';
import { defaultConfig, serializeConfig } from '../src/schema.mjs';
import {
  createFakeProcess,
  createFakeStderr,
  createFakeStdin,
  createFakeStdout,
} from './helpers/fake-tty.mjs';

const CONTEXT = { focusedPaneCwd: '/Users/cdragon/repo', workspaceCwd: '/Users/cdragon' };

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-popup-'));
  return { dir, file: join(dir, 'commands.json') };
}

async function harness(keys, { dir, extraEnv = {}, size } = {}) {
  const spawns = [];
  const stdin = createFakeStdin(keys);
  const stdout = createFakeStdout(size);
  const stderr = createFakeStderr();
  const processRef = createFakeProcess(4242);
  const code = await runPopup({
    env: {
      HERDR_PLUGIN_CONFIG_DIR: dir,
      HERDR_PLUGIN_STATE_DIR: join(dir, 'state'),
      COMMAND_CENTER_CONTEXT_JSON: JSON.stringify(CONTEXT),
      HERDR_BIN_PATH: '/opt/homebrew/bin/herdr',
      TERM: 'xterm-256color',
      ...extraEnv,
    },
    stdin,
    stdout,
    stderr,
    processRef,
    execPath: '/usr/local/bin/node',
    spawn: (file, args, options) => {
      spawns.push({ file, args, options });
      return { unref: () => {} };
    },
    execFile: async () => { throw new Error('execFile must not be called; the config dir is in env'); },
  });
  return { code, spawns, stdin, stdout, stderr, processRef };
}

function taskFrom(spawn) {
  return JSON.parse(spawn.options.env.COMMAND_CENTER_TASK_JSON);
}

test('runPopup refuses to run without an interactive terminal', async () => {
  const stderr = createFakeStderr();
  const code = await runPopup({
    env: {},
    stdin: { isTTY: false },
    stdout: createFakeStdout(),
    stderr,
    processRef: createFakeProcess(),
    spawn: () => { throw new Error('must not spawn'); },
    execFile: async () => {},
  });
  assert.equal(code, 2);
  assert.match(stderr.lines.join(''), /command-center: an interactive terminal is required/u);
});

test('runPopup exits 2 when the config directory cannot be resolved', async () => {
  const stderr = createFakeStderr();
  const code = await runPopup({
    env: {},
    stdin: createFakeStdin([]),
    stdout: createFakeStdout(),
    stderr,
    processRef: createFakeProcess(),
    spawn: () => { throw new Error('must not spawn'); },
    execFile: async () => { throw new Error('socket down'); },
  });
  assert.equal(code, 2);
  assert.match(stderr.lines.join(''), /config directory/u);
});

test('runPopup seeds commands.json on first open and draws the list', async () => {
  const { dir, file } = await scratch();
  const { code, stdout } = await harness(['\u001b'], { dir });
  assert.equal(code, 0);
  assert.equal(await readFile(file, 'utf8'), serializeConfig(defaultConfig()));
  assert.match(stdout.lastFrame, /Command Center · 3 commands/u);
  assert.match(stdout.lastFrame, /1\. Open in VS Code/u);
});

test('runPopup enters and restores raw mode', async () => {
  const { dir } = await scratch();
  const { stdin } = await harness(['\u001b'], { dir });
  assert.deepEqual(stdin.rawModeHistory, [true, false]);
});

test('runPopup clears the screen before each frame', async () => {
  const { dir } = await scratch();
  const { stdout } = await harness(['\u001b[B', '\u001b'], { dir });
  assert.ok(stdout.frames.length >= 2);
  for (const frame of stdout.frames) assert.ok(frame.startsWith('\u001b[2J\u001b[H'), frame.slice(0, 12));
});

test('escape closes without spawning anything', async () => {
  const { dir } = await scratch();
  const { code, spawns } = await harness(['\u001b'], { dir });
  assert.equal(code, 0);
  assert.deepEqual(spawns, []);
});

test('enter hands the selected command to the detached runner and returns', async () => {
  const { dir } = await scratch();
  const { code, spawns } = await harness(['\r'], { dir });
  assert.equal(code, 0);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, '/usr/local/bin/node');
  assert.equal(spawns[0].args.length, 1);
  assert.match(spawns[0].args[0], /bin\/run\.mjs$/u);
  assert.equal(spawns[0].options.detached, true);
  assert.equal(spawns[0].options.stdio, 'ignore');
  assert.equal(spawns[0].options.shell, false);
});

test('the runner task carries the command, context, editor, and both paths', async () => {
  const { dir, file } = await scratch();
  const { spawns } = await harness(['\r'], { dir });
  const task = taskFrom(spawns[0]);
  assert.equal(task.kind, 'run');
  assert.equal(task.command.id, 'open-in-vs-code');
  assert.equal(task.command.command, 'code .');
  assert.deepEqual(task.context, CONTEXT);
  assert.deepEqual(task.editor, ['code']);
  assert.equal(task.commandsPath, file);
  assert.equal(task.logPath, join(dir, 'state', 'run.log'));
});

test('the runner env carries the popup pid so the runner can wait for it', async () => {
  const { dir } = await scratch();
  const { spawns } = await harness(['\r'], { dir });
  assert.equal(spawns[0].options.env.COMMAND_CENTER_POPUP_PID, '4242');
});

test('the popup never executes the command itself', async () => {
  const { dir } = await scratch();
  const { spawns } = await harness(['\r'], { dir });
  assert.equal(spawns.length, 1, 'exactly one spawn: the runner');
  assert.ok(!spawns[0].args.join(' ').includes('code .'));
});

test('a digit hands the badged command to the runner', async () => {
  const { dir } = await scratch();
  const { code, spawns } = await harness(['3'], { dir });
  assert.equal(code, 0);
  assert.equal(taskFrom(spawns[0]).command.id, 'open-pull-request');
});

test('o hands an open-config task to the runner', async () => {
  const { dir, file } = await scratch();
  const { code, spawns } = await harness(['o'], { dir });
  assert.equal(code, 0);
  const task = taskFrom(spawns[0]);
  assert.equal(task.kind, 'open-config');
  assert.equal(task.command, undefined);
  assert.equal(task.commandsPath, file);
  assert.deepEqual(task.editor, ['code']);
});

test('o forwards a custom editor from commands.json', async () => {
  const { dir, file } = await scratch();
  await writeFile(file, serializeConfig({
    schema_version: 1,
    editor: ['code', '--new-window'],
    commands: [],
  }), 'utf8');
  const { spawns } = await harness(['o'], { dir });
  assert.deepEqual(taskFrom(spawns[0]).editor, ['code', '--new-window']);
});

test('adding a command writes commands.json and keeps the popup open', async () => {
  const { dir, file } = await scratch();
  const { code, spawns, stdout } = await harness(['a', 'Tidy', '\t\t', 'ls', '\r', '\u001b'], { dir });
  assert.equal(code, 0);
  assert.deepEqual(spawns, [], 'saving must not spawn the runner');
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.commands.length, 4);
  assert.deepEqual(written.commands[3], {
    id: 'tidy', label: 'Tidy', type: 'shell', command: 'ls', cwd: 'focused', description: '',
  });
  assert.match(stdout.lastFrame, /4 commands/u);
});

test('a saved command is immediately runnable in the same session', async () => {
  const { dir } = await scratch();
  const { spawns } = await harness(['a', 'Tidy', '\t\t', 'ls', '\r', '4'], { dir });
  assert.equal(spawns.length, 1);
  assert.equal(taskFrom(spawns[0]).command.id, 'tidy');
});

test('deleting a command rewrites commands.json', async () => {
  const { dir, file } = await scratch();
  const { code } = await harness(['d', 'y', '\u001b'], { dir });
  assert.equal(code, 0);
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(written.commands.map((command) => command.id), [
    'open-repo-on-github',
    'open-pull-request',
  ]);
});

test('editing a command rewrites it in place', async () => {
  const { dir, file } = await scratch();
  const { code } = await harness(['e', '\u007f\u007f\u007f\u007f', 'Kod', '\r', '\u001b'], { dir });
  assert.equal(code, 0);
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.commands[0].id, 'open-in-vs-code');
  assert.match(written.commands[0].label, /Kod$/u);
});

test('an invalid commands.json opens in error mode and still offers the editor', async () => {
  const { dir, file } = await scratch();
  await writeFile(file, '{ broken', 'utf8');
  const { code, spawns, stdout } = await harness(['o'], { dir });
  assert.equal(code, 0);
  assert.match(stdout.frames[0], /config error/u);
  assert.match(stdout.frames[0], /not valid JSON/u);
  assert.equal(taskFrom(spawns[0]).kind, 'open-config');
  assert.deepEqual(taskFrom(spawns[0]).editor, ['code']);
});

test('an invalid commands.json is never overwritten by the popup', async () => {
  const { dir, file } = await scratch();
  await writeFile(file, '{ broken', 'utf8');
  await harness(['a', 'X', '\r', '\u001b'], { dir });
  assert.equal(await readFile(file, 'utf8'), '{ broken');
});

test('a save that collides with an external edit switches to error mode', async () => {
  const { dir, file } = await scratch();
  const stdin = createFakeStdin(['a'], { endAfterQueue: false });
  const stdout = createFakeStdout();
  const pending = runPopup({
    env: {
      HERDR_PLUGIN_CONFIG_DIR: dir,
      HERDR_PLUGIN_STATE_DIR: join(dir, 'state'),
      TERM: 'xterm-256color',
    },
    stdin,
    stdout,
    stderr: createFakeStderr(),
    processRef: createFakeProcess(),
    execPath: '/usr/local/bin/node',
    spawn: () => ({ unref: () => {} }),
    execFile: async () => {},
  });
  // Let the popup finish loading and enter the form, then edit the file behind it.
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  await writeFile(file, serializeConfig({ schema_version: 1, editor: ['code'], commands: [] }), 'utf8');
  stdin.push('Tidy\t\tls\r');
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  stdin.push('\u001b');
  assert.equal(await pending, 0);
  assert.match(stdout.lastFrame, /changed on disk/u);
});

test('NO_COLOR and TERM=dumb turn styling off', async () => {
  const { dir } = await scratch();
  const plain = await harness(['\u001b'], { dir, extraEnv: { NO_COLOR: '1' } });
  assert.ok(!plain.stdout.lastFrame.slice(7).includes('\u001b['));
  const dumb = await harness(['\u001b'], { dir, extraEnv: { TERM: 'dumb' } });
  assert.ok(!dumb.stdout.lastFrame.slice(7).includes('\u001b['));
});

test('styling is on for a capable terminal', async () => {
  const { dir } = await scratch();
  const { stdout } = await harness(['\u001b'], { dir });
  assert.ok(stdout.lastFrame.slice(7).includes('\u001b['));
});

test('input ending without a decision exits 1 and restores the terminal', async () => {
  const { dir } = await scratch();
  const { code, spawns, stdin } = await harness([], { dir });
  assert.equal(code, 1);
  assert.deepEqual(spawns, []);
  assert.deepEqual(stdin.rawModeHistory, [true, false]);
});

test('SIGTERM stops the popup with the conventional code', async () => {
  const { dir } = await scratch();
  const stdin = createFakeStdin([], { endAfterQueue: false });
  const processRef = createFakeProcess();
  const pending = runPopup({
    env: {
      HERDR_PLUGIN_CONFIG_DIR: dir,
      HERDR_PLUGIN_STATE_DIR: join(dir, 'state'),
      TERM: 'xterm-256color',
    },
    stdin,
    stdout: createFakeStdout(),
    stderr: createFakeStderr(),
    processRef,
    execPath: '/usr/local/bin/node',
    spawn: () => ({ unref: () => {} }),
    execFile: async () => {},
  });
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  processRef.fire('SIGTERM');
  assert.equal(await pending, 143);
  assert.deepEqual(stdin.rawModeHistory, [true, false]);
  assert.equal(stdin.destroyed, true);
});

test('the popup deregisters its process listeners on the way out', async () => {
  const { dir } = await scratch();
  const { processRef } = await harness(['\u001b'], { dir });
  assert.deepEqual(processRef.handlers, []);
});

test('a resize redraws at the new size', async () => {
  const { dir } = await scratch();
  const stdin = createFakeStdin([], { endAfterQueue: false });
  const stdout = createFakeStdout({ columns: 78, rows: 24 });
  const processRef = createFakeProcess();
  const pending = runPopup({
    env: {
      HERDR_PLUGIN_CONFIG_DIR: dir,
      HERDR_PLUGIN_STATE_DIR: join(dir, 'state'),
      TERM: 'xterm-256color',
    },
    stdin,
    stdout,
    stderr: createFakeStderr(),
    processRef,
    execPath: '/usr/local/bin/node',
    spawn: () => ({ unref: () => {} }),
    execFile: async () => {},
  });
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  const before = stdout.frames.length;
  stdout.columns = 40;
  stdout.rows = 12;
  processRef.fire('SIGWINCH');
  assert.ok(stdout.frames.length > before);
  assert.equal(stdout.lastFrame.split('\n').length, 12);
  stdin.push('\u001b');
  assert.equal(await pending, 0);
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `node --test test/popup.test.mjs`
Expected: FAIL — `runPopup` is not exported from the placeholder `bin/popup.mjs`.

- [ ] **Step 4: Write `bin/popup.mjs`**

```js
#!/usr/bin/env node

// The interactive half of Command Center. It reads keys, renders frames, and
// persists commands.json — but it never runs a command. On a run/open-config
// effect it spawns bin/run.mjs detached and returns; its own exit is what closes
// the herdr popup, which is precisely the ordering the runner then depends on.

import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readContext } from '../src/context.mjs';
import { createKeyDecoder } from '../src/keys.mjs';
import { commandsPath, resolveConfigDir, resolveStateDir, runLogPath } from '../src/paths.mjs';
import { renderView } from '../src/render.mjs';
import { ConfigError, DEFAULT_EDITOR } from '../src/schema.mjs';
import { ensureStore, saveStore } from '../src/store.mjs';
import { createView, reduceKey } from '../src/view.mjs';

const execFileAsync = promisify(execFileCallback);

const CLEAR_SCREEN = '\u001b[2J\u001b[H';
const RUNNER_URL = new URL('./run.mjs', import.meta.url);
const SIGNAL_EXIT_CODES = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
  SIGQUIT: 131,
});

function diagnostic(stderr, message) {
  try {
    stderr.write(`command-center: ${message}\n`);
  } catch {
    // Never let a diagnostic keep the terminal in raw mode.
  }
}

function screenSize(stdout, color) {
  return {
    columns: Number.isFinite(stdout.columns) ? stdout.columns : 78,
    rows: Number.isFinite(stdout.rows) ? stdout.rows : 24,
    color,
  };
}

export async function runPopup({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  processRef = process,
  spawn = spawnChild,
  execFile = execFileAsync,
  execPath = process.execPath,
} = {}) {
  if (!stdin?.isTTY || !stdout?.isTTY || typeof stdin.setRawMode !== 'function') {
    diagnostic(stderr, 'an interactive terminal is required');
    return 2;
  }

  let configDir;
  try {
    configDir = await resolveConfigDir(env, execFile);
  } catch (error) {
    diagnostic(stderr, error?.message ?? 'the plugin config directory could not be resolved');
    return 2;
  }
  const commandsFile = commandsPath(configDir);
  const logFile = runLogPath(resolveStateDir(configDir, env));
  const context = readContext(env);
  const useColor = !env.NO_COLOR && env.TERM !== 'dumb';

  let view;
  let raw = null;
  try {
    const loaded = await ensureStore(commandsFile);
    view = createView({ doc: loaded.doc });
    raw = loaded.raw;
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      diagnostic(stderr, 'commands.json could not be opened');
      return 1;
    }
    // A broken config must still give the user a way to fix it, so keep a
    // minimal usable doc (for `editor`) and show the reason.
    view = createView({
      doc: { schema_version: 1, editor: [...DEFAULT_EDITOR], commands: [] },
      error: error.message,
    });
  }

  let rawMode = false;
  let stopCode = null;
  const restoreRaw = () => {
    if (!rawMode) return;
    rawMode = false;
    try {
      stdin.setRawMode(false);
    } catch {
      // The terminal may already be detached.
    }
  };
  const draw = () => {
    try {
      stdout.write(`${CLEAR_SCREEN}${renderView(view, screenSize(stdout, useColor))}`);
    } catch {
      requestStop(1);
    }
  };
  function requestStop(code) {
    if (stopCode !== null) return;
    stopCode = code;
    restoreRaw();
    try {
      stdin.destroy?.();
    } catch {
      // The iterator will finish on its own.
    }
  }
  const signalHandlers = Object.entries(SIGNAL_EXIT_CODES)
    .map(([signal, code]) => [signal, () => requestStop(code)]);
  const onResize = () => draw();
  const onStreamError = () => requestStop(1);

  const spawnRunner = (task) => {
    const child = spawn(execPath, [fileURLToPath(RUNNER_URL)], {
      detached: true,
      stdio: 'ignore',
      shell: false,
      env: {
        ...env,
        COMMAND_CENTER_TASK_JSON: JSON.stringify({
          ...task,
          context,
          editor: view.doc.editor,
          commandsPath: commandsFile,
          logPath: logFile,
        }),
        COMMAND_CENTER_POPUP_PID: String(processRef.pid),
      },
    });
    child?.unref?.();
  };

  try {
    for (const [signal, handler] of signalHandlers) processRef.once(signal, handler);
    processRef.on('SIGWINCH', onResize);
    stdout.on?.('resize', onResize);
    stdin.on?.('error', onStreamError);
    stdout.on?.('error', onStreamError);
    stdin.setRawMode(true);
    rawMode = true;

    const decoder = createKeyDecoder();
    draw();

    for await (const chunk of stdin) {
      if (stopCode !== null) break;
      for (const key of decoder.push(chunk)) {
        view = reduceKey(view, key);
        const { effect } = view;
        if (!effect) {
          draw();
          continue;
        }
        if (effect.type === 'close') return 0;
        if (effect.type === 'run') {
          spawnRunner({ kind: 'run', command: effect.command });
          return 0;
        }
        if (effect.type === 'open-config') {
          spawnRunner({ kind: 'open-config' });
          return 0;
        }
        if (effect.type === 'save') {
          try {
            const saved = await saveStore(commandsFile, effect.doc, { expectedRaw: raw });
            raw = saved.raw;
            view = createView({ doc: effect.doc, cursor: effect.cursor });
          } catch (error) {
            if (!(error instanceof ConfigError)) throw error;
            view = createView({ doc: effect.doc, error: error.message });
          }
          draw();
        }
      }
    }
    if (stopCode !== null) return stopCode;
    diagnostic(stderr, 'terminal input ended before a command was chosen');
    return 1;
  } catch {
    diagnostic(stderr, 'the popup closed after an internal failure');
    return stopCode ?? 1;
  } finally {
    restoreRaw();
    for (const [signal, handler] of signalHandlers) processRef.removeListener?.(signal, handler);
    processRef.removeListener?.('SIGWINCH', onResize);
    stdout.removeListener?.('resize', onResize);
    stdin.removeListener?.('error', onStreamError);
    stdout.removeListener?.('error', onStreamError);
  }
}

async function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await invokedAsMain()) {
  process.exitCode = await runPopup();
}
```

- [ ] **Step 5: Run the popup tests**

Run: `node --test test/popup.test.mjs`
Expected: PASS — 26 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS — 185 tests total.

- [ ] **Step 7: Commit**

```bash
git add bin/popup.mjs test/popup.test.mjs test/helpers/fake-tty.mjs
git commit -m "feat: add the Command Center popup entrypoint

The popup owns the terminal — raw mode, frames, resize, signals — and owns
writes to commands.json, but deliberately owns no execution. A run or
open-config effect spawns bin/run.mjs detached with the command, the forwarded
herdr context, the editor argv, both file paths, and the popup's own pid, and
then returns; that return is what closes the herdr popup, and the pid is how the
runner knows when the close has actually happened.

A commands.json that fails to load opens the popup in error mode with the reason
and the 'o' key still working, so a hand-edit typo is fixable from the popup
that just failed to read it, and the broken file is never overwritten.

Tested against a fake TTY pair so the whole keyboard-to-spawn path — including
raw-mode restoration, SIGTERM, resize, and the save-conflict path — is covered
without a real terminal."
```

---

## Task 11: The herdr actions

**Files:**
- Modify: `bin/open.mjs`, `bin/edit-config.mjs` (replace the Task 1 placeholders)
- Test: `test/actions.test.mjs`

**Interfaces:**
- Consumes: `src/plugin.mjs` (`PLUGIN_ID`, `POPUP_ENTRYPOINT_ID`), `src/context.mjs` (`readContext`, `serializeContext`), `src/paths.mjs` (`commandsPath`, `resolveConfigDir`, `resolveStateDir`, `runLogPath`), `src/store.mjs` (`loadStore`), `src/schema.mjs` (`DEFAULT_EDITOR`), `src/editor.mjs` (`openInEditor`), `src/logger.mjs` (`createLogger`).
- Produces:
  - `bin/open.mjs`: `openPalette(deps?: { env?, execFile?, stderr? }): Promise<number>`
  - `bin/edit-config.mjs`: `editConfig(deps?: { env?, execFile?, spawn?, stderr?, createLogger? }): Promise<number>`

`openPalette` is what the user's keybinding invokes. Its whole job is to capture the invocation context herdr gave *the action* — where the user actually was — and forward it into the popup, because the popup itself will be the focused pane by the time it starts.

- [ ] **Step 1: Write the failing test `test/actions.test.mjs`**

```js
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { editConfig } from '../bin/edit-config.mjs';
import { openPalette } from '../bin/open.mjs';
import { serializeConfig } from '../src/schema.mjs';

function stderrSink() {
  const lines = [];
  return { lines, write(text) { lines.push(String(text)); return true; } };
}

test('openPalette opens the popup pane for this plugin', async () => {
  const calls = [];
  const code = await openPalette({
    env: { HERDR_BIN_PATH: '/opt/homebrew/bin/herdr' },
    execFile: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '{"result":{"type":"plugin_pane_opened"}}', stderr: '' };
    },
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/opt/homebrew/bin/herdr');
  const args = calls[0].args;
  assert.equal(args[0], 'plugin');
  assert.equal(args[1], 'pane');
  assert.equal(args[2], 'open');
  assert.ok(args.includes('--plugin'));
  assert.equal(args[args.indexOf('--plugin') + 1], 'cdragon.command-center');
  assert.equal(args[args.indexOf('--entrypoint') + 1], 'palette');
  assert.equal(args[args.indexOf('--placement') + 1], 'popup');
  assert.ok(args.includes('--focus'));
});

test('openPalette forwards the action invocation context into the popup', async () => {
  let args = null;
  await openPalette({
    env: {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        focused_pane_cwd: '/Users/cdragon/repo',
        workspace_cwd: '/Users/cdragon',
        focused_pane_id: 'wE:p3',
      }),
    },
    execFile: async (bin, callArgs) => {
      args = callArgs;
      return { stdout: '{}', stderr: '' };
    },
  });
  const envArg = args[args.indexOf('--env') + 1];
  assert.match(envArg, /^COMMAND_CENTER_CONTEXT_JSON=/u);
  assert.deepEqual(JSON.parse(envArg.slice('COMMAND_CENTER_CONTEXT_JSON='.length)), {
    focusedPaneCwd: '/Users/cdragon/repo',
    workspaceCwd: '/Users/cdragon',
  });
});

test('openPalette still opens when there is no context to forward', async () => {
  let args = null;
  const code = await openPalette({
    env: {},
    execFile: async (bin, callArgs) => {
      args = callArgs;
      return { stdout: '{}', stderr: '' };
    },
  });
  assert.equal(code, 0);
  const envArg = args[args.indexOf('--env') + 1];
  assert.deepEqual(JSON.parse(envArg.slice('COMMAND_CENTER_CONTEXT_JSON='.length)), {
    focusedPaneCwd: null,
    workspaceCwd: null,
  });
});

test('openPalette reports a refused popup instead of failing silently', async () => {
  const stderr = stderrSink();
  const code = await openPalette({
    env: {},
    stderr,
    execFile: async () => {
      const error = new Error('exit 1');
      error.stdout = JSON.stringify({ error: { code: 'ui_busy', message: 'a popup is already open' } });
      throw error;
    },
  });
  assert.equal(code, 1);
  assert.match(stderr.lines.join(''), /command-center:/u);
  assert.match(stderr.lines.join(''), /ui_busy/u);
});

test('openPalette reports a generic failure', async () => {
  const stderr = stderrSink();
  const code = await openPalette({
    env: {},
    stderr,
    execFile: async () => { throw new Error('socket down'); },
  });
  assert.equal(code, 1);
  assert.match(stderr.lines.join(''), /could not be opened/u);
});

test('editConfig opens commands.json with the configured editor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-action-'));
  await writeFile(join(dir, 'commands.json'), serializeConfig({
    schema_version: 1,
    editor: ['code', '-g'],
    commands: [],
  }), 'utf8');
  const spawns = [];
  const code = await editConfig({
    env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: join(dir, 'state') },
    execFile: async () => { throw new Error('execFile must not be needed'); },
    spawn: (file, args, options) => {
      spawns.push({ file, args, options });
      return { unref: () => {} };
    },
  });
  assert.equal(code, 0);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, 'code');
  assert.deepEqual(spawns[0].args, ['-g', join(dir, 'commands.json')]);
  assert.equal(spawns[0].options.detached, true);
});

test('editConfig seeds nothing but still opens a file that does not exist yet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-action-'));
  const spawns = [];
  const code = await editConfig({
    env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: join(dir, 'state') },
    execFile: async () => {},
    spawn: (file, args) => {
      spawns.push({ file, args });
      return { unref: () => {} };
    },
  });
  assert.equal(code, 0);
  assert.equal(spawns[0].file, 'code');
  assert.deepEqual(spawns[0].args, [join(dir, 'commands.json')]);
});

test('editConfig falls back to the default editor when the file is broken', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-action-'));
  await writeFile(join(dir, 'commands.json'), '{ broken', 'utf8');
  const spawns = [];
  const code = await editConfig({
    env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: join(dir, 'state') },
    execFile: async () => {},
    spawn: (file, args) => {
      spawns.push({ file, args });
      return { unref: () => {} };
    },
  });
  assert.equal(code, 0);
  assert.equal(spawns[0].file, 'code');
});

test('editConfig reports an unresolvable config directory', async () => {
  const stderr = stderrSink();
  const code = await editConfig({
    env: {},
    stderr,
    execFile: async () => { throw new Error('socket down'); },
    spawn: () => { throw new Error('must not spawn'); },
  });
  assert.equal(code, 2);
  assert.match(stderr.lines.join(''), /config directory/u);
});

test('editConfig reports a missing editor binary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-action-'));
  const stderr = stderrSink();
  const code = await editConfig({
    env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: join(dir, 'state') },
    stderr,
    execFile: async () => {},
    spawn: () => { throw new Error('spawn code ENOENT'); },
  });
  assert.equal(code, 1);
  assert.match(stderr.lines.join(''), /ENOENT/u);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/actions.test.mjs`
Expected: FAIL — `openPalette` / `editConfig` are not exported from the placeholders.

- [ ] **Step 3: Write `bin/open.mjs`**

```js
#!/usr/bin/env node

// The `open` action: what the user's keybinding actually triggers.
//
// It must run before the popup exists, because that is the only moment when
// herdr's invocation context still describes where the *user* was. Once the
// popup opens it becomes the focused pane, so the cwd is captured here and
// forwarded in as COMMAND_CENTER_CONTEXT_JSON.

import { execFile as execFileCallback } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readContext, serializeContext } from '../src/context.mjs';
import { PLUGIN_ID, POPUP_ENTRYPOINT_ID } from '../src/plugin.mjs';

const execFileAsync = promisify(execFileCallback);
const CLI_TIMEOUT_MS = 5_000;
const MAX_BUFFER_BYTES = 1_048_576;
const MAX_ERROR_STDOUT_BYTES = 16_384;

function herdrErrorCode(error) {
  const stdout = error?.stdout;
  if (typeof stdout !== 'string' || stdout.length > MAX_ERROR_STDOUT_BYTES) return null;
  try {
    const code = JSON.parse(stdout)?.error?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

export async function openPalette({
  env = process.env,
  execFile = execFileAsync,
  stderr = process.stderr,
} = {}) {
  const context = serializeContext(readContext(env));
  try {
    await execFile(env.HERDR_BIN_PATH || 'herdr', [
      'plugin', 'pane', 'open',
      '--plugin', PLUGIN_ID,
      '--entrypoint', POPUP_ENTRYPOINT_ID,
      '--placement', 'popup',
      '--focus',
      '--env', `COMMAND_CENTER_CONTEXT_JSON=${context}`,
    ], {
      env,
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      shell: false,
    });
    return 0;
  } catch (error) {
    const code = herdrErrorCode(error);
    try {
      stderr.write(
        `command-center: the popup could not be opened${code ? ` (${code})` : ''}\n`,
      );
    } catch {
      // Nothing more to do; the exit code still reports the failure.
    }
    return 1;
  }
}

async function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await invokedAsMain()) {
  process.exitCode = await openPalette();
}
```

- [ ] **Step 4: Write `bin/edit-config.mjs`**

```js
#!/usr/bin/env node

// The `edit-config` action: open commands.json in the configured editor without
// going through the popup at all, for when the user already knows what to change.

import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { openInEditor } from '../src/editor.mjs';
import { createLogger as createDefaultLogger } from '../src/logger.mjs';
import { commandsPath, resolveConfigDir, resolveStateDir, runLogPath } from '../src/paths.mjs';
import { DEFAULT_EDITOR } from '../src/schema.mjs';
import { loadStore } from '../src/store.mjs';

const execFileAsync = promisify(execFileCallback);

export async function editConfig({
  env = process.env,
  execFile = execFileAsync,
  spawn = spawnChild,
  stderr = process.stderr,
  createLogger = createDefaultLogger,
} = {}) {
  let configDir;
  try {
    configDir = await resolveConfigDir(env, execFile);
  } catch (error) {
    try {
      stderr.write(`command-center: ${error?.message ?? 'the config directory could not be resolved'}\n`);
    } catch {
      // The exit code still reports the failure.
    }
    return 2;
  }
  const commandsFile = commandsPath(configDir);
  const logger = createLogger(runLogPath(resolveStateDir(configDir, env)));

  // A broken or absent file is exactly when the user most needs the editor, so
  // fall back to the default editor rather than refusing to open.
  let editor = [...DEFAULT_EDITOR];
  try {
    const loaded = await loadStore(commandsFile);
    editor = loaded.doc.editor;
  } catch {
    await logger.write('edit-config-fallback-editor', { path: commandsFile });
  }

  try {
    await openInEditor(commandsFile, { editor, spawn, env, log: logger.write });
    return 0;
  } catch (error) {
    await logger.write('failed', { message: error?.message ?? 'unknown failure' });
    try {
      stderr.write(`command-center: the editor could not be started (${error?.message ?? 'unknown failure'})\n`);
    } catch {
      // The exit code still reports the failure.
    }
    return 1;
  }
}

async function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await invokedAsMain()) {
  process.exitCode = await editConfig();
}
```

- [ ] **Step 5: Run the action tests**

Run: `node --test test/actions.test.mjs`
Expected: PASS — 10 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS — 195 tests total.

- [ ] **Step 7: Commit**

```bash
git add bin/open.mjs bin/edit-config.mjs test/actions.test.mjs
git commit -m "feat: add the open and edit-config herdr actions

'open' is what the keybinding triggers, and it has to capture the invocation
context before the popup exists: HERDR_PLUGIN_CONTEXT_JSON describes where the
user was, but once the popup opens it becomes the focused pane, so the cwd is
read here and forwarded in as COMMAND_CENTER_CONTEXT_JSON.

A refused popup (herdr answers ui_busy when one is already open) is reported on
stderr with the herdr error code and exits 1, rather than the keypress appearing
to do nothing.

'edit-config' opens commands.json directly for when the user already knows what
to change. It falls back to the default editor when the file is broken or
missing, because that is exactly when the editor is most needed."
```

---

## Task 12: Operator documentation and end-to-end verification

**Files:**
- Create: `README.md`, `README.ko.md`
- Modify: `test/manifest.test.mjs` (add doc-consistency assertions)

**Interfaces:**
- Consumes: everything built so far.
- Produces: no new code exports. This task proves the plugin works inside the real herdr and documents it.

- [ ] **Step 1: Write `README.md`**

````markdown
# Command Center

[English](README.md) ｜ [한국어](README.ko.md)

`cdragon.command-center` is a herdr plugin that replaces a drawer full of
prefix keybindings with **one** keybinding. Press it, and a popup lists every
command you registered. Move with the arrow keys and press Enter, or just press
the number next to the one you want.

The point is that you stop memorizing. As you install more herdr plugins, each
one wants its own `prefix+<key>`, and eventually you cannot remember which key
does what. Command Center gives all of them one door.

## How it works

The popup **never runs your command.** When you pick one, the popup hands the
command to a detached runner process and exits — and the popup closing *is* that
exit. The runner then waits for the popup's process id to disappear, waits a
further 120ms for herdr to finish tearing the popup down and restoring focus,
and only then executes.

That ordering is not cosmetic. herdr resolves `plugin action invoke` against
whatever pane is focused *right now*, and it refuses UI work with `ui_busy`
while a popup owns the screen. If the command ran before the popup closed, it
would either target the popup itself or be refused outright. So the runner also
retries a `ui_busy` refusal, as a second line of defence.

## Installation

Requires Node.js 22+ and herdr 0.7.5+.

```bash
herdr plugin install speardragon/herdr-command-center --yes
```

Or, for local development:

```bash
herdr plugin link /path/to/herdr-command-center
```

Then bind one key in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "cdragon.command-center.open"
description = "Open Command Center"
```

Any unused key works — check it does not collide with a herdr default
(`prefix+c` is `new_tab`, `prefix+e` is `edit_scrollback`, and so on) or with
another plugin. Reload without restarting:

```bash
herdr server reload-config
```

## Keys

| Key | In the list | In the add/edit form |
| --- | --- | --- |
| `↑` `↓` | move the selection | previous / next field |
| `Tab` / `Shift-Tab` | — | next / previous field |
| `k` `j` | move the selection | typed into the focused text field |
| `Enter` | run the selected command | save |
| `1`–`9` | run the command with that badge | type the digit |
| `a` | add a command | — |
| `e` | edit the selected command | — |
| `d` then `y` | delete the selected command | — |
| `←` `→` / `Space` | — | change `Type` or `Cwd` |
| `Backspace` | — | delete the last character |
| `o` | open `commands.json` in your editor | — |
| `Esc` | close the popup | discard and go back |
| `Ctrl-C` | close the popup | close the popup |

Badges are **absolute positions**: `3` always runs the third command in the
file, no matter how far the list has scrolled. Commands past the ninth have no
badge and are reached with the arrow keys.

## The config file

Everything the popup edits lives in one JSON file you are meant to edit by hand
too. Press `o` in the popup, or run the action directly:

```bash
herdr plugin action invoke edit-config --plugin cdragon.command-center
```

Its path:

```bash
herdr plugin config-dir cdragon.command-center
# → <that directory>/commands.json
```

```json
{
  "schema_version": 1,
  "editor": ["code"],
  "commands": [
    {
      "id": "open-in-vs-code",
      "label": "Open in VS Code",
      "type": "shell",
      "command": "code .",
      "cwd": "focused",
      "description": "Open the focused pane's directory in VS Code"
    },
    {
      "id": "file-explorer",
      "label": "File explorer",
      "type": "plugin_action",
      "command": "ray.file-explorer.open",
      "cwd": "focused",
      "description": "Open Yazi in a split"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `editor` | argv used for the `o` key and the `edit-config` action. Defaults to `["code"]`. |
| `id` | stable identifier. Omit it and one is derived from the label (Korean labels keep readable ids). |
| `label` | what the popup shows. Up to 80 characters. |
| `type` | `shell` or `plugin_action`. |
| `command` | for `shell`, a single-line shell command; for `plugin_action`, `<plugin_id>.<action_id>`. |
| `cwd` | `focused` (default), `workspace`, or an absolute path. Ignored for `plugin_action`. |
| `description` | optional one-line note shown under the list. |

The file is only ever written atomically, and the popup refuses to save if the
file changed on disk since it was opened — so editing it in VS Code while the
popup is open cannot lose your edits. A malformed file opens the popup in an
error mode that names the problem and still lets you press `o` to go fix it; it
is never overwritten.

### Anything herdr can do

`type` is deliberately just `shell` and `plugin_action`, because a `shell`
command can call the `herdr` CLI and therefore do anything herdr does:

```json
{ "label": "Lazygit in a split", "type": "shell", "command": "herdr plugin pane open --plugin ray.file-explorer --entrypoint explorer --placement split" }
```

## Actions

| Action | What it does |
| --- | --- |
| `herdr plugin action invoke open --plugin cdragon.command-center` | open the popup |
| `herdr plugin action invoke edit-config --plugin cdragon.command-center` | open `commands.json` in your editor |

## Troubleshooting

**The keypress seems to do nothing.** herdr answers `ui_busy` if a popup is
already open. `herdr plugin log --plugin cdragon.command-center` shows the
action's own output.

**The popup closed but nothing ran.** The runner is detached and has no
terminal, so it writes a JSONL log instead:

```bash
find ~/.config/herdr -name run.log -path '*command-center*' -exec tail -20 {} +
```

Each line records whether the popup was observed to close (`popup-closed`),
what was started (`shell` / `plugin_action` / `open-config`), and any failure
(`failed`, `plugin_action_failed`).

**A shell command ran in the wrong directory.** `cwd: "focused"` uses the pane
that was focused when you pressed the key. If herdr reported no cwd for it, the
plugin falls back to the workspace cwd, then to your home directory.

## License

MIT
````

- [ ] **Step 2: Write `README.ko.md`**

````markdown
# Command Center

[English](README.md) ｜ [한국어](README.ko.md)

`cdragon.command-center`는 수많은 prefix 키 조합을 **키 하나**로 바꿔주는 herdr
플러그인입니다. 그 키를 누르면 등록해 둔 커맨드 목록이 팝업으로 뜹니다. 방향키로
옮겨서 Enter를 누르거나, 옆에 붙은 번호를 바로 누르면 실행됩니다.

핵심은 외우지 않아도 된다는 점입니다. herdr 플러그인이 늘어날수록 각자
`prefix+<키>`를 하나씩 차지하는데, 어느 순간부터 어떤 키가 무엇인지 기억할 수
없게 됩니다. Command Center는 그 전부를 문 하나로 모읍니다.

## 동작 방식

팝업은 **커맨드를 직접 실행하지 않습니다.** 커맨드를 선택하면 팝업은 그 커맨드를
분리된(detached) 러너 프로세스에 넘기고 종료하는데, 이 종료가 곧 팝업이 닫히는
동작입니다. 러너는 팝업 프로세스 id가 사라질 때까지 기다리고, herdr가 팝업을
정리하고 포커스를 되돌릴 시간으로 120ms를 더 기다린 뒤에 실행합니다.

이 순서는 겉치레가 아닙니다. herdr는 `plugin action invoke`를 **지금 포커스된**
페인 기준으로 해석하고, 팝업이 화면을 점유한 동안에는 UI 작업을 `ui_busy`로
거부합니다. 팝업이 닫히기 전에 실행하면 커맨드가 팝업 자신을 대상으로 잡히거나
아예 거부됩니다. 그래서 러너는 `ui_busy` 거부에 대해 재시도까지 합니다.

## 설치

Node.js 22+ 와 herdr 0.7.5+ 가 필요합니다.

```bash
herdr plugin install speardragon/herdr-command-center --yes
```

로컬 개발 시:

```bash
herdr plugin link /path/to/herdr-command-center
```

그리고 `~/.config/herdr/config.toml`에 키 하나만 매핑합니다:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "cdragon.command-center.open"
description = "Open Command Center"
```

비어 있는 키면 무엇이든 됩니다. herdr 기본값(`prefix+c`는 `new_tab`, `prefix+e`는
`edit_scrollback` 등)이나 다른 플러그인과 겹치지 않는지만 확인하세요. 재시작 없이
적용하려면:

```bash
herdr server reload-config
```

## 키

| 키 | 목록에서 | 추가/수정 폼에서 |
| --- | --- | --- |
| `↑` `↓` | 선택 이동 | 이전 / 다음 필드 |
| `Tab` / `Shift-Tab` | — | 다음 / 이전 필드 |
| `k` `j` | 선택 이동 | 포커스된 텍스트 필드에 입력됨 |
| `Enter` | 선택한 커맨드 실행 | 저장 |
| `1`–`9` | 그 번호의 커맨드 실행 | 숫자 입력 |
| `a` | 커맨드 추가 | — |
| `e` | 선택한 커맨드 수정 | — |
| `d` 다음 `y` | 선택한 커맨드 삭제 | — |
| `←` `→` / `Space` | — | `Type`·`Cwd` 값 변경 |
| `Backspace` | — | 마지막 글자 삭제 |
| `o` | `commands.json`을 에디터로 열기 | — |
| `Esc` | 팝업 닫기 | 취소하고 목록으로 |
| `Ctrl-C` | 팝업 닫기 | 팝업 닫기 |

번호는 **절대 위치**입니다. 목록이 아무리 스크롤되어 있어도 `3`은 항상 파일의 세
번째 커맨드를 실행합니다. 열 번째 이후 커맨드에는 번호가 붙지 않고 방향키로
접근합니다.

## 설정 파일

팝업이 편집하는 내용은 전부 JSON 파일 하나에 들어 있고, 이 파일은 직접 손으로
고치는 것도 전제로 하고 있습니다. 팝업에서 `o`를 누르거나, 액션을 직접 실행하세요:

```bash
herdr plugin action invoke edit-config --plugin cdragon.command-center
```

경로:

```bash
herdr plugin config-dir cdragon.command-center
# → <그 디렉터리>/commands.json
```

```json
{
  "schema_version": 1,
  "editor": ["code"],
  "commands": [
    {
      "id": "open-in-vs-code",
      "label": "Open in VS Code",
      "type": "shell",
      "command": "code .",
      "cwd": "focused",
      "description": "포커스된 페인의 디렉터리를 VS Code로 열기"
    },
    {
      "id": "file-explorer",
      "label": "File explorer",
      "type": "plugin_action",
      "command": "ray.file-explorer.open",
      "cwd": "focused",
      "description": "Yazi를 split으로 열기"
    }
  ]
}
```

| 필드 | 의미 |
| --- | --- |
| `editor` | `o` 키와 `edit-config` 액션이 사용할 argv. 기본값 `["code"]`. |
| `id` | 고정 식별자. 생략하면 label에서 만들어집니다(한글 label도 읽을 수 있는 id가 됩니다). |
| `label` | 팝업에 보이는 이름. 최대 80자. |
| `type` | `shell` 또는 `plugin_action`. |
| `command` | `shell`이면 한 줄 셸 커맨드, `plugin_action`이면 `<plugin_id>.<action_id>`. |
| `cwd` | `focused`(기본), `workspace`, 또는 절대 경로. `plugin_action`에서는 무시됩니다. |
| `description` | 목록 아래에 보여줄 한 줄 설명(선택). |

파일은 항상 원자적으로 기록되고, 팝업을 연 뒤 파일이 디스크에서 바뀌었다면 저장을
거부합니다. 팝업을 열어둔 채 VS Code에서 편집해도 그 편집이 사라지지 않습니다.
형식이 깨진 파일은 무엇이 문제인지 알려주는 에러 화면으로 열리고, 그 화면에서도
`o`로 고치러 갈 수 있습니다. 깨진 파일을 덮어쓰지는 않습니다.

### herdr가 할 수 있는 건 다 됩니다

`type`을 `shell`과 `plugin_action` 둘로만 둔 이유는, `shell` 커맨드가 `herdr` CLI를
호출할 수 있어서 herdr가 하는 일은 전부 가능하기 때문입니다:

```json
{ "label": "Lazygit in a split", "type": "shell", "command": "herdr plugin pane open --plugin ray.file-explorer --entrypoint explorer --placement split" }
```

## 액션

| 액션 | 설명 |
| --- | --- |
| `herdr plugin action invoke open --plugin cdragon.command-center` | 팝업 열기 |
| `herdr plugin action invoke edit-config --plugin cdragon.command-center` | `commands.json`을 에디터로 열기 |

## 문제 해결

**키를 눌러도 아무 일도 안 납니다.** 이미 팝업이 열려 있으면 herdr가 `ui_busy`로
응답합니다. `herdr plugin log --plugin cdragon.command-center`로 액션 자체의 출력을
확인하세요.

**팝업은 닫혔는데 실행이 안 됐습니다.** 러너는 분리된 프로세스라 터미널이 없어서
JSONL 로그를 남깁니다:

```bash
find ~/.config/herdr -name run.log -path '*command-center*' -exec tail -20 {} +
```

각 줄에는 팝업이 닫힌 것을 확인했는지(`popup-closed`), 무엇을 시작했는지
(`shell` / `plugin_action` / `open-config`), 실패했다면 그 내용(`failed`,
`plugin_action_failed`)이 남습니다.

**셸 커맨드가 엉뚱한 디렉터리에서 실행됩니다.** `cwd: "focused"`는 키를 누른 시점에
포커스되어 있던 페인을 씁니다. herdr가 그 페인의 cwd를 주지 않으면 workspace cwd,
그다음 홈 디렉터리로 넘어갑니다.

## 라이선스

MIT
````

- [ ] **Step 3: Add doc-consistency assertions to `test/manifest.test.mjs`**

Append these tests to the existing file:

```js
test('both READMEs document the herdr 0.7.5 action argument order', async () => {
  for (const name of ['README.md', 'README.ko.md']) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    for (const action of ['open', 'edit-config']) {
      assert.match(
        text,
        new RegExp(`herdr plugin action invoke ${action} --plugin ${PLUGIN_ID.replace('.', '\\.')}`),
        `${name} is missing the ${action} invocation`,
      );
    }
  }
});

test('both READMEs document the keybinding that opens the popup', async () => {
  for (const name of ['README.md', 'README.ko.md']) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.match(text, /type = "plugin_action"/u, name);
    assert.match(text, new RegExp(`command = "${PLUGIN_ID.replace('.', '\\.')}\\.open"`), name);
    assert.match(text, /herdr server reload-config/u, name);
  }
});

test('both READMEs state the version floors the manifest enforces', async () => {
  for (const name of ['README.md', 'README.ko.md']) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.match(text, /Node\.js 22\+/u, name);
    assert.match(text, /0\.7\.5\+/u, name);
  }
});

test('both READMEs document every config field', async () => {
  for (const name of ['README.md', 'README.ko.md']) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    for (const field of ['schema_version', 'editor', 'label', 'plugin_action', 'focused', 'workspace', 'description']) {
      assert.ok(text.includes(field), `${name} does not document ${field}`);
    }
  }
});
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS — 199 tests total.

- [ ] **Step 5: Commit the docs**

```bash
git add README.md README.ko.md test/manifest.test.mjs
git commit -m "docs: document Command Center in English and Korean

Both READMEs lead with why the popup does not run the command itself, because
that is the non-obvious part of the design and the thing a future reader is most
likely to 'simplify' into a bug: herdr resolves plugin-action context against
the live focused pane and refuses UI work with ui_busy while a popup is open, so
the close must happen first.

Manifest tests now assert the docs stay consistent with the code: the herdr
0.7.5 action argument order, the keybinding snippet, the Node 22 / herdr 0.7.5
floors, and every commands.json field."
```

- [ ] **Step 6: Link the plugin into the running herdr**

```bash
herdr plugin link /Users/cdragon/Desktop/Programming/side/herdr-command-center
```

Expected: JSON on stdout containing `"type":"plugin_linked"` and
`"plugin_id":"cdragon.command-center"`. The manifest's build steps run here, so
the Node check and `npm test` must both pass or the link fails.

- [ ] **Step 7: Verify herdr registered both actions and the config dir**

```bash
herdr plugin list
herdr plugin config-dir cdragon.command-center
herdr plugin action list --plugin cdragon.command-center
```

Expected: `cdragon.command-center (Command Center) enabled [local:...]` in the
list; an absolute path from `config-dir`; and two actions (`open`,
`edit-config`) from `action list`.

- [ ] **Step 8: Open the popup from the CLI and check the frame**

```bash
herdr plugin action invoke open --plugin cdragon.command-center
```

Expected: a popup appears showing `Command Center · 3 commands` with badges
`1.`, `2.`, `3.`, the selected command's `shell · code .` detail line, and the
footer of key hints. Confirm the seed file was written:

```bash
cat "$(herdr plugin config-dir cdragon.command-center)/commands.json"
```

- [ ] **Step 9: Verify the close-before-run ordering by hand**

In the popup, move to `Open in VS Code` and press Enter. Expected: the popup
closes **first**, and VS Code then opens on the directory of the pane that was
focused when you opened the popup — not on the plugin directory and not on your
home directory. Then check the runner's own log:

```bash
find ~/.config/herdr -name run.log -path '*command-center*' -exec cat {} +
```

Expected: a `popup-closed` line with `"exited":true`, followed by a `shell` line
naming `open-in-vs-code` and the cwd it used.

- [ ] **Step 10: Verify a plugin_action command end to end**

Add an entry pointing at a plugin action that is actually installed — the
already-installed `ray.file-explorer.open` is a good target. Press `a` in the
popup, fill in `File explorer`, press `Tab` then `→` to switch `Type` to
`plugin_action`, press `Tab` and type `ray.file-explorer.open`, then Enter.
Expected: the list shows four commands and `commands.json` gained the entry.
Press `4`. Expected: the popup closes and the file explorer opens in a split —
this is the case that would fail with `ui_busy` if the runner did not wait.

- [ ] **Step 11: Verify the config-file round trip**

Press `o` in the popup. Expected: the popup closes and `commands.json` opens in
VS Code. Add a command by hand there, save, then reopen the popup and confirm it
appears. Then break the JSON on purpose (delete a brace), reopen the popup, and
confirm it shows `Command Center · config error` naming the problem, that `o`
still opens the file, and that the broken file was **not** overwritten.

- [ ] **Step 12: Bind the key and confirm the real entry point**

Add to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "cdragon.command-center.open"
description = "Open Command Center"
```

```bash
herdr server reload-config
```

Expected: pressing `ctrl+a` then `a` opens the popup. Verify a `shell` command
still resolves the cwd correctly when opened this way, since this is the path
that carries a real invocation context.

- [ ] **Step 13: Commit any fixes found during verification**

If Steps 6–12 turned up a defect, fix it with its own test and commit
separately, one commit per change:

```bash
git add <files>
git commit -m "fix: <what was wrong and why the fix is right>"
```

---

## Self-Review

**Spec coverage**

| Requirement from the request | Where it is implemented |
| --- | --- |
| herdr plugin using a popup | Task 1 manifest `[[panes]] placement = "popup"`; Task 10 popup entrypoint |
| popup lists the user's registered commands | Task 3 schema, Task 4 store, Task 7 list rendering |
| arrow keys focus an entry | Task 6 `reduceList` (`up`/`down`/`k`/`j`), Task 7 cursor marker |
| Enter runs the focused command | Task 6 `run` effect, Task 8 `executeCommand`, Task 9 runner |
| **popup closes before the command runs** | Task 10 (popup spawns the runner then returns), Task 9 (`waitForProcessExit` + `SETTLE_MS`), Task 8 (`ui_busy` retry) |
| follows the existing herdr plugins' conventions | zero-dependency `.mjs` + `node --test` + manifest shape, matching `cdragon.ask-inbox` |
| one keybinding replaces many prefix mappings | Task 11 `open` action, Task 12 keybinding docs; `shell` + `plugin_action` covers exactly what `[[keys.command]]` covers |
| register / edit / delete inside the popup | Task 6 form and confirm modes, Task 10 save handling |
| a separate config file editable by hand | Task 4 `commands.json` in the plugin config dir, atomic writes, external-edit guard, error mode |
| numbers on each entry, runnable by number | Task 6 digit handling (absolute index), Task 7 badges |
| a key that opens the config file in VS Code | Task 6 `o` → `open-config`, Task 8 `src/editor.mjs`, default `["code"]`, Task 11 `edit-config` action |

No gaps found.

**Placeholder scan**

No `TBD`, `TODO`, "implement later", "add error handling", or "similar to Task N"
appears. Every code step contains the full file or the full appended block.
`bin/*.mjs` are created as explicit three-line stubs in Task 1 and each is
replaced by a named later task, which is stated in both places.

**Type consistency**

Checked across tasks:
- `Command` fields (`id`, `label`, `type`, `command`, `cwd`, `description`) are identical in Task 3 (`normalizeCommand`), Task 6 (`formFor` / `submitForm`), Task 7 (`commandRow`, detail line), Task 8 (`buildShellSpawn`, `buildPluginActionArgs`) and Task 9 (task JSON).
- `ConfigDoc` is `{ schema_version, editor, commands }` in Tasks 3, 4, 6, 10, 11.
- Effect names are exactly `run` / `open-config` / `save` / `close` in Tasks 6 and 10.
- `createView({ doc, error, cursor })` is called with that same shape in Tasks 6, 7 and 10.
- Env variable names are consistent: `COMMAND_CENTER_CONTEXT_JSON` (Task 5 reader, Task 10 test harness, Task 11 writer), `COMMAND_CENTER_TASK_JSON` and `COMMAND_CENTER_POPUP_PID` (Task 9 reader, Task 10 writer), `COMMAND_CENTER_CONFIG_DIR` (Task 4).
- Context shape is `{ focusedPaneCwd, workspaceCwd }` in Tasks 5, 8, 9, 10, 11.
- `resolveConfigDir` / `resolveStateDir` / `commandsPath` / `runLogPath` are used with the Task 4 signatures in Tasks 10 and 11.
- `createLogger(path).write(event, detail)` is used with that shape in Tasks 8, 9 and 11.
- `waitForProcessExit(pid, { sleep })` matches the Task 9 injection point in `runPending`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-26-herdr-command-center.md`.

# Addendum: move the config file from JSON to TOML

> **Status:** Tasks 1–12 shipped with `commands.json`. This addendum converts the
> config file to `commands.toml`. Same execution rules as the rest of the plan.

**Why:** every other file the user hand-edits in herdr is TOML (`config.toml`,
`herdr-plugin.toml`), and the user comments those files heavily. JSON cannot hold
a comment at all, so "comment a command out for a week" was impossible, and the
`config error` mode existed largely to catch brace/comma slips TOML avoids.

**The hard part, and the design that answers it:** the popup *writes* this file,
and every mainstream TOML serializer drops comments on write. Re-rendering the
whole file would therefore *promise* comments and then eat them — strictly worse
than JSON. So the popup never re-renders the file. It splits the document into
`[[commands]]` blocks plus opaque text, and only ever replaces, removes, or
appends individual blocks. Preamble, blank lines, comments between blocks, and
commented-out blocks are preserved byte-for-byte. A command whose fields did not
change keeps its original block text verbatim, hand-formatting and all.

**Contract to document:** comments *inside* a block you edit through the popup
are lost, because that block is re-rendered. Everything else survives.

## Addendum constraints

- Config file is `commands.toml`. `commands.json` from Tasks 1–12 is migrated once, and the old file is renamed to `commands.json.bak` rather than deleted.
- One runtime dependency is now allowed: `smol-toml` (TOML 1.0, zero transitive deps, ESM). Verified against Node 22.20: parses the exact document shape, handles Korean text and escaped quotes, ignores commented-out `[[commands]]` blocks, and throws a typed `TomlError` on malformed input. Parsing hand-edited text is not something to hand-roll.
- The manifest gains an `npm ci` build step **before** `npm test`, and `package-lock.json` is committed.
- `normalizeConfig` / `normalizeCommand` in `src/schema.mjs` are format-agnostic (they take a plain object) and do **not** change. Only serialization and reading change.
- The popup never edits the `editor` key. If a save is asked to change it, `saveStore` falls back to a full re-render — documented, and unreachable through the popup UI.

---

## Task 13: TOML codec for the config document

**Files:**
- Create: `src/toml-config.mjs`
- Modify: `package.json` (add `smol-toml`), `herdr-plugin.toml` (add `npm ci` build step), `src/plugin.mjs` (config file names)
- Test: `test/toml-config.test.mjs`

**Interfaces:**
- Consumes: `src/schema.mjs` (`ConfigError`).
- Produces:
  - `escapeTomlString(value: string): string`
  - `renderCommandBlock(command: Command): string` — one `[[commands]]` block, newline-terminated
  - `renderConfigToml(doc: ConfigDoc): string` — the whole file, used for seeding and for the `editor`-changed fallback
  - `parseConfigToml(text: string, fileName?: string): object` — throws `ConfigError` on malformed TOML
  - From `src/plugin.mjs`: `CONFIG_FILE_NAME` becomes `'commands.toml'`, and a new `LEGACY_CONFIG_FILE_NAME = 'commands.json'`

- [ ] **Step 1: Add the dependency and the build gate**

```bash
npm install smol-toml@1.7.1 --save-exact
```

Then confirm the lockfile exists and the tree is flat:

```bash
node -e "const p=require('./package.json');console.log(p.dependencies)"
test -f package-lock.json && echo "lockfile present"
```
Expected: `{ 'smol-toml': '1.7.1' }` and `lockfile present`.

In `herdr-plugin.toml`, insert an `npm ci` build step immediately **before** the `npm test` step, so a fresh `herdr plugin install` has the dependency before the tests run:

```toml
[[build]]
command = ["npm", "ci"]

[[build]]
command = ["npm", "test"]
```

- [ ] **Step 2: Update the file names in `src/plugin.mjs`**

Replace the `CONFIG_FILE_NAME` line and add the legacy name:

```js
export const CONFIG_FILE_NAME = 'commands.toml';
// Tasks 1-12 shipped commands.json; ensureStore migrates it once and renames the
// original rather than deleting it.
export const LEGACY_CONFIG_FILE_NAME = 'commands.json';
```

- [ ] **Step 3: Write the failing test `test/toml-config.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { parse as parseToml } from 'smol-toml';

import { ConfigError, defaultConfig, normalizeConfig } from '../src/schema.mjs';
import {
  escapeTomlString,
  parseConfigToml,
  renderCommandBlock,
  renderConfigToml,
} from '../src/toml-config.mjs';

const COMMAND = Object.freeze({
  id: 'open-in-vs-code',
  label: 'Open in VS Code',
  type: 'shell',
  command: 'code .',
  cwd: 'focused',
  description: 'Open the focused directory',
});

test('escapeTomlString escapes what TOML basic strings require', () => {
  assert.equal(escapeTomlString('plain'), 'plain');
  assert.equal(escapeTomlString('say "hi"'), 'say \\"hi\\"');
  assert.equal(escapeTomlString('back\\slash'), 'back\\\\slash');
  assert.equal(escapeTomlString('a\nb'), 'a\\nb');
  assert.equal(escapeTomlString('a\tb'), 'a\\tb');
  assert.equal(escapeTomlString('a\rb'), 'a\\rb');
});

test('escapeTomlString escapes other control characters as \\uXXXX', () => {
  assert.equal(escapeTomlString('a\u0000b'), 'a\\u0000b');
  assert.equal(escapeTomlString('a\u0007b'), 'a\\u0007b');
});

test('escapeTomlString leaves Korean and emoji alone', () => {
  assert.equal(escapeTomlString('브랜치 정리'), '브랜치 정리');
  assert.equal(escapeTomlString('🚀'), '🚀');
});

test('renderCommandBlock emits a parseable block with a stable key order', () => {
  const text = renderCommandBlock(COMMAND);
  assert.equal(text, [
    '[[commands]]',
    'id = "open-in-vs-code"',
    'label = "Open in VS Code"',
    'type = "shell"',
    'command = "code ."',
    'cwd = "focused"',
    'description = "Open the focused directory"',
    '',
  ].join('\n'));
  assert.deepEqual(parseToml(text).commands[0], COMMAND);
});

test('renderCommandBlock omits an empty description to keep files tidy', () => {
  const text = renderCommandBlock({ ...COMMAND, description: '' });
  assert.ok(!text.includes('description'));
  assert.equal(parseToml(text).commands[0].description, undefined);
});

test('renderCommandBlock survives a label full of quotes and backslashes', () => {
  const hostile = { ...COMMAND, label: 'say "hi" \\ bye', command: 'echo "x"' };
  const parsed = parseToml(renderCommandBlock(hostile)).commands[0];
  assert.equal(parsed.label, 'say "hi" \\ bye');
  assert.equal(parsed.command, 'echo "x"');
});

test('renderConfigToml round-trips the default config exactly', () => {
  const doc = defaultConfig();
  const text = renderConfigToml(doc);
  assert.deepEqual(normalizeConfig(parseConfigToml(text)), doc);
});

test('renderConfigToml writes the header keys before any block', () => {
  const text = renderConfigToml(defaultConfig());
  assert.match(text, /^schema_version = 1\neditor = \["code"\]\n/u);
  assert.ok(text.indexOf('schema_version') < text.indexOf('[[commands]]'));
});

test('renderConfigToml round-trips a Korean, multi-arg-editor config', () => {
  const doc = normalizeConfig({
    editor: ['code', '--new-window'],
    commands: [
      { label: '브랜치 정리', type: 'shell', command: 'git branch --merged', description: '병합된 브랜치 보기' },
      { label: '파일 탐색기', type: 'plugin_action', command: 'ray.file-explorer.open' },
    ],
  });
  assert.deepEqual(normalizeConfig(parseConfigToml(renderConfigToml(doc))), doc);
});

test('renderConfigToml handles an empty command list', () => {
  const doc = normalizeConfig({ commands: [] });
  assert.deepEqual(normalizeConfig(parseConfigToml(renderConfigToml(doc))), doc);
});

test('parseConfigToml accepts comments and commented-out blocks', () => {
  const value = parseConfigToml([
    'schema_version = 1',
    'editor = ["code"]',
    '',
    '# the ones I actually use',
    '[[commands]]',
    'label = "Ls"',
    'type = "shell"',
    'command = "ls"   # trailing comment',
    '',
    '# [[commands]]',
    '# label = "Lazygit"',
    '# type = "shell"',
    '# command = "lazygit"',
    '',
  ].join('\n'));
  assert.equal(value.commands.length, 1);
  assert.equal(value.commands[0].command, 'ls');
});

test('parseConfigToml reports malformed TOML as a ConfigError naming the file', () => {
  assert.throws(() => parseConfigToml('label = ', 'commands.toml'), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /commands\.toml/u);
    assert.match(error.message, /not valid TOML/u);
    return true;
  });
});

test('parseConfigToml keeps only the reason, not the source excerpt', () => {
  assert.throws(() => parseConfigToml('[[commands]]\nlabel = \n'), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /not valid TOML at line \d+/u);
    assert.match(error.message, /no value specified/u);
    // smol-toml appends a blank line, a source excerpt and a caret diagram. The
    // popup collapses newlines when wrapping, so none of that may reach it.
    assert.ok(!error.message.includes('^'), error.message);
    assert.ok(!error.message.includes('\n'), error.message);
    assert.ok(error.message.length < 160, error.message);
    return true;
  });
});

test('parseConfigToml reports a duplicated key rather than throwing raw', () => {
  assert.throws(
    () => parseConfigToml('a = 1\na = 2'),
    (error) => error instanceof ConfigError,
  );
});
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `node --test test/toml-config.test.mjs`
Expected: FAIL — `Cannot find module '.../src/toml-config.mjs'`.

- [ ] **Step 5: Write `src/toml-config.mjs`**

```js
import { parse as parseToml } from 'smol-toml';

import { ConfigError } from './schema.mjs';

// Key order is fixed so a block the popup rewrites still reads like the ones the
// user wrote by hand.
const COMMAND_KEYS = Object.freeze(['id', 'label', 'type', 'command', 'cwd', 'description']);
const SIMPLE_ESCAPES = Object.freeze({
  '\\': '\\\\',
  '"': '\\"',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
});

export function escapeTomlString(value) {
  let out = '';
  for (const character of String(value ?? '')) {
    const simple = SIMPLE_ESCAPES[character];
    if (simple !== undefined) {
      out += simple;
      continue;
    }
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
      continue;
    }
    out += character;
  }
  return out;
}

function keyValue(key, value) {
  return `${key} = "${escapeTomlString(value)}"`;
}

export function renderCommandBlock(command) {
  const lines = ['[[commands]]'];
  for (const key of COMMAND_KEYS) {
    // An empty description would just be noise in a file meant to be read.
    if (key === 'description' && !command[key]) continue;
    lines.push(keyValue(key, command[key]));
  }
  return `${lines.join('\n')}\n`;
}

// Whole-file render. Used for seeding a new config and for the rare fallback when
// a save changes something outside the [[commands]] blocks. Ordinary popup edits
// go through applyCommands in toml-edit.mjs so comments survive.
export function renderConfigToml(doc) {
  const editor = doc.editor.map((entry) => `"${escapeTomlString(entry)}"`).join(', ');
  const header = `schema_version = ${doc.schema_version}\neditor = [${editor}]\n`;
  if (doc.commands.length === 0) return header;
  return `${header}\n${doc.commands.map((command) => renderCommandBlock(command)).join('\n')}`;
}

export function parseConfigToml(text, fileName = 'commands.toml') {
  try {
    return parseToml(String(text));
  } catch (error) {
    const line = Number.isSafeInteger(error?.line) ? ` at line ${error.line}` : '';
    // smol-toml puts the reason on the first line, then a blank line, a source
    // excerpt and a caret. Keep only the reason: the popup collapses newlines
    // when it wraps text, so the excerpt would arrive as noise mashed onto the
    // end of the sentence.
    const reason = typeof error?.message === 'string'
      ? error.message.split('\n', 1)[0].trim()
      : '';
    const detail = reason.length > 0 && reason.length <= 160 ? `: ${reason}` : '';
    throw new ConfigError(`${fileName} is not valid TOML${line}${detail}`);
  }
}
```

- [ ] **Step 6: Run the codec tests**

Run: `node --test test/toml-config.test.mjs`
Expected: PASS — 14 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json herdr-plugin.toml src/plugin.mjs src/toml-config.mjs test/toml-config.test.mjs
git commit -m "feat: add a TOML codec for the command config

Every other file the user hand-edits in herdr is TOML, and JSON cannot hold a
comment, so a command could not be annotated or temporarily commented out. This
adds the read and render half of the move.

Parsing is delegated to smol-toml rather than hand-rolled: this file is
hand-edited, so the parser sees untrusted text where quoting, escapes and inline
comments all have to be right. It is the plugin's only runtime dependency, has
no transitive deps, and the manifest now runs npm ci before npm test so a fresh
install has it.

renderConfigToml is only for seeding a new file. Ordinary edits go through the
block-level writer added next, so comments survive a save."
```

---

## Task 14: Block-level TOML writer

**Files:**
- Create: `src/toml-edit.mjs`
- Test: `test/toml-edit.test.mjs`

**Interfaces:**
- Consumes: `src/toml-config.mjs` (`parseConfigToml`, `renderCommandBlock`).
- Produces:
  - `splitDocument(text: string): Array<{ kind: 'command' | 'opaque', text: string }>`
  - `joinDocument(segments): string`
  - `applyCommands(text: string, commands: Command[]): string`

Two invariants the tests pin down, and they are the reason this module exists:

1. `joinDocument(splitDocument(text)) === text` for any input. The splitter never loses or reorders a byte.
2. `applyCommands` only ever touches `command` segments. Every `opaque` segment — preamble, blank lines, comments between blocks, commented-out `[[commands]]` blocks — comes out byte-identical and in its original position.

A command whose fields all match its existing block keeps that block's original
text, so hand-formatting and in-block comments survive an unrelated edit.

- [ ] **Step 1: Write the failing test `test/toml-edit.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../src/schema.mjs';
import { parseConfigToml } from '../src/toml-config.mjs';
import { applyCommands, joinDocument, splitDocument } from '../src/toml-edit.mjs';

const HAND_WRITTEN = [
  'schema_version = 1',
  'editor = ["code"]',
  '',
  '# 자주 쓰는 것들',
  '[[commands]]',
  'id = "vscode"',
  'label = "Open in VS Code"',
  'type = "shell"',
  'command = "code ."',
  'cwd = "focused"',
  '',
  '[[commands]]',
  'id = "browse"',
  'label = "Open repo on GitHub"',
  'type = "shell"',
  'command = "gh browse"',
  'cwd = "focused"',
  '',
  '# 잠시 끔',
  '# [[commands]]',
  '# label = "Lazygit"',
  '# command = "lazygit"',
  '',
].join('\n');

function commandsOf(text) {
  return normalizeConfig(parseConfigToml(text)).commands;
}

function withField(commands, id, field, value) {
  return commands.map((command) => (command.id === id ? { ...command, [field]: value } : command));
}

test('splitDocument round-trips any document byte-for-byte', () => {
  for (const text of [
    HAND_WRITTEN,
    '',
    'editor = ["code"]\n',
    '[[commands]]\nid = "a"\n',
    '\n\n\n',
    '# only a comment',
    'no trailing newline',
  ]) {
    assert.equal(joinDocument(splitDocument(text)), text, JSON.stringify(text.slice(0, 30)));
  }
});

test('splitDocument finds each real block and leaves comments opaque', () => {
  const segments = splitDocument(HAND_WRITTEN);
  const commands = segments.filter((segment) => segment.kind === 'command');
  assert.equal(commands.length, 2);
  assert.ok(commands[0].text.startsWith('[[commands]]'));
  assert.ok(commands[0].text.includes('id = "vscode"'));
  // The commented-out block is never a command segment.
  assert.ok(segments.every((segment) => (
    segment.kind === 'opaque' || !segment.text.includes('# [[commands]]')
  )));
  assert.ok(joinDocument(segments.filter((s) => s.kind === 'opaque')).includes('# 잠시 끔'));
});

test('splitDocument ignores an indented or commented header', () => {
  const text = ['# [[commands]]', '  # [[commands]]', 'x = 1'].join('\n');
  assert.equal(splitDocument(text).filter((s) => s.kind === 'command').length, 0);
});

test('applyCommands is a no-op when nothing changed', () => {
  assert.equal(applyCommands(HAND_WRITTEN, commandsOf(HAND_WRITTEN)), HAND_WRITTEN);
});

test('editing one command leaves every other byte untouched', () => {
  const next = withField(commandsOf(HAND_WRITTEN), 'browse', 'label', 'Repo on GitHub');
  const result = applyCommands(HAND_WRITTEN, next);
  assert.ok(result.includes('# 자주 쓰는 것들'), 'preamble comment survived');
  assert.ok(result.includes('# 잠시 끔'), 'trailing comment survived');
  assert.ok(result.includes('# [[commands]]'), 'commented-out block survived');
  assert.ok(result.includes('label = "Repo on GitHub"'), 'edit applied');
  assert.ok(!result.includes('label = "Open repo on GitHub"'), 'old label gone');
  // The untouched block keeps its original text exactly.
  assert.ok(result.includes('id = "vscode"\nlabel = "Open in VS Code"'));
  assert.deepEqual(commandsOf(result).map((c) => c.label), ['Open in VS Code', 'Repo on GitHub']);
});

test('an unchanged block keeps hand-formatting the renderer would not produce', () => {
  const odd = [
    'editor = ["code"]',
    '',
    '[[commands]]',
    'label   =   "Spaced Out"   # why not',
    'type = "shell"',
    'command = "ls"',
    '',
  ].join('\n');
  const result = applyCommands(odd, commandsOf(odd));
  assert.ok(result.includes('label   =   "Spaced Out"   # why not'));
});

test('deleting a command removes only its block', () => {
  const next = commandsOf(HAND_WRITTEN).filter((command) => command.id !== 'vscode');
  const result = applyCommands(HAND_WRITTEN, next);
  assert.ok(!result.includes('id = "vscode"'));
  assert.ok(result.includes('id = "browse"'));
  assert.ok(result.includes('# 자주 쓰는 것들'), 'comment above the deleted block survived');
  assert.ok(result.includes('# [[commands]]'));
  assert.deepEqual(commandsOf(result).map((c) => c.id), ['browse']);
});

test('deleting every command keeps the preamble and the comments', () => {
  const result = applyCommands(HAND_WRITTEN, []);
  assert.ok(result.includes('editor = ["code"]'));
  assert.ok(result.includes('# 자주 쓰는 것들'));
  assert.ok(result.includes('# [[commands]]'));
  assert.deepEqual(commandsOf(result), []);
});

test('adding a command appends it and changes nothing before it', () => {
  const before = commandsOf(HAND_WRITTEN);
  const added = normalizeConfig({
    commands: [...before, { label: 'Lazygit', type: 'shell', command: 'lazygit' }],
  }).commands;
  const result = applyCommands(HAND_WRITTEN, added);
  assert.ok(result.startsWith(HAND_WRITTEN), 'the entire original document is preserved verbatim');
  assert.ok(result.includes('label = "Lazygit"'));
  assert.deepEqual(commandsOf(result).map((c) => c.label), [
    'Open in VS Code', 'Open repo on GitHub', 'Lazygit',
  ]);
  assert.ok(result.includes('# 잠시 끔'), 'the trailing comment is still there');
});

test('adding to a file with no blocks at all still parses', () => {
  const bare = 'schema_version = 1\neditor = ["code"]\n';
  const added = normalizeConfig({ commands: [{ label: 'Ls', type: 'shell', command: 'ls' }] }).commands;
  const result = applyCommands(bare, added);
  assert.ok(result.startsWith(bare));
  assert.deepEqual(commandsOf(result).map((c) => c.label), ['Ls']);
});

test('reordering emits the blocks in the new order', () => {
  const [first, second] = commandsOf(HAND_WRITTEN);
  const result = applyCommands(HAND_WRITTEN, [second, first]);
  assert.deepEqual(commandsOf(result).map((c) => c.id), ['browse', 'vscode']);
  assert.ok(result.includes('# [[commands]]'));
});

test('every applyCommands result re-parses to exactly the requested commands', () => {
  const base = commandsOf(HAND_WRITTEN);
  const cases = [
    base,
    [],
    base.slice(0, 1),
    withField(base, 'vscode', 'command', 'code -n .'),
    withField(base, 'browse', 'description', '설명 "인용" 포함'),
    normalizeConfig({ commands: [...base, { label: '새 커맨드', type: 'plugin_action', command: 'ray.file-explorer.open' }] }).commands,
  ];
  for (const commands of cases) {
    const result = applyCommands(HAND_WRITTEN, commands);
    assert.deepEqual(commandsOf(result), commands, JSON.stringify(commands.map((c) => c.id)));
  }
});

test('a hand-written block with no id keeps its formatting when untouched', () => {
  // Regression: matching on the raw `id` key meant any block a human wrote
  // (they do not write ids) was treated as new and silently reformatted.
  const noId = [
    'editor = ["code"]',
    '',
    '[[commands]]',
    'label   =   "Ls"      # aligned by hand',
    'type = "shell"',
    'command = "ls"',
    '',
    '[[commands]]',
    'label = "Browse"',
    'type = "shell"',
    'command = "gh browse"',
    '',
  ].join('\n');
  const commands = commandsOf(noId);
  // Edit only the second command; the first must come out byte-identical.
  const result = applyCommands(noId, withField(commands, 'browse', 'command', 'gh browse --branch main'));
  assert.ok(result.includes('label   =   "Ls"      # aligned by hand'));
  assert.ok(result.includes('command = "gh browse --branch main"'));
  assert.deepEqual(commandsOf(result).map((c) => c.command), ['ls', 'gh browse --branch main']);
});

test('a block the user wrote without an id is still matched and editable', () => {
  const noId = [
    'editor = ["code"]',
    '',
    '[[commands]]',
    'label = "Ls"',
    'type = "shell"',
    'command = "ls"',
    '',
  ].join('\n');
  const commands = commandsOf(noId);
  assert.equal(commands[0].id, 'ls');
  const result = applyCommands(noId, withField(commands, 'ls', 'command', 'ls -la'));
  assert.deepEqual(commandsOf(result).map((c) => c.command), ['ls -la']);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/toml-edit.test.mjs`
Expected: FAIL — `Cannot find module '.../src/toml-edit.mjs'`.

- [ ] **Step 3: Write `src/toml-edit.mjs`**

```js
import { normalizeConfig } from './schema.mjs';
import { parseConfigToml, renderCommandBlock } from './toml-config.mjs';

// Only a bare, unindented header starts a block. `# [[commands]]` and any
// indented variant stay in opaque text, which is what lets a user comment a
// command out and have it survive every popup save.
const HEADER = /^\[\[commands\]\][ \t]*$/;
const COMPARED_KEYS = Object.freeze(['id', 'label', 'type', 'command', 'cwd', 'description']);

function isBlankOrComment(line) {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith('#');
}

// Trailing blank/comment lines belong to whatever comes next, not to the block
// above them — otherwise deleting the last command would take the user's
// commented-out block with it.
function peelTrailer(lines) {
  let end = lines.length;
  while (end > 1 && isBlankOrComment(lines[end - 1])) end -= 1;
  return { body: lines.slice(0, end), trailer: lines.slice(end) };
}

export function splitDocument(text) {
  const lines = String(text).split('\n');
  const segments = [];
  let pending = [];
  let block = null;
  const flushPending = () => {
    if (pending.length === 0) return;
    segments.push({ kind: 'opaque', text: pending.join('\n') });
    pending = [];
  };
  const flushBlock = () => {
    if (block === null) return;
    const { body, trailer } = peelTrailer(block);
    segments.push({ kind: 'command', text: body.join('\n') });
    block = null;
    pending = trailer;
  };
  for (const line of lines) {
    if (HEADER.test(line)) {
      flushBlock();
      flushPending();
      block = [line];
      continue;
    }
    if (block === null) pending.push(line);
    else block.push(line);
  }
  flushBlock();
  flushPending();
  return segments;
}

export function joinDocument(segments) {
  return segments.map((segment) => segment.text).join('\n');
}

function sameCommand(left, right) {
  if (!left || !right) return false;
  return COMPARED_KEYS.every((key) => left[key] === right[key]);
}

export function applyCommands(text, commands) {
  const segments = splitDocument(text);
  const slots = segments.filter((segment) => segment.kind === 'command');

  // Normalize the whole original document once, so each block's identity is
  // derived exactly the way the loader derived it, and slot N corresponds to
  // previous[N]. Reading the raw `id` key out of each block instead would fail
  // for every hand-written block that omits it — which is most of them — and
  // would silently reformat the user's file on the next save.
  let previous = [];
  try {
    previous = normalizeConfig(parseConfigToml(text)).commands;
  } catch {
    previous = [];
  }

  // Reuse the block a command already occupied so an untouched command keeps its
  // original text, and an edited one is rewritten in place.
  const claimed = new Set();
  const rendered = commands.map((command) => {
    const position = previous.findIndex((entry, index) => (
      !claimed.has(index) && index < slots.length && entry.id === command.id
    ));
    if (position < 0) return renderCommandBlock(command).replace(/\n$/u, '');
    claimed.add(position);
    return sameCommand(previous[position], command)
      ? slots[position].text
      : renderCommandBlock(command).replace(/\n$/u, '');
  });

  // Walk the original document, feeding the new blocks into the slots the old
  // ones occupied. Opaque segments are copied untouched, in place.
  const output = [];
  let next = 0;
  for (const segment of segments) {
    if (segment.kind === 'opaque') {
      output.push(segment);
      continue;
    }
    if (next < rendered.length) {
      output.push({ kind: 'command', text: rendered[next] });
      next += 1;
    }
    // Otherwise this slot's command was deleted: emit nothing.
  }
  // Anything left over is new; append it after a blank line. Segments join with
  // "\n", so an empty opaque segment is exactly one blank line — and when the
  // document already ends in one, no separator is needed.
  while (next < rendered.length) {
    if (output.length > 0 && !joinDocument(output).endsWith('\n')) {
      output.push({ kind: 'opaque', text: '' });
    }
    output.push({ kind: 'command', text: rendered[next] });
    next += 1;
  }
  const joined = joinDocument(output);
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}
```

- [ ] **Step 4: Run the writer tests**

Run: `node --test test/toml-edit.test.mjs`
Expected: PASS — 14 tests.

If any test fails, fix `src/toml-edit.mjs` — not the test. These tests encode the
promise made to the user about their comments; a failure here means the writer is
wrong, and this is the one module in the plugin where a bug damages a file the
user wrote by hand.

- [ ] **Step 5: Commit**

```bash
git add src/toml-edit.mjs test/toml-edit.test.mjs
git commit -m "feat: edit commands.toml a block at a time so comments survive

Re-rendering the whole file on save would drop every comment, which would make
TOML strictly worse than the JSON it replaces: it would invite annotations and
then eat them. So the writer splits the document into [[commands]] blocks and
opaque text, and only ever replaces, removes, or appends a block. Preamble,
blank lines, comments between blocks, and commented-out blocks come out
byte-identical and in place.

A command whose fields all match its existing block keeps that block's original
text, so hand-formatting survives an edit to some other command. Only a block
the popup actually rewrites loses the comments inside it.

Two invariants are tested directly: the splitter round-trips any document
byte-for-byte, and every applyCommands result re-parses to exactly the requested
command list."
```

---

## Task 15: Read and write commands.toml, and migrate the old JSON

**Files:**
- Modify: `src/paths.mjs` (add `legacyCommandsPath`), `src/store.mjs` (TOML + migration), `src/schema.mjs` (drop the JSON serializer), `bin/popup.mjs` and `src/render.mjs` (error copy)
- Test: `test/store.test.mjs` (rewritten for TOML), `test/paths.test.mjs` (one added case), `test/schema.test.mjs` (drop the `serializeConfig` case), and `test/render.test.mjs`, `test/popup.test.mjs`, `test/actions.test.mjs`, `test/manifest.test.mjs` (copy that names the file)

**Interfaces:**
- Consumes: `src/toml-config.mjs` (`parseConfigToml`, `renderConfigToml`), `src/toml-edit.mjs` (`applyCommands`).
- Produces:
  - `legacyCommandsPath(configDir: string): string`
  - `loadStore`, `saveStore`, `ensureStore` keep their exact signatures from Task 4. Only the on-disk format changes.

Behaviour changes, precisely:
- `loadStore` reads `commands.toml` and parses TOML. `raw` is still the file text.
- `saveStore(file, doc, { expectedRaw })` — when `expectedRaw` is a string **and** the parsed `editor` still matches `doc.editor`, it produces the new text with `applyCommands(expectedRaw, doc.commands)`, so comments survive. Otherwise it falls back to `renderConfigToml(doc)`.
- `ensureStore` — if `commands.toml` is absent but `commands.json` exists, it converts the JSON, writes the TOML, then renames the JSON to `commands.json.bak`. Nothing is deleted.
- `serializeConfig` is removed from `src/schema.mjs`; `renderConfigToml` replaces it. Keeping a JSON serializer around would invite writing the wrong format.

- [ ] **Step 1: Add `legacyCommandsPath` to `src/paths.mjs`**

Add the import and the export (leave everything else untouched):

```js
import { CONFIG_FILE_NAME, LEGACY_CONFIG_FILE_NAME, MAX_PATH_BYTES, PLUGIN_ID, RUN_LOG_FILE_NAME } from './plugin.mjs';
```

```js
export function legacyCommandsPath(configDir) {
  return join(configDir, LEGACY_CONFIG_FILE_NAME);
}
```

- [ ] **Step 2: Add the path test**

Append to `test/paths.test.mjs`:

```js
test('legacyCommandsPath points at the pre-TOML file name', () => {
  assert.equal(legacyCommandsPath('/tmp/cfg'), join('/tmp/cfg', 'commands.json'));
  assert.equal(commandsPath('/tmp/cfg'), join('/tmp/cfg', 'commands.toml'));
});
```

and extend that file's import to include `legacyCommandsPath`.

Also repair the pre-existing test in that file, `path helpers append the known
file names` — Task 13 changed `CONFIG_FILE_NAME`, so its expectation is already
stale. Change its `commandsPath` expectation from `commands.json` to
`commands.toml`. Miss this and the task ends with two failures instead of one.

Run: `node --test test/paths.test.mjs`
Expected: FAIL — `legacyCommandsPath is not a function` (before Step 1) or PASS (after).

- [ ] **Step 3: Drop the JSON serializer from `src/schema.mjs`**

Delete this function entirely:

```js
export function serializeConfig(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
```

and delete the `serializeConfig` test from `test/schema.test.mjs` (the one named
`serializeConfig writes stable indented JSON with a trailing newline`) plus its
name from that file's import list. The round-trip guarantee it provided now lives
in `test/toml-config.test.mjs`.

- [ ] **Step 4: Replace `test/store.test.mjs`**

```js
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConfigError, defaultConfig, normalizeConfig } from '../src/schema.mjs';
import { parseConfigToml, renderConfigToml } from '../src/toml-config.mjs';
import { ensureStore, loadStore, saveStore } from '../src/store.mjs';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-store-'));
  return { dir, file: join(dir, 'commands.toml'), legacy: join(dir, 'commands.json') };
}

test('loadStore returns the seeded default when the file is absent', async () => {
  const { file } = await scratch();
  const loaded = await loadStore(file);
  assert.deepEqual(loaded.doc, defaultConfig());
  assert.equal(loaded.raw, null);
});

test('loadStore reads and normalizes an existing TOML file', async () => {
  const { file } = await scratch();
  await writeFile(file, [
    'editor = ["code"]',
    '',
    '# 자주 쓰는 것',
    '[[commands]]',
    'label = "Ls"',
    'type = "shell"',
    'command = "ls"',
    '',
  ].join('\n'), 'utf8');
  const loaded = await loadStore(file);
  assert.equal(loaded.doc.commands.length, 1);
  assert.equal(loaded.doc.commands[0].id, 'ls');
  assert.equal(loaded.doc.commands[0].cwd, 'focused');
  assert.deepEqual(loaded.doc.editor, ['code']);
  assert.ok(loaded.raw.includes('# 자주 쓰는 것'));
});

test('loadStore reports malformed TOML as a ConfigError naming the file', async () => {
  const { file } = await scratch();
  await writeFile(file, '[[commands]]\nlabel = ', 'utf8');
  await assert.rejects(loadStore(file), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /commands\.toml/u);
    assert.match(error.message, /not valid TOML/u);
    return true;
  });
});

test('loadStore surfaces schema failures with the file name', async () => {
  const { file } = await scratch();
  await writeFile(file, '[[commands]]\nlabel = "a"\ntype = "nope"\ncommand = "b"\n', 'utf8');
  await assert.rejects(loadStore(file), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /commands\.toml/u);
    assert.match(error.message, /commands\[0\]/u);
    return true;
  });
});

test('ensureStore writes the seed file exactly once', async () => {
  const { file } = await scratch();
  const first = await ensureStore(file);
  assert.deepEqual(first.doc, defaultConfig());
  assert.equal(await readFile(file, 'utf8'), renderConfigToml(defaultConfig()));

  await writeFile(file, 'editor = ["code"]\n', 'utf8');
  const second = await ensureStore(file);
  assert.deepEqual(second.doc.commands, []);
});

test('ensureStore migrates a pre-TOML commands.json and keeps a backup', async () => {
  const { dir, file, legacy } = await scratch();
  await writeFile(legacy, JSON.stringify({
    schema_version: 1,
    editor: ['code', '-g'],
    commands: [{ id: 'ls', label: 'Ls', type: 'shell', command: 'ls', cwd: 'workspace', description: 'list' }],
  }), 'utf8');

  const migrated = await ensureStore(file);
  assert.deepEqual(migrated.doc.editor, ['code', '-g']);
  assert.deepEqual(migrated.doc.commands.map((command) => command.id), ['ls']);
  assert.equal(migrated.doc.commands[0].cwd, 'workspace');

  const written = await readFile(file, 'utf8');
  assert.ok(written.includes('[[commands]]'));
  assert.deepEqual(normalizeConfig(parseConfigToml(written)), migrated.doc);

  const entries = (await readdir(dir)).sort();
  assert.deepEqual(entries, ['commands.json.bak', 'commands.toml']);
});

test('ensureStore does not migrate when a TOML file already exists', async () => {
  const { file, legacy } = await scratch();
  await writeFile(file, 'editor = ["code"]\n', 'utf8');
  await writeFile(legacy, JSON.stringify({ commands: [{ label: 'Old', type: 'shell', command: 'old' }] }), 'utf8');
  const loaded = await ensureStore(file);
  assert.deepEqual(loaded.doc.commands, []);
  assert.equal(await readFile(legacy, 'utf8').then((t) => t.includes('Old')), true);
});

test('ensureStore falls back to the seed when the legacy file is unusable', async () => {
  const { file, legacy } = await scratch();
  await writeFile(legacy, '{ broken', 'utf8');
  const loaded = await ensureStore(file);
  assert.deepEqual(loaded.doc, defaultConfig());
  assert.ok((await readFile(file, 'utf8')).includes('[[commands]]'));
});

test('saveStore writes atomically and leaves no temp files behind', async () => {
  const { dir, file } = await scratch();
  const doc = normalizeConfig({ commands: [] });
  const saved = await saveStore(file, doc);
  assert.equal(saved.raw, renderConfigToml(doc));
  assert.deepEqual(await readdir(dir), ['commands.toml']);
});

test('saveStore preserves comments and untouched blocks when given the loaded text', async () => {
  const { file } = await scratch();
  const original = [
    'schema_version = 1',
    'editor = ["code"]',
    '',
    '# 자주 쓰는 것들',
    '[[commands]]',
    'id = "ls"',
    'label = "Ls"',
    'type = "shell"',
    'command = "ls"',
    '',
    '# 잠시 끔',
    '# [[commands]]',
    '# label = "Lazygit"',
    '',
  ].join('\n');
  await writeFile(file, original, 'utf8');
  const loaded = await loadStore(file);
  const next = {
    ...loaded.doc,
    commands: loaded.doc.commands.map((command) => ({ ...command, command: 'ls -la' })),
  };
  const saved = await saveStore(file, next, { expectedRaw: loaded.raw });
  const text = await readFile(file, 'utf8');
  assert.equal(text, saved.raw);
  assert.ok(text.includes('# 자주 쓰는 것들'), 'comment above the block survived');
  assert.ok(text.includes('# 잠시 끔'), 'trailing comment survived');
  assert.ok(text.includes('# [[commands]]'), 'commented-out block survived');
  assert.ok(text.includes('command = "ls -la"'), 'the edit landed');
  assert.deepEqual(normalizeConfig(parseConfigToml(text)).commands, next.commands);
});

test('saveStore full-renders when there is no prior text to splice into', async () => {
  const { file } = await scratch();
  const doc = normalizeConfig({ commands: [{ label: 'Ls', type: 'shell', command: 'ls' }] });
  const saved = await saveStore(file, doc, { expectedRaw: null });
  assert.equal(saved.raw, renderConfigToml(doc));
});

test('saveStore full-renders when the editor key changes', async () => {
  const { file } = await scratch();
  await writeFile(file, 'editor = ["code"]\n\n# a comment\n', 'utf8');
  const loaded = await loadStore(file);
  const next = { ...loaded.doc, editor: ['vim'] };
  const saved = await saveStore(file, next, { expectedRaw: loaded.raw });
  assert.equal(saved.raw, renderConfigToml(next));
  assert.ok(!saved.raw.includes('# a comment'), 'a full re-render cannot keep comments');
});

test('saveStore normalizes before writing', async () => {
  const { file } = await scratch();
  await saveStore(file, { commands: [{ label: '  Ls  ', type: 'shell', command: 'ls' }] });
  const written = normalizeConfig(parseConfigToml(await readFile(file, 'utf8')));
  assert.equal(written.commands[0].label, 'Ls');
  assert.equal(written.schema_version, 1);
});

test('saveStore refuses to clobber an external edit', async () => {
  const { file } = await scratch();
  const first = await saveStore(file, normalizeConfig({ commands: [] }));
  await writeFile(file, `${first.raw}\n# added behind our back\n`, 'utf8');
  await assert.rejects(
    saveStore(file, normalizeConfig({ commands: [{ label: 'New', type: 'shell', command: 'ls' }] }), { expectedRaw: first.raw }),
    (error) => error instanceof ConfigError && /changed on disk/u.test(error.message),
  );
});

test('saveStore rejects an invalid document without touching the file', async () => {
  const { file } = await scratch();
  const good = await saveStore(file, normalizeConfig({ commands: [] }));
  await assert.rejects(
    saveStore(file, { commands: [{ label: 'a', type: 'nope', command: 'b' }] }, { expectedRaw: good.raw }),
    ConfigError,
  );
  assert.equal(await readFile(file, 'utf8'), good.raw);
});
```

- [ ] **Step 5: Run it to confirm it fails**

Run: `node --test test/store.test.mjs`
Expected: FAIL — `src/store.mjs` still imports `serializeConfig` (now deleted) and writes JSON.

- [ ] **Step 6: Rewrite `src/store.mjs`**

```js
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { LEGACY_CONFIG_FILE_NAME } from './plugin.mjs';
import { ConfigError, defaultConfig, normalizeConfig } from './schema.mjs';
import { parseConfigToml, renderConfigToml } from './toml-config.mjs';
import { applyCommands } from './toml-edit.mjs';

async function readRaw(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ConfigError(`${basename(file)} could not be read (${error?.code ?? 'unknown error'})`);
  }
}

function normalizeNamed(parsed, file) {
  try {
    return normalizeConfig(parsed);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new ConfigError(`${basename(file)}: ${error.message}`);
  }
}

export async function loadStore(file) {
  const raw = await readRaw(file);
  if (raw === null) return { doc: defaultConfig(), raw: null };
  return { doc: normalizeNamed(parseConfigToml(raw, basename(file)), file), raw };
}

async function writeAtomic(file, raw) {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  // Write-then-rename so a crash mid-write can never leave a half-written config
  // that the next popup would refuse to load.
  const temporary = join(directory, `.${basename(file)}.${process.pid}.tmp`);
  await writeFile(temporary, raw, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}

export async function saveStore(file, doc, { expectedRaw = null } = {}) {
  const normalized = normalizeConfig(doc);
  if (typeof expectedRaw === 'string') {
    const current = await readRaw(file);
    if (current !== null && current !== expectedRaw) {
      throw new ConfigError(
        `${basename(file)} changed on disk since it was loaded; reopen Command Center to pick up the new file`,
      );
    }
  }
  // Splice individual [[commands]] blocks into the text we loaded so the user's
  // comments, ordering and spacing survive. Only fall back to a whole-file
  // render when there is no prior text, or when something outside the command
  // blocks changed and a splice could not express it.
  let raw;
  if (typeof expectedRaw === 'string') {
    let previousEditor = null;
    try {
      previousEditor = normalizeConfig(parseConfigToml(expectedRaw, basename(file))).editor;
    } catch {
      previousEditor = null;
    }
    const editorUnchanged = Array.isArray(previousEditor)
      && previousEditor.length === normalized.editor.length
      && previousEditor.every((entry, index) => entry === normalized.editor[index]);
    raw = editorUnchanged
      ? applyCommands(expectedRaw, normalized.commands)
      : renderConfigToml(normalized);
  } else {
    raw = renderConfigToml(normalized);
  }
  await writeAtomic(file, raw);
  return { raw };
}

// Tasks 1-12 shipped commands.json. Convert it once, and rename rather than
// delete it: this is a file the user may have hand-written.
async function migrateLegacy(file) {
  const legacy = join(dirname(file), LEGACY_CONFIG_FILE_NAME);
  const raw = await readRaw(legacy).catch(() => null);
  if (raw === null) return null;
  let doc;
  try {
    doc = normalizeConfig(JSON.parse(raw));
  } catch {
    return null;
  }
  await writeAtomic(file, renderConfigToml(doc));
  await rename(legacy, `${legacy}.bak`).catch(() => {});
  return doc;
}

export async function ensureStore(file) {
  const loaded = await loadStore(file);
  if (loaded.raw !== null) return { doc: loaded.doc, raw: loaded.raw };
  const migrated = await migrateLegacy(file);
  if (migrated) {
    const raw = await readRaw(file);
    return { doc: migrated, raw: raw ?? renderConfigToml(migrated) };
  }
  const saved = await saveStore(file, loaded.doc);
  return { doc: loaded.doc, raw: saved.raw };
}
```

- [ ] **Step 7: Run the store tests**

Run: `node --test test/store.test.mjs`
Expected: PASS — 15 tests.

- [ ] **Step 8: Update the copy that names the file**

Four places still say `commands.json`. Change each to `commands.toml`: two in `src/render.mjs`, one in `src/schema.mjs`, one in `bin/popup.mjs`, plus the header comment in `bin/edit-config.mjs`:

In `src/render.mjs`, the empty-list line:

```js
    lines.push(...wrap('Press a to add one, or o to open commands.toml in your editor.', width));
```

and the error-mode fallback:

```js
    ...wrap(view.error ?? 'commands.toml could not be loaded', width),
```

In `src/schema.mjs`, the top-level shape message:

```js
    throw new ConfigError('commands.toml must contain a TOML table');
```

In `bin/popup.mjs`, the non-ConfigError diagnostic:

```js
      diagnostic(stderr, 'commands.toml could not be opened');
```

Then update the assertions that pinned the old copy. Do the mechanical part with
this script rather than by hand, so nothing is missed or half-renamed:

```bash
python3 - <<'RENAME'
import pathlib
for name in ('test/render.test.mjs', 'test/popup.test.mjs', 'test/actions.test.mjs'):
    p = pathlib.Path(name)
    s = p.read_text(encoding='utf8')
    s = s.replace('commands.json', 'commands.toml')
    p.write_text(s, encoding='utf8')
    print('renamed in', name)
RENAME
```

The script does **not** fix escaped regex forms: `commands.json` is not a
substring of `commands\.json`, because the backslash sits between them. Fix those
by hand. In `test/render.test.mjs` there are two, in the invalid-config tests:

- `/commands\.json/u` becomes `/commands\.toml/u`
- `/commands\.json is not valid JSON/u` becomes `/commands\.toml is not valid TOML/u`

Afterwards `grep -rn 'commands\\.json' test/` must print only
`test/paths.test.mjs` (whose `legacyCommandsPath` assertion is meant to keep the
old name).

Then three edits in `test/popup.test.mjs` that a rename cannot do:

1. Both malformed-config fixtures must become malformed *TOML*. Replace each
   `await writeFile(file, '{ broken', 'utf8');`
   with
   `await writeFile(file, '[[commands]]\nlabel = ', 'utf8');`
   and in the test asserting the file was not overwritten, change that test's
   expected value from `'{ broken'` to `'[[commands]]\nlabel = '`.
2. The seeded-file test compares against a rendered file. Change
   `serializeConfig(defaultConfig())` to `renderConfigToml(defaultConfig())`.
3. The custom-editor test builds a config file. Change
   `serializeConfig({ schema_version: 1, editor: ['code', '--new-window'], commands: [] })`
   to
   `renderConfigToml(normalizeConfig({ editor: ['code', '--new-window'], commands: [] }))`.
4. There is a **third** `serializeConfig(...)` call, in the external-edit-collision
   test. Convert it the same way.
5. Three tests read the file back with `JSON.parse(await readFile(file, 'utf8'))`
   (the add, delete, and edit tests). That throws on TOML. Replace each with
   `normalizeConfig(parseConfigToml(await readFile(file, 'utf8')))` and import
   `parseConfigToml` from `../src/toml-config.mjs`.
6. One assertion checks the parse-failure copy: `/not valid JSON/u` becomes
   `/not valid TOML/u`.

Then fix that file's imports: drop `serializeConfig` from the `../src/schema.mjs`
import, add `normalizeConfig` to it, and add
`import { renderConfigToml } from '../src/toml-config.mjs';`.

`test/actions.test.mjs` needs the same treatment, because its `editConfig` tests
build a real config file:

1. Change `serializeConfig({ schema_version: 1, editor: ['code', '-g'], commands: [] })`
   to `renderConfigToml(normalizeConfig({ editor: ['code', '-g'], commands: [] }))`.
2. In the broken-file test, change `writeFile(join(dir, 'commands.toml'), '{ broken', 'utf8')`
   to `writeFile(join(dir, 'commands.toml'), '[[commands]]\nlabel = ', 'utf8')`.
3. Replace its `serializeConfig` import with
   `import { normalizeConfig } from '../src/schema.mjs';` and
   `import { renderConfigToml } from '../src/toml-config.mjs';`.

`test/manifest.test.mjs` asserts the config file name; Task 16 Step 2 updates it,
so this task leaves that single failure standing and Task 16 clears it. Note that
when you finish this task the suite will still have exactly that one failure.

`test/schema.test.mjs` needs no copy change — the shape-rejection test asserts
nothing about that message. Confirm by running it.
- [ ] **Step 9: Run the whole suite**

Run: `npm test`
Expected: **232 tests, 1 fail** — the remaining failure is
`manifest identity matches the shared plugin constants`, which pins the config file
name and is updated in Task 16 Step 2. Every other test must pass. The total moves
from 199 to **232**: `serializeConfig`'s test is gone (−1), `test/store.test.mjs` grows from 10 to 15 (+5), `test/paths.test.mjs` grows from 7 to 8 (+1), and the two new files add 14 + 14 (+28). If your count differs, do not adjust a test to reach it — report the discrepancy with the failing or unexpected test names.

- [ ] **Step 10: Commit**

```bash
git add src/paths.mjs src/store.mjs src/schema.mjs src/render.mjs bin/popup.mjs bin/edit-config.mjs test/paths.test.mjs test/store.test.mjs test/schema.test.mjs test/render.test.mjs test/popup.test.mjs test/actions.test.mjs
git commit -m "feat: store the command list in commands.toml

The popup now reads TOML and, on save, splices only the [[commands]] blocks it
changed back into the text it loaded — so a comment, a hand-formatted block, or a
commented-out command survives an edit made through the popup. A whole-file
render is kept for two cases only: seeding a new file, and a change to the editor
key that a block splice cannot express.

A commands.json left by an earlier version is converted once on first open and
renamed to commands.json.bak rather than deleted, because the user may have
hand-written it.

serializeConfig is deleted rather than left unused: keeping a JSON serializer in
the module that owns the config shape would invite writing the wrong format."
```

---

## Task 16: Documentation and re-verification

**Files:**
- Modify: `README.md`, `README.ko.md`, `herdr-plugin.toml` (the `edit-config` action title names the config file, and herdr shows it in the action list), `test/manifest.test.mjs`
- Test: `test/manifest.test.mjs`

- [ ] **Step 1: Update both READMEs**

In **both** files, make these changes:

1. Every `commands.json` becomes `commands.toml`, including in the troubleshooting and actions sections.
2. Replace the JSON config example with the TOML equivalent:

```toml
schema_version = 1
editor = ["code"]

# the ones I actually use
[[commands]]
id = "open-in-vs-code"
label = "Open in VS Code"
type = "shell"
command = "code ."
cwd = "focused"
description = "Open the focused pane's directory in VS Code"

[[commands]]
label = "File explorer"
type = "plugin_action"
command = "ray.file-explorer.open"

# [[commands]]                 <- commented out for now
# label = "Lazygit"
# type = "shell"
# command = "lazygit"
```

3. Replace the paragraph that begins "The file is only ever written atomically" with this (English):

> The file is only ever written atomically, and the popup refuses to save if the
> file changed on disk since it was opened — so editing it in VS Code while the
> popup is open cannot lose your edits.
>
> **Your comments survive.** The popup does not re-render the file; it replaces,
> removes, or appends individual `[[commands]]` blocks. Your header, blank lines,
> comments between blocks, and commented-out blocks are left byte-for-byte alone,
> and a command you did not touch keeps its original formatting. The one
> exception: comments *inside* a block you edit through the popup are lost,
> because that block is rewritten.
>
> A malformed file opens the popup in an error mode that names the problem and
> still lets you press `o` to go fix it; it is never overwritten.

and the Korean equivalent:

> 파일은 항상 원자적으로 기록되고, 팝업을 연 뒤 파일이 디스크에서 바뀌었다면 저장을
> 거부합니다. 팝업을 열어둔 채 VS Code에서 편집해도 그 편집이 사라지지 않습니다.
>
> **주석은 유지됩니다.** 팝업은 파일을 다시 렌더링하지 않고 `[[commands]]` 블록만
> 교체·삭제·추가합니다. 헤더, 빈 줄, 블록 사이 주석, 주석 처리해 둔 블록은 바이트
> 단위로 그대로 남고, 건드리지 않은 커맨드는 원래 서식을 유지합니다. 예외는 하나:
> 팝업에서 수정한 블록 *안쪽*의 주석은 그 블록이 다시 쓰이므로 사라집니다.
>
> 형식이 깨진 파일은 무엇이 문제인지 알려주는 에러 화면으로 열리고, 그 화면에서도
> `o`로 고치러 갈 수 있습니다. 깨진 파일을 덮어쓰지는 않습니다.

4. In the field table, change the `id` row to note that omitting it is fine and add a `schema_version` row. English:

| `schema_version` | Always `1`. |

Korean:

| `schema_version` | 항상 `1`. |

5. Add a migration note directly under the config-file heading. English:

> Upgrading from a version that used `commands.json`? The first time you open the
> popup it converts your file to `commands.toml` and renames the original to
> `commands.json.bak`. Nothing is deleted.

Korean:

> `commands.json`을 쓰던 버전에서 올라오셨다면, 팝업을 처음 열 때 `commands.toml`로
> 변환하고 원본은 `commands.json.bak`으로 이름만 바꿔 둡니다. 삭제하지 않습니다.

6. In the Installation section of both, note the dependency. English: "Requires Node.js 22+ and herdr 0.7.5+. `herdr plugin install` runs `npm ci` for you." Korean: "Node.js 22+ 와 herdr 0.7.5+ 가 필요합니다. `herdr plugin install` 이 `npm ci` 를 대신 실행합니다."

- [ ] **Step 2: Update the manifest tests**

In `test/manifest.test.mjs`, change the existing `CONFIG_FILE_NAME` assertion:

```js
  assert.equal(CONFIG_FILE_NAME, 'commands.toml');
```

Change the build-pipeline test to require the `npm ci` gate and to require it before `npm test`:

```js
test('manifest build pipeline checks Node, installs deps, then runs the tests', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  assert.match(text, /Node\.js >= 22 required/);
  assert.match(text, /command = \["npm", "ci"\]/);
  assert.match(text, /command = \["npm", "test"\]/);
  assert.ok(
    text.indexOf('["npm", "ci"]') < text.indexOf('["npm", "test"]'),
    'npm ci must run before npm test or a fresh install has no dependencies',
  );
});
```

Change the config-field doc test to cover the TOML shape and the migration note:

```js
test('both READMEs document every config field and the migration', async () => {
  for (const name of ['README.md', 'README.ko.md']) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    for (const field of ['schema_version', 'editor', 'label', 'plugin_action', 'focused', 'workspace', 'description']) {
      assert.ok(text.includes(field), `${name} does not document ${field}`);
    }
    assert.ok(text.includes('[[commands]]'), `${name} does not show the TOML block shape`);
    assert.ok(text.includes('commands.json.bak'), `${name} does not explain the migration`);
    // One mention is the migration sentence itself; more than that means a stale
    // reference is still lying around in the troubleshooting or actions section.
    const stale = (text.replace(/commands\.json\.bak/gu, '').match(/commands\.json/gu) ?? []).length;
    assert.ok(stale <= 1, `${name} refers to commands.json ${stale} times outside the migration note`);
  }
});
```

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: PASS — 232 tests, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add README.md README.ko.md test/manifest.test.mjs
git commit -m "docs: document the TOML config and what survives a popup save

The comment-preservation contract is the reason this file is TOML at all, so both
READMEs now state it precisely, including the one exception (comments inside a
block the popup rewrites). The example config shows a commented-out command,
since that is the workflow JSON could not support.

Manifest tests now require the npm ci build step to come before npm test — a
fresh 'herdr plugin install' would otherwise run the suite with no smol-toml —
and assert that neither README still points at commands.json outside the
migration note."
```

- [ ] **Step 5: Relink and re-verify against the live herdr**

```bash
herdr plugin link /Users/cdragon/Desktop/Programming/side/herdr-command-center
herdr plugin list | grep -A1 command-center
```

Expected: the link succeeds, which means `npm ci` and `npm test` both passed as build gates.

- [ ] **Step 6: Verify the migration on the real config directory**

The live config dir already holds a `commands.json` from the previous version.

```bash
CFG=$(herdr plugin config-dir cdragon.command-center)
ls -1 "$CFG"
node -e "import('./src/store.mjs').then(async ({ensureStore}) => {
  const r = await ensureStore(process.argv[1]);
  console.log('commands:', r.doc.commands.map((c) => c.id).join(', '));
});" "$CFG/commands.toml"
ls -1 "$CFG"
cat "$CFG/commands.toml"
```

Expected: before, `commands.json`; after, both `commands.toml` and
`commands.json.bak`, with the three commands intact and rendered as
`[[commands]]` blocks.

- [ ] **Step 7: Prove comment preservation on the real file**

```bash
CFG=$(herdr plugin config-dir cdragon.command-center)
python3 - "$CFG/commands.toml" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text(encoding='utf8')
p.write_text(text.replace('[[commands]]', '# 자주 쓰는 것들\n[[commands]]', 1)
             + '\n# [[commands]]\n# label = "Lazygit"\n', encoding='utf8')
print('added a comment and a commented-out block')
PY
node -e "
import('./src/store.mjs').then(async ({loadStore, saveStore}) => {
  const file = process.argv[1];
  const loaded = await loadStore(file);
  const next = { ...loaded.doc, commands: loaded.doc.commands.map((c, i) =>
    (i === 0 ? { ...c, description: '팝업에서 바꾼 설명' } : c)) };
  await saveStore(file, next, { expectedRaw: loaded.raw });
  console.log('saved through the popup path');
});" "$CFG/commands.toml"
grep -c "자주 쓰는 것들" "$CFG/commands.toml"
grep -c "# \[\[commands\]\]" "$CFG/commands.toml"
grep -c "팝업에서 바꾼 설명" "$CFG/commands.toml"
```

Expected: all three greps print `1` — the comment survived, the commented-out
block survived, and the edit landed.

---
