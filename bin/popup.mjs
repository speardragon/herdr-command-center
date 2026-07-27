#!/usr/bin/env node

// The interactive half of Command Center. It reads keys, renders frames, and
// persists commands.toml — but it never runs a command. On a run/open-config
// effect it spawns bin/run.mjs detached and returns; its own exit is what closes
// the herdr popup, which is precisely the ordering the runner then depends on.

import { execFile as execFileCallback, spawn as spawnChild } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readContext } from '../src/context.mjs';
import { resolveEditors } from '../src/editor.mjs';
import { herdrConfigPath, readImportable } from '../src/herdr-config.mjs';
import { createKeyDecoder } from '../src/keys.mjs';
import { commandsPath, resolveConfigDir, resolveStateDir, runLogPath } from '../src/paths.mjs';
import { gridColumns, renderView, textCursor } from '../src/render.mjs';
import { ConfigError } from '../src/schema.mjs';
import { ensureStore, saveStore } from '../src/store.mjs';
import { beginEditorPick, beginImport, createView, reduceKey } from '../src/view.mjs';

const execFileAsync = promisify(execFileCallback);

const CLEAR_SCREEN = '\u001b[2J\u001b[H';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
// DECSCUSR: a blinking bar reads as a text caret, which is the point.
const BLINKING_BAR = '\u001b[5 q';
const DEFAULT_CURSOR_SHAPE = '\u001b[0 q';
const RUNNER_URL = new URL('./run.mjs', import.meta.url);
const SIGNAL_EXIT_CODES = Object.freeze({
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
  SIGQUIT: 131,
});

function diagnostic(stderr, message) {
  try {
    stderr.write(`command-center: ${message}\n`);
  } catch {
    // Never let a diagnostic keep the terminal in raw mode.
  }
}

function screenSize(stdout, color) {
  return {
    columns: Number.isFinite(stdout.columns) ? stdout.columns : 78,
    rows: Number.isFinite(stdout.rows) ? stdout.rows : 24,
    color,
  };
}

