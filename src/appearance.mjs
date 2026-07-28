// Whether the terminal is light or dark decides which way "recede into the
// background" points. Dimming text is the wrong tool for it: dim darkens, which
// hides text on a dark terminal and *sharpens* it on a light one.

// Terminals that report COLORFGBG give "<fg>;<bg>", occasionally with a middle
// field. The background is an ANSI colour index: 7 and 9-15 are the light ones.
const LIGHT_BACKGROUNDS = Object.freeze(new Set(['7', '9', '10', '11', '12', '13', '14', '15']));

export function isLightTerminal(env = process.env) {
  const reported = typeof env?.COLORFGBG === 'string' ? env.COLORFGBG : '';
  const fields = reported.split(';');
  // Two fields minimum, or the last one is a foreground being read as a
  // background — and a foreground of 15 would flip a black terminal to light.
  if (fields.length < 2) return false;
  // Anything unreported stays dark: that is what a terminal running a TUI
  // overwhelmingly is, and guessing wrong on a dark terminal is the cheaper
  // mistake — the text lands too faint rather than too loud.
  return LIGHT_BACKGROUNDS.has(fields.at(-1).trim());
}
