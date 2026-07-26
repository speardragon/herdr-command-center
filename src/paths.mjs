import { execFile as execFileCallback } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import { CONFIG_FILE_NAME, LEGACY_CONFIG_FILE_NAME, MAX_PATH_BYTES, PLUGIN_ID, RUN_LOG_FILE_NAME } from './plugin.mjs';

const execFileAsync = promisify(execFileCallback);

function usablePath(path) {
  return typeof path === 'string'
    && path.length > 0
    && isAbsolute(path)
    && !path.includes('\u0000')
    && Buffer.byteLength(path) <= MAX_PATH_BYTES;
}

// herdr injects HERDR_PLUGIN_CONFIG_DIR into plugin panes and actions. The CLI
// lookup is the fallback for running an entrypoint by hand outside herdr.
export async function resolveConfigDir(env = process.env, execFile = execFileAsync) {
  const configured = env.COMMAND_CENTER_CONFIG_DIR || env.HERDR_PLUGIN_CONFIG_DIR;
  if (configured) {
    if (!usablePath(configured)) throw new Error('plugin config directory is invalid');
    return configured;
  }
  let stdout;
  try {
    const result = await execFile(env.HERDR_BIN_PATH || 'herdr', ['plugin', 'config-dir', PLUGIN_ID], {
      env,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1_048_576,
      shell: false,
    });
    stdout = result?.stdout;
  } catch {
    throw new Error('plugin config directory could not be resolved');
  }
  const path = typeof stdout === 'string' ? stdout.trim() : '';
  if (!usablePath(path)) throw new Error('plugin config directory could not be resolved');
  return path;
}

export function resolveStateDir(configDir, env = process.env) {
  const configured = env.HERDR_PLUGIN_STATE_DIR;
  if (usablePath(configured)) return configured;
  return join(configDir, 'state');
}

export function commandsPath(configDir) {
  return join(configDir, CONFIG_FILE_NAME);
}

export function legacyCommandsPath(configDir) {
  return join(configDir, LEGACY_CONFIG_FILE_NAME);
}

export function runLogPath(stateDir) {
  return join(stateDir, RUN_LOG_FILE_NAME);
}
