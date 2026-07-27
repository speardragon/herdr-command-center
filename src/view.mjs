import { COMMAND_TYPES, ConfigError, CWD_MODES, normalizeCommand, SLOT_KEYS } from './schema.mjs';

export const MODES = Object.freeze(['list', 'form', 'confirm-delete', 'error', 'import', 'editor-pick']);
export const FORM_FIELDS = Object.freeze(['label', 'slot', 'type', 'command', 'cwd', 'description']);
export const CHOICE_FIELDS = Object.freeze(new Set(['slot', 'type', 'cwd']));
export const CHOICE_VALUES = Object.freeze({ type: COMMAND_TYPES, cwd: CWD_MODES });

function clampCursor(index, length) {
  if (length <= 0) return 0;
  const value = Number.isSafeInteger(index) ? index : 0;
  return Math.max(0, Math.min(value, length - 1));
}

function step(index, delta, length) {
  if (length <= 0) return 0;
  return (index + delta + length) % length;
}

function removeLastGrapheme(value) {
  if (value.length === 0) return '';
  if (typeof Intl.Segmenter === 'function') {
    const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
    if (segments.length === 0) return '';
    return value.slice(0, segments.at(-1).index);
  }
  return [...value].slice(0, -1).join('');
}

function freeSlots(doc, keepSlot = null) {
  const taken = new Set((doc.commands ?? []).map((command) => command.slot));
  if (keepSlot) taken.delete(keepSlot);
  return [...SLOT_KEYS].filter((slot) => !taken.has(slot));
}

function emptyForm(doc) {
  const available = freeSlots(doc);
  return {
    commandId: null,
    fieldIndex: 0,
    slotChoices: available,
    fields: {
      label: '', slot: available[0] ?? '', type: 'shell', command: '', cwd: 'focused', description: '',
    },
  };
}

function formFor(command, doc) {
  // The command keeps its own slot as a choice, plus everything still unclaimed.
  const available = [command.slot, ...freeSlots(doc, command.slot).filter((s) => s !== command.slot)];
  return {
    commandId: command.id,
    fieldIndex: 0,
    slotChoices: available,
    fields: {
      label: command.label,
      slot: command.slot,
      type: command.type,
      command: command.command,
      cwd: command.cwd,
      description: command.description,
    },
  };
}

export function createView({ doc, error = null, cursor = 0 } = {}) {
  if (!doc || typeof doc !== 'object') throw new TypeError('a config document is required');
  return {
    mode: error ? 'error' : 'list',
    doc,
    error: error ?? null,
    formError: null,
    cursor: clampCursor(cursor, doc.commands?.length ?? 0),
    form: null,
    importCursor: 0,
    editorChoices: [],
    editorCursor: 0,
    effect: null,
  };
}

// The reducer does no I/O, so the popup resolves the candidate list and hands it
// in. One candidate never reaches this mode: the popup just opens it.
export function beginEditorPick(view, candidates) {
  return {
    ...view,
    mode: 'editor-pick',
    editorChoices: [...candidates],
    editorCursor: 0,
    effect: null,
  };
}

function reduceEditorPick(view, key) {
  const choices = view.editorChoices ?? [];
  if (key === 'escape') return { ...view, mode: 'list', editorChoices: [], editorCursor: 0 };
  if (key === 'up') return { ...view, editorCursor: step(view.editorCursor, -1, choices.length) };
  if (key === 'down') return { ...view, editorCursor: step(view.editorCursor, 1, choices.length) };
  const chosen = (index) => {
    const editor = choices[index];
    if (!editor) return view;
    return { ...view, mode: 'list', effect: { type: 'open-config', editor } };
  };
  if (key === 'enter') return chosen(view.editorCursor);
  if (/^[1-9]$/u.test(key)) return chosen(Number(key) - 1);
  return view;
}

function reduceError(view, key) {
  if (key === 'o') return { ...view, effect: { type: 'open-config' } };
  if (key === 'escape' || key === 'q') return { ...view, effect: { type: 'close' } };
  return view;
}

function moveCursor(view, key, columns) {
  const total = view.doc.commands?.length ?? 0;
  if (total === 0) return view;
  const span = Math.max(1, columns);
  if (key === 'left') return { ...view, cursor: step(view.cursor, -1, total) };
  if (key === 'right') return { ...view, cursor: step(view.cursor, 1, total) };
  if (span === 1) {
    // A single column is the old linear list, and its ↑/↓ wrapped end-to-end;
    // columns defaulting to 1 has to reproduce that exactly.
    return { ...view, cursor: step(view.cursor, key === 'up' ? -1 : 1, total) };
  }
  // A real grid clamps instead of wrapping: a partial last row would otherwise
  // send the cursor wrapping to some unrelated cell the user cannot predict.
  const raw = key === 'up' ? view.cursor - span : view.cursor + span;
  return { ...view, cursor: Math.max(0, Math.min(total - 1, raw)) };
}

