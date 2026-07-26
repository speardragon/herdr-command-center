import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { commandsPath, legacyCommandsPath, resolveConfigDir, resolveStateDir, runLogPath } from '../src/paths.mjs';

test('resolveConfigDir prefers the env herdr injects', async () => {
  const dir = await resolveConfigDir({ HERDR_PLUGIN_CONFIG_DIR: '/tmp/cc-config' }, async () => {
    throw new Error('execFile must not be called');
  });
  assert.equal(dir, '/tmp/cc-config');
});

test('resolveConfigDir asks herdr when the env is absent', async () => {
  const calls = [];
  const dir = await resolveConfigDir({ HERDR_BIN_PATH: '/opt/homebrew/bin/herdr' }, async (bin, args) => {
    calls.push({ bin, args });
    return { stdout: '/tmp/from-cli\n', stderr: '' };
  });
  assert.equal(dir, '/tmp/from-cli');
  assert.deepEqual(calls, [{
    bin: '/opt/homebrew/bin/herdr',
    args: ['plugin', 'config-dir', 'cdragon.command-center'],
  }]);
});

test('resolveConfigDir falls back to the herdr on PATH', async () => {
  let seenBin = null;
  await resolveConfigDir({}, async (bin) => {
    seenBin = bin;
    return { stdout: '/tmp/x', stderr: '' };
  });
  assert.equal(seenBin, 'herdr');
});

test('resolveConfigDir rejects relative, NUL-bearing, and oversized paths', async () => {
  await assert.rejects(resolveConfigDir({ HERDR_PLUGIN_CONFIG_DIR: 'relative' }, async () => {}), /invalid/u);
  await assert.rejects(resolveConfigDir({ HERDR_PLUGIN_CONFIG_DIR: '/a\u0000b' }, async () => {}), /invalid/u);
  await assert.rejects(
    resolveConfigDir({ HERDR_PLUGIN_CONFIG_DIR: `/${'a'.repeat(20_000)}` }, async () => {}),
    /invalid/u,
  );
});

test('resolveConfigDir rejects an unusable CLI answer', async () => {
  await assert.rejects(resolveConfigDir({}, async () => ({ stdout: '   ', stderr: '' })), /could not be resolved/u);
  await assert.rejects(resolveConfigDir({}, async () => { throw new Error('socket down'); }), /could not be resolved/u);
});

test('resolveStateDir prefers HERDR_PLUGIN_STATE_DIR and falls back beside the config', () => {
  assert.equal(resolveStateDir('/tmp/cfg', { HERDR_PLUGIN_STATE_DIR: '/tmp/state' }), '/tmp/state');
  assert.equal(resolveStateDir('/tmp/cfg', {}), join('/tmp/cfg', 'state'));
  assert.equal(resolveStateDir('/tmp/cfg', { HERDR_PLUGIN_STATE_DIR: 'relative' }), join('/tmp/cfg', 'state'));
});

test('path helpers append the known file names', () => {
  assert.equal(commandsPath('/tmp/cfg'), join('/tmp/cfg', 'commands.toml'));
  assert.equal(runLogPath('/tmp/state'), join('/tmp/state', 'run.log'));
});

test('legacyCommandsPath points at the pre-TOML file name', () => {
  assert.equal(legacyCommandsPath('/tmp/cfg'), join('/tmp/cfg', 'commands.json'));
  assert.equal(commandsPath('/tmp/cfg'), join('/tmp/cfg', 'commands.toml'));
});
