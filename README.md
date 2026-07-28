# Command Center

[English](README.md) ｜ [한국어](README.ko.md)

`cdragon.command-center` is a herdr plugin that replaces a drawer full of
prefix keybindings with **one** keybinding. Press it, and a popup lists every
command you registered. Move with the arrow keys and press Enter, or just press
the slot key next to the one you want.

![The Command Center popup listing commands in a grid, each with its own slot key](docs/popup-list.png)

Every command has a slot: `1`–`9`, `0`, then `a`–`z`. Press `s` and the
git-status command runs — no arrow keys, no remembering which prefix key it was
under. The line under the grid shows what the highlighted command actually does
before you commit to it.

The grid draws all 36 slots, filling top to bottom down each column, and marks
the unclaimed ones `(empty)` in your theme's bright-black — the colour the theme
author already placed just off their own background. What is taken and what is
still free is one glance rather than a guess, and `Enter` on an empty slot opens
the add form already aimed at it.

On a light terminal the empty cells use bright-white instead, so they recede
toward that background too. Which side you are on is read from `COLORFGBG`;
terminals that do not report it are treated as dark, which is what a terminal
running a TUI almost always is.

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
| `1`–`9`, `0`, `a`–`z` | run the command in that slot | typed into the focused text field |
| `↑` `↓` `←` `→` | move through the grid | previous / next field |
| `Tab` / `Shift-Tab` | — | next / previous field |
| `Enter` | run the highlighted command, or fill it if the slot is empty | save |
| `shift+a` | add a command | — |
| `shift+e` | edit the highlighted command | — |
| `shift+d` then `y` | delete the highlighted command | — |
| `shift+o` | open `commands.toml` in your editor | — |
| `shift+i` | import from your herdr config | — |
| `Space` | — | change `Slot`, `Type` or `Cwd` |
| `Backspace` | — | delete the last character |
| `Esc` | close the popup | discard and go back |
| `Ctrl-C` | close the popup | close the popup |

**Lowercase and digits run; uppercase acts.** The key that runs a command is
stored with the command as its `slot`, so it never changes when the list is
reordered — `d` runs whatever lives in slot `d`. All 36 slots are usable, and
all 36 are on screen whether or not anything claims them yet.

Two things follow from that. `j` and `k` are slots now, so moving around is
arrow keys only. `q` is a slot now, so `Esc` is how you close the popup.

Press `shift+a` to add one without leaving the popup. `Tab` moves between fields,
`←`/`→` cycle `Slot`, `Type` and `Cwd`, and `Enter` writes it to `commands.toml`.

A blinking caret marks the field you are typing into, so there is nothing to
guess: just type. `Slot`, `Type` and `Cwd` deliberately have no caret — they are
changed with the arrow keys, and a caret there would promise typing that does
nothing.

![Adding a command in the popup, with the Command field focused](docs/popup-form.png)

## The config file

> Upgrading from a version that used `commands.json`? The first time you open the
> popup it converts your file to `commands.toml` and renames the original to
> `commands.json.bak`. Nothing is deleted.

Everything the popup edits lives in one TOML file you are meant to edit by hand
too. Press `shift+o` in the popup, or run the action directly:

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
editor = ["code --new-window", "nvim"]

# 자주 쓰는 것들
[[commands]]
slot = "1"
label = "Open in VS Code"
type = "shell"
command = "code ."
cwd = "focused"

[[commands]]
slot = "s"
label = "git status"
type = "pane"
command = "git status --short --branch"

[[commands]]
slot = "f"
label = "File explorer"
type = "plugin_action"
command = "ray.file-explorer.open"

# [[commands]]                 <- commented out for now
# slot = "g"
# label = "Lazygit"
# type = "pane"
# command = "lazygit"
```

Flags belong inside one entry, not as separate entries:

```toml
editor = ["code --new-window", "nvim", "vim"]
```

That is three candidates, the first of which passes a flag.

A fresh `commands.toml` is seeded with every editor the plugin knows about —
`code`, `cursor`, `zed`, `subl`, `nvim`, `vim`, `hx`, `nano` — so the list is
something you edit down rather than something you have to discover. Entries that
are not on your `PATH` are dropped before the picker sees them, because opening
an editor that is not installed would spawn `command not found` into a detached
process you would never see. An entry carrying its own arguments is taken on
trust and never filtered, the same way `$VISUAL` and `$EDITOR` are.

Trim the list to one entry to stop being asked.

| Field | Meaning |
| --- | --- |
| `schema_version` | Always `1`. |
| `editor` | Candidate editors, one command line per entry; seeded with all of them on first run. Whatever is not on your `PATH` is dropped, then one surviving entry opens straight away and several make the popup ask which. Leave it empty to auto-detect from `$VISUAL`, `$EDITOR`, then your `PATH`. |
| `id` | stable identifier. Omit it and one is derived from the label (Korean labels keep readable ids). |
| `slot` | the key that runs it: one of `1`-`9`, `0`, `a`-`z`. Omit it and the next free slot is assigned. |
| `label` | what the popup shows. Up to 80 characters. |
| `type` | `shell`, `pane`, or `plugin_action`. |
| `command` | for `shell` and `pane`, a single-line shell command; for `plugin_action`, `<plugin_id>.<action_id>`. |
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
> still lets you press `shift+o` to go fix it; it is never overwritten.

![The popup showing a TOML parse error with the line number](docs/popup-error.png)

### Where the output goes

| `type` | What happens |
| --- | --- |
| `shell` | Runs detached in the background, in the resolved `cwd`. Use it for things that open their own window — `code .`, `gh browse`. You will not see stdout. |
| `pane` | Typed into the pane you were looking at and run there, so you see the output. Use it for `echo`, `git status`, `npm test`. |
| `plugin_action` | Invokes another herdr plugin's action, as `<plugin_id>.<action_id>`. |

`pane` commands are refused when the focused pane is running an agent, because
`herdr` would submit the line to that agent as a prompt instead of to a shell. You
get a notification saying so rather than a prompt you did not mean to send.

### Importing what you already have

Press `shift+i` and Command Center reads the `[[keys.command]]` entries out of your
`~/.config/herdr/config.toml` — the prefix keybindings this plugin exists to
replace — and offers them. Choosing one opens the add form prefilled, so you still
choose the slot and can fix the label before it is written. Entries you have
already added are marked, and entries whose herdr type has no equivalent here are
listed with the reason rather than quietly dropped.

![The import list, reading key bindings out of the user's herdr config.toml](docs/popup-import.png)

### Anything herdr can do

`type` is deliberately just `shell`, `pane`, and `plugin_action`, because a
`shell` command can call the `herdr` CLI and therefore do anything herdr does:

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
what was started (`shell` / `pane` / `plugin_action` / `open-config`), and any
failure (`failed`, `plugin_action_failed`).

**A shell command ran in the wrong directory.** `cwd: "focused"` uses the pane
that was focused when you pressed the key. If herdr reported no cwd for it, the
plugin falls back to the workspace cwd, then to your home directory.

## License

MIT
