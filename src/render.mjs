import { SLOT_KEYS } from './schema.mjs';
import { clipLine, displayWidth, wrap } from './text.mjs';
import { CHOICE_FIELDS, commandInSlot, FORM_FIELDS, gridRows } from './view.mjs';

// Matches the popup size declared in herdr-plugin.toml, used when a caller has
// no TTY dimensions to offer.
const DEFAULT_COLUMNS = 78;
const DEFAULT_ROWS = 24;
const MAX_COLUMNS = 240;
const MAX_ROWS = 100;
const PADDING_X = 2;
const PADDING_Y = 1;

const LIST_FOOTER = '↑↓←→ move · enter run · slot key runs · shift+a add · shift+e edit · shift+d delete · shift+o edit file · shift+i import · esc close';
const FORM_FOOTER = 'type to edit · tab/↑↓ field · ←→ change · enter save · esc cancel';
const CONFIRM_FOOTER = 'y delete · any other key cancels';
const ERROR_FOOTER = 'shift+o edit file · esc close';
const EDITOR_FOOTER = '↑↓ move · enter open · 1-9 open · esc cancel';
const IMPORT_FOOTER = '↑↓ move · enter set up · esc cancel';

const FIELD_LABELS = Object.freeze({
  label: 'Label',
  slot: 'Slot',
  type: 'Type',
  command: 'Command',
  cwd: 'Cwd',
  description: 'Description',
});
const FIELD_LABEL_WIDTH = 12;

// Styling is applied only after clipping so an escape code can never be counted
// as a visible cell.
const RESET = '\u001b[0m';
const styles = {
  bold: (text) => `\u001b[1m${text}${RESET}`,
  dim: (text) => `\u001b[2m${text}${RESET}`,
  // Thirty-three empty cells against a handful of real commands is a lot of
  // scaffolding, so they are pushed toward the background rather than dimmed:
  // dim darkens, which recedes on a dark terminal but stands out on a light one.
  // Bright-black and bright-white rather than fixed grays: the theme author has
  // already placed those just off their own background, whereas a hardcoded
  // gray is at the mercy of a background this code cannot see.
  faintOnDark: (text) => `\u001b[90m${text}${RESET}`,
  faintOnLight: (text) => `\u001b[97m${text}${RESET}`,
  cyan: (text) => `\u001b[36m${text}${RESET}`,
  yellow: (text) => `\u001b[33m${text}${RESET}`,
};

function boundedSize(size) {
  const columns = Number.isFinite(size?.columns) ? Math.floor(size.columns) : DEFAULT_COLUMNS;
  const rows = Number.isFinite(size?.rows) ? Math.floor(size.rows) : DEFAULT_ROWS;
  return {
    outerWidth: Math.max(1, Math.min(MAX_COLUMNS, columns)),
    outerHeight: Math.max(1, Math.min(MAX_ROWS, rows)),
  };
}

const MIN_CELL_WIDTH = 26;
const MAX_GRID_COLUMNS = 4;

// One definition, used by both the renderer and the popup: if the layout and the
// reducer ever disagreed about the column count, the arrow keys would move the
// cursor somewhere other than where the grid shows it.
function columnsForWidth(width) {
  return Math.max(1, Math.min(MAX_GRID_COLUMNS, Math.floor(width / MIN_CELL_WIDTH)));
}

export function gridColumns(view, size = {}) {
  const { outerWidth } = boundedSize(size);
  return columnsForWidth(Math.max(1, outerWidth - PADDING_X * 2));
}

const EMPTY_LABEL = '(empty)';

// One grid row, built left to right. The last cell is left unpadded so that a
// styled empty cell cannot smuggle trailing spaces past the plain-text layout.
function gridRow(view, indices, cellWidth, color, faint) {
  return indices.map((index, position) => {
    const slot = SLOT_KEYS[index];
    const command = commandInSlot(view.doc, slot);
    const marker = index === view.cursor ? '›' : ' ';
    const text = clipLine(`${marker} ${slot}  ${command ? command.label : EMPTY_LABEL}`, cellWidth);
    const padded = position === indices.length - 1
      ? text
      : text + ' '.repeat(Math.max(0, cellWidth - displayWidth(text)));
    if (!color) return padded;
    if (index === view.cursor) return styles.bold(styles.cyan(padded));
    return command ? padded : faint(padded);
  }).join('');
}