export async function runPopup({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  processRef = process,
  spawn = spawnChild,
  execFile = execFileAsync,
  execPath = process.execPath,
} = {}) {
  if (!stdin?.isTTY || !stdout?.isTTY || typeof stdin.setRawMode !== 'function') {
    diagnostic(stderr, 'an interactive terminal is required');
    return 2;
  }

  let configDir;
  try {
    configDir = await resolveConfigDir(env, execFile);
  } catch (error) {
    diagnostic(stderr, error?.message ?? 'the plugin config directory could not be resolved');
    return 2;
  }
  const commandsFile = commandsPath(configDir);
  const logFile = runLogPath(resolveStateDir(configDir, env));
  const context = readContext(env);
  const useColor = !env.NO_COLOR && env.TERM !== 'dumb';

  let view;
  let raw = null;
  try {
    const loaded = await ensureStore(commandsFile);
    view = createView({ doc: loaded.doc });
    raw = loaded.raw;
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      diagnostic(stderr, 'commands.toml could not be opened');
      return 1;
    }
    // A broken config must still give the user a way to fix it, so keep a
    // minimal usable doc (for `editor`) and show the reason.
    view = createView({
      doc: { schema_version: 1, editor: [], commands: [] },
      error: error.message,
    });
  }

  let rawMode = false;
  let stopCode = null;
  const restoreRaw = () => {
    if (!rawMode) return;
    rawMode = false;
    try {
      stdin.setRawMode(false);
    } catch {
      // The terminal may already be detached.
    }
  };
  const draw = () => {
    try {
      const size = screenSize(stdout, useColor);
      const cursor = textCursor(view, size);
      // Hide first so the cursor does not visibly skate across the repaint, then
      // park it on the edit point when a text field has focus.
      const frame = `${HIDE_CURSOR}${CLEAR_SCREEN}${renderView(view, size)}`;
      stdout.write(cursor
        ? `${frame}\u001b[${cursor.row + 1};${cursor.column + 1}H${BLINKING_BAR}${SHOW_CURSOR}`
        : `${frame}${DEFAULT_CURSOR_SHAPE}`);
    } catch {
      requestStop(1);
    }
  };
  function requestStop(code) {
    if (stopCode !== null) return;
    stopCode = code;
    restoreRaw();
    try {
      stdin.destroy?.();
    } catch {
      // The iterator will finish on its own.
    }
  }
  const signalHandlers = Object.entries(SIGNAL_EXIT_CODES)
    .map(([signal, code]) => [signal, () => requestStop(code)]);
  const onResize = () => draw();
  const onStreamError = () => requestStop(1);

  const spawnRunner = (task) => {
    const child = spawn(execPath, [fileURLToPath(RUNNER_URL)], {
      detached: true,
      stdio: 'ignore',
      shell: false,
      env: {
        ...env,
        COMMAND_CENTER_TASK_JSON: JSON.stringify({
          ...task,
          context,
          commandsPath: commandsFile,
          logPath: logFile,
        }),
        COMMAND_CENTER_POPUP_PID: String(processRef.pid),
      },
    });
    child?.unref?.();
  };

  try {
    for (const [signal, handler] of signalHandlers) processRef.once(signal, handler);
    processRef.on('SIGWINCH', onResize);
    stdout.on?.('resize', onResize);
    stdin.on?.('error', onStreamError);
    stdout.on?.('error', onStreamError);
    stdin.setRawMode(true);
    rawMode = true;

    const decoder = createKeyDecoder();
    draw();

    for await (const chunk of stdin) {
      if (stopCode !== null) break;
      for (const key of decoder.push(chunk)) {
        view = reduceKey(view, key, { columns: gridColumns(view, screenSize(stdout, useColor)) });
        const { effect } = view;
        if (!effect) {
          draw();
          continue;
        }
        if (effect.type === 'close') return 0;
        if (effect.type === 'run') {
          spawnRunner({ kind: 'run', command: effect.command });
          return 0;
        }
        if (effect.type === 'open-config') {
          const candidates = resolveEditors(view.doc, { env });
          // Only ask when the user listed several themselves: naming more than one
          // editor *is* the request to be asked. When nothing is configured we are
          // guessing from $VISUAL/$EDITOR/PATH, and a guess should not become a
          // question every single time the config file is opened.
          const asks = (view.doc.editor ?? []).length > 1;
          const editor = effect.editor ?? (asks ? null : candidates[0] ?? null);
          if (editor) {
            spawnRunner({ kind: 'open-config', editor });
            return 0;
          }
          if (candidates.length === 0) {
            view = createView({
              doc: view.doc,
              error: 'no editor found; set editor = ["your-editor"] in commands.toml, or $EDITOR',
            });
            draw();
            continue;
          }
          view = beginEditorPick(view, candidates);
          draw();
          continue;
        }
        if (effect.type === 'load-import') {
          view = beginImport(view, await readImportable(herdrConfigPath(env)));
          draw();
          continue;
        }
        if (effect.type === 'save') {
          try {
            const saved = await saveStore(commandsFile, effect.doc, { expectedRaw: raw });
            raw = saved.raw;
            view = createView({ doc: effect.doc, cursor: effect.cursor });
          } catch (error) {
            if (!(error instanceof ConfigError)) throw error;
            view = createView({ doc: effect.doc, error: error.message });
          }
          draw();
        }
      }
    }
    if (stopCode !== null) return stopCode;
    diagnostic(stderr, 'terminal input ended before a command was chosen');
    return 1;
  } catch {
    diagnostic(stderr, 'the popup closed after an internal failure');
    return stopCode ?? 1;
  } finally {
    try {
      stdout.write(`${DEFAULT_CURSOR_SHAPE}${SHOW_CURSOR}`);
    } catch {
      // The pane is going away regardless; never mask the real exit code.
    }
    restoreRaw();
    for (const [signal, handler] of signalHandlers) processRef.removeListener?.(signal, handler);
    processRef.removeListener?.('SIGWINCH', onResize);
    stdout.removeListener?.('resize', onResize);
    stdin.removeListener?.('error', onStreamError);
    stdout.removeListener?.('error', onStreamError);
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
  process.exitCode = await runPopup();
}
