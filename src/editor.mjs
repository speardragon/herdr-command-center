import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

// Deliberately not just "code": the plugin cannot assume VS Code is installed or
// that its shell integration is on the PATH. Ordered by how likely a terminal
// user is to want each one. This is also what a fresh commands.toml is seeded
// with, so it doubles as the menu the user edits down to their own preference.
export const COMMON_EDITORS = Object.freeze([
  'code', 'cursor', 'zed', 'subl', 'nvim', 'vim', 'hx', 'nano',
]);

function onPath(name, env = process.env) {
  const directories = String(env.PATH ?? '').split(delimiter).filter(Boolean);
  return directories.some((directory) => {
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// $VISUAL and $EDITOR are taken on trust: the user set them on purpose, and they
// may name something we cannot see (a function, an alias, a wrapper).
export function detectEditors({ env = process.env, exists = (name) => onPath(name, env) } = {}) {
  const candidates = [];
  const add = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length > 0 && !candidates.includes(text)) candidates.push(text);
  };
  add(env.VISUAL);
  add(env.EDITOR);
  for (const name of COMMON_EDITORS) {
    if (exists(name)) add(name);
  }
  return candidates;
}

// A bare name is something we can look up; anything carrying arguments is the
// user's own invocation and is taken on trust, exactly like $VISUAL and $EDITOR.
function isFindable(candidate) {
  return !/\s/u.test(candidate);
}

export function resolveEditors(doc, { env = process.env, exists = (name) => onPath(name, env) } = {}) {
  const configured = Array.isArray(doc?.editor)
    ? doc.editor.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)
    : [];
  if (configured.length === 0) return detectEditors({ env, exists });
  // A fresh commands.toml is seeded with every editor the plugin knows about, so
  // most of the list is missing on any given machine. Hiding what is not there
  // keeps the picker from offering a choice that would spawn "command not found"
  // into a detached process nobody ever sees.
  const installed = configured.filter((entry) => !isFindable(entry) || exists(entry));
  // If none of them are here, fall back to detection rather than to the list: it
  // still honours $VISUAL and $EDITOR, and an empty result is how the popup knows
  // to say so out loud instead of opening nothing.
  return installed.length > 0 ? installed : detectEditors({ env, exists });
}

export function editorSpawn(commandLine, filePath, { shell } = {}) {
  if (typeof commandLine !== 'string' || commandLine.trim().length === 0) {
    throw new TypeError('an editor candidate must be a non-empty command line');
  }
  // The path goes in as "$1" rather than being pasted into the command line, so a
  // path containing a space or a quote needs no escaping from us at all.
  return {
    file: shell || '/bin/sh',
    args: ['-lc', `${commandLine.trim()} "$1"`, 'cc-editor', filePath],
  };
}

export async function openInEditor(filePath, { editor, spawn, env = process.env, log, shell } = {}) {
  const { file, args } = editorSpawn(editor, filePath, { shell });
  const child = spawn(file, args, { detached: true, stdio: 'ignore', shell: false, env });
  child?.unref?.();
  if (typeof log === 'function') await log('open-config', { editor, path: filePath });
  return { status: 'started' };
}
