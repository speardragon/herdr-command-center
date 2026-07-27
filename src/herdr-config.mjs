import { readFile as readFileAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { PLUGIN_ID } from './plugin.mjs';
import { parseConfigToml } from './toml-config.mjs';

const MAX_LABEL_LENGTH = 80;
// herdr's own keybinding types, mapped onto this plugin's. A herdr `popup`
// command runs something in a popup pane, so a pane command is the closest thing
// this plugin can offer.
const TYPE_MAP = Object.freeze({
  shell: 'shell',
  pane: 'pane',
  popup: 'pane',
  plugin_action: 'plugin_action',
});

export function herdrConfigPath(env = process.env) {
  const configured = env.HERDR_CONFIG_PATH;
  if (typeof configured === 'string' && configured.length > 0 && isAbsolute(configured)) {
    return configured;
  }
  return join(env.HOME || homedir(), '.config', 'herdr', 'config.toml');
}

function label(entry) {
  const described = typeof entry.description === 'string' ? entry.description.trim() : '';
  const source = described.length > 0 ? described : String(entry.command ?? '').trim();
  return source.slice(0, MAX_LABEL_LENGTH);
}

export function importableCommands(text) {
  let parsed;
  try {
    parsed = parseConfigToml(text, 'config.toml');
  } catch {
    // Someone else's config failing to parse is not this plugin's problem to
    // report; there is simply nothing to offer.
    return [];
  }
  const raw = parsed?.keys?.command;
  if (!Array.isArray(raw)) return [];
  const entries = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const command = typeof entry.command === 'string' ? entry.command.trim() : '';
    if (command.length === 0) continue;
    const herdrType = typeof entry.type === 'string' ? entry.type : '';
    const mapped = TYPE_MAP[herdrType] ?? null;
    // The binding that opens this popup is in there too. Importing it would add a
    // command whose only effect is to reopen the popup you are standing in.
    if (mapped === 'plugin_action' && command.startsWith(`${PLUGIN_ID}.`)) continue;
    entries.push({
      key: typeof entry.key === 'string' ? entry.key : '',
      label: label(entry),
      type: mapped,
      command,
      description: typeof entry.description === 'string' ? entry.description.trim() : '',
      reason: mapped ? null : `herdr type "${herdrType}" has no equivalent here`,
    });
  }
  return entries;
}

export async function readImportable(path, { readFile = readFileAsync } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  return importableCommands(text);
}
