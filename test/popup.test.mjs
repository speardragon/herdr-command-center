import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runPopup } from '../bin/popup.mjs';
import { defaultConfig, normalizeConfig } from '../src/schema.mjs';
import { parseConfigToml, renderConfigToml } from '../src/toml-config.mjs';
import {
  createFakeProcess,
  createFakeStderr,
  createFakeStdin,
  createFakeStdout,
} from './helpers/fake-tty.mjs';
import { fakePath } from './helpers/fake-path.mjs';

const CONTEXT = {
  focusedPaneCwd: '/Users/cdragon/repo', workspaceCwd: '/Users/cdragon', focusedPaneId: null, focusedPaneAgent: null,
};

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-popup-'));
  return { dir, file: join(dir, 'commands.toml') };
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

test('runPopup seeds commands.toml on first open and draws the list', async () => {
  const { dir, file } = await scratch();
  const { code, stdout } = await harness(['\u001b'], { dir });
  assert.equal(code, 0);
  assert.equal(await readFile(file, 'utf8'), renderConfigToml(defaultConfig()));
  assert.match(stdout.lastFrame, /Command Center · 3 commands/u);
  assert.match(stdout.lastFrame, /1 {2}Open in VS Code/u);
});

test('runPopup enters and restores raw mode', async () => {
  const { dir } = await scratch();
  const { stdin } = await harness(['\u001b'], { dir });
  assert.deepEqual(stdin.rawModeHistory, [true, false]);
});

