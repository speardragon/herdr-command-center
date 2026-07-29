import { fileURLToPath } from 'node:url';

// Like herdr's switch_ascii_input_source_in_prefix: the popup is a single-key
// TUI, so opening it on a Korean IME would swallow every slot key into a
// half-composed syllable. On open we hop to the last-used ASCII layout, and a
// detached watchdog puts the original source back once the popup process dies —
// by ANY path: esc, running a command, herdr killing the pane, SIGKILL. An exit
// handler in the popup could not cover all of those, so the watchdog owns the
// restore instead (the same shape cdragon.plugin-manager uses).

const HELPER_URL = new URL('../bin/input-source.js', import.meta.url);
const WATCHDOG_URL = new URL('../bin/restore-input.mjs', import.meta.url);

export function osascriptArgs(command, ...rest) {
  return ['-l', 'JavaScript', fileURLToPath(HELPER_URL), command, ...rest];
}

// macOS only, and opt-out rather than opt-in: the harm when it misfires is one
// keyboard-layout hop, and the harm without it is a popup that eats keys.
export function asciiInputEnabled(env = process.env, platform = process.platform) {
  return platform === 'darwin' && env?.COMMAND_CENTER_ASCII_INPUT !== '0';
}

// Fire-and-forget from the popup: never awaited before the first paint, and
// never allowed to throw — input switching is a courtesy, not a dependency.
export async function guardAsciiInput({
  env = process.env,
  platform = process.platform,
  execFile,
  spawn,
  execPath = process.execPath,
  pid,
} = {}) {
  if (!asciiInputEnabled(env, platform)) return { switched: false };
  try {
    const { stdout } = await execFile('osascript', osascriptArgs('switch-ascii'));
    const previous = String(stdout ?? '').trim();
    // Nothing printed means the source was already ASCII-capable: no switch
    // happened, so there is nothing to restore and no watchdog to pay for.
    if (previous.length === 0) return { switched: false };
    const child = spawn(execPath, [fileURLToPath(WATCHDOG_URL), String(pid), previous], {
      detached: true,
      stdio: 'ignore',
      shell: false,
      env,
    });
    child?.unref?.();
    return { switched: true, previous };
  } catch {
    return { switched: false };
  }
}

// The watchdog half, shared so bin/restore-input.mjs stays a thin entry point.
export async function restoreAfterExit({ pid, previous, execFile, waitForExit }) {
  const id = String(previous ?? '').trim();
  if (id.length === 0) return { restored: false };
  // No timeout: the popup may sit open for as long as the user is reading it.
  await waitForExit(pid, { timeoutMs: Infinity, intervalMs: 300 });
  try {
    await execFile('osascript', osascriptArgs('select', id));
    return { restored: true };
  } catch {
    return { restored: false };
  }
}
