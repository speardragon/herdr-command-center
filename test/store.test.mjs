import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConfigError, defaultConfig, normalizeConfig } from '../src/schema.mjs';
import { parseConfigToml, renderConfigToml } from '../src/toml-config.mjs';
import { ensureStore, loadStore, saveStore } from '../src/store.mjs';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'cc-store-'));
  return { dir, file: join(dir, 'commands.toml'), legacy: join(dir, 'commands.json') };
}

test('loadStore returns the seeded default when the file is absent', async () => {
  const { file } = await scratch();
  const loaded = await loadStore(file);
  assert.deepEqual(loaded.doc, defaultConfig());
  assert.equal(loaded.raw, null);
});

test('loadStore reads and normalizes an existing TOML file', async () => {
  const { file } = await scratch();
  await writeFile(file, [
    'editor = ["code"]',
    '',
    '# 자주 쓰는 것',
    '[[commands]]',
    'label = "Ls"',
    'type = "shell"',
    'command = "ls"',
    '',
  ].join('\n'), 'utf8');
  const loaded = await loadStore(file);
  assert.equal(loaded.doc.commands.length, 1);
  assert.equal(loaded.doc.commands[0].id, 'ls');
  assert.equal(loaded.doc.commands[0].cwd, 'focused');
  assert.deepEqual(loaded.doc.editor, ['code']);
  assert.ok(loaded.raw.includes('# 자주 쓰는 것'));
});

test('loadStore reports malformed TOML as a ConfigError naming the file', async () => {
  const { file } = await scratch();
  await writeFile(file, '[[commands]]\nlabel = ', 'utf8');
  await assert.rejects(loadStore(file), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /commands\.toml/u);
    assert.match(error.message, /not valid TOML/u);
    return true;
  });
});

test('loadStore surfaces schema failures with the file name', async () => {
  const { file } = await scratch();
  await writeFile(file, '[[commands]]\nlabel = "a"\ntype = "nope"\ncommand = "b"\n', 'utf8');
  await assert.rejects(loadStore(file), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /commands\.toml/u);
    assert.match(error.message, /commands\[0\]/u);
    return true;
  });
});

test('ensureStore writes the seed file exactly once', async () => {
  const { file } = await scratch();
  const first = await ensureStore(file);
  assert.deepEqual(first.doc, defaultConfig());
  assert.equal(await readFile(file, 'utf8'), renderConfigToml(defaultConfig()));

  await writeFile(file, 'editor = ["code"]\n', 'utf8');
  const second = await ensureStore(file);
  assert.deepEqual(second.doc.commands, []);
});

test('ensureStore migrates a pre-TOML commands.json and keeps a backup', async () => {
  const { dir, file, legacy } = await scratch();
  await writeFile(legacy, JSON.stringify({
    schema_version: 1,
    editor: ['code', '-g'],
    commands: [{ id: 'ls', label: 'Ls', type: 'shell', command: 'ls', cwd: 'workspace', description: 'list' }],
  }), 'utf8');

  const migrated = await ensureStore(file);
  assert.deepEqual(migrated.doc.editor, ['code', '-g']);
  assert.deepEqual(migrated.doc.commands.map((command) => command.id), ['ls']);
  assert.equal(migrated.doc.commands[0].cwd, 'workspace');

  const written = await readFile(file, 'utf8');
  assert.ok(written.includes('[[commands]]'));
  assert.deepEqual(normalizeConfig(parseConfigToml(written)), migrated.doc);

  const entries = (await readdir(dir)).sort();
  assert.deepEqual(entries, ['commands.json.bak', 'commands.toml']);
});

test('ensureStore does not migrate when a TOML file already exists', async () => {
  const { file, legacy } = await scratch();
  await writeFile(file, 'editor = ["code"]\n', 'utf8');
  await writeFile(legacy, JSON.stringify({ commands: [{ label: 'Old', type: 'shell', command: 'old' }] }), 'utf8');
  const loaded = await ensureStore(file);
  assert.deepEqual(loaded.doc.commands, []);
  assert.equal(await readFile(legacy, 'utf8').then((t) => t.includes('Old')), true);
});

