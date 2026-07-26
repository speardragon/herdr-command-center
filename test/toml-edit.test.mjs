import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../src/schema.mjs';
import { parseConfigToml } from '../src/toml-config.mjs';
import { applyCommands, joinDocument, splitDocument } from '../src/toml-edit.mjs';

const HAND_WRITTEN = [
  'schema_version = 1',
  'editor = ["code"]',
  '',
  '# 자주 쓰는 것들',
  '[[commands]]',
  'id = "vscode"',
  'label = "Open in VS Code"',
  'type = "shell"',
  'command = "code ."',
  'cwd = "focused"',
  '',
  '[[commands]]',
  'id = "browse"',
  'label = "Open repo on GitHub"',
  'type = "shell"',
  'command = "gh browse"',
  'cwd = "focused"',
  '',
  '# 잠시 끔',
  '# [[commands]]',
  '# label = "Lazygit"',
  '# command = "lazygit"',
  '',
].join('\n');

function commandsOf(text) {
  return normalizeConfig(parseConfigToml(text)).commands;
}

function withField(commands, id, field, value) {
  return commands.map((command) => (command.id === id ? { ...command, [field]: value } : command));
}

test('splitDocument round-trips any document byte-for-byte', () => {
  for (const text of [
    HAND_WRITTEN,
    '',
    'editor = ["code"]\n',
    '[[commands]]\nid = "a"\n',
    '\n\n\n',
    '# only a comment',
    'no trailing newline',
  ]) {
    assert.equal(joinDocument(splitDocument(text)), text, JSON.stringify(text.slice(0, 30)));
  }
});

test('splitDocument finds each real block and leaves comments opaque', () => {
  const segments = splitDocument(HAND_WRITTEN);
  const commands = segments.filter((segment) => segment.kind === 'command');
  assert.equal(commands.length, 2);
  assert.ok(commands[0].text.startsWith('[[commands]]'));
  assert.ok(commands[0].text.includes('id = "vscode"'));
  // The commented-out block is never a command segment.
  assert.ok(segments.every((segment) => (
    segment.kind === 'opaque' || !segment.text.includes('# [[commands]]')
  )));
  assert.ok(joinDocument(segments.filter((s) => s.kind === 'opaque')).includes('# 잠시 끔'));
});

test('splitDocument ignores an indented or commented header', () => {
  const text = ['# [[commands]]', '  # [[commands]]', 'x = 1'].join('\n');
  assert.equal(splitDocument(text).filter((s) => s.kind === 'command').length, 0);
});

test('applyCommands is a no-op when nothing changed', () => {
  assert.equal(applyCommands(HAND_WRITTEN, commandsOf(HAND_WRITTEN)), HAND_WRITTEN);
});

test('editing one command leaves every other byte untouched', () => {
  const next = withField(commandsOf(HAND_WRITTEN), 'browse', 'label', 'Repo on GitHub');
  const result = applyCommands(HAND_WRITTEN, next);
  assert.ok(result.includes('# 자주 쓰는 것들'), 'preamble comment survived');
  assert.ok(result.includes('# 잠시 끔'), 'trailing comment survived');
  assert.ok(result.includes('# [[commands]]'), 'commented-out block survived');
  assert.ok(result.includes('label = "Repo on GitHub"'), 'edit applied');
  assert.ok(!result.includes('label = "Open repo on GitHub"'), 'old label gone');
  // The untouched block keeps its original text exactly.
  assert.ok(result.includes('id = "vscode"\nlabel = "Open in VS Code"'));
  assert.deepEqual(commandsOf(result).map((c) => c.label), ['Open in VS Code', 'Repo on GitHub']);
});

test('an unchanged block keeps hand-formatting the renderer would not produce', () => {
  const odd = [
    'editor = ["code"]',
    '',
    '[[commands]]',
    'label   =   "Spaced Out"   # why not',
    'type = "shell"',
    'command = "ls"',
    '',
  ].join('\n');
  const result = applyCommands(odd, commandsOf(odd));
  assert.ok(result.includes('label   =   "Spaced Out"   # why not'));
});

test('deleting a command removes only its block', () => {
  const next = commandsOf(HAND_WRITTEN).filter((command) => command.id !== 'vscode');
  const result = applyCommands(HAND_WRITTEN, next);
  assert.ok(!result.includes('id = "vscode"'));
  assert.ok(result.includes('id = "browse"'));
  assert.ok(result.includes('# 자주 쓰는 것들'), 'comment above the deleted block survived');
  assert.ok(result.includes('# [[commands]]'));
  assert.deepEqual(commandsOf(result).map((c) => c.id), ['browse']);
});

