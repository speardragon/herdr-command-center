import assert from 'node:assert/strict';
import test from 'node:test';

import { cellWidth, clipLine, displayWidth, wrap } from '../src/text.mjs';

test('cellWidth counts CJK and emoji as two cells', () => {
  assert.equal(cellWidth('a'), 1);
  assert.equal(cellWidth('한'), 2);
  assert.equal(cellWidth('。'), 2);
  assert.equal(cellWidth('🚀'), 2);
});

test('cellWidth counts combining marks as zero', () => {
  assert.equal(cellWidth('́'), 0);
});

test('displayWidth sums cells rather than code points', () => {
  assert.equal(displayWidth('ab'), 2);
  assert.equal(displayWidth('브랜치'), 6);
  assert.equal(displayWidth(''), 0);
});

test('wrap breaks on cell width and never exceeds the budget', () => {
  assert.deepEqual(wrap('abcdef', 3), ['abc', 'def']);
  assert.deepEqual(wrap('한글테스트', 4), ['한글', '테스', '트']);
  for (const line of wrap('브랜치 정리하고 푸시하기', 7)) {
    assert.ok(displayWidth(line) <= 7, `"${line}" is ${displayWidth(line)} cells`);
  }
});

test('wrap collapses newlines and returns one empty line for empty input', () => {
  assert.deepEqual(wrap('a\nb', 10), ['a b']);
  assert.deepEqual(wrap('', 10), ['']);
  assert.deepEqual(wrap('anything', 0), []);
});

test('clipLine truncates with an ellipsis and respects wide characters', () => {
  assert.equal(clipLine('abcdef', 10), 'abcdef');
  assert.equal(clipLine('abcdef', 4), 'abc…');
  assert.ok(displayWidth(clipLine('한글테스트입니다', 7)) <= 7);
  assert.ok(clipLine('한글테스트입니다', 7).endsWith('…'));
});

test('clipLine renders control characters visibly instead of moving the cursor', () => {
  assert.equal(clipLine('a\u0007b', 20), 'a<U+0007>b');
  assert.equal(clipLine('a\u001b[31mb', 40), 'a<U+001B>[31mb');
});
