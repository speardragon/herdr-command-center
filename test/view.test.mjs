import assert from 'node:assert/strict';
import test from 'node:test';

import { SLOT_KEYS } from '../src/schema.mjs';
import { beginImport, CHOICE_FIELDS, createView, FORM_FIELDS, MODES, reduceKey } from '../src/view.mjs';

function doc(labels = ['One', 'Two', 'Three']) {
  return {
    schema_version: 1,
    editor: ['code'],
    commands: labels.map((label, index) => ({
      id: `id-${index}`,
      slot: SLOT_KEYS[index],
      label,
      type: 'shell',
      command: `run-${index}`,
      cwd: 'focused',
      description: '',
    })),
  };
}

function press(view, ...keys) {
  return keys.reduce((current, key) => reduceKey(current, key), view);
}

test('exports the mode and field vocabularies', () => {
  assert.deepEqual([...MODES], ['list', 'form', 'confirm-delete', 'error', 'import', 'editor-pick']);
  assert.deepEqual([...FORM_FIELDS], ['label', 'slot', 'type', 'command', 'cwd', 'description']);
  assert.deepEqual([...CHOICE_FIELDS].sort(), ['cwd', 'slot', 'type']);
});

test('createView starts in list mode with the cursor clamped', () => {
  const view = createView({ doc: doc() });
  assert.equal(view.mode, 'list');
  assert.equal(view.cursor, 0);
  assert.equal(view.form, null);
  assert.equal(view.effect, null);
  // The cursor addresses a slot, so it is bounded by the slot list, not by how
  // many commands happen to be registered.
  assert.equal(createView({ doc: doc(), cursor: 99 }).cursor, SLOT_KEYS.length - 1);
  assert.equal(createView({ doc: doc([]), cursor: 5 }).cursor, 5);
});

test('createView with an error starts in error mode', () => {
  const view = createView({ doc: doc(), error: 'commands.json is not valid JSON' });
  assert.equal(view.mode, 'error');
  assert.equal(view.error, 'commands.json is not valid JSON');
});

test('reduceKey rejects a non-object view', () => {
  assert.throws(() => reduceKey(null, 'enter'), TypeError);
});

test('arrow keys move the cursor and wrap', () => {
  const view = createView({ doc: doc() });
  assert.equal(press(view, 'down').cursor, 1);
  assert.equal(press(view, 'down', 'down').cursor, 2);
  assert.equal(press(view, 'up').cursor, SLOT_KEYS.length - 1);
});

test('moving the cursor never emits an effect', () => {
  assert.equal(press(createView({ doc: doc() }), 'down').effect, null);
});

test('enter runs the command under the cursor', () => {
  const view = press(createView({ doc: doc() }), 'down', 'enter');
  assert.deepEqual(view.effect, { type: 'run', command: doc().commands[1] });
});

test('digits run the command at that absolute index', () => {
  const view = createView({ doc: doc(['a', 'b', 'c']) });
  const pressed = press(view, '3');
  assert.equal(pressed.cursor, 2);
  assert.equal(pressed.effect.type, 'run');
  assert.equal(pressed.effect.command.label, 'c');
});

test('digits beyond the list are ignored', () => {
  const view = createView({ doc: doc(['a', 'b']) });
  const pressed = press(view, '9');
  assert.equal(pressed.effect, null);
  assert.equal(pressed.cursor, 0);
});

test('digits address absolute positions even when the list has scrolled', () => {
  const labels = Array.from({ length: 20 }, (unused, index) => `cmd-${index}`);
  const view = press(createView({ doc: doc(labels) }), 'up');
  assert.equal(view.cursor, SLOT_KEYS.length - 1);
  const pressed = reduceKey(view, '1');
  assert.equal(pressed.cursor, 0);
  assert.equal(pressed.effect.command.label, 'cmd-0');
});

test('escape and interrupt close the popup', () => {
  const view = createView({ doc: doc() });
  for (const key of ['escape', 'interrupt']) {
    assert.deepEqual(reduceKey(view, key).effect, { type: 'close' });
  }
});

test('O asks to open the config file', () => {
  assert.deepEqual(reduceKey(createView({ doc: doc() }), 'O').effect, { type: 'open-config' });
});

