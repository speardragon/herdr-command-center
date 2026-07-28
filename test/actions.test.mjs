import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { editConfig } from '../bin/edit-config.mjs';
import { openPalette } from '../bin/open.mjs';
import { normalizeConfig } from '../src/schema.mjs';
import { renderConfigToml } from '../src/toml-config.mjs';
import { fakePath } from './helpers/fake-path.mjs';

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
    focusedPaneId: 'wE:p3',
    focusedPaneAgent: null,
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
    focusedPaneId: null,
    focusedPaneAgent: null,
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

test('editConfig opens commands.toml with the configured editor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-action-'));
  await writeFile(join(dir, 'commands.toml'), renderConfigToml(normalizeConfig({
    editor: ['code -g'],
    commands: [],
  })), 'utf8');
  const spawns = [];
  const code = await editConfig({
    env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: join(dir, 'state'), SHELL: '/bin/zsh' },
    execFile: async () => { throw new Error('execFile must not be needed'); },
    spawn: (file, args, options) => {
      spawns.push({ file, args, options });
      return { unref: () => {} };
    },
  });
  assert.equal(code, 0);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, '/bin/zsh');
  assert.deepEqual(spawns[0].args, ['-lc', 'code -g "$1"', 'cc-editor', join(dir, 'commands.toml')]);
  assert.equal(spawns[0].options.detached, true);
});

test('editConfig picks the first candidate and logs it when several are configured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-action-'));
  await writeFile(join(dir, 'commands.toml'), renderConfigToml(normalizeConfig({
    editor: ['code', 'vim'],
    commands: [],
  })), 'utf8');
  const events = [];
  const spawns = [];
  const code = await editConfig({
    env: {
      HERDR_PLUGIN_CONFIG_DIR: dir,
      HERDR_PLUGIN_STATE_DIR: join(dir, 'state'),
      PATH: await fakePath(dir, ['code', 'vim']),
    },
    execFile: async () => { throw new Error('execFile must not be needed'); },
    spawn: (file, args, options) => {
      spawns.push({ file, args, options });
      return { unref: () => {} };
    },
    createLogger: () => ({ write: async (event, detail) => { events.push([event, detail]); } }),
  });
  assert.equal(code, 0);
  assert.equal(spawns.length, 1, 'there is no popup to ask, so it just picks one');
  assert.equal(spawns[0].args[1], 'code "$1"');
  assert.ok(
    events.some(([event, detail]) => event === 'edit-config-multiple-editors' && detail.editor === 'code'),
    'it logs that a choice among several candidates was made',
  );
});

test('editConfig seeds nothing but still opens a file that does not exist yet', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-action-'));
  const spawns = [];
  const code = await editConfig({
    env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: join(dir, 'state'), EDITOR: 'code' },
    execFile: async () => {},
    spawn: (file, args) => {
      spawns.push({ file, args });
      return { unref: () => {} };
    },
  });
  assert.equal(code, 0);
  assert.equal(spawns[0].file, '/bin/sh');
  assert.deepEqual(spawns[0].args, ['-lc', 'code "$1"', 'cc-editor', join(dir, 'commands.toml')]);
});

test('editConfig falls back to auto-detection when the file is broken', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-action-'));
  await writeFile(join(dir, 'commands.toml'), '[[commands]]\nlabel = ', 'utf8');
  const spawns = [];
  const code = await editConfig({
    env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: join(dir, 'state'), EDITOR: 'code' },
    execFile: async () => {},
    spawn: (file, args) => {
      spawns.push({ file, args });
      return { unref: () => {} };
    },
  });
  assert.equal(code, 0);
  assert.equal(spawns[0].args[1], 'code "$1"');
});

test('editConfig reports failure when no editor can be found at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-action-'));
  const stderr = stderrSink();
  const code = await editConfig({
    env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: join(dir, 'state') },
    stderr,
    execFile: async () => {},
    spawn: () => { throw new Error('must not spawn'); },
  });
  assert.equal(code, 1);
  assert.match(stderr.lines.join(''), /no editor found/u);
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
    env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: join(dir, 'state'), EDITOR: 'code' },
    stderr,
    execFile: async () => {},
    spawn: () => { throw new Error('spawn code ENOENT'); },
  });
  assert.equal(code, 1);
  assert.match(stderr.lines.join(''), /ENOENT/u);
});
