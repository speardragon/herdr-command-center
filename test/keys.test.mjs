import assert from 'node:assert/strict';
import test from 'node:test';

import { createKeyDecoder, decodeKeys, KEY_NAMES } from '../src/keys.mjs';

test('decodeKeys maps arrow escape sequences', () => {
  assert.deepEqual(decodeKeys('\u001b[A'), ['up']);
  assert.deepEqual(decodeKeys('\u001b[B'), ['down']);
  assert.deepEqual(decodeKeys('\u001b[C'), ['right']);
  assert.deepEqual(decodeKeys('\u001b[D'), ['left']);
  assert.deepEqual(decodeKeys('\u001b[Z'), ['backtab']);
});

test('decodeKeys maps editing and control keys', () => {
  assert.deepEqual(decodeKeys('\r'), ['enter']);
  assert.deepEqual(decodeKeys('\n'), ['enter']);
  assert.deepEqual(decodeKeys('\t'), ['tab']);
  assert.deepEqual(decodeKeys('\u007f'), ['backspace']);
  assert.deepEqual(decodeKeys('\b'), ['backspace']);
  assert.deepEqual(decodeKeys(' '), ['space']);
  assert.deepEqual(decodeKeys('\u0003'), ['interrupt']);
  assert.deepEqual(decodeKeys('\u001b'), ['escape']);
});

test('decodeKeys passes printable graphemes through, including Korean', () => {
  assert.deepEqual(decodeKeys('a'), ['a']);
  assert.deepEqual(decodeKeys('7'), ['7']);
  assert.deepEqual(decodeKeys('한글'), ['한', '글']);
  assert.deepEqual(decodeKeys('🚀'), ['🚀']);
});

test('decodeKeys drops unhandled control characters', () => {
  assert.deepEqual(decodeKeys('\u0001'), []);
  assert.deepEqual(decodeKeys('a\u0000b'), ['a', 'b']);
});

test('decodeKeys handles several keys in one chunk', () => {
  assert.deepEqual(decodeKeys('\u001b[Bj\r'), ['down', 'j', 'enter']);
});

test('createKeyDecoder reassembles UTF-8 split across chunks', () => {
  const decoder = createKeyDecoder();
  const bytes = Buffer.from('한', 'utf8');
  assert.deepEqual(decoder.push(bytes.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(bytes.subarray(2)), ['한']);
});

test('KEY_NAMES lists every canonical named key', () => {
  for (const name of ['up', 'down', 'left', 'right', 'enter', 'escape', 'tab', 'backtab', 'backspace', 'space', 'interrupt']) {
    assert.ok(KEY_NAMES.has(name), `${name} missing`);
  }
});