function listBody(view, width, budget, color, light) {
  const faint = light ? styles.faintOnLight : styles.faintOnDark;
  const commands = view.doc.commands ?? [];
  const count = commands.length;
  const header = clipLine(`Command Center · ${count} command${count === 1 ? '' : 's'}`, width);
  const lines = [color ? styles.bold(header) : header, ''];
  if (count === 0) {
    lines.push(...wrap('Press shift+a to add one, shift+i to import from your herdr config, or shift+o to open commands.toml.', width));
    return lines;
  }
  const total = SLOT_KEYS.length;
  const columns = columnsForWidth(width);
  const cellWidth = Math.floor(width / columns);
  const rows = gridRows(columns);
  const cursor = Math.max(0, Math.min(total - 1, view.cursor));
  const selected = commandInSlot(view.doc, SLOT_KEYS[cursor]);
  const detail = selected
    ? [
      clipLine(`${selected.type} · ${selected.command}`, width),
      ...(selected.description.length > 0 ? [clipLine(selected.description, width)] : []),
    ]
    : [clipLine(`slot ${SLOT_KEYS[cursor]} is empty · enter to add a command here`, width)];
  // One line is always held back for the scroll hint, so the detail block does
  // not jump a row the moment the grid stops fitting.
  const rowBudget = Math.max(1, budget - lines.length - 2 - detail.length);
  const shown = Math.min(rows, rowBudget);
  // Keep the cursor's row inside the window, centred wherever there is room.
  const first = Math.max(0, Math.min(cursor % rows - Math.floor((shown - 1) / 2), rows - shown));
  for (let row = first; row < first + shown; row += 1) {
    const indices = [];
    for (let column = 0; column < columns; column += 1) {
      const index = column * rows + row;
      if (index < total) indices.push(index);
    }
    lines.push(gridRow(view, indices, cellWidth, color, faint));
  }
  const hidden = [
    first > 0 ? `↑ ${first * columns} more` : null,
    first + shown < rows ? `↓ ${(rows - first - shown) * columns} more` : null,
  ].filter(Boolean);
  if (hidden.length > 0) {
    const hint = clipLine(hidden.join(' · '), width);
    lines.push(color ? styles.dim(hint) : hint);
  }
  lines.push('');
  lines.push(...(color ? detail.map((line) => styles.dim(line)) : detail));
  return lines;
}

function formBody(view, width, budget, color) {
  const { form } = view;
  const title = clipLine(`Command Center · ${form.commandId ? 'Edit' : 'Add'} command`, width);
  const lines = [color ? styles.bold(title) : title, ''];
  FORM_FIELDS.forEach((field, index) => {
    const focused = index === form.fieldIndex;
    const value = CHOICE_FIELDS.has(field)
      ? `${form.fields[field]}  (←→)`
      : form.fields[field];
    const line = clipLine(
      `${focused ? '›' : ' '} ${FIELD_LABELS[field].padEnd(FIELD_LABEL_WIDTH)} ${value}`,
      width,
    );
    lines.push(color && focused ? styles.bold(styles.cyan(line)) : line);
  });
  if (view.formError) {
    lines.push('');
    const wrapped = wrap(view.formError, width);
    lines.push(...(color ? wrapped.map((line) => styles.yellow(line)) : wrapped));
  }
  return lines.slice(0, Math.max(1, budget));
}

function confirmBody(view, width, budget, color) {
  // By slot, not by position: the cursor addresses the grid, and a command's
  // place in the array has nothing to do with which cell it is drawn in.
  const command = commandInSlot(view.doc, SLOT_KEYS[view.cursor]);
  const title = clipLine('Command Center · Delete command', width);
  return [
    color ? styles.bold(title) : title,
    '',
    ...wrap(`Delete "${command?.label ?? ''}"?`, width),
  ].slice(0, Math.max(1, budget));
}

function errorBody(view, width, budget, color) {
  const title = clipLine('Command Center · config error', width);
  return [
    color ? styles.bold(title) : title,
    '',
    ...wrap(view.error ?? 'commands.toml could not be loaded', width),
  ].slice(0, Math.max(1, budget));
}

function editorPickBody(view, width, budget, color) {
  const title = clipLine('Command Center · Open commands.toml with', width);
  const lines = [color ? styles.bold(title) : title, ''];
  (view.editorChoices ?? []).forEach((editor, index) => {
    const marker = index === view.editorCursor ? '›' : ' ';
    const line = clipLine(`${marker} ${index + 1}. ${editor}`, width);
    lines.push(color && index === view.editorCursor ? styles.bold(styles.cyan(line)) : line);
  });
  return lines.slice(0, Math.max(1, budget));
}

