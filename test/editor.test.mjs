import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMON_EDITORS,
  detectEditors,
  editorSpawn,
  openInEditor,
  resolveEditors,
} from '../src/editor.mjs';

const nothingInstalled = () => false;
const everythingInstalled = () => true;

test('editorSpawn passes the path as an argument rather than splicing it in', () => {
  const built = editorSpawn('code', '/tmp/a b/commands.toml', { shell: '/bin/zsh' });
  assert.equal(built.file, '/bin/zsh');
  // "$1" keeps a path with spaces or quotes intact without any escaping of our own
  assert.deepEqual(built.args, ['-lc', 'code "$1"', 'cc-editor', '/tmp/a b/commands.toml']);
});

test('editorSpawn keeps the flags in a candidate command line', () => {
  const built = editorSpawn('code --new-window -g', '/tmp/commands.toml');
  assert.equal(built.args[1], 'code --new-window -g "$1"');
});

test('editorSpawn rejects an unusable candidate', () => {
  for (const candidate of [null, '', '   ', 42, []]) {
    assert.throws(() => editorSpawn(candidate, '/tmp/x'), TypeError, JSON.stringify(candidate));
  }
});

test('detectEditors prefers VISUAL, then EDITOR', () => {
  assert.deepEqual(
    detectEditors({ env: { VISUAL: 'nvim', EDITOR: 'vim' }, exists: nothingInstalled }),
    ['nvim', 'vim'],
  );
  assert.deepEqual(detectEditors({ env: { EDITOR: 'vim' }, exists: nothingInstalled }), ['vim']);
});

test('detectEditors falls back to whatever is actually installed', () => {
  const detected = detectEditors({ env: {}, exists: (name) => name === 'nvim' });
  assert.deepEqual(detected, ['nvim']);
});

test('detectEditors does not offer editors that are not installed', () => {
  assert.deepEqual(detectEditors({ env: {}, exists: nothingInstalled }), []);
});

test('detectEditors never repeats a candidate', () => {
  const detected = detectEditors({ env: { VISUAL: 'vim', EDITOR: 'vim' }, exists: everythingInstalled });
  assert.equal(detected.filter((name) => name === 'vim').length, 1);
});

test('COMMON_EDITORS covers the obvious choices without assuming VS Code', () => {
  for (const name of ['code', 'nvim', 'vim', 'nano']) {
    assert.ok(COMMON_EDITORS.includes(name), `${name} missing`);
  }
});

test('resolveEditors uses the config when it names any candidate', () => {
  assert.deepEqual(
    resolveEditors({ editor: ['code', 'vim'] }, { env: {}, exists: nothingInstalled }),
    ['code', 'vim'],
    'a configured candidate is honoured even if we cannot see it on PATH',
  );
});

test('resolveEditors auto-detects when the config names none', () => {
  const options = { env: { EDITOR: 'vim' }, exists: nothingInstalled };
  assert.deepEqual(resolveEditors({ editor: [] }, options), ['vim']);
  assert.deepEqual(resolveEditors({}, options), ['vim']);
});

test('openInEditor spawns one candidate detached', async () => {
  const calls = [];
  let unrefs = 0;
  const result = await openInEditor('/tmp/commands.toml', {
    editor: 'code',
    shell: '/bin/zsh',
    env: { PATH: '/usr/bin' },
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return { unref: () => { unrefs += 1; } };
    },
  });
  assert.deepEqual(result, { status: 'started' });
  assert.equal(calls[0].file, '/bin/zsh');
  assert.equal(calls[0].args[1], 'code "$1"');
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(unrefs, 1);
});

test('openInEditor logs which candidate it used', async () => {
  const events = [];
  await openInEditor('/tmp/commands.toml', {
    editor: 'nvim',
    spawn: () => ({ unref: () => {} }),
    log: async (event, detail) => { events.push([event, detail]); },
  });
  assert.deepEqual(events[0], ['open-config', { editor: 'nvim', path: '/tmp/commands.toml' }]);
});

test('openInEditor surfaces a spawn failure', async () => {
  await assert.rejects(openInEditor('/tmp/commands.toml', {
    editor: 'nope',
    spawn: () => { throw new Error('ENOENT'); },
  }), /ENOENT/u);
});
