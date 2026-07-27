import { resolveCwd } from './context.mjs';
import { parsePluginActionTarget } from './schema.mjs';

export const UI_BUSY_CODE = 'ui_busy';

const DEFAULT_ATTEMPTS = 10;
const RETRY_DELAY_MS = 120;
const CLI_TIMEOUT_MS = 5_000;
const MAX_BUFFER_BYTES = 1_048_576;
const MAX_ERROR_STDOUT_BYTES = 16_384;

export class ExecutionError extends Error {
  constructor(message, { code = null } = {}) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function buildShellSpawn(command, { cwd, shell } = {}) {
  // No implicit process.env read: bin/run.mjs passes the user's SHELL through, so
  // the fallback here stays deterministic and testable.
  const file = shell || '/bin/sh';
  return {
    file,
    // -lc matches herdr's own `type = "shell"` keybindings: a login shell so the
    // user's PATH and aliases from their profile are available.
    args: ['-lc', command.command],
    options: { cwd, detached: true, stdio: 'ignore', shell: false },
  };
}

// Single quotes are the only shell quoting with no escapes inside, so a path can
// be wrapped verbatim once its own single quotes are closed, escaped and reopened.
export function shellQuote(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
}

// Typed input runs wherever that shell already is, so the command's own cwd would
// be ignored. A subshell honours it without leaving the user's shell somewhere
// they did not put it.
export function buildPaneLine(command, context) {
  return `(cd ${shellQuote(resolveCwd(command, context))} && ${command.command})`;
}

export function buildPluginActionArgs(command) {
  const { pluginId, actionId } = parsePluginActionTarget(command.command);
  return ['plugin', 'action', 'invoke', actionId, '--plugin', pluginId];
}

function isUiBusy(error) {
  const stdout = error?.stdout;
  if (typeof stdout !== 'string' || stdout.length > MAX_ERROR_STDOUT_BYTES) return false;
  try {
    return JSON.parse(stdout)?.error?.code === UI_BUSY_CODE;
  } catch {
    return false;
  }
}

async function runShell(command, { context, shell, env, spawn, log }) {
  const cwd = resolveCwd(command, context);
  const { file, args, options } = buildShellSpawn(command, { cwd, shell });
  const child = spawn(file, args, { ...options, env });
  child?.unref?.();
  if (typeof log === 'function') await log('shell', { id: command.id, cwd, command: command.command });
  return { status: 'started' };
}

async function runInPane(command, { context, herdrBin, env, execFile, log, notify }) {
  const paneId = context?.focusedPaneId;
  const agent = context?.focusedPaneAgent;
  if (!paneId) {
    if (typeof log === 'function') await log('pane_no_target', { id: command.id });
    throw new ExecutionError('there is no focused pane to run this in');
  }
  // `herdr pane run` types the line into the pane and presses Enter. When an agent
  // owns that pane, the line would be submitted to the agent as a prompt instead
  // of to a shell, so refuse and say so rather than prompt someone's Claude.
  if (agent) {
    if (typeof log === 'function') await log('pane_busy_with_agent', { id: command.id, agent });
    if (typeof notify === 'function') {
      await notify(
        'Command Center',
        `"${command.label}" was not run: the focused pane is running ${agent}, and typing into it would prompt the agent. Focus a shell pane and try again.`,
      );
    }
    throw new ExecutionError(`the focused pane is running ${agent}, not a shell`);
  }
  await execFile(herdrBin, ['pane', 'run', paneId, buildPaneLine(command, context)], {
    env,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    shell: false,
  });
  if (typeof log === 'function') {
    await log('pane', { id: command.id, paneId, cwd: resolveCwd(command, context) });
  }
  return { status: 'sent' };
}

async function runPluginAction(command, { herdrBin, env, execFile, log, sleep, attempts }) {
  const args = buildPluginActionArgs(command);
  let lastBusy = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await execFile(herdrBin, args, {
        env,
        encoding: 'utf8',
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        shell: false,
      });
      if (typeof log === 'function') await log('plugin_action', { id: command.id, attempt });
      return { status: 'invoked' };
    } catch (error) {
      lastBusy = isUiBusy(error);
      // herdr refuses UI work while a popup owns the screen. The popup process
      // has already exited by the time we get here, but herdr's teardown is not
      // instantaneous — so a bounded retry turns a millisecond race into a
      // reliable invocation instead of a silent no-op.
      if (attempt < attempts && lastBusy) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      if (typeof log === 'function') {
        await log('plugin_action_failed', { id: command.id, attempt, busy: lastBusy });
      }
      throw new ExecutionError(
        `plugin action ${command.command} could not be invoked`,
        { code: lastBusy ? UI_BUSY_CODE : null },
      );
    }
  }
  throw new ExecutionError(`plugin action ${command.command} could not be invoked`, {
    code: lastBusy ? UI_BUSY_CODE : null,
  });
}

export async function executeCommand(command, {
  context,
  herdrBin = 'herdr',
  shell,
  env = process.env,
  spawn,
  execFile,
  log,
  sleep = defaultSleep,
  attempts = DEFAULT_ATTEMPTS,
  notify,
} = {}) {
  if (typeof spawn !== 'function') throw new TypeError('spawn is required');
  if (typeof execFile !== 'function') throw new TypeError('execFile is required');
  if (command?.type === 'shell') {
    return runShell(command, { context, shell, env, spawn, log });
  }
  if (command?.type === 'pane') {
    return runInPane(command, { context, herdrBin, env, execFile, log, notify });
  }
  if (command?.type === 'plugin_action') {
    return runPluginAction(command, { herdrBin, env, execFile, log, sleep, attempts });
  }
  throw new ExecutionError(`unsupported command type ${JSON.stringify(command?.type)}`);
}
