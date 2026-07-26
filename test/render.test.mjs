import assert from 'node:assert/strict';
import test from 'node:test';

import { displayWidth } from '../src/text.mjs';
import { createView, reduceKey } from '../src/view.mjs';
import { renderLines, renderView } from '../src/render.mjs';

const SIZE = { columns: 78, rows: 24 };

function doc(labels = ['Open in VS Code', 'Open repo on GitHub', 'File explorer']) {
  return {
    schema_version: 1,
    editor: ['code'],
    commands: labels.map((label, index) => ({
      id: `id-${index}`,
      label,
      type: index === 2 ? 'plugin_action' : 'shell',
      command: index === 2 ? 'ray.file-explorer.open' : `cmd-${index}`,
      cwd: 'focused',
      description: index === 0 ? 'Open the focused directory' : '',
    })),
  };
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/gu, '');
}

test('renderLines fills the terminal exactly and never overflows the width', () => {
  const lines = renderLines(createView({ doc: doc() }), SIZE);
  assert.equal(lines.length, SIZE.rows);
  for (const line of lines) {
    assert.ok(displayWidth(line) <= SIZE.columns, `"${line}" is ${displayWidth(line)} cells`);
  }
});

test('renderLines keeps the width budget with long Korean labels', () => {
  const long = '브랜치를 정리하고 원격에 푸시한 다음 알림까지 보내는 아주 긴 커맨드 이름';
  const lines = renderLines(createView({ doc: doc([long, long, long]) }), { columns: 40, rows: 16 });
  assert.equal(lines.length, 16);
  for (const line of lines) assert.ok(displayWidth(line) <= 40, line);
});

test('renderLines survives an absurdly small and an absurdly large terminal', () => {
  for (const size of [{ columns: 1, rows: 1 }, { columns: 4, rows: 3 }, { columns: 500, rows: 400 }]) {
    const lines = renderLines(createView({ doc: doc() }), size);
    assert.ok(lines.length >= 1);
    for (const line of lines) assert.ok(displayWidth(line) <= Math.min(size.columns, 240), line);
  }
});

test('renderLines defaults a missing size to the manifest popup size', () => {
  const lines = renderLines(createView({ doc: doc() }));
  assert.equal(lines.length, 24);
});

test('the list shows a header with the command count', () => {
  const text = renderView(createView({ doc: doc() }), SIZE);
  assert.match(text, /Command Center · 3 commands/u);
  assert.match(renderView(createView({ doc: doc(['One']) }), SIZE), /1 command\b/u);
});

test('the list numbers the first nine commands and marks the cursor', () => {
  const text = renderView(createView({ doc: doc() }), SIZE);
  assert.match(text, /› 1\. Open in VS Code/u);
  assert.match(text, / {2}2\. Open repo on GitHub/u);
  const moved = renderView(reduceKey(createView({ doc: doc() }), 'down'), SIZE);
  assert.match(moved, /› 2\. Open repo on GitHub/u);
});

test('commands past the ninth have no badge', () => {
  const labels = Array.from({ length: 12 }, (unused, index) => `cmd-${index}`);
  const text = renderView(createView({ doc: doc(labels), cursor: 11 }), { columns: 78, rows: 40 });
  assert.match(text, /9\. cmd-8/u);
  assert.doesNotMatch(text, /10\. cmd-9/u);
  assert.match(text, /cmd-11/u);
});

test('the list shows the selected command type, command, and description', () => {
  const text = renderView(createView({ doc: doc() }), SIZE);
  assert.match(text, /shell · cmd-0/u);
  assert.match(text, /Open the focused directory/u);
  const plugin = renderView(createView({ doc: doc(), cursor: 2 }), SIZE);
  assert.match(plugin, /plugin_action · ray\.file-explorer\.open/u);
});

test('the list footer advertises every key', () => {
  const text = renderView(createView({ doc: doc() }), SIZE);
  for (const fragment of ['enter run', '1-9 run', 'a add', 'e edit', 'd delete', 'o edit file', 'esc close']) {
    assert.ok(text.includes(fragment), `footer is missing "${fragment}"`);
  }
});

