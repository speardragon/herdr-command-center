import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { installedPluginGroups, pluginsJsonPath, readInstalledPluginGroups } from '../src/plugin-actions.mjs';

function plugin(overrides = {}) {
  return {
    plugin_id: 'ray.example',
    name: 'Example',
    enabled: true,
    actions: [{ id: 'open', title: 'Open the thing' }],
    ...overrides,
  };
}

test('pluginsJsonPath honours HERDR_PLUGINS_JSON_PATH and otherwise uses the default', () => {
  assert.equal(pluginsJsonPath({ HERDR_PLUGINS_JSON_PATH: '/tmp/plugins.json' }), '/tmp/plugins.json');
  assert.equal(
    pluginsJsonPath({ HOME: '/Users/x' }),
    join('/Users/x', '.config', 'herdr', 'plugins.json'),
  );
});

test('installedPluginGroups turns each enabled plugin into a browsable group', () => {
  const groups = installedPluginGroups(JSON.stringify([plugin()]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'group');
  assert.equal(groups[0].key, 'ray.example');
  assert.equal(groups[0].pluginName, 'Example');
  assert.match(groups[0].label, /Example \(1 action\)/u);
  assert.equal(groups[0].actions.length, 1);
});

test('a group\'s actions are shaped like importable commands, addressed as <plugin>.<action>', () => {
  const [group] = installedPluginGroups(JSON.stringify([plugin({
    actions: [{ id: 'open', title: 'Open the thing' }],
  })]));
  assert.deepEqual(group.actions[0], {
    kind: 'command',
    key: 'open',
    label: 'Open the thing',
    type: 'plugin_action',
    command: 'ray.example.open',
    description: '',
    reason: null,
  });
});

test('a group with several actions pluralizes its count', () => {
  const [group] = installedPluginGroups(JSON.stringify([plugin({
    actions: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
  })]));
  assert.match(group.label, /\(2 actions\)/u);
});

test('a disabled plugin is dropped entirely, since its actions cannot be invoked', () => {
  const groups = installedPluginGroups(JSON.stringify([plugin({ enabled: false })]));
  assert.deepEqual(groups, []);
});

test('this plugin\'s own actions are dropped, since importing them would just reopen this popup', () => {
  const groups = installedPluginGroups(JSON.stringify([plugin({ plugin_id: 'cdragon.command-center' })]));
  assert.deepEqual(groups, []);
});

test('a plugin with no usable actions is dropped rather than shown empty', () => {
  const groups = installedPluginGroups(JSON.stringify([plugin({ actions: [] })]));
  assert.deepEqual(groups, []);
  const malformed = installedPluginGroups(JSON.stringify([plugin({ actions: [{ title: 'no id' }] })]));
  assert.deepEqual(malformed, []);
});

test('a missing name falls back to the plugin id', () => {
  const [group] = installedPluginGroups(JSON.stringify([plugin({ name: undefined })]));
  assert.match(group.label, /^ray\.example /u);
});

test('a missing action title falls back to the <plugin>.<action> command', () => {
  const [group] = installedPluginGroups(JSON.stringify([plugin({
    actions: [{ id: 'open' }],
  })]));
  assert.equal(group.actions[0].label, 'ray.example.open');
});

test('installedPluginGroups tolerates malformed or unexpected JSON', () => {
  assert.deepEqual(installedPluginGroups('not json'), []);
  assert.deepEqual(installedPluginGroups('{}'), []);
  assert.deepEqual(installedPluginGroups('[]'), []);
  assert.deepEqual(installedPluginGroups(JSON.stringify([null, 42, 'nope'])), []);
});

test('readInstalledPluginGroups returns nothing when the registry is missing', async () => {
  const groups = await readInstalledPluginGroups('/nope/plugins.json', {
    readFile: async () => {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.deepEqual(groups, []);
});

test('readInstalledPluginGroups reads and parses a real file', async () => {
  const groups = await readInstalledPluginGroups('/tmp/plugins.json', {
    readFile: async () => JSON.stringify([plugin()]),
  });
  assert.equal(groups.length, 1);
});
