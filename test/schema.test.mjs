import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMAND_TYPES,
  CWD_MODES,
  ConfigError,
  DEFAULT_EDITOR,
  defaultConfig,
  normalizeCommand,
  normalizeConfig,
  parsePluginActionTarget,
  SCHEMA_VERSION,
  slugify,
  uniqueId,
} from '../src/schema.mjs';

test('exported vocabularies are frozen and complete', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual([...COMMAND_TYPES], ['shell', 'plugin_action']);
  assert.deepEqual([...CWD_MODES], ['focused', 'workspace']);
  assert.deepEqual([...DEFAULT_EDITOR], ['code']);
  assert.ok(Object.isFrozen(COMMAND_TYPES));
});

test('slugify keeps unicode letters so Korean labels get readable ids', () => {
  assert.equal(slugify('Open in VS Code'), 'open-in-vs-code');
  assert.equal(slugify('브랜치 정리'), '브랜치-정리');
  assert.equal(slugify('  ---  '), 'command');
  assert.equal(slugify('gh pr view --web'), 'gh-pr-view-web');
});

test('uniqueId suffixes collisions', () => {
  assert.equal(uniqueId('open', []), 'open');
  assert.equal(uniqueId('open', ['open']), 'open-2');
  assert.equal(uniqueId('open', ['open', 'open-2']), 'open-3');
});

test('parsePluginActionTarget splits on the final dot', () => {
  assert.deepEqual(parsePluginActionTarget('ray.file-explorer.open'), {
    pluginId: 'ray.file-explorer',
    actionId: 'open',
  });
  assert.deepEqual(parsePluginActionTarget('cdragon.ask-inbox.hook-status'), {
    pluginId: 'cdragon.ask-inbox',
    actionId: 'hook-status',
  });
});

test('parsePluginActionTarget rejects targets without a plugin and an action', () => {
  for (const target of ['open', '.open', 'ray.file-explorer.', '']) {
    assert.throws(() => parsePluginActionTarget(target), ConfigError, target);
  }
});

test('normalizeCommand fills defaults and derives an id from the label', () => {
  assert.deepEqual(normalizeCommand({ label: 'Open in VS Code', type: 'shell', command: 'code .' }), {
    id: 'open-in-vs-code',
    label: 'Open in VS Code',
    type: 'shell',
    command: 'code .',
    cwd: 'focused',
    description: '',
  });
});

test('normalizeCommand trims text and keeps an explicit id', () => {
  const command = normalizeCommand({
    id: 'my-id',
    label: '  Tidy branches  ',
    type: 'shell',
    command: '  git branch --merged  ',
    cwd: 'workspace',
    description: '  cleanup  ',
  });
  assert.equal(command.id, 'my-id');
  assert.equal(command.label, 'Tidy branches');
  assert.equal(command.command, 'git branch --merged');
  assert.equal(command.cwd, 'workspace');
  assert.equal(command.description, 'cleanup');
});

test('normalizeCommand dedupes generated ids against existing ones', () => {
  const command = normalizeCommand(
    { label: 'Open in VS Code', type: 'shell', command: 'code .' },
    { existingIds: ['open-in-vs-code'] },
  );
  assert.equal(command.id, 'open-in-vs-code-2');
});

test('normalizeCommand accepts an absolute cwd path', () => {
  const command = normalizeCommand({
    label: 'Notes',
    type: 'shell',
    command: 'ls',
    cwd: '/Users/cdragon/notes',
  });
  assert.equal(command.cwd, '/Users/cdragon/notes');
});

test('normalizeCommand validates plugin_action targets', () => {
  const command = normalizeCommand({
    label: 'File explorer',
    type: 'plugin_action',
    command: 'ray.file-explorer.open',
  });
  assert.equal(command.type, 'plugin_action');
  assert.throws(
    () => normalizeCommand({ label: 'Broken', type: 'plugin_action', command: 'nope' }),
    (error) => error instanceof ConfigError && /plugin_id\.action_id/u.test(error.message),
  );
});

test('normalizeCommand rejects every malformed field with a readable message', () => {
  const cases = [
    [{}, /label/u],
    [{ label: '   ', type: 'shell', command: 'ls' }, /label/u],
    [{ label: 'a', type: 'nope', command: 'ls' }, /type/u],
    [{ label: 'a', type: 'shell', command: '   ' }, /command/u],
    [{ label: 'a', type: 'shell', command: 'ls', cwd: 'relative/path' }, /cwd/u],
    [{ label: 'a', type: 'shell', command: 'ls \u0000 ls' }, /command/u],
    [{ label: 'a'.repeat(81), type: 'shell', command: 'ls' }, /label/u],
    [{ id: 'Bad Id', label: 'a', type: 'shell', command: 'ls' }, /id/u],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => normalizeCommand(value), (error) => {
      assert.ok(error instanceof ConfigError, `${JSON.stringify(value)} threw ${error.name}`);
      assert.match(error.message, pattern);
      return true;
    });
  }
});

test('normalizeCommand rejects a multi-line command', () => {
  assert.throws(
    () => normalizeCommand({ label: 'a', type: 'shell', command: 'ls\nrm -rf /' }),
    (error) => error instanceof ConfigError && /single line/u.test(error.message),
  );
});

test('defaultConfig is valid and normalizes to itself', () => {
  const doc = defaultConfig();
  assert.equal(doc.schema_version, 1);
  assert.deepEqual(doc.editor, ['code']);
  assert.ok(doc.commands.length >= 1);
  assert.deepEqual(normalizeConfig(doc), doc);
});

test('normalizeConfig fills missing schema_version, editor, and commands', () => {
  assert.deepEqual(normalizeConfig({}), { schema_version: 1, editor: ['code'], commands: [] });
});

test('normalizeConfig assigns unique ids across the whole list', () => {
  const doc = normalizeConfig({
    commands: [
      { label: 'Same', type: 'shell', command: 'a' },
      { label: 'Same', type: 'shell', command: 'b' },
    ],
  });
  assert.deepEqual(doc.commands.map((command) => command.id), ['same', 'same-2']);
});

test('normalizeConfig reports the offending index', () => {
  assert.throws(
    () => normalizeConfig({ commands: [{ label: 'ok', type: 'shell', command: 'a' }, { label: 'x', type: 'nope', command: 'b' }] }),
    (error) => error instanceof ConfigError && /commands\[1\]/u.test(error.message),
  );
});

test('normalizeConfig rejects unsupported shapes and versions', () => {
  assert.throws(() => normalizeConfig(null), ConfigError);
  assert.throws(() => normalizeConfig([]), ConfigError);
  assert.throws(() => normalizeConfig({ schema_version: 2 }), (error) => (
    error instanceof ConfigError && /schema_version/u.test(error.message)
  ));
  assert.throws(() => normalizeConfig({ editor: [] }), (error) => (
    error instanceof ConfigError && /editor/u.test(error.message)
  ));
  assert.throws(() => normalizeConfig({ editor: 'code' }), ConfigError);
  assert.throws(() => normalizeConfig({ commands: {} }), ConfigError);
});

test('normalizeConfig rejects duplicate explicit ids', () => {
  assert.throws(
    () => normalizeConfig({
      commands: [
        { id: 'dupe', label: 'a', type: 'shell', command: 'a' },
        { id: 'dupe', label: 'b', type: 'shell', command: 'b' },
      ],
    }),
    (error) => error instanceof ConfigError && /duplicate/u.test(error.message),
  );
});
