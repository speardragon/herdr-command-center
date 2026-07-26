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
