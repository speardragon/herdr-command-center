import assert from 'node:assert/strict';
import test from 'node:test';

import { isLightTerminal } from '../src/appearance.mjs';

test('isLightTerminal reads the background out of COLORFGBG', () => {
  assert.equal(isLightTerminal({ COLORFGBG: '15;0' }), false, 'white on black');
  assert.equal(isLightTerminal({ COLORFGBG: '0;15' }), true, 'black on white');
  assert.equal(isLightTerminal({ COLORFGBG: '0;7' }), true, 'black on light grey');
  assert.equal(isLightTerminal({ COLORFGBG: '7;0' }), false);
});

test('isLightTerminal handles the three-field form some terminals send', () => {
  assert.equal(isLightTerminal({ COLORFGBG: '15;default;0' }), false);
  assert.equal(isLightTerminal({ COLORFGBG: '0;default;15' }), true);
});

test('isLightTerminal assumes dark when nothing says otherwise', () => {
  for (const env of [{}, { COLORFGBG: '' }, { COLORFGBG: 'nonsense' }, { COLORFGBG: '15;default' }]) {
    assert.equal(isLightTerminal(env), false, JSON.stringify(env));
  }
  assert.equal(isLightTerminal(undefined), false);
});

test('a single-field COLORFGBG is not read as a background', () => {
  // "15" is a foreground. Treating it as the background would flip a black
  // terminal to light and paint the empty cells nearly white.
  assert.equal(isLightTerminal({ COLORFGBG: '15' }), false);
  assert.equal(isLightTerminal({ COLORFGBG: '7' }), false);
});
