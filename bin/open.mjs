#!/usr/bin/env node

// The `open` action: what the user's keybinding actually triggers.
//
// It must run before the popup exists, because that is the only moment when
// herdr's invocation context still describes where the *user* was. Once the
// popup opens it becomes the focused pane, so the cwd is captured here and
// forwarded in as COMMAND_CENTER_CONTEXT_JSON.

import { execFile as execFileCallback } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readContext, serializeContext } from '../src/context.mjs';
import { PLUGIN_ID, POPUP_ENTRYPOINT_ID } from '../src/plugin.mjs';

const execFileAsync = promisify(execFileCallback);
const CLI_TIMEOUT_MS = 5_000;
const MAX_BUFFER_BYTES = 1_048_576;
const MAX_ERROR_STDOUT_BYTES = 16_384;

function herdrErrorCode(error) {
  const stdout = error?.stdout;
  if (typeof stdout !== 'string' || stdout.length > MAX_ERROR_STDOUT_BYTES) return null;
  try {
    const code = JSON.parse(stdout)?.error?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

export async function openPalette({
  env = process.env,
  execFile = execFileAsync,
  stderr = process.stderr,
} = {}) {
  const context = serializeContext(readContext(env));
  try {
    await execFile(env.HERDR_BIN_PATH || 'herdr', [
      'plugin', 'pane', 'open',
      '--plugin', PLUGIN_ID,
      '--entrypoint', POPUP_ENTRYPOINT_ID,
      '--placement', 'popup',
      '--focus',
      '--env', `COMMAND_CENTER_CONTEXT_JSON=${context}`,
    ], {
      env,
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      shell: false,
    });
    return 0;
  } catch (error) {
    const code = herdrErrorCode(error);
    try {
      stderr.write(
        `command-center: the popup could not be opened${code ? ` (${code})` : ''}\n`,
      );
    } catch {
      // Nothing more to do; the exit code still reports the failure.
    }
    return 1;
  }
}

async function invokedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (await invokedAsMain()) {
  process.exitCode = await openPalette();
}
