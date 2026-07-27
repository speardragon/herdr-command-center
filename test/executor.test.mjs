import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPaneLine,
  buildPluginActionArgs,
  buildShellSpawn,
  executeCommand,
  ExecutionError,
  shellQuote,
  UI_BUSY_CODE,
} from '../src/executor.mjs';

const CONTEXT = { focusedPaneCwd: '/Users/cdragon/repo', workspaceCwd: '/Users/cdragon' };

function shellCommand(overrides = {}) {
  return {
    id: 'open-in-vs-code',
    label: 'Open in VS Code',
    type: 'shell',
    command: 'code .',
    cwd: 'focused',
    description: '',
    ...overrides,
  };
}

function actionCommand(overrides = {}) {
  return {
    id: 'file-explorer',
    label: 'File explorer',
    type: 'plugin_action',
    command: 'ray.file-explorer.open',
    cwd: 'focused',
    description: '',
    ...overrides,
  };
}

function paneCommand(overrides = {}) {
  return {
    id: 'echo', slot: '1', label: 'Echo', type: 'pane',
    command: 'echo hello', cwd: 'focused', description: '', ...overrides,
  };
}

const noSleep = async () => {};

test('shellQuote makes any directory safe to paste into a shell line', () => {
  assert.equal(shellQuote('/tmp/plain'), "'/tmp/plain'");
  assert.equal(shellQuote('/tmp/with space'), "'/tmp/with space'");
  assert.equal(shellQuote("/tmp/it's"), "'/tmp/it'\\''s'");
  assert.equal(shellQuote('/tmp/$HOME`x`'), "'/tmp/$HOME`x`'");
});

test('buildPaneLine runs the command in the resolved cwd via a subshell', () => {
  // Typed input would otherwise run wherever that shell already is, silently
  // ignoring the command's own cwd.
  assert.equal(
    buildPaneLine(paneCommand(), { focusedPaneCwd: '/Users/cdragon/repo', workspaceCwd: '/Users/cdragon' }),
    "(cd '/Users/cdragon/repo' && echo hello)",
  );
  assert.equal(
    buildPaneLine(paneCommand({ cwd: 'workspace' }), { focusedPaneCwd: '/a', workspaceCwd: '/b' }),
    "(cd '/b' && echo hello)",
  );
});

test('a pane command is typed into the focused pane so its output shows there', async () => {
  const calls = [];
  const result = await executeCommand(paneCommand(), {
    context: { focusedPaneId: 'wC:p7', focusedPaneAgent: null, focusedPaneCwd: '/Users/cdragon/repo' },
    herdrBin: '/opt/homebrew/bin/herdr',
    spawn: () => { throw new Error('a pane command must not spawn'); },
    execFile: async (bin, args) => { calls.push({ bin, args }); return { stdout: '{}', stderr: '' }; },
    sleep: noSleep,
  });
  assert.deepEqual(result, { status: 'sent' });
  assert.deepEqual(calls, [{
    bin: '/opt/homebrew/bin/herdr',
    args: ['pane', 'run', 'wC:p7', "(cd '/Users/cdragon/repo' && echo hello)"],
  }]);
});

test('a pane command keeps shell metacharacters in one argument', async () => {
  let args = null;
  await executeCommand(paneCommand({ command: 'printf "a\\nb\\n" | wc -l' }), {
    context: { focusedPaneId: 'wC:p7', focusedPaneAgent: null, focusedPaneCwd: '/r' },
    spawn: () => {},
    execFile: async (bin, callArgs) => { args = callArgs; return { stdout: '{}' }; },
    sleep: noSleep,
  });
  assert.equal(args.at(-1), "(cd '/r' && printf \"a\\nb\\n\" | wc -l)");
  assert.equal(args.length, 4, 'the line is one argument, not split on spaces');
});