test('ensureStore falls back to the seed when the legacy file is unusable', async () => {
  const { file, legacy } = await scratch();
  await writeFile(legacy, '{ broken', 'utf8');
  const loaded = await ensureStore(file);
  assert.deepEqual(loaded.doc, defaultConfig());
  assert.ok((await readFile(file, 'utf8')).includes('[[commands]]'));
});

test('saveStore writes atomically and leaves no temp files behind', async () => {
  const { dir, file } = await scratch();
  const doc = normalizeConfig({ commands: [] });
  const saved = await saveStore(file, doc);
  assert.equal(saved.raw, renderConfigToml(doc));
  assert.deepEqual(await readdir(dir), ['commands.toml']);
});

test('saveStore preserves comments and untouched blocks when given the loaded text', async () => {
  const { file } = await scratch();
  const original = [
    'schema_version = 1',
    'editor = ["code"]',
    '',
    '# 자주 쓰는 것들',
    '[[commands]]',
    'id = "ls"',
    'label = "Ls"',
    'type = "shell"',
    'command = "ls"',
    '',
    '# 잠시 끔',
    '# [[commands]]',
    '# label = "Lazygit"',
    '',
  ].join('\n');
  await writeFile(file, original, 'utf8');
  const loaded = await loadStore(file);
  const next = {
    ...loaded.doc,
    commands: loaded.doc.commands.map((command) => ({ ...command, command: 'ls -la' })),
  };
  const saved = await saveStore(file, next, { expectedRaw: loaded.raw });
  const text = await readFile(file, 'utf8');
  assert.equal(text, saved.raw);
  assert.ok(text.includes('# 자주 쓰는 것들'), 'comment above the block survived');
  assert.ok(text.includes('# 잠시 끔'), 'trailing comment survived');
  assert.ok(text.includes('# [[commands]]'), 'commented-out block survived');
  assert.ok(text.includes('command = "ls -la"'), 'the edit landed');
  assert.deepEqual(normalizeConfig(parseConfigToml(text)).commands, next.commands);
});

test('saveStore full-renders when there is no prior text to splice into', async () => {
  const { file } = await scratch();
  const doc = normalizeConfig({ commands: [{ label: 'Ls', type: 'shell', command: 'ls' }] });
  const saved = await saveStore(file, doc, { expectedRaw: null });
  assert.equal(saved.raw, renderConfigToml(doc));
});

test('saveStore full-renders when the editor key changes', async () => {
  const { file } = await scratch();
  await writeFile(file, 'editor = ["code"]\n\n# a comment\n', 'utf8');
  const loaded = await loadStore(file);
  const next = { ...loaded.doc, editor: ['vim'] };
  const saved = await saveStore(file, next, { expectedRaw: loaded.raw });
  assert.equal(saved.raw, renderConfigToml(next));
  assert.ok(!saved.raw.includes('# a comment'), 'a full re-render cannot keep comments');
});

test('saveStore normalizes before writing', async () => {
  const { file } = await scratch();
  await saveStore(file, { commands: [{ label: '  Ls  ', type: 'shell', command: 'ls' }] });
  const written = normalizeConfig(parseConfigToml(await readFile(file, 'utf8')));
  assert.equal(written.commands[0].label, 'Ls');
  assert.equal(written.schema_version, 1);
});

test('saveStore refuses to clobber an external edit', async () => {
  const { file } = await scratch();
  const first = await saveStore(file, normalizeConfig({ commands: [] }));
  await writeFile(file, `${first.raw}\n# added behind our back\n`, 'utf8');
  await assert.rejects(
    saveStore(file, normalizeConfig({ commands: [{ label: 'New', type: 'shell', command: 'ls' }] }), { expectedRaw: first.raw }),
    (error) => error instanceof ConfigError && /changed on disk/u.test(error.message),
  );
});

test('saveStore rejects an invalid document without touching the file', async () => {
  const { file } = await scratch();
  const good = await saveStore(file, normalizeConfig({ commands: [] }));
  await assert.rejects(
    saveStore(file, { commands: [{ label: 'a', type: 'nope', command: 'b' }] }, { expectedRaw: good.raw }),
    ConfigError,
  );
  assert.equal(await readFile(file, 'utf8'), good.raw);
});