function importBody(view, width, budget, color) {
  const entries = view.importEntries ?? [];
  const title = clipLine(`Command Center · import from herdr config · ${entries.length} found`, width);
  const lines = [color ? styles.bold(title) : title, ''];
  if (entries.length === 0) {
    lines.push(...wrap('No [[keys.command]] entries found in your herdr config.toml.', width));
    return lines.slice(0, Math.max(1, budget));
  }
  const rowBudget = Math.max(1, budget - lines.length - 2);
  entries.slice(0, rowBudget).forEach((entry, index) => {
    const marker = index === view.importCursor ? '›' : ' ';
    const note = entry.reason ? '  (unsupported)' : (entry.already ? '  (already added)' : '');
    const line = clipLine(`${marker} ${entry.key}  ${entry.label}${note}`, width);
    const styled = color && index === view.importCursor
      ? styles.bold(styles.cyan(line))
      : (color && (entry.reason || entry.already) ? styles.dim(line) : line);
    lines.push(styled);
  });
  const chosen = entries[Math.max(0, Math.min(entries.length - 1, view.importCursor))];
  lines.push('');
  const detail = clipLine(`${chosen.type ?? '—'} · ${chosen.command}`, width);
  lines.push(color ? styles.dim(detail) : detail);
  return lines;
}

const BODIES = Object.freeze({
  list: listBody,
  form: formBody,
  'confirm-delete': confirmBody,
  error: errorBody,
  'editor-pick': editorPickBody,
  import: importBody,
});

const FOOTERS = Object.freeze({
  list: LIST_FOOTER,
  form: FORM_FOOTER,
  'confirm-delete': CONFIRM_FOOTER,
  error: ERROR_FOOTER,
  'editor-pick': EDITOR_FOOTER,
  import: IMPORT_FOOTER,
});

export function renderLines(view, size = {}) {
  const { outerWidth, outerHeight } = boundedSize(size);
  const width = Math.max(1, outerWidth - PADDING_X * 2);
  const height = Math.max(1, outerHeight - PADDING_Y * 2);
  const color = size?.color === true;
  const light = size?.light === true;

  const footerLines = wrap(FOOTERS[view.mode] ?? LIST_FOOTER, width);
  const footer = color ? footerLines.map((line) => styles.dim(line)) : footerLines;
  const bodyBudget = Math.max(1, height - footer.length);
  const body = (BODIES[view.mode] ?? listBody)(view, width, bodyBudget, color, light).slice(0, bodyBudget);
  const fill = Array.from({ length: Math.max(0, bodyBudget - body.length) }, () => '');

  const indent = ' '.repeat(PADDING_X);
  const content = [...body, ...fill, ...footer]
    .slice(0, height)
    .map((line) => (line.length === 0 ? line : `${indent}${line}`));
  const vertical = Array.from({ length: PADDING_Y }, () => '');
  const lines = [...vertical, ...content, ...vertical].slice(0, outerHeight);
  // Pad short frames so callers always get exactly the rows they asked for.
  while (lines.length < outerHeight) lines.push('');
  return lines;
}

// Where the real terminal cursor belongs. The popup parks the hardware cursor at
// the edit point of a focused text field so that "you can type here right now" is
// signalled by a blinking cursor rather than by a glyph we draw into the frame.
// Choice fields get no cursor — they are changed with the arrow keys, and showing
// a text caret on them would promise typing that does nothing.
export function textCursor(view, size = {}) {
  if (view?.mode !== 'form' || !view.form) return null;
  const field = FORM_FIELDS[view.form.fieldIndex];
  if (!field || CHOICE_FIELDS.has(field)) return null;

  const { outerWidth, outerHeight } = boundedSize(size);
  const width = Math.max(1, outerWidth - PADDING_X * 2);
  const height = Math.max(1, outerHeight - PADDING_Y * 2);
  // Mirrors renderLines: the footer is reserved and the body gets what is left.
  const bodyBudget = Math.max(1, height - wrap(FORM_FOOTER, width).length);
  const bodyLine = 2 + view.form.fieldIndex; // title, blank line, then the fields
  if (bodyLine >= bodyBudget) return null;

  // "› " + the label padded to FIELD_LABEL_WIDTH + " ", all ASCII.
  const valueColumn = 2 + FIELD_LABEL_WIDTH + 1;
  const typed = displayWidth(view.form.fields[field] ?? '');
  const column = Math.min(valueColumn + typed, width - 1);
  return { row: PADDING_Y + bodyLine, column: PADDING_X + column };
}

export function renderView(view, size = {}) {
  return renderLines(view, size).join('\n');
}
