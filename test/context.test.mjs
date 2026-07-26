import assert from 'node:assert/strict';
import test from 'node:test';

import { readContext, resolveCwd, serializeContext } from '../src/context.mjs';

const HOME = () => '/Users/cdragon';

test('readContext prefers the forwarded context over the pane context', () => {
  const context = readContext({
    COMMAND_CENTER_CONTEXT_JSON: JSON.stringify({ focusedPaneCwd: '/a', workspaceCwd: '/b' }),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: '/c', workspace_cwd: '/d' }),
  });
  assert.deepEqual(context, { focusedPaneCwd: '/a', workspaceCwd: '/b' });
});

test('readContext reads herdr snake_case fields', () => {
  const context = readContext({
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      focused_pane_cwd: '/Users/cdragon/repo',
      workspace_cwd: '/Users/cdragon',
      focused_pane_id: 'wE:p3',
    }),
  });
  assert.deepEqual(context, { focusedPaneCwd: '/Users/cdragon/repo', workspaceCwd: '/Users/cdragon' });
});

test('readContext falls back to the active pane cwd env', () => {
  const context = readContext({ HERDR_ACTIVE_PANE_CWD: '/Users/cdragon/fallback' });
  assert.deepEqual(context, { focusedPaneCwd: '/Users/cdragon/fallback', workspaceCwd: null });
});

test('readContext tolerates missing, malformed, and non-object JSON', () => {
  for (const env of [
    {},
    { HERDR_PLUGIN_CONTEXT_JSON: 'not json' },
    { HERDR_PLUGIN_CONTEXT_JSON: '[]' },
    { HERDR_PLUGIN_CONTEXT_JSON: 'null' },
    { HERDR_PLUGIN_CONTEXT_JSON: `"${'a'.repeat(200_000)}"` },
  ]) {
    assert.deepEqual(readContext(env), { focusedPaneCwd: null, workspaceCwd: null });
  }
});

test('readContext drops relative and NUL-bearing paths', () => {
  const context = readContext({
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_cwd: 'rel/ative', workspace_cwd: '/ok\u0000' }),
  });
  assert.deepEqual(context, { focusedPaneCwd: null, workspaceCwd: null });
});

test('serializeContext round-trips through readContext', () => {
  const context = { focusedPaneCwd: '/a', workspaceCwd: '/b' };
  assert.deepEqual(readContext({ COMMAND_CENTER_CONTEXT_JSON: serializeContext(context) }), context);
});

test('resolveCwd honours the focused mode', () => {
  const command = { cwd: 'focused' };
  assert.equal(resolveCwd(command, { focusedPaneCwd: '/a', workspaceCwd: '/b' }, { homedir: HOME }), '/a');
  assert.equal(resolveCwd(command, { focusedPaneCwd: null, workspaceCwd: '/b' }, { homedir: HOME }), '/b');
  assert.equal(resolveCwd(command, { focusedPaneCwd: null, workspaceCwd: null }, { homedir: HOME }), '/Users/cdragon');
});

test('resolveCwd honours the workspace mode', () => {
  const command = { cwd: 'workspace' };
  assert.equal(resolveCwd(command, { focusedPaneCwd: '/a', workspaceCwd: '/b' }, { homedir: HOME }), '/b');
  assert.equal(resolveCwd(command, { focusedPaneCwd: '/a', workspaceCwd: null }, { homedir: HOME }), '/a');
});

test('resolveCwd returns an explicit absolute path unchanged', () => {
  assert.equal(
    resolveCwd({ cwd: '/Users/cdragon/notes' }, { focusedPaneCwd: '/a', workspaceCwd: '/b' }, { homedir: HOME }),
    '/Users/cdragon/notes',
  );
});
