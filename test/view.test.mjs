import assert from 'node:assert/strict';
import test from 'node:test';

import { CHOICE_FIELDS, createView, FORM_FIELDS, MODES, reduceKey } from '../src/view.mjs';

function doc(labels = ['One', 'Two', 'Three']) {
  return {
    schema_version: 1,
    editor: ['code'],
    commands: labels.map((label, index) => ({
      id: `id-${index}`,
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
  assert.deepEqual([...MODES], ['list', 'form', 'confirm-delete', 'error']);
  assert.deepEqual([...FORM_FIELDS], ['label', 'type', 'command', 'cwd', 'description']);
  assert.deepEqual([...CHOICE_FIELDS].sort(), ['cwd', 'type']);
});

test('createView starts in list mode with the cursor clamped', () => {
  const view = createView({ doc: doc() });
  assert.equal(view.mode, 'list');
  assert.equal(view.cursor, 0);
  assert.equal(view.form, null);
  assert.equal(view.effect, null);
  assert.equal(createView({ doc: doc(), cursor: 99 }).cursor, 2);
  assert.equal(createView({ doc: doc([]) , cursor: 5 }).cursor, 0);
});

test('createView with an error starts in error mode', () => {
  const view = createView({ doc: doc(), error: 'commands.json is not valid JSON' });
  assert.equal(view.mode, 'error');
  assert.equal(view.error, 'commands.json is not valid JSON');
});

test('reduceKey rejects a non-object view', () => {
  assert.throws(() => reduceKey(null, 'enter'), TypeError);
});

test('arrow keys and vim keys move the cursor and wrap', () => {
  const view = createView({ doc: doc() });
  assert.equal(press(view, 'down').cursor, 1);
  assert.equal(press(view, 'j', 'j').cursor, 2);
  assert.equal(press(view, 'down', 'down', 'down').cursor, 0);
  assert.equal(press(view, 'up').cursor, 2);
  assert.equal(press(view, 'k').cursor, 2);
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
  assert.equal(view.cursor, 19);
  const pressed = reduceKey(view, '1');
  assert.equal(pressed.cursor, 0);
  assert.equal(pressed.effect.command.label, 'cmd-0');
});

test('escape, q, and interrupt close the popup', () => {
  const view = createView({ doc: doc() });
  for (const key of ['escape', 'q', 'interrupt']) {
    assert.deepEqual(reduceKey(view, key).effect, { type: 'close' });
  }
});

test('o asks to open the config file', () => {
  assert.deepEqual(reduceKey(createView({ doc: doc() }), 'o').effect, { type: 'open-config' });
});

test('an empty list still closes and still opens the config', () => {
  const view = createView({ doc: doc([]) });
  assert.deepEqual(reduceKey(view, 'enter').effect, null);
  assert.deepEqual(reduceKey(view, 'e').effect, null);
  assert.equal(reduceKey(view, 'e').mode, 'list');
  assert.deepEqual(reduceKey(view, 'd').effect, null);
  assert.equal(reduceKey(view, 'd').mode, 'list');
  assert.deepEqual(reduceKey(view, 'o').effect, { type: 'open-config' });
  assert.deepEqual(reduceKey(view, 'escape').effect, { type: 'close' });
});

test('a opens an empty add form', () => {
  const view = reduceKey(createView({ doc: doc() }), 'a');
  assert.equal(view.mode, 'form');
  assert.equal(view.form.commandId, null);
  assert.equal(view.form.fieldIndex, 0);
  assert.deepEqual(view.form.fields, {
    label: '', type: 'shell', command: '', cwd: 'focused', description: '',
  });
});

test('e prefills the form from the selected command', () => {
  const view = press(createView({ doc: doc() }), 'down', 'e');
  assert.equal(view.mode, 'form');
  assert.equal(view.form.commandId, 'id-1');
  assert.equal(view.form.fields.label, 'Two');
  assert.equal(view.form.fields.command, 'run-1');
});

test('tab and backtab cycle form fields', () => {
  const form = reduceKey(createView({ doc: doc() }), 'a');
  assert.equal(press(form, 'tab').form.fieldIndex, 1);
  assert.equal(press(form, 'down', 'down').form.fieldIndex, 2);
  assert.equal(press(form, 'backtab').form.fieldIndex, 4);
  assert.equal(press(form, 'up').form.fieldIndex, 4);
});

test('typing edits the focused text field, including Korean and spaces', () => {
  let view = reduceKey(createView({ doc: doc() }), 'a');
  view = press(view, 'a', 'b', 'space', '한');
  assert.equal(view.form.fields.label, 'ab 한');
  view = reduceKey(view, 'backspace');
  assert.equal(view.form.fields.label, 'ab ');
});

test('digits are literal text inside the form', () => {
  const view = press(reduceKey(createView({ doc: doc() }), 'a'), '3', '7');
  assert.equal(view.form.fields.label, '37');
  assert.equal(view.form.effect, undefined);
});

test('named keys are never inserted as text', () => {
  const view = press(reduceKey(createView({ doc: doc() }), 'a'), 'left', 'right');
  assert.equal(view.form.fields.label, '');
});

test('left, right, and space cycle the type and cwd choices', () => {
  let view = press(reduceKey(createView({ doc: doc() }), 'a'), 'tab');
  assert.equal(view.form.fields.type, 'shell');
  view = reduceKey(view, 'right');
  assert.equal(view.form.fields.type, 'plugin_action');
  view = reduceKey(view, 'space');
  assert.equal(view.form.fields.type, 'shell');
  view = reduceKey(view, 'left');
  assert.equal(view.form.fields.type, 'plugin_action');

  let cwdView = press(reduceKey(createView({ doc: doc() }), 'a'), 'tab', 'tab', 'tab');
  assert.equal(cwdView.form.fields.cwd, 'focused');
  cwdView = reduceKey(cwdView, 'right');
  assert.equal(cwdView.form.fields.cwd, 'workspace');
});

test('escape discards the form without saving', () => {
  const view = press(reduceKey(createView({ doc: doc() }), 'a'), 'x', 'escape');
  assert.equal(view.mode, 'list');
  assert.equal(view.form, null);
  assert.equal(view.effect, null);
  assert.equal(view.doc.commands.length, 3);
});

test('enter appends a new command and asks for a save', () => {
  let view = reduceKey(createView({ doc: doc() }), 'a');
  for (const key of [...'Tidy']) view = reduceKey(view, key);
  view = reduceKey(view, 'tab');
  view = reduceKey(view, 'tab');
  for (const key of [...'ls']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');

  assert.equal(view.mode, 'list');
  assert.equal(view.form, null);
  assert.equal(view.doc.commands.length, 4);
  assert.equal(view.cursor, 3);
  assert.deepEqual(view.doc.commands[3], {
    id: 'tidy', label: 'Tidy', type: 'shell', command: 'ls', cwd: 'focused', description: '',
  });
  assert.deepEqual(view.effect, { type: 'save', doc: view.doc, cursor: 3 });
});

test('enter updates the edited command in place and keeps its id', () => {
  let view = press(createView({ doc: doc() }), 'down', 'e');
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
  const view = reduceKey(reduceKey(createView({ doc: doc() }), 'a'), 'enter');
  assert.equal(view.mode, 'form');
  assert.match(view.formError, /label/u);
  assert.equal(view.effect, null);
});

test('a plugin_action form rejects a bare action id', () => {
  let view = reduceKey(createView({ doc: doc() }), 'a');
  for (const key of [...'Explorer']) view = reduceKey(view, key);
  view = press(view, 'tab', 'right', 'tab');
  for (const key of [...'open']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');
  assert.equal(view.mode, 'form');
  assert.match(view.formError, /plugin_id\.action_id/u);
});

test('a duplicate label gets a deduped id rather than an error', () => {
  let view = reduceKey(createView({ doc: doc(['One']) }), 'a');
  for (const key of [...'One']) view = reduceKey(view, key);
  view = press(view, 'tab', 'tab');
  for (const key of [...'ls']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');
  assert.deepEqual(view.doc.commands.map((command) => command.id), ['id-0', 'one']);
});

test('editing a command keeps its own id available to itself', () => {
  const single = {
    schema_version: 1,
    editor: ['code'],
    commands: [{ id: 'keep', label: 'Keep', type: 'shell', command: 'ls', cwd: 'focused', description: '' }],
  };
  let view = reduceKey(createView({ doc: single }), 'e');
  view = press(view, 'tab', 'tab');
  for (const key of [...'!']) view = reduceKey(view, key);
  view = reduceKey(view, 'enter');
  assert.equal(view.doc.commands[0].id, 'keep');
});

test('d then y removes the command and asks for a save', () => {
  const confirm = press(createView({ doc: doc() }), 'down', 'd');
  assert.equal(confirm.mode, 'confirm-delete');
  assert.equal(confirm.effect, null);
  const deleted = reduceKey(confirm, 'y');
  assert.equal(deleted.mode, 'list');
  assert.deepEqual(deleted.doc.commands.map((command) => command.label), ['One', 'Three']);
  assert.deepEqual(deleted.effect, { type: 'save', doc: deleted.doc, cursor: 1 });
});

test('deleting the last row clamps the cursor', () => {
  const deleted = press(createView({ doc: doc() }), 'up', 'd', 'y');
  assert.equal(deleted.cursor, 1);
  assert.equal(deleted.doc.commands.length, 2);
});

test('deleting the only command leaves an empty list at cursor zero', () => {
  const deleted = press(createView({ doc: doc(['Only']) }), 'd', 'y');
  assert.deepEqual(deleted.doc.commands, []);
  assert.equal(deleted.cursor, 0);
});

test('any key other than y cancels the delete', () => {
  const confirm = reduceKey(createView({ doc: doc() }), 'd');
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
