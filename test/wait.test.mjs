import assert from 'node:assert/strict';
import test from 'node:test';

import { waitForProcessExit } from '../src/wait.mjs';

test('waitForProcessExit returns true as soon as the process is gone', async () => {
  let probes = 0;
  const exited = await waitForProcessExit(4242, {
    kill: () => {
      probes += 1;
      if (probes >= 3) {
        const error = new Error('no such process');
        error.code = 'ESRCH';
        throw error;
      }
    },
    sleep: async () => {},
    intervalMs: 10,
    timeoutMs: 1_000,
  });
  assert.equal(exited, true);
  assert.equal(probes, 3);
});

test('waitForProcessExit gives up after the timeout', async () => {
  let slept = 0;
  const exited = await waitForProcessExit(4242, {
    kill: () => {},
    sleep: async () => { slept += 1; },
    intervalMs: 25,
    timeoutMs: 100,
  });
  assert.equal(exited, false);
  assert.ok(slept >= 4 && slept <= 6, `slept ${slept} times`);
});

test('waitForProcessExit treats a missing or invalid pid as already exited', async () => {
  for (const pid of [undefined, null, 0, -1, Number.NaN, 1.5]) {
    assert.equal(await waitForProcessExit(pid, {
      kill: () => { throw new Error('kill must not be called'); },
      sleep: async () => {},
    }), true);
  }
});

test('waitForProcessExit really observes a live process ending', async () => {
  const exited = await waitForProcessExit(process.pid, { timeoutMs: 60, intervalMs: 20 });
  assert.equal(exited, false, 'our own process is still alive');
});
