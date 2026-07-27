import { parse as parseToml } from 'smol-toml';

import { ConfigError } from './schema.mjs';

// Key order is fixed so a block the popup rewrites still reads like the ones the
// user wrote by hand.
const COMMAND_KEYS = Object.freeze(['id', 'slot', 'label', 'type', 'command', 'cwd', 'description']);
const SIMPLE_ESCAPES = Object.freeze({
  '\\': '\\\\',
  '"': '\\"',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
});

export function escapeTomlString(value) {
  let out = '';
  for (const character of String(value ?? '')) {
    const simple = SIMPLE_ESCAPES[character];
    if (simple !== undefined) {
      out += simple;
      continue;
    }
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
      continue;
    }
    out += character;
  }
  return out;
}

function keyValue(key, value) {
  return `${key} = "${escapeTomlString(value)}"`;
}

export function renderCommandBlock(command) {
  const lines = ['[[commands]]'];
  for (const key of COMMAND_KEYS) {
    // An empty description would just be noise in a file meant to be read.
    if (key === 'description' && !command[key]) continue;
    lines.push(keyValue(key, command[key]));
  }
  return `${lines.join('\n')}\n`;
}

// Whole-file render. Used for seeding a new config and for the rare fallback when
// a save changes something outside the [[commands]] blocks. Ordinary popup edits
// go through applyCommands in toml-edit.mjs so comments survive.
export function renderConfigToml(doc) {
  const editor = doc.editor.map((entry) => `"${escapeTomlString(entry)}"`).join(', ');
  const header = `schema_version = ${doc.schema_version}\neditor = [${editor}]\n`;
  if (doc.commands.length === 0) return header;
  return `${header}\n${doc.commands.map((command) => renderCommandBlock(command)).join('\n')}`;
}

export function parseConfigToml(text, fileName = 'commands.toml') {
  try {
    return parseToml(String(text));
  } catch (error) {
    const line = Number.isSafeInteger(error?.line) ? ` at line ${error.line}` : '';
    // smol-toml puts the reason on the first line, then a blank line, a source
    // excerpt and a caret. Keep only the reason: the popup collapses newlines
    // when it wraps text, so the excerpt would arrive as noise mashed onto the
    // end of the sentence.
    const reason = typeof error?.message === 'string'
      ? error.message.split('\n', 1)[0].trim()
      : '';
    const detail = reason.length > 0 && reason.length <= 160 ? `: ${reason}` : '';
    throw new ConfigError(`${fileName} is not valid TOML${line}${detail}`);
  }
}
