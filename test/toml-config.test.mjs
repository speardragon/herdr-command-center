import assert from 'node:assert/strict';
import test from 'node:test';

import { parse as parseToml } from 'smol-toml';

import { ConfigError, defaultConfig, normalizeConfig } from '../src/schema.mjs';
import {
  escapeTomlString,
  parseConfigToml,
  renderCommandBlock,
  renderConfigToml,
} from '../src/toml-config.mjs';

const COMMAND = Object.freeze({
  id: 'open-in-vs-code',
  slot: '1',
  label: 'Open in VS Code',
  type: 'shell',
  command: 'code .',
  cwd: 'focused',
  description: 'Open the focused directory',
});

test('escapeTomlString escapes what TOML basic strings require', () => {
  assert.equal(escapeTomlString('plain'), 'plain');
  assert.equal(escapeTomlString('say "hi"'), 'say \\"hi\\"');
  assert.equal(escapeTomlString('back\\slash'), 'back\\\\slash');
  assert.equal(escapeTomlString('a\nb'), 'a\\nb');
  assert.equal(escapeTomlString('a\tb'), 'a\\tb');
  assert.equal(escapeTomlString('a\rb'), 'a\\rb');
});

test('escapeTomlString escapes other control characters as \\uXXXX', () => {
  assert.equal(escapeTomlString('a\u0000b'), 'a\\u0000b');
  assert.equal(escapeTomlString('a\u0007b'), 'a\\u0007b');
});

test('escapeTomlString leaves Korean and emoji alone', () => {
  assert.equal(escapeTomlString('브랜치 정리'), '브랜치 정리');
  assert.equal(escapeTomlString('🚀'), '🚀');
});

test('renderCommandBlock emits a parseable block with a stable key order', () => {
  const text = renderCommandBlock(COMMAND);
  assert.equal(text, [
    '[[commands]]',
    'id = "open-in-vs-code"',
    'slot = "1"',
    'label = "Open in VS Code"',
    'type = "shell"',
    'command = "code ."',
    'cwd = "focused"',
    'description = "Open the focused directory"',
    '',
  ].join('\n'));
  assert.deepEqual(parseToml(text).commands[0], COMMAND);
});

test('renderCommandBlock omits an empty description to keep files tidy', () => {
  const text = renderCommandBlock({ ...COMMAND, description: '' });
  assert.ok(!text.includes('description'));
  assert.equal(parseToml(text).commands[0].description, undefined);
});

test('renderCommandBlock survives a label full of quotes and backslashes', () => {
  const hostile = { ...COMMAND, label: 'say "hi" \\ bye', command: 'echo "x"' };
  const parsed = parseToml(renderCommandBlock(hostile)).commands[0];
  assert.equal(parsed.label, 'say "hi" \\ bye');
  assert.equal(parsed.command, 'echo "x"');
});

test('renderConfigToml round-trips the default config exactly', () => {
  const doc = defaultConfig();
  const text = renderConfigToml(doc);
  assert.deepEqual(normalizeConfig(parseConfigToml(text)), doc);
});

test('renderConfigToml writes the header keys before any block', () => {
  const text = renderConfigToml(defaultConfig());
  assert.match(text, /^schema_version = 1\neditor = \["code", .*"nano"\]\n/u);
  assert.ok(text.indexOf('schema_version') < text.indexOf('[[commands]]'));
});

test('renderConfigToml round-trips a Korean, multi-arg-editor config', () => {
  const doc = normalizeConfig({
    editor: ['code', '--new-window'],
    commands: [
      { label: '브랜치 정리', type: 'shell', command: 'git branch --merged', description: '병합된 브랜치 보기' },
      { label: '파일 탐색기', type: 'plugin_action', command: 'ray.file-explorer.open' },
    ],
  });
  assert.deepEqual(normalizeConfig(parseConfigToml(renderConfigToml(doc))), doc);
});

test('renderConfigToml handles an empty command list', () => {
  const doc = normalizeConfig({ commands: [] });
  assert.deepEqual(normalizeConfig(parseConfigToml(renderConfigToml(doc))), doc);
});

test('parseConfigToml accepts comments and commented-out blocks', () => {
  const value = parseConfigToml([
    'schema_version = 1',
    'editor = ["code"]',
    '',
    '# the ones I actually use',
    '[[commands]]',
    'label = "Ls"',
    'type = "shell"',
    'command = "ls"   # trailing comment',
    '',
    '# [[commands]]',
    '# label = "Lazygit"',
    '# type = "shell"',
    '# command = "lazygit"',
    '',
  ].join('\n'));
  assert.equal(value.commands.length, 1);
  assert.equal(value.commands[0].command, 'ls');
});

test('parseConfigToml reports malformed TOML as a ConfigError naming the file', () => {
  assert.throws(() => parseConfigToml('label = ', 'commands.toml'), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /commands\.toml/u);
    assert.match(error.message, /not valid TOML/u);
    return true;
  });
});

test('parseConfigToml keeps only the reason, not the source excerpt', () => {
  assert.throws(() => parseConfigToml('[[commands]]\nlabel = \n'), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /not valid TOML at line \d+/u);
    assert.match(error.message, /no value specified/u);
    // smol-toml appends a blank line, a source excerpt and a caret diagram. The
    // popup collapses newlines when wrapping, so none of that may reach it.
    assert.ok(!error.message.includes('^'), error.message);
    assert.ok(!error.message.includes('\n'), error.message);
    assert.ok(error.message.length < 160, error.message);
    return true;
  });
});

test('parseConfigToml reports a duplicated key rather than throwing raw', () => {
  assert.throws(
    () => parseConfigToml('a = 1\na = 2'),
    (error) => error instanceof ConfigError,
  );
});
