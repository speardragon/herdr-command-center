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
