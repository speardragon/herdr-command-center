import { COMMAND_TYPES, ConfigError, CWD_MODES, normalizeCommand } from './schema.mjs';

export const MODES = Object.freeze(['list', 'form', 'confirm-delete', 'error']);
export const FORM_FIELDS = Object.freeze(['label', 'type', 'command', 'cwd', 'description']);
export const CHOICE_FIELDS = Object.freeze(new Set(['type', 'cwd']));
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

function emptyForm() {
  return {
    commandId: null,
    fieldIndex: 0,
    fields: { label: '', type: 'shell', command: '', cwd: 'focused', description: '' },
  };
}

function formFor(command) {
  return {
    commandId: command.id,
    fieldIndex: 0,
    fields: {
      label: command.label,
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
    effect: null,
  };
}

function reduceError(view, key) {
  if (key === 'o') return { ...view, effect: { type: 'open-config' } };
  if (key === 'escape' || key === 'q') return { ...view, effect: { type: 'close' } };
  return view;
}

function reduceList(view, key) {
  const commands = view.doc.commands ?? [];
  if (key === 'escape' || key === 'q') return { ...view, effect: { type: 'close' } };
  if (key === 'o') return { ...view, effect: { type: 'open-config' } };
  if (key === 'a') return { ...view, mode: 'form', formError: null, form: emptyForm() };
  if (key === 'up' || key === 'k') return { ...view, cursor: step(view.cursor, -1, commands.length) };
  if (key === 'down' || key === 'j') return { ...view, cursor: step(view.cursor, 1, commands.length) };

  const selected = commands[view.cursor] ?? null;
  if (key === 'e') {
    if (!selected) return view;
    return { ...view, mode: 'form', formError: null, form: formFor(selected) };
  }
  if (key === 'd') {
    if (!selected) return view;
    return { ...view, mode: 'confirm-delete' };
  }
  if (key === 'enter') {
    if (!selected) return view;
    return { ...view, effect: { type: 'run', command: selected } };
  }
  // Badges are absolute positions, not viewport offsets, so the digit next to a
  // row always runs that row no matter how far the list has scrolled.
  if (/^[1-9]$/u.test(key)) {
    const index = Number(key) - 1;
    const target = commands[index];
    if (!target) return view;
    return { ...view, cursor: index, effect: { type: 'run', command: target } };
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
  const values = CHOICE_VALUES[field];
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
  let command;
  try {
    command = normalizeCommand({
      id: form.commandId ?? undefined,
      label: form.fields.label,
      type: form.fields.type,
      command: form.fields.command,
      cwd: form.fields.cwd,
      description: form.fields.description,
    }, { existingIds });
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

export function reduceKey(view, key) {
  if (!view || typeof view !== 'object') throw new TypeError('view state is required');
  const cleared = { ...view, effect: null };
  if (key === 'interrupt') return { ...cleared, effect: { type: 'close' } };
  if (cleared.mode === 'error') return reduceError(cleared, key);
  if (cleared.mode === 'confirm-delete') return reduceConfirm(cleared, key);
  if (cleared.mode === 'form') return reduceForm(cleared, key);
  return reduceList(cleared, key);
}
