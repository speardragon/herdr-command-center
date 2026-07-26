const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// signal 0 probes for existence without delivering a signal. This is how the
// detached runner knows the popup is really gone before it touches herdr's UI —
// it depends on nothing but the OS process table.
export async function waitForProcessExit(pid, {
  timeoutMs = 3_000,
  intervalMs = 25,
  kill = process.kill.bind(process),
  sleep = defaultSleep,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  let waited = 0;
  for (;;) {
    try {
      kill(pid, 0);
    } catch {
      return true;
    }
    if (waited >= timeoutMs) return false;
    await sleep(intervalMs);
    waited += intervalMs;
  }
}
