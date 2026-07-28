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

// The list cursor addresses a slot, not a command: every slot is a cell in the
// grid, whether or not anything is registered in it.
export function slotAt(cursor) {
  return SLOT_KEYS[clampCursor(cursor, SLOT_KEYS.length)];
}

export function commandInSlot(doc, slot) {
  return (doc?.commands ?? []).find((command) => command.slot === slot) ?? null;
}

function emptyForm(doc, preferredSlot = null) {
  const available = freeSlots(doc);
  const slot = available.includes(preferredSlot) ? preferredSlot : available[0] ?? '';
  return {
    commandId: null,
    fieldIndex: 0,
    slotChoices: available,
    fields: {
      label: '', slot, type: 'shell', command: '', cwd: 'focused', description: '',
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
    cursor: clampCursor(cursor, SLOT_KEYS.length),
    form: null,
    importEntries: [],
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

// The reducer does no I/O, so the popup reads the herdr config and hands the
// entries in. `already` marks what this plugin has registered, so the user is not
// offered a duplicate without knowing it.
export function beginImport(view, entries) {
  const registered = new Set((view.doc.commands ?? []).map((command) => `${command.type} ${command.command}`));
  return {
    ...view,
    mode: 'import',
    importEntries: entries.map((entry) => ({
      ...entry,
      already: registered.has(`${entry.type} ${entry.command}`),
    })),
    importCursor: 0,
    effect: null,
  };
}

function reduceImport(view, key) {
  const entries = view.importEntries ?? [];
  if (key === 'escape') return { ...view, mode: 'list', importEntries: [], importCursor: 0 };
  if (key === 'up') return { ...view, importCursor: step(view.importCursor, -1, entries.length) };
  if (key === 'down') return { ...view, importCursor: step(view.importCursor, 1, entries.length) };
  if (key !== 'enter') return view;
  const entry = entries[view.importCursor];
  if (!entry || !entry.type) return view;
  // Hand it to the ordinary add form, prefilled: the user still picks the slot and
  // can fix the label before anything is written.
  const available = freeSlots(view.doc);
  return {
    ...view,
    mode: 'form',
    importEntries: [],
    importCursor: 0,
    formError: null,
    form: {
      commandId: null,
      fieldIndex: 0,
      slotChoices: available,
      fields: {
        label: entry.label,
        slot: available[0] ?? '',
        type: entry.type,
        command: entry.command,
        cwd: 'focused',
        description: entry.description,
      },
    },
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
  // The list teaches "uppercase acts", so O must work here too. Lowercase o still
  // works because this mode has no slots to collide with, and someone who learned
  // the old key should not be stuck staring at a broken config.
  if (key === 'O' || key === 'o') return { ...view, effect: { type: 'open-config' } };
  if (key === 'escape' || key === 'q') return { ...view, effect: { type: 'close' } };
  return view;
}

// Every column count the grid supports divides the slot count evenly, so the grid
// is always a full rectangle and a cell always has a neighbour in every direction.
export function gridRows(columns) {
  return Math.ceil(SLOT_KEYS.length / Math.max(1, columns));
}

function moveCursor(view, key, columns) {
  const total = SLOT_KEYS.length;
  // The grid fills top to bottom, so ↑/↓ walk the slot order itself and ←/→ step
  // a whole column, landing on the same row of the neighbouring column.
  if (key === 'up') return { ...view, cursor: step(view.cursor, -1, total) };
  if (key === 'down') return { ...view, cursor: step(view.cursor, 1, total) };
  const rows = gridRows(columns);
  return { ...view, cursor: step(view.cursor, key === 'left' ? -rows : rows, total) };
}

function reduceList(view, key, columns) {
  if (key === 'escape') return { ...view, effect: { type: 'close' } };
  if (key === 'A') return { ...view, mode: 'form', formError: null, form: emptyForm(view.doc) };
  if (key === 'O') return { ...view, effect: { type: 'open-config' } };
  if (key === 'I') return { ...view, effect: { type: 'load-import' } };
  if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
    return moveCursor(view, key, columns);
  }

  const slot = slotAt(view.cursor);
  const selected = commandInSlot(view.doc, slot);
  if (key === 'E') {
    if (!selected) return view;
    return { ...view, mode: 'form', formError: null, form: formFor(selected, view.doc) };
  }
  if (key === 'D') {
    if (!selected) return view;
    return { ...view, mode: 'confirm-delete' };
  }
  if (key === 'enter') {
    // An empty cell is an offer, not a dead end: enter fills the slot it sits on.
    if (!selected) return { ...view, mode: 'form', formError: null, form: emptyForm(view.doc, slot) };
    return { ...view, effect: { type: 'run', command: selected } };
  }
  // A slot key runs its command wherever it sits in the grid.
  if (typeof key === 'string' && key.length === 1 && SLOT_KEYS.includes(key)) {
    const command = commandInSlot(view.doc, key);
    if (!command) return view;
    return { ...view, cursor: SLOT_KEYS.indexOf(key), effect: { type: 'run', command } };
  }
  return view;
}

function reduceConfirm(view, key) {
  if (key !== 'y') return { ...view, mode: 'list' };
  const slot = slotAt(view.cursor);
  const commands = (view.doc.commands ?? []).filter((command) => command.slot !== slot);
  const doc = { ...view.doc, commands };
  // The cursor stays put: the slot is still there, it is just empty now.
  const cursor = view.cursor;
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
  // The cursor follows the command to whichever slot it now claims.
  const cursor = SLOT_KEYS.indexOf(command.slot);
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
  if (cleared.mode === 'import') return reduceImport(cleared, key);
  if (cleared.mode === 'form') return reduceForm(cleared, key);
  return reduceList(cleared, key, columns);
}
