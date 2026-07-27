import assert from 'node:assert/strict';
import test from 'node:test';

import { runPending, SETTLE_MS } from '../bin/run.mjs';

const COMMAND = {
  id: 'open-in-vs-code',
  label: 'Open in VS Code',
  type: 'shell',
  command: 'code .',
  cwd: 'focused',
  description: '',
};

function task(overrides = {}) {
  return {
    kind: 'run',
    command: COMMAND,
    context: { focusedPaneCwd: '/Users/cdragon/repo', workspaceCwd: '/Users/cdragon' },
    editor: 'code',
    commandsPath: '/tmp/cc/commands.json',
    logPath: '/tmp/cc/state/run.log',
    ...overrides,
  };
}

function deps(overrides = {}) {
  const events = [];
  const spawns = [];
  return {
    events,
    spawns,
    options: {
      env: {
        COMMAND_CENTER_TASK_JSON: JSON.stringify(task()),
        COMMAND_CENTER_POPUP_PID: '4242',
        SHELL: '/bin/zsh',
      },
      spawn: (file, args, options) => {
        spawns.push({ file, args, options });
        return { unref: () => {} };
      },
      execFile: async () => ({ stdout: '{}', stderr: '' }),
      waitForExit: async () => true,
      sleep: async () => {},
      createLogger: () => ({ write: async (event, detail) => { events.push([event, detail]); } }),
      ...overrides,
    },
  };
}

test('SETTLE_MS gives herdr time to tear the popup down', () => {
  assert.ok(SETTLE_MS >= 50 && SETTLE_MS <= 500);
});

test('runPending waits for the popup pid before executing', async () => {
  const order = [];
  const { options, spawns } = deps({
    waitForExit: async (pid) => { order.push(`wait:${pid}`); return true; },
    spawn: (file, args, spawnOptions) => { order.push('spawn'); return { unref: () => {} }; },
  });
  const code = await runPending(options);
  assert.equal(code, 0);
  assert.deepEqual(order, ['wait:4242', 'spawn']);
});

test('runPending settles after the popup exits and before it executes', async () => {
  const order = [];
  const { options } = deps({
    waitForExit: async () => { order.push('wait'); return true; },
    sleep: async (ms) => { order.push(`sleep:${ms}`); },
    spawn: () => { order.push('spawn'); return { unref: () => {} }; },
  });
  await runPending(options);
  assert.deepEqual(order, ['wait', `sleep:${SETTLE_MS}`, 'spawn']);
});

test('runPending runs a shell command in the forwarded cwd', async () => {
  const { options, spawns } = deps();
  assert.equal(await runPending(options), 0);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, '/bin/zsh');
  assert.deepEqual(spawns[0].args, ['-lc', 'code .']);
  assert.equal(spawns[0].options.cwd, '/Users/cdragon/repo');
});

test('runPending invokes a plugin action through the herdr CLI', async () => {
  const calls = [];
  const { options } = deps({
    env: {
      COMMAND_CENTER_TASK_JSON: JSON.stringify(task({
        command: { ...COMMAND, id: 'fx', type: 'plugin_action', command: 'ray.file-explorer.open' },
      })),
      COMMAND_CENTER_POPUP_PID: '4242',
      HERDR_BIN_PATH: '/opt/homebrew/bin/herdr',
    },
    execFile: async (bin, args) => { calls.push({ bin, args }); return { stdout: '{}', stderr: '' }; },
  });
  assert.equal(await runPending(options), 0);
  assert.deepEqual(calls, [{
    bin: '/opt/homebrew/bin/herdr',
    args: ['plugin', 'action', 'invoke', 'open', '--plugin', 'ray.file-explorer'],
  }]);
});

test('runPending opens the config file for an open-config task', async () => {
  const { options, spawns } = deps({
    env: {
      COMMAND_CENTER_TASK_JSON: JSON.stringify(task({ kind: 'open-config', command: undefined })),
      COMMAND_CENTER_POPUP_PID: '4242',
      SHELL: '/bin/zsh',
    },
  });
  assert.equal(await runPending(options), 0);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, '/bin/zsh');
  assert.equal(spawns[0].args[1], 'code "$1"');
});

test('runPending waits for the popup before opening the editor too', async () => {
  const order = [];
  const { options } = deps({
    env: {
      COMMAND_CENTER_TASK_JSON: JSON.stringify(task({ kind: 'open-config', command: undefined })),
      COMMAND_CENTER_POPUP_PID: '4242',
    },
    waitForExit: async () => { order.push('wait'); return true; },
    spawn: () => { order.push('spawn'); return { unref: () => {} }; },
  });
  await runPending(options);
  assert.deepEqual(order, ['wait', 'spawn']);
});

test('runPending executes even when the popup outlives the wait timeout', async () => {
  const { options, spawns, events } = deps({ waitForExit: async () => false });
  assert.equal(await runPending(options), 0);
  assert.equal(spawns.length, 1);
  assert.deepEqual(events[0], ['popup-closed', { exited: false }]);
});

test('runPending logs the popup-closed observation first', async () => {
  const { options, events } = deps();
  await runPending(options);
  assert.deepEqual(events[0], ['popup-closed', { exited: true }]);
});

test('runPending returns 2 for a missing or malformed task', async () => {
  for (const value of [undefined, '', 'not json', '[]', 'null', JSON.stringify({ kind: 'nope' })]) {
    const { options, spawns } = deps({
      env: { COMMAND_CENTER_TASK_JSON: value, COMMAND_CENTER_POPUP_PID: '4242' },
    });
    assert.equal(await runPending(options), 2, JSON.stringify(value));
    assert.equal(spawns.length, 0);
  }
});

test('runPending returns 2 when a run task has no valid command', async () => {
  for (const command of [undefined, {}, { label: 'a', type: 'nope', command: 'b' }]) {
    const { options } = deps({
      env: {
        COMMAND_CENTER_TASK_JSON: JSON.stringify(task({ command })),
        COMMAND_CENTER_POPUP_PID: '4242',
      },
    });
    assert.equal(await runPending(options), 2);
  }
});

test('runPending returns 2 when the paths or editor are unusable', async () => {
  for (const overrides of [
    { commandsPath: 'relative/commands.json' },
    { logPath: 'relative/run.log' },
    { kind: 'open-config', command: undefined, editor: '' },
    { kind: 'open-config', command: undefined, editor: ['code'] },
  ]) {
    const { options } = deps({
      env: {
        COMMAND_CENTER_TASK_JSON: JSON.stringify(task(overrides)),
        COMMAND_CENTER_POPUP_PID: '4242',
      },
    });
    assert.equal(await runPending(options), 2, JSON.stringify(overrides));
  }
});

test('runPending returns 1 and logs when execution fails', async () => {
  const { options, events } = deps({
    spawn: () => { throw new Error('ENOENT'); },
  });
  assert.equal(await runPending(options), 1);
  assert.equal(events.at(-1)[0], 'failed');
  assert.match(events.at(-1)[1].message, /ENOENT/u);
});

test('runPending tolerates a missing popup pid', async () => {
  const { options, spawns } = deps({
    env: { COMMAND_CENTER_TASK_JSON: JSON.stringify(task()) },
    waitForExit: async (pid) => {
      assert.equal(pid, 0);
      return true;
    },
  });
  assert.equal(await runPending(options), 0);
  assert.equal(spawns.length, 1);
});
