#!/usr/bin/env node

// The `edit-config` action: open commands.toml in the configured editor without
// going through the popup at all, for when the user already knows what to change.

import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { openInEditor, resolveEditors } from '../src/editor.mjs';
import { createLogger as createDefaultLogger } from '../src/logger.mjs';
import { commandsPath, resolveConfigDir, resolveStateDir, runLogPath } from '../src/paths.mjs';
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
  // fall back to an empty editor list (auto-detect) rather than refusing to open.
  let doc = { editor: [] };
  try {
    const loaded = await loadStore(commandsFile);
    doc = loaded.doc;
  } catch {
    await logger.write('edit-config-fallback-editor', { path: commandsFile });
  }

  const candidates = resolveEditors(doc, { env });
  if (candidates.length === 0) {
    await logger.write('failed', { message: 'no editor found' });
    try {
      stderr.write('command-center: no editor found; set editor = ["your-editor"] in commands.toml, or $EDITOR\n');
    } catch {
      // The exit code still reports the failure.
    }
    return 1;
  }
  // There is no popup here to ask which candidate to use, so take the first
  // and log that a choice was made rather than silently picking one.
  const editor = candidates[0];
  if (candidates.length > 1) {
    await logger.write('edit-config-multiple-editors', { editor, candidates });
  }

  try {
    await openInEditor(commandsFile, { editor, spawn, env, shell: env.SHELL, log: logger.write });
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
