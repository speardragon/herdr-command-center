import { isAbsolute } from 'node:path';

export const SCHEMA_VERSION = 1;
export const COMMAND_TYPES = Object.freeze(['shell', 'plugin_action']);
export const CWD_MODES = Object.freeze(['focused', 'workspace']);
export const DEFAULT_EDITOR = Object.freeze(['code']);

const MAX_LABEL_LENGTH = 80;
const MAX_COMMAND_LENGTH = 2_000;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_ID_LENGTH = 64;
const MAX_COMMANDS = 200;
const MAX_EDITOR_ARGS = 8;
// Unicode-aware so a Korean label yields a readable id instead of "command-7".
const ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireText(value, field, maxLength) {
  if (typeof value !== 'string') throw new ConfigError(`${field} must be a string`);
  const text = value.trim();
  if (text.length === 0) throw new ConfigError(`${field} must not be empty`);
  if (text.length > maxLength) throw new ConfigError(`${field} must be at most ${maxLength} characters`);
  if (text.includes('\u0000')) throw new ConfigError(`${field} must not contain NUL bytes`);
  return text;
}

export function slugify(label) {
  const slug = String(label ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug.length > 0 ? slug.slice(0, MAX_ID_LENGTH) : 'command';
}

export function uniqueId(base, existingIds = []) {
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ConfigError(`could not derive a unique id for "${base}"`);
}

export function parsePluginActionTarget(target) {
  const text = typeof target === 'string' ? target.trim() : '';
  const lastDot = text.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === text.length - 1) {
    throw new ConfigError(
      `command "${text}" must be a plugin action target of the form plugin_id.action_id`,
    );
  }
  return { pluginId: text.slice(0, lastDot), actionId: text.slice(lastDot + 1) };
}

function normalizeCwd(value) {
  if (value === undefined || value === null || value === '') return 'focused';
  if (typeof value !== 'string') throw new ConfigError('cwd must be a string');
  const text = value.trim();
  if (CWD_MODES.includes(text)) return text;
  if (!isAbsolute(text) || text.includes('\u0000')) {
    throw new ConfigError(`cwd must be ${CWD_MODES.join(', ')}, or an absolute path`);
  }
  return text;
}

function normalizeDescription(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ConfigError('description must be a string');
  const text = value.trim();
  if (text.length > MAX_DESCRIPTION_LENGTH) {
    throw new ConfigError(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return text.replace(/[\u0000\r\n]/gu, ' ');
}

export function normalizeCommand(value, { existingIds = [] } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('a command must be an object');
  }
  const label = requireText(value.label, 'label', MAX_LABEL_LENGTH);
  const type = value.type;
  if (!COMMAND_TYPES.includes(type)) {
    throw new ConfigError(`type must be one of ${COMMAND_TYPES.join(', ')}`);
  }
  const command = requireText(value.command, 'command', MAX_COMMAND_LENGTH);
  if (/[\r\n]/u.test(command)) throw new ConfigError('command must be a single line');
  if (type === 'plugin_action') parsePluginActionTarget(command);
  let id;
  if (value.id === undefined || value.id === null || value.id === '') {
    id = uniqueId(slugify(label), existingIds);
  } else {
    id = requireText(value.id, 'id', MAX_ID_LENGTH);
    if (!ID_PATTERN.test(id)) {
      throw new ConfigError(`id "${id}" must contain only letters, digits, "-", and "_"`);
    }
  }
  return {
    id,
    label,
    type,
    command,
    cwd: normalizeCwd(value.cwd),
    description: normalizeDescription(value.description),
  };
}

function normalizeEditor(value) {
  if (value === undefined || value === null) return [...DEFAULT_EDITOR];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EDITOR_ARGS) {
    throw new ConfigError(`editor must be an array of 1 to ${MAX_EDITOR_ARGS} strings`);
  }
  return value.map((entry, index) => requireText(entry, `editor[${index}]`, 512));
}

export function normalizeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('commands.toml must contain a TOML table');
  }
  const version = value.schema_version ?? SCHEMA_VERSION;
  if (version !== SCHEMA_VERSION) {
    throw new ConfigError(`schema_version must be ${SCHEMA_VERSION} (found ${JSON.stringify(version)})`);
  }
  const rawCommands = value.commands ?? [];
  if (!Array.isArray(rawCommands)) throw new ConfigError('commands must be an array');
  if (rawCommands.length > MAX_COMMANDS) {
    throw new ConfigError(`commands must contain at most ${MAX_COMMANDS} entries`);
  }
  const commands = [];
  const existingIds = [];
  rawCommands.forEach((entry, index) => {
    let normalized;
    try {
      normalized = normalizeCommand(entry, { existingIds });
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      throw new ConfigError(`commands[${index}]: ${error.message}`);
    }
    if (existingIds.includes(normalized.id)) {
      throw new ConfigError(`commands[${index}]: duplicate id "${normalized.id}"`);
    }
    existingIds.push(normalized.id);
    commands.push(normalized);
  });
  return { schema_version: SCHEMA_VERSION, editor: normalizeEditor(value.editor), commands };
}

export function defaultConfig() {
  return {
    schema_version: SCHEMA_VERSION,
    editor: [...DEFAULT_EDITOR],
    commands: [
      {
        id: 'open-in-vs-code',
        label: 'Open in VS Code',
        type: 'shell',
        command: 'code .',
        cwd: 'focused',
        description: "Open the focused pane's directory in VS Code",
      },
      {
        id: 'open-repo-on-github',
        label: 'Open repo on GitHub',
        type: 'shell',
        command: 'gh browse',
        cwd: 'focused',
        description: 'Open the current repository in the browser',
      },
      {
        id: 'open-pull-request',
        label: 'Open pull request',
        type: 'shell',
        command: 'gh pr view --web',
        cwd: 'focused',
        description: "Open this branch's pull request in the browser",
      },
    ],
  };
}
