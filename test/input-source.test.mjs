import assert from 'node:assert/strict';
import test from 'node:test';

import {
  asciiInputEnabled,
  guardAsciiInput,
  osascriptArgs,
  restoreAfterExit,
} from '../src/input-source.mjs';

function recorder(stdout = '') {
  const calls = [];
  const execFile = async (file, args) => {
    calls.push({ file, args });
    return { stdout };
  };
  return { calls, execFile };
}

function spawnRecorder() {
  const spawns = [];
  let unrefs = 0;
  const spawn = (file, args, options) => {
    spawns.push({ file, args, options });
    return { unref: () => { unrefs += 1; } };
  };
  return { spawns, spawn, unrefCount: () => unrefs };
}

test('osascriptArgs names the JXA helper and the command', () => {
  const args = osascriptArgs('switch-ascii');
  assert.deepEqual(args.slice(0, 2), ['-l', 'JavaScript']);
  assert.match(args[2], /bin\/input-source\.js$/u);
  assert.equal(args[3], 'switch-ascii');
  assert.deepEqual(osascriptArgs('select', 'com.apple.keylayout.ABC').slice(3), ['select', 'com.apple.keylayout.ABC']);
});

test('asciiInputEnabled is macOS-only and opt-out', () => {
  assert.equal(asciiInputEnabled({}, 'darwin'), true);
  assert.equal(asciiInputEnabled({}, 'linux'), false);
  assert.equal(asciiInputEnabled({ COMMAND_CENTER_ASCII_INPUT: '0' }, 'darwin'), false);
  assert.equal(asciiInputEnabled({ COMMAND_CENTER_ASCII_INPUT: '1' }, 'darwin'), true);
  assert.equal(asciiInputEnabled(null, 'darwin'), true, 'a missing env means nobody opted out');
});

test('guardAsciiInput does nothing off macOS or when opted out', async () => {
  const { calls, execFile } = recorder('com.apple.inputmethod.Korean');
  const { spawns, spawn } = spawnRecorder();
  for (const [env, platform] of [[{}, 'linux'], [{ COMMAND_CENTER_ASCII_INPUT: '0' }, 'darwin']]) {
    const result = await guardAsciiInput({ env, platform, execFile, spawn, execPath: '/usr/bin/node', pid: 42 });
    assert.deepEqual(result, { switched: false });
  }
  assert.equal(calls.length, 0);
  assert.equal(spawns.length, 0);
});

test('an already-ASCII source needs no switch and no watchdog', async () => {
  const { execFile } = recorder('\n');
  const { spawns, spawn } = spawnRecorder();
  const result = await guardAsciiInput({ env: {}, platform: 'darwin', execFile, spawn, execPath: '/usr/bin/node', pid: 42 });
  assert.deepEqual(result, { switched: false });
  assert.equal(spawns.length, 0);
});

test('a switched source hands the restore to a detached watchdog', async () => {
  const { calls, execFile } = recorder('com.apple.inputmethod.Korean.2SetKorean\n');
  const { spawns, spawn, unrefCount } = spawnRecorder();
  const env = { HOME: '/Users/cdragon' };
  const result = await guardAsciiInput({ env, platform: 'darwin', execFile, spawn, execPath: '/usr/bin/node', pid: 4242 });

  assert.deepEqual(result, { switched: true, previous: 'com.apple.inputmethod.Korean.2SetKorean' });
  assert.equal(calls[0].file, 'osascript');
  assert.equal(calls[0].args.at(-1), 'switch-ascii');

  assert.equal(spawns.length, 1);
  const watchdog = spawns[0];
  assert.equal(watchdog.file, '/usr/bin/node');
  assert.match(watchdog.args[0], /bin\/restore-input\.mjs$/u);
  assert.equal(watchdog.args[1], '4242');
  assert.equal(watchdog.args[2], 'com.apple.inputmethod.Korean.2SetKorean');
  assert.equal(watchdog.options.detached, true, 'must outlive the popup process group');
  assert.equal(watchdog.options.stdio, 'ignore');
  assert.equal(watchdog.options.env, env);
  assert.equal(unrefCount(), 1);
});

test('a failing osascript is swallowed, not thrown into the popup', async () => {
  const { spawns, spawn } = spawnRecorder();
  const result = await guardAsciiInput({
    env: {},
    platform: 'darwin',
    execFile: async () => { throw new Error('osascript exploded'); },
    spawn,
    execPath: '/usr/bin/node',
    pid: 42,
  });
  assert.deepEqual(result, { switched: false });
  assert.equal(spawns.length, 0);
});

test('restoreAfterExit waits for the popup to die, then selects the old source', async () => {
  const order = [];
  const { calls, execFile } = recorder('ok');
  const result = await restoreAfterExit({
    pid: 4242,
    previous: 'com.apple.inputmethod.Korean.2SetKorean',
    execFile: async (...args) => { order.push('select'); return execFile(...args); },
    waitForExit: async (pid, options) => {
      order.push('wait');
      assert.equal(pid, 4242);
      assert.equal(options.timeoutMs, Infinity, 'the popup may stay open for minutes');
      return true;
    },
  });
  assert.deepEqual(result, { restored: true });
  assert.deepEqual(order, ['wait', 'select']);
  assert.deepEqual(calls[0].args.slice(3), ['select', 'com.apple.inputmethod.Korean.2SetKorean']);
});

test('restoreAfterExit with nothing to restore does not even wait', async () => {
  for (const previous of ['', '   ', undefined, null]) {
    const result = await restoreAfterExit({
      pid: 42,
      previous,
      execFile: async () => { throw new Error('must not run'); },
      waitForExit: async () => { throw new Error('must not wait'); },
    });
    assert.deepEqual(result, { restored: false }, JSON.stringify(previous));
  }
});

test('restoreAfterExit reports a failed restore instead of throwing', async () => {
  const result = await restoreAfterExit({
    pid: 42,
    previous: 'some.source',
    execFile: async () => { throw new Error('osascript exploded'); },
    waitForExit: async () => true,
  });
  assert.deepEqual(result, { restored: false });
});
