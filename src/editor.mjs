import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

// Deliberately not just "code": the plugin cannot assume VS Code is installed or
// that its shell integration is on the PATH. Ordered by how likely a terminal
// user is to want each one.
export const COMMON_EDITORS = Object.freeze([
  'code', 'cursor', 'subl', 'nvim', 'vim', 'hx', 'nano',
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

export function resolveEditors(doc, options = {}) {
  const configured = Array.isArray(doc?.editor)
    ? doc.editor.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  return configured.length > 0 ? configured : detectEditors(options);
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