test('runPopup clears the screen before each frame', async () => {
  const { dir } = await scratch();
  const { stdout } = await harness(['\u001b[B', '\u001b'], { dir });
  assert.ok(stdout.renderedFrames.length >= 2);
  // Each paint hides the cursor first so it cannot skate across the redraw.
  for (const frame of stdout.renderedFrames) {
    assert.ok(frame.startsWith('\u001b[?25l\u001b[2J\u001b[H'), frame.slice(0, 20));
  }
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

test('the runner task carries the command, context, and both paths', async () => {
  const { dir, file } = await scratch();
  const { spawns } = await harness(['\r'], { dir });
  const task = taskFrom(spawns[0]);
  assert.equal(task.kind, 'run');
  assert.equal(task.command.id, 'open-in-vs-code');
  assert.equal(task.command.command, 'code .');
  assert.deepEqual(task.context, CONTEXT);
  // A 'run' task never needs an editor; only 'open-config' carries one.
  assert.equal(task.editor, undefined);
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

test('O hands an open-config task to the runner when exactly one editor is found', async () => {
  const { dir, file } = await scratch();
  const { code, spawns } = await harness(['O'], { dir, extraEnv: { EDITOR: 'code' } });
  assert.equal(code, 0);
  const task = taskFrom(spawns[0]);
  assert.equal(task.kind, 'open-config');
  assert.equal(task.command, undefined);
  assert.equal(task.commandsPath, file);
  assert.equal(task.editor, 'code');
});

test('O forwards a single custom editor candidate from commands.toml', async () => {
  const { dir, file } = await scratch();
  await writeFile(file, renderConfigToml(normalizeConfig({
    editor: ['code --new-window'],
    commands: [],
  })), 'utf8');
  const { spawns } = await harness(['O'], { dir });
  assert.equal(taskFrom(spawns[0]).editor, 'code --new-window');
});

test('O opens a picker when commands.toml names several editor candidates', async () => {
  const { dir, file } = await scratch();
  await writeFile(file, renderConfigToml(normalizeConfig({
    editor: ['code', 'vim'],
    commands: [],
  })), 'utf8');
  const { spawns, stdout } = await harness(['O'], {
    dir,
    extraEnv: { PATH: await fakePath(dir, ['code', 'vim']) },
  });
  // No candidate is spawned yet: the popup is waiting on a pick.
  assert.deepEqual(spawns, []);
  assert.match(stdout.lastFrame, /Open commands\.toml with/u);
  assert.match(stdout.lastFrame, /1\. code/u);
  assert.match(stdout.lastFrame, /2\. vim/u);
  void file;
});

test('choosing a candidate from the editor picker hands it to the runner', async () => {
  const { dir, file } = await scratch();
  await writeFile(file, renderConfigToml(normalizeConfig({
    editor: ['code', 'vim'],
    commands: [],
  })), 'utf8');
  const { code, spawns } = await harness(['O', '2'], {
    dir,
    extraEnv: { PATH: await fakePath(dir, ['code', 'vim']) },
  });
  assert.equal(code, 0);
  const task = taskFrom(spawns[0]);
  assert.equal(task.kind, 'open-config');
  assert.equal(task.editor, 'vim');
  assert.equal(task.commandsPath, file);
});

test('escape backs out of the editor picker without spawning', async () => {
  const { dir } = await scratch();
  await writeFile(join(dir, 'commands.toml'), renderConfigToml(normalizeConfig({
    editor: ['code', 'vim'],
    commands: [],
  })), 'utf8');
  const { code, spawns } = await harness(['O', '\u001b', '\u001b'], {
    dir,
    extraEnv: { PATH: await fakePath(dir, ['code', 'vim']) },
  });
  assert.equal(code, 0);
  assert.deepEqual(spawns, []);
});

test('O reports failure when no editor can be found at all', async () => {
  const { dir } = await scratch();
  const { code, spawns, stdout } = await harness(['O'], { dir });
  // No key follows the failed pick, so input ends before a decision is made.
  assert.equal(code, 1);
  assert.deepEqual(spawns, []);
  assert.match(stdout.lastFrame, /no editor found/u);
});

test('adding a command writes commands.toml and keeps the popup open', async () => {
  const { dir, file } = await scratch();
  const { code, spawns, stdout } = await harness(['A', 'Tidy', '\t\t\t', 'ls', '\r', '\u001b'], { dir });
  assert.equal(code, 0);
  assert.deepEqual(spawns, [], 'saving must not spawn the runner');
  const written = normalizeConfig(parseConfigToml(await readFile(file, 'utf8')));
  assert.equal(written.commands.length, 4);
  assert.deepEqual(written.commands[3], {
    id: 'tidy', slot: '4', label: 'Tidy', type: 'shell', command: 'ls', cwd: 'focused', description: '',
  });
  assert.match(stdout.lastFrame, /4 commands/u);
});

test('a saved command is immediately runnable in the same session', async () => {
  const { dir } = await scratch();
  const { spawns } = await harness(['A', 'Tidy', '\t\t\t', 'ls', '\r', '4'], { dir });
  assert.equal(spawns.length, 1);
  assert.equal(taskFrom(spawns[0]).command.id, 'tidy');
});

test('deleting a command rewrites commands.toml', async () => {
  const { dir, file } = await scratch();
  const { code } = await harness(['D', 'y', '\u001b'], { dir });
  assert.equal(code, 0);
  const written = normalizeConfig(parseConfigToml(await readFile(file, 'utf8')));
  assert.deepEqual(written.commands.map((command) => command.id), [
    'open-repo-on-github',
    'open-pull-request',
  ]);
});

test('editing a command rewrites it in place', async () => {
  const { dir, file } = await scratch();
  const { code } = await harness(['E', '\u007f\u007f\u007f\u007f', 'Kod', '\r', '\u001b'], { dir });
  assert.equal(code, 0);
  const written = normalizeConfig(parseConfigToml(await readFile(file, 'utf8')));
  assert.equal(written.commands[0].id, 'open-in-vs-code');
  assert.match(written.commands[0].label, /Kod$/u);
});

test('an invalid commands.toml opens in error mode and still offers the editor', async () => {
  const { dir, file } = await scratch();
  await writeFile(file, '[[commands]]\nlabel = ', 'utf8');
  const { code, spawns, stdout } = await harness(['o'], { dir, extraEnv: { EDITOR: 'code' } });
  assert.equal(code, 0);
  assert.match(stdout.frames[0], /config error/u);
  assert.match(stdout.frames[0], /not valid TOML/u);
  assert.equal(taskFrom(spawns[0]).kind, 'open-config');
  assert.equal(taskFrom(spawns[0]).editor, 'code');
});

test('an invalid commands.toml is never overwritten by the popup', async () => {
  const { dir, file } = await scratch();
  await writeFile(file, '[[commands]]\nlabel = ', 'utf8');
  await harness(['a', 'X', '\r', '\u001b'], { dir });
  assert.equal(await readFile(file, 'utf8'), '[[commands]]\nlabel = ');
});

test('a save that collides with an external edit switches to error mode', async () => {
  const { dir, file } = await scratch();
  const stdin = createFakeStdin(['A'], { endAfterQueue: false });
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
  await writeFile(file, renderConfigToml(normalizeConfig({ editor: ['code'], commands: [] })), 'utf8');
  stdin.push('Tidy\t\t\tls\r');
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  stdin.push('\u001b');
  assert.equal(await pending, 0);
  assert.match(stdout.lastFrame, /changed on disk/u);
});

test('NO_COLOR and TERM=dumb turn styling off', async () => {
  const { dir } = await scratch();
  // Assert on the styling itself rather than on a byte offset: the frame also
  // carries cursor control sequences that are not styling.
  const SGR = /\u001b\[(?:0|1|2|3[236])m/u;
  const plain = await harness(['\u001b'], { dir, extraEnv: { NO_COLOR: '1' } });
  assert.doesNotMatch(plain.stdout.lastFrame, SGR);
  const dumb = await harness(['\u001b'], { dir, extraEnv: { TERM: 'dumb' } });
  assert.doesNotMatch(dumb.stdout.lastFrame, SGR);
});

test('styling is on for a capable terminal', async () => {
  const { dir } = await scratch();
  const { stdout } = await harness(['\u001b'], { dir });
  assert.match(stdout.lastFrame, /\u001b\[1m/u, 'the header is bold');
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

test('the popup parks a blinking cursor on a focused text field', async () => {
  const { dir } = await scratch();
  const { stdout } = await harness(['A'], { dir });
  const form = stdout.frames.filter((frame) => frame.includes('Add command')).at(-1);
  assert.ok(form.includes('\u001b[?25h'), 'the cursor is shown');
  assert.ok(form.includes('\u001b[5 q'), 'a blinking bar is requested');
  // row 3 / column 17 zero-based is 4;18 in the terminal's 1-based addressing
  assert.ok(form.includes('\u001b[4;18H'), form.slice(-60));
});

test('the popup keeps the cursor hidden where nothing is editable', async () => {
  const { dir } = await scratch();
  const { stdout } = await harness(['A'], { dir });
  const list = stdout.frames.find((frame) => frame.includes('3 commands'));
  assert.ok(list.includes('\u001b[?25l'), 'the cursor is hidden');
  assert.ok(!list.includes('\u001b[?25h'), 'and never shown again in that frame');
});

test('the popup hides the cursor again on a choice field', async () => {
  const { dir } = await scratch();
  const { stdout } = await harness(['A', '\t'], { dir });
  const type = stdout.frames.filter((frame) => frame.includes('Add command')).at(-1);
  assert.ok(!type.includes('\u001b[?25h'), 'Slot takes arrows, not typing');
});

test('the popup leaves the terminal with a visible default cursor', async () => {
  const { dir } = await scratch();
  const { stdout } = await harness(['\u001b'], { dir });
  const last = stdout.frames.at(-1);
  assert.ok(last.includes('\u001b[0 q'), 'the cursor shape is reset');
  assert.ok(last.includes('\u001b[?25h'), 'and the cursor is left visible');
});

test('an auto-detected editor opens without asking, but a configured list asks', async () => {
  const { dir, file } = await scratch();
  // Nothing configured: we are guessing, so do not turn the guess into a question.
  await writeFile(file, renderConfigToml(normalizeConfig({ editor: [], commands: [] })), 'utf8');
  const auto = await harness(['O'], { dir, extraEnv: { EDITOR: 'vim' } });
  assert.equal(auto.spawns.length, 1, 'opened straight away');
  assert.equal(JSON.parse(auto.spawns[0].options.env.COMMAND_CENTER_TASK_JSON).editor, 'vim');

  // Several named on purpose, and both really here: that is the request to be asked.
  await writeFile(file, renderConfigToml(normalizeConfig({ editor: ['code', 'vim'], commands: [] })), 'utf8');
  const asked = await harness(['O', '\u001b'], {
    dir,
    extraEnv: { PATH: await fakePath(dir, ['code', 'vim']) },
  });
  assert.deepEqual(asked.spawns, [], 'nothing opened until a choice was made');
  assert.ok(asked.stdout.frames.some((f) => f.includes('Open commands.toml with')));
});

test('I lists the commands in the herdr config and adds the chosen one', async () => {
  const { dir, file } = await scratch();
  const herdrConfig = join(dir, 'herdr-config.toml');
  await writeFile(herdrConfig, [
    '[[keys.command]]',
    'key = "prefix+g"',
    'type = "shell"',
    'command = "lazygit"',
    'description = "git TUI"',
    '',
  ].join('\n'), 'utf8');

  const { code, stdout } = await harness(
    ['I', '\r', '\r', '\u001b'],
    { dir, extraEnv: { HERDR_CONFIG_PATH: herdrConfig } },
  );
  assert.equal(code, 0);
  assert.ok(stdout.frames.some((frame) => frame.includes('import from herdr config')));
  assert.ok(stdout.frames.some((frame) => frame.includes('prefix+g')));
  const written = await readFile(file, 'utf8');
  assert.ok(written.includes('command = "lazygit"'), written);
  assert.ok(written.includes('label = "git TUI"'), written);
});
