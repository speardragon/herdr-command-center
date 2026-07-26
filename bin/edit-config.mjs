#!/usr/bin/env node

// The `edit-config` action: open commands.json in the configured editor without
// going through the popup at all, for when the user already knows what to change.

import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { openInEditor } from '../src/editor.mjs';
import { createLogger as createDefaultLogger } from '../src/logger.mjs';
import { commandsPath, resolveConfigDir, resolveStateDir, runLogPath } from '../src/paths.mjs';
import { DEFAULT_EDITOR } from '../src/schema.mjs';
import { loadStore } from '../src/store.mjs';

const execFileAsync = promisify(execFileCallback);

export async function editConfig({
  env = process.env,
  execFile = execFileAsync,
  spawn = spawnChild,
  stderr = process.stderr,
  createLogger = createDefaultLogger,
} = {}) {
  let configDir;
  try {
    configDir = await resolveConfigDir(env, execFile);
  } catch (error) {
    try {
      stderr.write(`command-center: ${error?.message ?? 'the config directory could not be resolved'}\n`);
    } catch {
      // The exit code still reports the failure.
    }
    return 2;
  }
  const commandsFile = commandsPath(configDir);
  const logger = createLogger(runLogPath(resolveStateDir(configDir, env)));

  // A broken or absent file is exactly when the user most needs the editor, so
  // fall back to the default editor rather than refusing to open.
  let editor = [...DEFAULT_EDITOR];
  try {
    const loaded = await loadStore(commandsFile);
    editor = loaded.doc.editor;
  } catch {
    await logger.write('edit-config-fallback-editor', { path: commandsFile });
  }

  try {
    await openInEditor(commandsFile, { editor, spawn, env, log: logger.write });
    return 0;
  } catch (error) {
    await logger.write('failed', { message: error?.message ?? 'unknown failure' });
    try {
      stderr.write(`command-center: the editor could not be started (${error?.message ?? 'unknown failure'})\n`);
    } catch {
      // The exit code still reports the failure.
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
  process.exitCode = await editConfig();
}
