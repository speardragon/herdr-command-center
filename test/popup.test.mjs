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

const CONTEXT = { focusedPaneCwd: '/Users/cdragon/repo', workspaceCwd: '/Users/cdragon' };

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

test('o forwards a custom editor from commands.toml', async () => {
  const { dir, file } = await scratch();
  await writeFile(file, renderConfigToml(normalizeConfig({
    editor: ['code', '--new-window'],
    commands: [],
  })), 'utf8');
  const { spawns } = await harness(['o'], { dir });
  assert.deepEqual(taskFrom(spawns[0]).editor, ['code', '--new-window']);
});

test('adding a command writes commands.toml and keeps the popup open', async () => {
  const { dir, file } = await scratch();
  const { code, spawns, stdout } = await harness(['a', 'Tidy', '\t\t', 'ls', '\r', '\u001b'], { dir });
  assert.equal(code, 0);
  assert.deepEqual(spawns, [], 'saving must not spawn the runner');
  const written = normalizeConfig(parseConfigToml(await readFile(file, 'utf8')));
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

test('deleting a command rewrites commands.toml', async () => {
  const { dir, file } = await scratch();
  const { code } = await harness(['d', 'y', '\u001b'], { dir });
  assert.equal(code, 0);
  const written = normalizeConfig(parseConfigToml(await readFile(file, 'utf8')));
  assert.deepEqual(written.commands.map((command) => command.id), [
    'open-repo-on-github',
    'open-pull-request',
  ]);
});

test('editing a command rewrites it in place', async () => {
  const { dir, file } = await scratch();
  const { code } = await harness(['e', '\u007f\u007f\u007f\u007f', 'Kod', '\r', '\u001b'], { dir });
  assert.equal(code, 0);
  const written = normalizeConfig(parseConfigToml(await readFile(file, 'utf8')));
  assert.equal(written.commands[0].id, 'open-in-vs-code');
  assert.match(written.commands[0].label, /Kod$/u);
});

test('an invalid commands.toml opens in error mode and still offers the editor', async () => {
  const { dir, file } = await scratch();
  await writeFile(file, '[[commands]]\nlabel = ', 'utf8');
  const { code, spawns, stdout } = await harness(['o'], { dir });
  assert.equal(code, 0);
  assert.match(stdout.frames[0], /config error/u);
  assert.match(stdout.frames[0], /not valid TOML/u);
  assert.equal(taskFrom(spawns[0]).kind, 'open-config');
  assert.deepEqual(taskFrom(spawns[0]).editor, ['code']);
});

test('an invalid commands.toml is never overwritten by the popup', async () => {
  const { dir, file } = await scratch();
  await writeFile(file, '[[commands]]\nlabel = ', 'utf8');
  await harness(['a', 'X', '\r', '\u001b'], { dir });
  assert.equal(await readFile(file, 'utf8'), '[[commands]]\nlabel = ');
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
  await writeFile(file, renderConfigToml(normalizeConfig({ editor: ['code'], commands: [] })), 'utf8');
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
