import { StringDecoder } from 'node:string_decoder';

export const KEY_NAMES = Object.freeze(new Set([
  'up',
  'down',
  'left',
  'right',
  'enter',
  'escape',
  'tab',
  'backtab',
  'backspace',
  'space',
  'interrupt',
]));

const ESCAPES = Object.freeze({
  '\u001b[A': 'up',
  '\u001b[B': 'down',
  '\u001b[C': 'right',
  '\u001b[D': 'left',
  '\u001b[Z': 'backtab',
});

// Decoding is per-chunk with no pending-escape buffer on purpose: terminals
// deliver an escape sequence in a single read, and holding a lone ESC byte back
// to wait for more bytes would make Esc feel broken (it would only fire on the
// next keypress). A bare ESC is therefore Escape.
export function decodeKeys(value) {
  const text = String(value);
  const keys = [];
  for (let index = 0; index < text.length;) {
    const rest = text.slice(index);
    const escape = Object.keys(ESCAPES).find((sequence) => rest.startsWith(sequence));
    if (escape) {
      keys.push(ESCAPES[escape]);
      index += escape.length;
      continue;
    }
    const head = rest[0];
    if (head === '\u001b') {
      keys.push('escape');
      index += 1;
    } else if (head === '\r' || head === '\n') {
      keys.push('enter');
      index += 1;
    } else if (head === '\t') {
      keys.push('tab');
      index += 1;
    } else if (head === '\u007f' || head === '\b') {
      keys.push('backspace');
      index += 1;
    } else if (head === ' ') {
      keys.push('space');
      index += 1;
    } else if (head === '\u0003') {
      keys.push('interrupt');
      index += 1;
    } else {
      const character = String.fromCodePoint(text.codePointAt(index));
      const printable = !/[\p{Cc}\p{Cf}]/u.test(character)
        || character === '\u200c'
        || character === '\u200d';
      if (printable) keys.push(character);
      index += character.length;
    }
  }
  return keys;
}

export function createKeyDecoder() {
  const decoder = new StringDecoder('utf8');
  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      return decodeKeys(decoder.write(bytes));
    },
  };
}
