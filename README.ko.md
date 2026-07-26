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
| `↑` `↓` / `k` `j` | 선택 이동 | 이전 / 다음 필드 |
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