test('deleting every command keeps the preamble and the comments', () => {
  const result = applyCommands(HAND_WRITTEN, []);
  assert.ok(result.includes('editor = ["code"]'));
  assert.ok(result.includes('# 자주 쓰는 것들'));
  assert.ok(result.includes('# [[commands]]'));
  assert.deepEqual(commandsOf(result), []);
});

test('adding a command appends it and changes nothing before it', () => {
  const before = commandsOf(HAND_WRITTEN);
  const added = normalizeConfig({
    commands: [...before, { label: 'Lazygit', type: 'shell', command: 'lazygit' }],
  }).commands;
  const result = applyCommands(HAND_WRITTEN, added);
  assert.ok(result.startsWith(HAND_WRITTEN), 'the entire original document is preserved verbatim');
  assert.ok(result.includes('label = "Lazygit"'));
  assert.deepEqual(commandsOf(result).map((c) => c.label), [
    'Open in VS Code', 'Open repo on GitHub', 'Lazygit',
  ]);
  assert.ok(result.includes('# 잠시 끔'), 'the trailing comment is still there');
});

test('adding to a file with no blocks at all still parses', () => {
  const bare = 'schema_version = 1\neditor = ["code"]\n';
  const added = normalizeConfig({ commands: [{ label: 'Ls', type: 'shell', command: 'ls' }] }).commands;
  const result = applyCommands(bare, added);
  assert.ok(result.startsWith(bare));
  assert.deepEqual(commandsOf(result).map((c) => c.label), ['Ls']);
});

test('reordering emits the blocks in the new order', () => {
  const [first, second] = commandsOf(HAND_WRITTEN);
  const result = applyCommands(HAND_WRITTEN, [second, first]);
  assert.deepEqual(commandsOf(result).map((c) => c.id), ['browse', 'vscode']);
  assert.ok(result.includes('# [[commands]]'));
});

test('every applyCommands result re-parses to exactly the requested commands', () => {
  const base = commandsOf(HAND_WRITTEN);
  const cases = [
    base,
    [],
    base.slice(0, 1),
    withField(base, 'vscode', 'command', 'code -n .'),
    withField(base, 'browse', 'description', '설명 "인용" 포함'),
    normalizeConfig({ commands: [...base, { label: '새 커맨드', type: 'plugin_action', command: 'ray.file-explorer.open' }] }).commands,
  ];
  for (const commands of cases) {
    const result = applyCommands(HAND_WRITTEN, commands);
    assert.deepEqual(commandsOf(result), commands, JSON.stringify(commands.map((c) => c.id)));
  }
});

test('a hand-written block with no id keeps its formatting when untouched', () => {
  // Regression: matching on the raw `id` key meant any block a human wrote
  // (they do not write ids) was treated as new and silently reformatted.
  const noId = [
    'editor = ["code"]',
    '',
    '[[commands]]',
    'label   =   "Ls"      # aligned by hand',
    'type = "shell"',
    'command = "ls"',
    '',
    '[[commands]]',
    'label = "Browse"',
    'type = "shell"',
    'command = "gh browse"',
    '',
  ].join('\n');
  const commands = commandsOf(noId);
  // Edit only the second command; the first must come out byte-identical.
  const result = applyCommands(noId, withField(commands, 'browse', 'command', 'gh browse --branch main'));
  assert.ok(result.includes('label   =   "Ls"      # aligned by hand'));
  assert.ok(result.includes('command = "gh browse --branch main"'));
  assert.deepEqual(commandsOf(result).map((c) => c.command), ['ls', 'gh browse --branch main']);
});

test('a block the user wrote without an id is still matched and editable', () => {
  const noId = [
    'editor = ["code"]',
    '',
    '[[commands]]',
    'label = "Ls"',
    'type = "shell"',
    'command = "ls"',
    '',
  ].join('\n');
  const commands = commandsOf(noId);
  assert.equal(commands[0].id, 'ls');
  const result = applyCommands(noId, withField(commands, 'ls', 'command', 'ls -la'));
  assert.deepEqual(commandsOf(result).map((c) => c.command), ['ls -la']);
});
