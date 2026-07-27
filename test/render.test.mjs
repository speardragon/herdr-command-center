import assert from 'node:assert/strict';
import test from 'node:test';

import { SLOT_KEYS } from '../src/schema.mjs';
import { displayWidth } from '../src/text.mjs';
import { createView, reduceKey } from '../src/view.mjs';
import { gridColumns, renderLines, renderView, textCursor } from '../src/render.mjs';

const SIZE = { columns: 78, rows: 24 };

function doc(labels = ['Open in VS Code', 'Open repo on GitHub', 'File explorer']) {
  return {
    schema_version: 1,
    editor: ['code'],
    commands: labels.map((label, index) => ({
      id: `id-${index}`,
      slot: SLOT_KEYS[index],
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

function press(view, ...keys) {
  return keys.reduce((current, key) => reduceKey(current, key), view);
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

test('the grid shows the slot key next to each command and marks the cursor', () => {
  const text = renderView(createView({ doc: doc() }), SIZE);
  assert.match(text, /› 1  Open in VS Code/u);
  assert.match(text, / 2 {2}Open repo on GitHub/u);
  const moved = renderView(reduceKey(createView({ doc: doc() }), 'down'), SIZE);
  assert.match(moved, /› 2  Open repo on GitHub/u);
});

test('every command shows its own slot key, even past the ninth', () => {
  const labels = Array.from({ length: 12 }, (unused, index) => `cmd-${index}`);
  const text = renderView(createView({ doc: doc(labels), cursor: 11 }), { columns: 78, rows: 40 });
  assert.match(text, /0 {2}cmd-9/u);
  assert.match(text, /a {2}cmd-10/u);
  assert.match(text, /b {2}cmd-11/u);
});

test('the list shows the selected command type, command, and description', () => {
  const text = renderView(createView({ doc: doc() }), SIZE);
  assert.match(text, /shell · cmd-0/u);
  assert.match(text, /Open the focused directory/u);
  const plugin = renderView(createView({ doc: doc(), cursor: 2 }), SIZE);
  assert.match(plugin, /plugin_action · ray\.file-explorer\.open/u);
});

test('the list footer advertises the uppercase actions', () => {
  // Wide enough that the footer does not wrap, since a wrapped line would
  // split a fragment like "O edit file" across two lines.
  const text = renderView(createView({ doc: doc() }), { columns: 120, rows: 24 });
  for (const fragment of ['enter run', 'slot key runs', 'A add', 'E edit', 'D delete', 'O edit file', 'I import', 'esc close']) {
    assert.ok(text.includes(fragment), `footer is missing "${fragment}"`);
  }
  assert.ok(!text.includes('1-9 run'), 'slots are no longer a numeric range');
});

test('a long list hides the rows past the budget and says how many', () => {
  const labels = Array.from({ length: 40 }, (unused, index) => `cmd-${index}`);
  const view = createView({ doc: doc(labels), cursor: 20 });
  const text = renderView(view, SIZE);
  assert.match(text, /↓ \d+ more/u);
  assert.match(text, /cmd-0\b/u);
});

test('an empty list explains how to add a command', () => {
  // Wide enough that the sentence does not wrap mid-word.
  const text = renderView(createView({ doc: doc([]) }), { columns: 120, rows: 24 });
  assert.match(text, /Command Center · 0 commands/u);
  assert.match(text, /Press A to add one/u);
  assert.match(text, /commands\.toml/u);
});

test('the form labels every field and marks the focused one', () => {
  const view = reduceKey(createView({ doc: doc() }), 'A');
  const text = renderView(view, SIZE);
  assert.match(text, /Command Center · Add command/u);
  for (const label of ['Label', 'Slot', 'Type', 'Command', 'Cwd', 'Description']) {
    assert.ok(text.includes(label), `form is missing the ${label} field`);
  }
  assert.match(text, /› Label/u);
  const moved = reduceKey(view, 'tab');
  assert.match(renderView(moved, SIZE), /› Slot/u);
});

test('the edit form is titled and prefilled', () => {
  const view = reduceKey(createView({ doc: doc() }), 'E');
  const text = renderView(view, SIZE);
  assert.match(text, /Command Center · Edit command/u);
  assert.match(text, /Open in VS Code/u);
});

test('choice fields advertise that arrows change them', () => {
  const text = renderView(reduceKey(createView({ doc: doc() }), 'A'), SIZE);
  assert.match(text, /shell\s+\(←→\)/u);
  assert.match(text, /focused\s+\(←→\)/u);
});

test('the form offers the slot as a choice field', () => {
  const text = renderView(reduceKey(createView({ doc: doc() }), 'A'), SIZE);
  assert.match(text, /Slot/u);
  assert.match(text, /4\s+\(←→\)/u, 'the first free slot is pre-picked');
});

test('a form validation failure is rendered', () => {
  const view = reduceKey(reduceKey(createView({ doc: doc() }), 'A'), 'enter');
  assert.match(renderView(view, SIZE), /label must not be empty/u);
});

test('the form footer advertises its keys', () => {
  const text = renderView(reduceKey(createView({ doc: doc() }), 'A'), SIZE);
  for (const fragment of ['tab', 'enter save', 'esc cancel']) {
    assert.ok(text.includes(fragment), `form footer is missing "${fragment}"`);
  }
});

test('the delete confirmation names the command', () => {
  const view = reduceKey(createView({ doc: doc() }), 'D');
  const text = renderView(view, SIZE);
  assert.match(text, /Delete "Open in VS Code"\?/u);
  assert.match(text, /y delete/u);
});

test('error mode shows the config error and only its own keys', () => {
  const view = createView({ doc: doc(), error: 'commands.toml is not valid JSON' });
  const text = renderView(view, SIZE);
  assert.match(text, /Command Center · config error/u);
  assert.match(text, /commands\.toml is not valid JSON/u);
  assert.match(text, /O edit file/u);
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

test('textCursor marks the edit point of a focused text field', () => {
  const view = reduceKey(createView({ doc: doc() }), 'A');
  // padding(1) + title(0) + blank(1) => the Label row; the value column sits
  // after the marker and the padded label.
  assert.deepEqual(textCursor(view, SIZE), { row: 3, column: 17 });
  // Slot and Type are skipped: both are choice fields, reached by 3 tabs to Command.
  assert.deepEqual(textCursor(press(view, 'tab', 'tab', 'tab'), SIZE), { row: 6, column: 17 });
  // Cwd is also a choice field; 5 tabs reaches Description.
  assert.deepEqual(textCursor(press(view, 'tab', 'tab', 'tab', 'tab', 'tab'), SIZE), { row: 8, column: 17 });
});

test('textCursor advances past what has been typed, counting CJK as two cells', () => {
  let view = reduceKey(createView({ doc: doc() }), 'A');
  assert.equal(textCursor(view, SIZE).column, 17);
  view = press(view, 'a', 'b');
  assert.equal(textCursor(view, SIZE).column, 19);
  view = press(view, '배', '포');
  assert.equal(textCursor(view, SIZE).column, 23);
});

test('textCursor gives choice fields no caret, since typing does nothing there', () => {
  const view = reduceKey(createView({ doc: doc() }), 'A');
  assert.equal(textCursor(press(view, 'tab'), SIZE), null, 'Slot');
  assert.equal(textCursor(press(view, 'tab', 'tab'), SIZE), null, 'Type');
  assert.equal(textCursor(press(view, 'tab', 'tab', 'tab', 'tab'), SIZE), null, 'Cwd');
});

test('textCursor is null wherever nothing is editable', () => {
  assert.equal(textCursor(createView({ doc: doc() }), SIZE), null, 'list');
  assert.equal(textCursor(reduceKey(createView({ doc: doc() }), 'D'), SIZE), null, 'confirm');
  assert.equal(textCursor(createView({ doc: doc(), error: 'broken' }), SIZE), null, 'error');
  assert.equal(textCursor(null, SIZE), null);
});

test('textCursor never points outside the frame', () => {
  const view = reduceKey(createView({ doc: doc() }), 'A');
  // A terminal too short to show the field at all.
  assert.equal(textCursor(view, { columns: 78, rows: 4 }), null);
  // A terminal too narrow for the typed value: clamp to the last usable column.
  let typed = view;
  for (let index = 0; index < 40; index += 1) typed = reduceKey(typed, 'x');
  const cursor = textCursor(typed, { columns: 30, rows: 24 });
  assert.ok(cursor.column <= 30 - 1, `column ${cursor.column} escapes a 30-column frame`);
});

test('the form footer says the fields can be typed into', () => {
  const text = renderView(reduceKey(createView({ doc: doc() }), 'A'), SIZE);
  assert.match(text, /type to edit/u);
});

test('gridColumns grows with the terminal but stays readable', () => {
  const view = createView({ doc: doc() });
  assert.equal(gridColumns(view, { columns: 40, rows: 24 }), 1);
  assert.equal(gridColumns(view, { columns: 80, rows: 24 }), 2);
  assert.ok(gridColumns(view, { columns: 200, rows: 24 }) >= 3);
  assert.ok(gridColumns(view, { columns: 400, rows: 24 }) <= 4, 'capped so cells stay wide');
});

test('the grid shows every slot key next to its command', () => {
  const labels = Array.from({ length: 12 }, (unused, index) => `cmd-${index}`);
  const text = renderView(createView({ doc: doc(labels) }), { columns: 120, rows: 24 });
  for (const slot of [...'1234567890ab']) {
    assert.ok(text.includes(`${slot} `), `slot ${slot} is not shown`);
  }
  assert.ok(text.includes('cmd-11'), 'the twelfth command is reachable');
});

test('the renderer and the reducer agree on the column count', () => {
  // If these two ever disagreed, arrow keys would move the cursor somewhere other
  // than where the grid draws it.
  const labels = Array.from({ length: 8 }, (unused, index) => `cmd-${index}`);
  const view = createView({ doc: doc(labels) });
  for (const size of [{ columns: 40, rows: 24 }, { columns: 80, rows: 24 }, { columns: 200, rows: 24 }]) {
    const columns = gridColumns(view, size);
    const lines = renderLines(view, size);
    const firstRow = lines.find((line) => line.includes('cmd-0'));
    const onFirstRow = labels.filter((label) => firstRow.includes(label)).length;
    assert.equal(onFirstRow, Math.min(columns, labels.length), `at ${size.columns} columns`);
  }
});

test('the grid lays commands out across columns, not down one', () => {
  const labels = Array.from({ length: 6 }, (unused, index) => `cmd-${index}`);
  const lines = renderLines(createView({ doc: doc(labels) }), { columns: 120, rows: 24 });
  const row = lines.find((line) => line.includes('cmd-0'));
  assert.ok(row.includes('cmd-1'), 'the second command shares the first row');
});