test('a pane command refuses to type into a pane an agent owns', async () => {
  const notes = [];
  await assert.rejects(executeCommand(paneCommand(), {
    context: { focusedPaneId: 'wE:p3', focusedPaneAgent: 'claude' },
    spawn: () => {},
    execFile: async () => { throw new Error('must not be called'); },
    notify: async (title, body) => { notes.push([title, body]); },
    sleep: noSleep,
  }), (error) => {
    assert.ok(error instanceof ExecutionError);
    assert.match(error.message, /claude/u);
    return true;
  });
  assert.equal(notes.length, 1, 'the user is told why nothing happened');
  assert.match(notes[0][1], /claude/u);
});

test('a pane command refuses when there is no pane to type into', async () => {
  await assert.rejects(executeCommand(paneCommand(), {
    context: { focusedPaneId: null, focusedPaneAgent: null },
    spawn: () => {},
    execFile: async () => { throw new Error('must not be called'); },
    sleep: noSleep,
  }), ExecutionError);
});

test('UI_BUSY_CODE is the herdr error code we retry on', () => {
  assert.equal(UI_BUSY_CODE, 'ui_busy');
});

test('buildShellSpawn runs the command through a login shell in the resolved cwd', () => {
  const built = buildShellSpawn(shellCommand(), { cwd: '/Users/cdragon/repo', shell: '/bin/zsh' });
  assert.equal(built.file, '/bin/zsh');
  assert.deepEqual(built.args, ['-lc', 'code .']);
  assert.equal(built.options.cwd, '/Users/cdragon/repo');
  assert.equal(built.options.detached, true);
  assert.equal(built.options.stdio, 'ignore');
  assert.equal(built.options.shell, false);
});

test('buildShellSpawn falls back to /bin/sh', () => {
  assert.equal(buildShellSpawn(shellCommand(), { cwd: '/tmp' }).file, '/bin/sh');
});

test('buildPluginActionArgs produces the herdr 0.7.5 argument order', () => {
  assert.deepEqual(buildPluginActionArgs(actionCommand()), [
    'plugin', 'action', 'invoke', 'open', '--plugin', 'ray.file-explorer',
  ]);
});

test('executeCommand spawns a shell command detached in the focused cwd', async () => {
  const calls = [];
  let unrefs = 0;
  const result = await executeCommand(shellCommand(), {
    context: CONTEXT,
    shell: '/bin/zsh',
    env: { PATH: '/usr/bin' },
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return { unref: () => { unrefs += 1; } };
    },
    execFile: async () => { throw new Error('execFile must not be used for shell commands'); },
    sleep: noSleep,
  });
  assert.deepEqual(result, { status: 'started' });
  assert.equal(calls[0].file, '/bin/zsh');
  assert.deepEqual(calls[0].args, ['-lc', 'code .']);
  assert.equal(calls[0].options.cwd, '/Users/cdragon/repo');
  assert.equal(calls[0].options.detached, true);
  assert.deepEqual(calls[0].options.env, { PATH: '/usr/bin' });
  assert.equal(unrefs, 1);
});

test('executeCommand honours the workspace cwd mode and an explicit path', async () => {
  const seen = [];
  const spawn = (file, args, options) => {
    seen.push(options.cwd);
    return { unref: () => {} };
  };
  await executeCommand(shellCommand({ cwd: 'workspace' }), { context: CONTEXT, spawn, execFile: async () => {}, sleep: noSleep });
  await executeCommand(shellCommand({ cwd: '/tmp/explicit' }), { context: CONTEXT, spawn, execFile: async () => {}, sleep: noSleep });
  assert.deepEqual(seen, ['/Users/cdragon', '/tmp/explicit']);
});

test('executeCommand logs the shell command it started', async () => {
  const events = [];
  await executeCommand(shellCommand(), {
    context: CONTEXT,
    spawn: () => ({ unref: () => {} }),
    execFile: async () => {},
    log: async (event, detail) => { events.push([event, detail]); },
    sleep: noSleep,
  });
  assert.equal(events[0][0], 'shell');
  assert.equal(events[0][1].id, 'open-in-vs-code');
  assert.equal(events[0][1].cwd, '/Users/cdragon/repo');
});

