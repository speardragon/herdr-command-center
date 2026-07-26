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

Requires Node.js 22+ and herdr 0.7.5+. `herdr plugin install` runs `npm ci` for you.

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
| `o` | open `commands.toml` in your editor | — |
| `Esc` | close the popup | discard and go back |
| `Ctrl-C` | close the popup | close the popup |

Badges are **absolute positions**: `3` always runs the third command in the
file, no matter how far the list has scrolled. Commands past the ninth have no
badge and are reached with the arrow keys.

## The config file

> Upgrading from a version that used commands.json. The first time you open the
> popup it converts your file to `commands.toml` and renames the original to
> `commands.json.bak`. Nothing is deleted.

Everything the popup edits lives in one TOML file you are meant to edit by hand
too. Press `o` in the popup, or run the action directly:

```bash
herdr plugin action invoke edit-config --plugin cdragon.command-center
```

Its path:

```bash
herdr plugin config-dir cdragon.command-center
# → <that directory>/commands.toml
```

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

| Field | Meaning |
| --- | --- |
| `schema_version` | Always `1`. |
| `editor` | argv used for the `o` key and the `edit-config` action. Defaults to `["code"]`. |
| `id` | stable identifier. Omit it and one is derived from the label (Korean labels keep readable ids). |
| `label` | what the popup shows. Up to 80 characters. |
| `type` | `shell` or `plugin_action`. |
| `command` | for `shell`, a single-line shell command; for `plugin_action`, `<plugin_id>.<action_id>`. |
| `cwd` | `focused` (default), `workspace`, or an absolute path. Ignored for `plugin_action`. |
| `description` | optional one-line note shown under the list. |

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

### Anything herdr can do

`type` is deliberately just `shell` and `plugin_action`, because a `shell`
command can call the `herdr` CLI and therefore do anything herdr does:

```toml
[[commands]]
label = "Lazygit in a split"
type = "shell"
command = "herdr plugin pane open --plugin ray.file-explorer --entrypoint explorer --placement split"
```

## Actions

| Action | What it does |
| --- | --- |
| `herdr plugin action invoke open --plugin cdragon.command-center` | open the popup |
| `herdr plugin action invoke edit-config --plugin cdragon.command-center` | open `commands.toml` in your editor |

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