test('a long list scrolls around the cursor and shows the direction hints', () => {
  const labels = Array.from({ length: 40 }, (unused, index) => `cmd-${index}`);
  const view = createView({ doc: doc(labels), cursor: 20 });
  const text = renderView(view, SIZE);
  assert.match(text, /↑ more/u);
  assert.match(text, /↓ more/u);
  assert.match(text, /cmd-20/u);
  assert.doesNotMatch(text, /cmd-0\b/u);
  const top = renderView(createView({ doc: doc(labels), cursor: 0 }), SIZE);
  assert.doesNotMatch(top, /↑ more/u);
  assert.match(top, /↓ more/u);
});

test('an empty list explains how to add a command', () => {
  const text = renderView(createView({ doc: doc([]) }), SIZE);
  assert.match(text, /Command Center · 0 commands/u);
  assert.match(text, /Press a to add one/u);
  assert.match(text, /commands\.toml/u);
});

test('the form labels every field and marks the focused one', () => {
  const view = reduceKey(createView({ doc: doc() }), 'a');
  const text = renderView(view, SIZE);
  assert.match(text, /Command Center · Add command/u);
  for (const label of ['Label', 'Type', 'Command', 'Cwd', 'Description']) {
    assert.ok(text.includes(label), `form is missing the ${label} field`);
  }
  assert.match(text, /› Label/u);
  const moved = reduceKey(view, 'tab');
  assert.match(renderView(moved, SIZE), /› Type/u);
});

test('the edit form is titled and prefilled', () => {
  const view = reduceKey(createView({ doc: doc() }), 'e');
  const text = renderView(view, SIZE);
  assert.match(text, /Command Center · Edit command/u);
  assert.match(text, /Open in VS Code/u);
});

test('choice fields advertise that arrows change them', () => {
  const text = renderView(reduceKey(createView({ doc: doc() }), 'a'), SIZE);
  assert.match(text, /shell\s+\(←→\)/u);
  assert.match(text, /focused\s+\(←→\)/u);
});

test('a form validation failure is rendered', () => {
  const view = reduceKey(reduceKey(createView({ doc: doc() }), 'a'), 'enter');
  assert.match(renderView(view, SIZE), /label must not be empty/u);
});

test('the form footer advertises its keys', () => {
  const text = renderView(reduceKey(createView({ doc: doc() }), 'a'), SIZE);
  for (const fragment of ['tab', 'enter save', 'esc cancel']) {
    assert.ok(text.includes(fragment), `form footer is missing "${fragment}"`);
  }
});

test('the delete confirmation names the command', () => {
  const view = reduceKey(createView({ doc: doc() }), 'd');
  const text = renderView(view, SIZE);
  assert.match(text, /Delete "Open in VS Code"\?/u);
  assert.match(text, /y delete/u);
});

test('error mode shows the config error and only its own keys', () => {
  const view = createView({ doc: doc(), error: 'commands.toml is not valid JSON' });
  const text = renderView(view, SIZE);
  assert.match(text, /Command Center · config error/u);
  assert.match(text, /commands\.toml is not valid JSON/u);
  assert.match(text, /o edit file/u);
  assert.ok(!text.includes('a add'));
});

test('color mode adds ANSI styling without changing the layout width', () => {
  const view = createView({ doc: doc() });
  const plain = renderLines(view, SIZE);
  const colored = renderLines(view, { ...SIZE, color: true });
  assert.equal(colored.length, plain.length);
  assert.deepEqual(colored.map(stripAnsi), plain);
  assert.ok(colored.some((line) => line.includes('\u001b[')));
});

test('color is off unless requested', () => {
  assert.ok(!renderView(createView({ doc: doc() }), SIZE).includes('\u001b['));
});

test('a command label containing an escape sequence cannot corrupt the frame', () => {
  const hostile = doc(['\u001b[31mred\u001b[0m label']);
  const lines = renderLines(createView({ doc: hostile }), SIZE);
  assert.ok(lines.some((line) => line.includes('<U+001B>')));
  assert.ok(!lines.some((line) => /\u001b\[31m/u.test(line)));
});