test('executeCommand invokes a plugin action through the herdr CLI', async () => {
  const calls = [];
  const result = await executeCommand(actionCommand(), {
    context: CONTEXT,
    herdrBin: '/opt/homebrew/bin/herdr',
    env: { PATH: '/usr/bin' },
    spawn: () => { throw new Error('spawn must not be used for plugin actions'); },
    execFile: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return { stdout: '{"result":{"type":"plugin_action_invoked"}}', stderr: '' };
    },
    sleep: noSleep,
  });
  assert.deepEqual(result, { status: 'invoked' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/opt/homebrew/bin/herdr');
  assert.deepEqual(calls[0].args, ['plugin', 'action', 'invoke', 'open', '--plugin', 'ray.file-explorer']);
  assert.equal(calls[0].options.shell, false);
});

test('executeCommand retries a plugin action while herdr reports ui_busy', async () => {
  const delays = [];
  let attempts = 0;
  const result = await executeCommand(actionCommand(), {
    context: CONTEXT,
    spawn: () => {},
    execFile: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error('exit 1');
        error.stdout = JSON.stringify({ error: { code: 'ui_busy', message: 'popup is open' } });
        throw error;
      }
      return { stdout: '{}', stderr: '' };
    },
    sleep: async (ms) => { delays.push(ms); },
  });
  assert.deepEqual(result, { status: 'invoked' });
  assert.equal(attempts, 3);
  assert.equal(delays.length, 2);
  assert.ok(delays.every((ms) => ms > 0));
});

test('executeCommand gives up on ui_busy after the attempt budget', async () => {
  let attempts = 0;
  await assert.rejects(
    executeCommand(actionCommand(), {
      context: CONTEXT,
      spawn: () => {},
      execFile: async () => {
        attempts += 1;
        const error = new Error('exit 1');
        error.stdout = JSON.stringify({ error: { code: 'ui_busy' } });
        throw error;
      },
      sleep: noSleep,
      attempts: 4,
    }),
    (error) => {
      assert.ok(error instanceof ExecutionError);
      assert.equal(error.code, UI_BUSY_CODE);
      assert.match(error.message, /ray\.file-explorer\.open/u);
      return true;
    },
  );
  assert.equal(attempts, 4);
});

test('executeCommand does not retry a non-busy failure', async () => {
  let attempts = 0;
  await assert.rejects(
    executeCommand(actionCommand(), {
      context: CONTEXT,
      spawn: () => {},
      execFile: async () => {
        attempts += 1;
        const error = new Error('exit 1');
        error.stdout = JSON.stringify({ error: { code: 'plugin_action_not_found' } });
        throw error;
      },
      sleep: noSleep,
    }),
    (error) => error instanceof ExecutionError && error.code === null,
  );
  assert.equal(attempts, 1);
});

test('executeCommand treats unparseable and oversized CLI output as non-busy', async () => {
  for (const stdout of [undefined, 'not json', 'x'.repeat(20_000)]) {
    let attempts = 0;
    await assert.rejects(
      executeCommand(actionCommand(), {
        context: CONTEXT,
        spawn: () => {},
        execFile: async () => {
          attempts += 1;
          const error = new Error('exit 1');
          error.stdout = stdout;
          throw error;
        },
        sleep: noSleep,
      }),
      ExecutionError,
    );
    assert.equal(attempts, 1);
  }
});

test('executeCommand logs a failed plugin action', async () => {
  const events = [];
  await assert.rejects(executeCommand(actionCommand(), {
    context: CONTEXT,
    spawn: () => {},
    execFile: async () => { throw new Error('down'); },
    log: async (event, detail) => { events.push([event, detail]); },
    sleep: noSleep,
  }), ExecutionError);
  assert.equal(events.at(-1)[0], 'plugin_action_failed');
  assert.equal(events.at(-1)[1].id, 'file-explorer');
});

test('executeCommand rejects an unknown command type', async () => {
  await assert.rejects(
    executeCommand({ ...shellCommand(), type: 'nope' }, {
      context: CONTEXT,
      spawn: () => {},
      execFile: async () => {},
      sleep: noSleep,
    }),
    (error) => error instanceof ExecutionError && /nope/u.test(error.message),
  );
});
