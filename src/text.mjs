// Terminal text measurement. Everything the popup prints goes through here so a
// Korean label or an emoji can never overflow the popup and corrupt the frame.

const WIDE_RANGES = Object.freeze([
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
]);

export function cellWidth(character) {
  if (/\p{Mark}/u.test(character)) return 0;
  const code = character.codePointAt(0);
  if (code === undefined || code < 0x1100) return 1;
  if (code === 0x303f) return 1;
  return WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
}

function visibleCodePoint(character) {
  const code = character.codePointAt(0);
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || /\p{Cf}/u.test(character)) {
    return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
  }
  return character;
}

function sanitized(value) {
  return [...String(value ?? '')].map(visibleCodePoint).join('');
}

export function displayWidth(text) {
  let total = 0;
  for (const character of String(text ?? '')) total += cellWidth(character);
  return total;
}

export function wrap(value, width) {
  if (!Number.isFinite(width) || width <= 0) return [];
  // Collapse newlines to spaces BEFORE sanitizing, or a newline would be printed
  // as the literal <U+000A> instead of becoming a space.
  const text = sanitized(String(value ?? '').replace(/\r?\n/gu, ' '));
  if (text.length === 0) return [''];
  const lines = [];
  let line = '';
  let used = 0;
  // Break at the last space that fits rather than mid-word: a footer that reads
  // "shift+i im / port" looks like a rendering bug, and every string wrapped here
  // is prose meant for a human.
  let breakAt = -1;
  let widthAtBreak = 0;
  for (const character of text) {
    const characterWidth = cellWidth(character);
    if (characterWidth > width) continue;
    if (used > 0 && used + characterWidth > width) {
      if (breakAt > 0) {
        lines.push(line.slice(0, breakAt));
        line = line.slice(breakAt + 1);
        used -= widthAtBreak + 1;
      } else {
        lines.push(line);
        line = '';
        used = 0;
      }
      breakAt = -1;
      widthAtBreak = 0;
    }
    if (character === ' ' && used > 0) {
      breakAt = line.length;
      widthAtBreak = used;
    }
    line += character;
    used += characterWidth;
  }
  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}

export function clipLine(value, width) {
  const lines = wrap(value, width);
  if (lines.length <= 1) return lines[0] ?? '';
  const marker = width >= 3 ? '…' : '.';
  const markerWidth = cellWidth(marker);
  let clipped = '';
  let used = 0;
  for (const character of lines[0] ?? '') {
    const characterWidth = cellWidth(character);
    if (used + characterWidth + markerWidth > width) break;
    clipped += character;
    used += characterWidth;
  }
  return `${clipped}${marker}`;
}