function reduceList(view, key, columns) {
  const commands = view.doc.commands ?? [];
  if (key === 'escape') return { ...view, effect: { type: 'close' } };
  if (key === 'A') return { ...view, mode: 'form', formError: null, form: emptyForm(view.doc) };
  if (key === 'O') return { ...view, effect: { type: 'open-config' } };
  if (key === 'I') return { ...view, effect: { type: 'load-import' } };
  if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
    return moveCursor(view, key, columns);
  }

  const selected = commands[view.cursor] ?? null;
  if (key === 'E') {
    if (!selected) return view;
    return { ...view, mode: 'form', formError: null, form: formFor(selected, view.doc) };
  }
  if (key === 'D') {
    if (!selected) return view;
    return { ...view, mode: 'confirm-delete' };
  }
  if (key === 'enter') {
    if (!selected) return view;
    return { ...view, effect: { type: 'run', command: selected } };
  }
  // A slot key runs its command wherever it sits in the grid.
  if (typeof key === 'string' && key.length === 1 && SLOT_KEYS.includes(key)) {
    const index = commands.findIndex((command) => command.slot === key);
    if (index < 0) return view;
    return { ...view, cursor: index, effect: { type: 'run', command: commands[index] } };
  }
  return view;
}

function reduceConfirm(view, key) {
  if (key !== 'y') return { ...view, mode: 'list' };
  const commands = (view.doc.commands ?? []).filter((unused, index) => index !== view.cursor);
  const doc = { ...view.doc, commands };
  const cursor = clampCursor(view.cursor, commands.length);
  return { ...view, mode: 'list', doc, cursor, effect: { type: 'save', doc, cursor } };
}

function setField(view, field, value) {
  return {
    ...view,
    formError: null,
    form: { ...view.form, fields: { ...view.form.fields, [field]: value } },
  };
}

function cycleChoice(view, field, delta) {
  const values = field === 'slot' ? view.form.slotChoices : CHOICE_VALUES[field];
  if (!values || values.length === 0) return view;
  const current = values.indexOf(view.form.fields[field]);
  const next = values[step(current < 0 ? 0 : current, delta, values.length)];
  return setField(view, field, next);
}

function submitForm(view) {
  const { form } = view;
  const commands = view.doc.commands ?? [];
  const index = commands.findIndex((entry) => entry.id === form.commandId);
  const existingIds = commands
    .filter((entry) => entry.id !== form.commandId)
    .map((entry) => entry.id);
  const existingSlots = commands
    .filter((entry) => entry.id !== form.commandId)
    .map((entry) => entry.slot);
  let command;
  try {
    command = normalizeCommand({
      id: form.commandId ?? undefined,
      slot: form.fields.slot,
      label: form.fields.label,
      type: form.fields.type,
      command: form.fields.command,
      cwd: form.fields.cwd,
      description: form.fields.description,
    }, { existingIds, existingSlots });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return { ...view, formError: error.message };
  }
  const nextCommands = index >= 0
    ? commands.map((entry, position) => (position === index ? command : entry))
    : [...commands, command];
  const doc = { ...view.doc, commands: nextCommands };
  const cursor = index >= 0 ? index : nextCommands.length - 1;
  return {
    ...view,
    mode: 'list',
    form: null,
    formError: null,
    doc,
    cursor,
    effect: { type: 'save', doc, cursor },
  };
}

function reduceForm(view, key) {
  const { form } = view;
  if (key === 'escape') return { ...view, mode: 'list', form: null, formError: null };
  if (key === 'enter') return submitForm(view);
  if (key === 'tab' || key === 'down') {
    return { ...view, form: { ...form, fieldIndex: step(form.fieldIndex, 1, FORM_FIELDS.length) } };
  }
  if (key === 'backtab' || key === 'up') {
    return { ...view, form: { ...form, fieldIndex: step(form.fieldIndex, -1, FORM_FIELDS.length) } };
  }
  const field = FORM_FIELDS[form.fieldIndex];
  if (CHOICE_FIELDS.has(field)) {
    if (key === 'left') return cycleChoice(view, field, -1);
    if (key === 'right' || key === 'space') return cycleChoice(view, field, 1);
    return view;
  }
  if (key === 'backspace') return setField(view, field, removeLastGrapheme(form.fields[field]));
  if (key === 'space') return setField(view, field, `${form.fields[field]} `);
  // Every canonical key name is longer than one grapheme, so this admits
  // printable input only — including Korean syllables and emoji.
  if (typeof key === 'string' && [...key].length === 1) {
    return setField(view, field, `${form.fields[field]}${key}`);
  }
  return view;
}

export function reduceKey(view, key, { columns = 1 } = {}) {
  if (!view || typeof view !== 'object') throw new TypeError('view state is required');
  const cleared = { ...view, effect: null };
  if (key === 'interrupt') return { ...cleared, effect: { type: 'close' } };
  if (cleared.mode === 'error') return reduceError(cleared, key);
  if (cleared.mode === 'confirm-delete') return reduceConfirm(cleared, key);
  if (cleared.mode === 'editor-pick') return reduceEditorPick(cleared, key);
  if (cleared.mode === 'form') return reduceForm(cleared, key);
  return reduceList(cleared, key, columns);
}
