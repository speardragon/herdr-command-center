import { clipLine, displayWidth, wrap } from './text.mjs';
import { CHOICE_FIELDS, FORM_FIELDS } from './view.mjs';

// Matches the popup size declared in herdr-plugin.toml, used when a caller has
// no TTY dimensions to offer.
const DEFAULT_COLUMNS = 78;
const DEFAULT_ROWS = 24;
const MAX_COLUMNS = 240;
const MAX_ROWS = 100;
const PADDING_X = 2;
const PADDING_Y = 1;

const LIST_FOOTER = '↑↓ move · enter run · 1-9 run · a add · e edit · d delete · o edit file · esc close';
const FORM_FOOTER = 'type to edit · tab/↑↓ field · ←→ change · enter save · esc cancel';
const CONFIRM_FOOTER = 'y delete · any other key cancels';
const ERROR_FOOTER = 'o edit file · esc close';

const FIELD_LABELS = Object.freeze({
  label: 'Label',
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

function viewportRange(cursor, length, budget) {
  const safeCursor = Math.max(0, Math.min(length - 1, cursor));
  let start = safeCursor;
  let end = safeCursor;
  const rows = (nextStart, nextEnd) => (
    nextEnd - nextStart + 1
    + (nextStart > 0 ? 1 : 0)
    + (nextEnd < length - 1 ? 1 : 0)
  );
  for (;;) {
    const candidates = safeCursor - start <= end - safeCursor
      ? [[start - 1, end], [start, end + 1]]
      : [[start, end + 1], [start - 1, end]];
    const next = candidates.find(([nextStart, nextEnd]) => (
      nextStart >= 0 && nextEnd < length && rows(nextStart, nextEnd) <= budget
    ));
    if (!next) return { start, end };
    [start, end] = next;
  }
}

function commandRow(view, command, index, width, color) {
  const marker = index === view.cursor ? '›' : ' ';
  const badge = index < 9 ? `${index + 1}.` : '  ';
  const line = clipLine(`${marker} ${badge} ${command.label}`, width);
  if (!color) return line;
  return index === view.cursor ? styles.bold(styles.cyan(line)) : line;
}

function listBody(view, width, budget, color) {
  const commands = view.doc.commands ?? [];
  const count = commands.length;
  const header = clipLine(`Command Center · ${count} command${count === 1 ? '' : 's'}`, width);
  const lines = [color ? styles.bold(header) : header, ''];
  if (count === 0) {
    lines.push(...wrap('Press a to add one, or o to open commands.toml in your editor.', width));
    return lines;
  }
  const selected = commands[Math.max(0, Math.min(count - 1, view.cursor))];
  const detail = [
    clipLine(`${selected.type} · ${selected.command}`, width),
    ...(selected.description.length > 0 ? [clipLine(selected.description, width)] : []),
  ];
  // Reserve the header, the blank line, the blank separator, and the detail
  // block; whatever is left is how many rows the scrolling list may use.
  const listBudget = Math.max(1, budget - lines.length - 1 - detail.length);
  const { start, end } = viewportRange(view.cursor, count, listBudget);
  if (start > 0) lines.push(clipLine('↑ more', width));
  for (let index = start; index <= end; index += 1) {
    lines.push(commandRow(view, commands[index], index, width, color));
  }
  if (end < count - 1) lines.push(clipLine('↓ more', width));
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
  const command = (view.doc.commands ?? [])[view.cursor];
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

const BODIES = Object.freeze({
  list: listBody,
  form: formBody,
  'confirm-delete': confirmBody,
  error: errorBody,
});

const FOOTERS = Object.freeze({
  list: LIST_FOOTER,
  form: FORM_FOOTER,
  'confirm-delete': CONFIRM_FOOTER,
  error: ERROR_FOOTER,
});

export function renderLines(view, size = {}) {
  const { outerWidth, outerHeight } = boundedSize(size);
  const width = Math.max(1, outerWidth - PADDING_X * 2);
  const height = Math.max(1, outerHeight - PADDING_Y * 2);
  const color = size?.color === true;

  const footerLines = wrap(FOOTERS[view.mode] ?? LIST_FOOTER, width);
  const footer = color ? footerLines.map((line) => styles.dim(line)) : footerLines;
  const bodyBudget = Math.max(1, height - footer.length);
  const body = (BODIES[view.mode] ?? listBody)(view, width, bodyBudget, color).slice(0, bodyBudget);
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
