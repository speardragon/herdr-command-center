#!/usr/bin/env node

// The detached half of Command Center. The popup spawns this, then exits, which
// is what closes the popup. Everything here happens after the popup is gone —
// which is the whole point: `herdr plugin action invoke` resolves the focused
// pane server-side and refuses UI work while a popup owns the screen.

import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { openInEditor } from '../src/editor.mjs';
import { executeCommand } from '../src/executor.mjs';
import { createLogger as createDefaultLogger } from '../src/logger.mjs';
import { ConfigError, normalizeCommand } from '../src/schema.mjs';
import { waitForProcessExit } from '../src/wait.mjs';

const execFileAsync = promisify(execFileCallback);

export const SETTLE_MS = 120;
const MAX_TASK_BYTES = 64_000;
const TASK_KINDS = new Set(['run', 'open-config']);

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const herdrNotify = (bin, env, execFile) => async (title, body) => {
  try {
    await execFile(bin, ['notification', 'show', title, '--body', body], {
      env, encoding: 'utf8', timeout: 5_000, maxBuffer: 1_048_576, shell: false,
    });
  } catch {
    // A failed notification must not mask the execution error it describes.
  }
};

function usablePath(value) {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value) && !value.includes('\u0000');
}

function parseTask(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_TASK_BYTES) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!TASK_KINDS.has(value.kind)) return null;
  if (!usablePath(value.commandsPath) || !usablePath(value.logPath)) return null;
  const context = value.context && typeof value.context === 'object' && !Array.isArray(value.context)
    ? value.context
    : {};
  if (value.kind === 'open-config') {
    if (typeof value.editor !== 'string' || value.editor.trim().length === 0) return null;
    return { ...value, context, command: null };
  }
  let command;
  try {
    command = normalizeCommand(value.command);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return null;
  }
  return { ...value, context, command };
}

export async function runPending({
  env = process.env,
  spawn = spawnChild,
  execFile = execFileAsync,
  waitForExit = waitForProcessExit,
  sleep = defaultSleep,
  createLogger = createDefaultLogger,
} = {}) {
  const task = parseTask(env.COMMAND_CENTER_TASK_JSON);
  if (!task) return 2;
  const logger = createLogger(task.logPath);

  const popupPid = Number.parseInt(env.COMMAND_CENTER_POPUP_PID ?? '', 10);
  const exited = await waitForExit(Number.isSafeInteger(popupPid) ? popupPid : 0, { sleep });
  await logger.write('popup-closed', { exited });
  // Even if the popup somehow outlived the wait, go ahead: the ui_busy retry in
  // the executor is the second line of defence, and refusing to run would leave
  // the user's keypress with no visible result at all.
  await sleep(SETTLE_MS);

  try {
    if (task.kind === 'open-config') {
      await openInEditor(task.commandsPath, {
        editor: task.editor,
        shell: env.SHELL,
        spawn,
        env,
        log: logger.write,
      });
      return 0;
    }
    const herdrBin = env.HERDR_BIN_PATH || 'herdr';
    await executeCommand(task.command, {
      context: task.context,
      herdrBin,
      shell: env.SHELL,
      env,
      spawn,
      execFile,
      log: logger.write,
      sleep,
      notify: herdrNotify(herdrBin, env, execFile),
    });
    return 0;
  } catch (error) {
    await logger.write('failed', { message: error?.message ?? 'unknown failure' });
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
  process.exitCode = await runPending();
}
