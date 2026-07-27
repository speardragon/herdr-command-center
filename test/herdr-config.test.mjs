import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { herdrConfigPath, importableCommands, readImportable } from '../src/herdr-config.mjs';

const CONFIG = `
prefix = "ctrl+a"

[[keys.command]]
key = "prefix+shift+o"
type = "shell"
command = "code ."

[[keys.command]]              # split pane으로 열기
key = "prefix+y"
type = "plugin_action"
command = "ray.file-explorer.open"
description = "open file explorer"

[[keys.command]]
key = "prefix+alt+g"
type = "popup"
command = "lazygit"
width = "80%"

[[keys.command]]
key = "prefix+t"
type = "pane"
command = "htop"

[[keys.command]]
key = "prefix+b"
type = "nonsense"
command = "whatever"
`;

test('herdrConfigPath honours HERDR_CONFIG_PATH and otherwise uses the default', () => {
  assert.equal(herdrConfigPath({ HERDR_CONFIG_PATH: '/tmp/c.toml' }), '/tmp/c.toml');
  assert.equal(
    herdrConfigPath({ HOME: '/Users/x' }),
    join('/Users/x', '.config', 'herdr', 'config.toml'),
  );
});

test('importableCommands finds every keys.command entry', () => {
  const entries = importableCommands(CONFIG);
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map((entry) => entry.key), [
    'prefix+shift+o', 'prefix+y', 'prefix+alt+g', 'prefix+t', 'prefix+b',
  ]);
});

test('importableCommands maps herdr types onto this plugin types', () => {
  const byKey = Object.fromEntries(importableCommands(CONFIG).map((e) => [e.key, e]));
  assert.equal(byKey['prefix+shift+o'].type, 'shell');
  assert.equal(byKey['prefix+y'].type, 'plugin_action');
  assert.equal(byKey['prefix+t'].type, 'pane');
  // a herdr popup command also puts its output in a pane
  assert.equal(byKey['prefix+alt+g'].type, 'pane');
});

test('importableCommands explains an entry it cannot map rather than hiding it', () => {
  const entry = importableCommands(CONFIG).find((e) => e.key === 'prefix+b');
  assert.equal(entry.type, null);
  assert.match(entry.reason, /nonsense/u);
});

test('importableCommands prefers the description as the label', () => {
  const byKey = Object.fromEntries(importableCommands(CONFIG).map((e) => [e.key, e]));
  assert.equal(byKey['prefix+y'].label, 'open file explorer');
  // with no description, the command itself is the most useful label
  assert.equal(byKey['prefix+shift+o'].label, 'code .');
});

test('importableCommands skips the binding that opens this very popup', () => {
  const entries = importableCommands([
    '[[keys.command]]',
    'key = "prefix+m"',
    'type = "plugin_action"',
    'command = "cdragon.command-center.open"',
    '',
    '[[keys.command]]',
    'key = "prefix+y"',
    'type = "plugin_action"',
    'command = "ray.file-explorer.open"',
    '',
  ].join('\n'));
  assert.deepEqual(entries.map((entry) => entry.command), ['ray.file-explorer.open']);
});

test('importableCommands tolerates a config with no command keybindings', () => {
  assert.deepEqual(importableCommands('prefix = "ctrl+b"\n'), []);
  assert.deepEqual(importableCommands(''), []);
});

test('importableCommands returns nothing for a config it cannot parse', () => {
  assert.deepEqual(importableCommands('[[keys.command]]\nkey = '), []);
});

test('importableCommands skips an entry with no command to run', () => {
  const entries = importableCommands('[[keys.command]]\nkey = "prefix+x"\ntype = "shell"\n');
  assert.deepEqual(entries, []);
});

test('readImportable returns nothing when the config is missing', async () => {
  const entries = await readImportable('/nope/config.toml', {
    readFile: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.deepEqual(entries, []);
});

test('readImportable reads and parses a real file', async () => {
  const entries = await readImportable('/tmp/config.toml', { readFile: async () => CONFIG });
  assert.equal(entries.length, 5);
});