test('an empty list still closes and still opens the config', () => {
  const view = createView({ doc: doc([]) });
  assert.deepEqual(reduceKey(view, 'enter').effect, null);
  assert.equal(reduceKey(view, 'enter').mode, 'form', 'enter offers to fill the empty slot');
  assert.deepEqual(reduceKey(view, 'E').effect, null);
  assert.equal(reduceKey(view, 'E').mode, 'list');
  assert.deepEqual(reduceKey(view, 'D').effect, null);
  assert.equal(reduceKey(view, 'D').mode, 'list');
  assert.deepEqual(reduceKey(view, 'O').effect, { type: 'open-config' });
  assert.deepEqual(reduceKey(view, 'escape').effect, { type: 'close' });
});

test('A opens an empty add form', () => {
  const view = reduceKey(createView({ doc: doc() }), 'A');
  assert.equal(view.mode, 'form');
  assert.equal(view.form.commandId, null);
  assert.equal(view.form.fieldIndex, 0);
  assert.deepEqual(view.form.fields, {
    label: '', slot: '4', type: 'shell', command: '', cwd: 'focused', description: '',
  });
});

test('E prefills the form from the selected command', () => {
  const view = press(createView({ doc: doc() }), 'down', 'E');
  assert.equal(view.mode, 'form');
  assert.equal(view.form.commandId, 'id-1');
  assert.equal(view.form.fields.label, 'Two');
  assert.equal(view.form.fields.command, 'run-1');
});

test('tab and backtab cycle form fields', () => {
  const form = reduceKey(createView({ doc: doc() }), 'A');
  assert.equal(press(form, 'tab').form.fieldIndex, 1);
  assert.equal(press(form, 'down', 'down').form.fieldIndex, 2);
  assert.equal(press(form, 'backtab').form.fieldIndex, 5);
  assert.equal(press(form, 'up').form.fieldIndex, 5);
});

test('typing edits the focused text field, including Korean and spaces', () => {
  let view = reduceKey(createView({ doc: doc() }), 'A');
  view = press(view, 'a', 'b', 'space', '한');
  assert.equal(view.form.fields.label, 'ab 한');
  view = reduceKey(view, 'backspace');
  assert.equal(view.form.fields.label, 'ab ');
});

test('digits are literal text inside the form', () => {
  const view = press(reduceKey(createView({ doc: doc() }), 'A'), '3', '7');
  assert.equal(view.form.fields.label, '37');
  assert.equal(view.form.effect, undefined);
});

test('named keys are never inserted as text', () => {
  const view = press(reduceKey(createView({ doc: doc() }), 'A'), 'left', 'right');
  assert.equal(view.form.fields.label, '');
});

test('left, right, and space cycle the type and cwd choices', () => {
  let view = press(reduceKey(createView({ doc: doc() }), 'A'), 'tab', 'tab');
  assert.equal(view.form.fields.type, 'shell');
  view = reduceKey(view, 'right');
  assert.equal(view.form.fields.type, 'pane');
  view = reduceKey(view, 'space');
  assert.equal(view.form.fields.type, 'plugin_action');
  view = reduceKey(view, 'left');
  assert.equal(view.form.fields.type, 'pane');

  let cwdView = press(reduceKey(createView({ doc: doc() }), 'A'), 'tab', 'tab', 'tab', 'tab');
  assert.equal(cwdView.form.fields.cwd, 'focused');
  cwdView = reduceKey(cwdView, 'right');
  assert.equal(cwdView.form.fields.cwd, 'workspace');
});

test('left and right cycle the slot choice too', () => {
  let view = press(reduceKey(createView({ doc: doc() }), 'A'), 'tab');
  assert.equal(view.form.fields.slot, '4');
  view = reduceKey(view, 'right');
  assert.equal(view.form.fields.slot, '5');
  view = reduceKey(view, 'left');
  assert.equal(view.form.fields.slot, '4');
});

test('escape discards the form without saving', () => {
  const view = press(reduceKey(createView({ doc: doc() }), 'A'), 'x', 'escape');
  assert.equal(view.mode, 'list');
  assert.equal(view.form, null);
  assert.equal(view.effect, null);
  assert.equal(view.doc.commands.length, 3);
});

test('enter appends a new command and asks for a save', () => {
  let view = reduceKey(createView({ doc: doc() }), 'A');
  for (const key of [...'Tidy']) view = reduceKey(view, key);
  view = reduceKey(view, 'tab');
  view = reduceKey(view, 'tab');
  view = reduceKey(view, 'tab');
  for (const key of [...'ls']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');

  assert.equal(view.mode, 'list');
  assert.equal(view.form, null);
  assert.equal(view.doc.commands.length, 4);
  assert.equal(view.cursor, 3);
  assert.deepEqual(view.doc.commands[3], {
    id: 'tidy', slot: '4', label: 'Tidy', type: 'shell', command: 'ls', cwd: 'focused', description: '',
  });
  assert.deepEqual(view.effect, { type: 'save', doc: view.doc, cursor: 3 });
});

test('enter updates the edited command in place and keeps its id', () => {
  let view = press(createView({ doc: doc() }), 'down', 'E');
  view = reduceKey(view, 'backspace');
  view = reduceKey(view, 'backspace');
  view = reduceKey(view, 'backspace');
  for (const key of [...'Zwei']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');

  assert.equal(view.doc.commands.length, 3);
  assert.equal(view.doc.commands[1].id, 'id-1');
  assert.equal(view.doc.commands[1].label, 'Zwei');
  assert.equal(view.cursor, 1);
  assert.equal(view.effect.type, 'save');
});

test('enter on an invalid form reports the reason and stays in the form', () => {
  const view = reduceKey(reduceKey(createView({ doc: doc() }), 'A'), 'enter');
  assert.equal(view.mode, 'form');
  assert.match(view.formError, /label/u);
  assert.equal(view.effect, null);
});

test('a plugin_action form rejects a bare action id', () => {
  let view = reduceKey(createView({ doc: doc() }), 'A');
  for (const key of [...'Explorer']) view = reduceKey(view, key);
  view = press(view, 'tab', 'tab', 'right', 'right', 'tab');
  for (const key of [...'open']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');
  assert.equal(view.mode, 'form');
  assert.match(view.formError, /plugin_id\.action_id/u);
});

test('a duplicate label gets a deduped id rather than an error', () => {
  let view = reduceKey(createView({ doc: doc(['One']) }), 'A');
  for (const key of [...'One']) view = reduceKey(view, key);
  view = press(view, 'tab', 'tab', 'tab');
  for (const key of [...'ls']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');
  assert.deepEqual(view.doc.commands.map((command) => command.id), ['id-0', 'one']);
});

test('editing a command keeps its own id available to itself', () => {
  const single = {
    schema_version: 1,
    editor: ['code'],
    commands: [{ id: 'keep', slot: '1', label: 'Keep', type: 'shell', command: 'ls', cwd: 'focused', description: '' }],
  };
  let view = reduceKey(createView({ doc: single }), 'E');
  view = press(view, 'tab', 'tab', 'tab');
  for (const key of [...'!']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');
  assert.equal(view.doc.commands[0].id, 'keep');
});

test('d then y removes the command and asks for a save', () => {
  const confirm = press(createView({ doc: doc() }), 'down', 'D');
  assert.equal(confirm.mode, 'confirm-delete');
  assert.equal(confirm.effect, null);
  const deleted = reduceKey(confirm, 'y');
  assert.equal(deleted.mode, 'list');
  assert.deepEqual(deleted.doc.commands.map((command) => command.label), ['One', 'Three']);
  assert.deepEqual(deleted.effect, { type: 'save', doc: deleted.doc, cursor: 1 });
});

test('deleting leaves the cursor on the slot it emptied', () => {
  const deleted = press(createView({ doc: doc() }), 'down', 'down', 'D', 'y');
  assert.equal(deleted.cursor, 2);
  assert.deepEqual(deleted.doc.commands.map((command) => command.label), ['One', 'Two']);
});

test('deleting the only command leaves an empty list at cursor zero', () => {
  const deleted = press(createView({ doc: doc(['Only']) }), 'D', 'y');
  assert.deepEqual(deleted.doc.commands, []);
  assert.equal(deleted.cursor, 0);
});

test('any key other than y cancels the delete', () => {
  const confirm = reduceKey(createView({ doc: doc() }), 'D');
  for (const key of ['n', 'escape', 'enter', 'Y']) {
    const cancelled = reduceKey(confirm, key);
    assert.equal(cancelled.mode, 'list', key);
    assert.equal(cancelled.effect, null, key);
    assert.equal(cancelled.doc.commands.length, 3, key);
  }
});

test('error mode only offers open-config and close', () => {
  const view = createView({ doc: doc(), error: 'broken' });
  assert.deepEqual(reduceKey(view, 'o').effect, { type: 'open-config' });
  assert.deepEqual(reduceKey(view, 'escape').effect, { type: 'close' });
  assert.deepEqual(reduceKey(view, 'q').effect, { type: 'close' });
  assert.deepEqual(reduceKey(view, 'interrupt').effect, { type: 'close' });
  assert.equal(reduceKey(view, 'enter').effect, null);
  assert.equal(reduceKey(view, 'a').mode, 'error');
});

test('error mode accepts the uppercase action the list teaches', () => {
  const view = createView({ doc: doc(), error: 'broken' });
  assert.deepEqual(reduceKey(view, 'O').effect, { type: 'open-config' });
  // lowercase kept working: no slots exist in this mode to collide with
  assert.deepEqual(reduceKey(view, 'o').effect, { type: 'open-config' });
});

test('reduceKey never mutates the view it was given', () => {
  const view = createView({ doc: doc() });
  const snapshot = JSON.parse(JSON.stringify({ ...view, doc: view.doc }));
  reduceKey(view, 'down');
  reduceKey(view, 'a');
  reduceKey(view, 'enter');
  assert.deepEqual(JSON.parse(JSON.stringify({ ...view, doc: view.doc })), snapshot);
});

test('a stale effect is cleared by the next key', () => {
  const ran = reduceKey(createView({ doc: doc() }), 'enter');
  assert.equal(ran.effect.type, 'run');
  assert.equal(reduceKey(ran, 'down').effect, null);
});

test('a lowercase key or digit runs the command in that slot', () => {
  const view = createView({ doc: doc(['One', 'Two', 'Three']) });
  assert.equal(reduceKey(view, '1').effect.command.label, 'One');
  assert.equal(reduceKey(view, '3').effect.command.label, 'Three');
  assert.equal(reduceKey(view, '4').effect, null, 'no command in slot 4');
});

test('slots are addressed by key, not by position', () => {
  const custom = {
    schema_version: 1,
    editor: [],
    commands: [
      { id: 'deploy', slot: 'd', label: 'Deploy', type: 'shell', command: './deploy', cwd: 'focused', description: '' },
      { id: 'logs', slot: 'l', label: 'Logs', type: 'shell', command: 'tail -f log', cwd: 'focused', description: '' },
    ],
  };
  const view = createView({ doc: custom });
  assert.equal(reduceKey(view, 'd').effect.command.label, 'Deploy');
  assert.equal(reduceKey(view, 'l').effect.command.label, 'Logs');
  assert.equal(reduceKey(view, '1').effect, null, 'nothing claims slot 1');
});

test('running by slot moves the cursor onto it', () => {
  const view = createView({ doc: doc(['One', 'Two', 'Three']) });
  assert.equal(reduceKey(view, '3').cursor, 2);
});

test('uppercase keys are the actions', () => {
  const view = createView({ doc: doc() });
  assert.equal(reduceKey(view, 'A').mode, 'form');
  assert.equal(reduceKey(view, 'A').form.commandId, null);
  assert.equal(reduceKey(view, 'E').mode, 'form');
  assert.equal(reduceKey(view, 'E').form.commandId, 'id-0');
  assert.equal(reduceKey(view, 'D').mode, 'confirm-delete');
  assert.deepEqual(reduceKey(view, 'O').effect, { type: 'open-config' });
});

test('the old lowercase action keys now run their slots instead', () => {
  // a/e/d/o are slots 11-14 in a long enough list; with three commands they do nothing
  const view = createView({ doc: doc() });
  for (const key of ['a', 'e', 'd', 'o', 'q']) {
    const pressed = reduceKey(view, key);
    assert.equal(pressed.effect, null, key);
    assert.equal(pressed.mode, 'list', key);
  }
});

test('escape and interrupt still close, but q does not', () => {
  const view = createView({ doc: doc() });
  assert.deepEqual(reduceKey(view, 'escape').effect, { type: 'close' });
  assert.deepEqual(reduceKey(view, 'interrupt').effect, { type: 'close' });
  assert.equal(reduceKey(view, 'q').effect, null);
});

test('arrow keys walk the grid using the column count given', () => {
  const view = createView({ doc: doc() });
  const grid = { columns: 3 }; // 36 slots over 3 columns is 12 rows
  assert.equal(reduceKey(view, 'down', grid).cursor, 1, 'down walks the column');
  assert.equal(reduceKey(view, 'right', grid).cursor, 12, 'right steps a whole column');
  assert.equal(reduceKey(reduceKey(view, 'right', grid), 'left', grid).cursor, 0);
  assert.equal(reduceKey(view, 'left', grid).cursor, 24, 'wraps to the last column, same row');
});

test('the bottom of a column continues into the top of the next', () => {
  const grid = { columns: 3 };
  assert.equal(reduceKey(createView({ doc: doc(), cursor: 11 }), 'down', grid).cursor, 12);
  assert.equal(reduceKey(createView({ doc: doc(), cursor: 35 }), 'down', grid).cursor, 0);
});

test('without a column count the arrows behave linearly', () => {
  const view = createView({ doc: doc() });
  assert.equal(reduceKey(view, 'down').cursor, 1);
  assert.equal(reduceKey(view, 'up').cursor, SLOT_KEYS.length - 1);
});

test('enter on an empty slot opens an add form aimed at that slot', () => {
  const view = press(createView({ doc: doc() }), 'down', 'down', 'down');
  const form = reduceKey(view, 'enter');
  assert.equal(form.mode, 'form');
  assert.equal(form.form.commandId, null, 'it is an add, not an edit');
  assert.equal(form.form.fields.slot, '4', 'the slot the cursor was sitting on');
  assert.equal(form.effect, null, 'nothing is written until the form is saved');
});

test('an empty slot offers nothing to run, edit, or delete', () => {
  const view = press(createView({ doc: doc() }), 'down', 'down', 'down');
  assert.equal(reduceKey(view, 'E').mode, 'list');
  assert.equal(reduceKey(view, 'D').mode, 'list');
  assert.equal(reduceKey(view, '4').effect, null);
});

test('j and k no longer navigate, because they are slots', () => {
  const view = createView({ doc: doc() });
  assert.equal(reduceKey(view, 'j').cursor, 0);
  assert.equal(reduceKey(view, 'k').cursor, 0);
});

test('beginImport marks what is already registered', () => {
  const view = createView({ doc: doc(['One']) });
  const imported = beginImport(view, [
    { key: 'prefix+x', label: 'One', type: 'shell', command: 'run-0', description: '', reason: null },
    { key: 'prefix+y', label: 'New', type: 'shell', command: 'brand-new', description: '', reason: null },
  ]);
  assert.equal(imported.mode, 'import');
  assert.deepEqual(imported.importEntries.map((entry) => entry.already), [true, false]);
});

test('choosing an import entry opens a prefilled add form', () => {
  const view = beginImport(createView({ doc: doc() }), [
    { key: 'prefix+g', label: 'Lazygit', type: 'pane', command: 'lazygit', description: 'git TUI', reason: null },
  ]);
  const form = reduceKey(view, 'enter');
  assert.equal(form.mode, 'form');
  assert.equal(form.form.commandId, null, 'it is an add, not an edit');
  assert.equal(form.form.fields.label, 'Lazygit');
  assert.equal(form.form.fields.type, 'pane');
  assert.equal(form.form.fields.command, 'lazygit');
  assert.equal(form.form.fields.description, 'git TUI');
  assert.equal(form.form.fields.slot, '4', 'the first free slot');
  assert.equal(form.effect, null, 'nothing is written until the form is saved');
});

test('an unmappable import entry cannot be chosen', () => {
  const view = beginImport(createView({ doc: doc() }), [
    { key: 'prefix+b', label: 'x', type: null, command: 'whatever', description: '', reason: 'no equivalent' },
  ]);
  assert.equal(reduceKey(view, 'enter').mode, 'import');
});

test('escape leaves the import list without changing anything', () => {
  const view = beginImport(createView({ doc: doc() }), []);
  const back = reduceKey(view, 'escape');
  assert.equal(back.mode, 'list');
  assert.equal(back.effect, null);
});
