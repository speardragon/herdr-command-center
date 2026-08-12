import { readFile as readFileAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { PLUGIN_ID } from './plugin.mjs';

const MAX_LABEL_LENGTH = 80;

// herdr keeps a merged registry of every installed plugin's manifest at
// ~/.config/herdr/plugins.json, refreshed on install/enable/disable. Reading
// it directly is what lets the import list offer actions nobody has ever
// bound to a key — parsing each plugin's herdr-plugin.toml by hand would mean
// re-deriving what herdr already resolved.
export function pluginsJsonPath(env = process.env) {
  const configured = env.HERDR_PLUGINS_JSON_PATH;
  if (typeof configured === 'string' && configured.length > 0 && isAbsolute(configured)) {
    return configured;
  }
  return join(env.HOME || homedir(), '.config', 'herdr', 'plugins.json');
}

function actionEntry(pluginId, action) {
  const title = typeof action.title === 'string' ? action.title.trim() : '';
  const command = `${pluginId}.${action.id}`;
  return {
    kind: 'command',
    key: action.id,
    label: (title.length > 0 ? title : command).slice(0, MAX_LABEL_LENGTH),
    type: 'plugin_action',
    command,
    description: '',
    reason: null,
  };
}

// Every enabled plugin but this one, as a browsable group of its actions.
// Disabled plugins are dropped because their actions cannot actually be
// invoked, and this plugin's own actions would just be a command whose only
// effect is to reopen the popup you are standing in.
export function installedPluginGroups(text) {
  let plugins;
  try {
    plugins = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(plugins)) return [];
  const groups = [];
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== 'object' || plugin.enabled !== true) continue;
    const pluginId = typeof plugin.plugin_id === 'string' ? plugin.plugin_id : '';
    if (pluginId.length === 0 || pluginId === PLUGIN_ID) continue;
    const actions = (Array.isArray(plugin.actions) ? plugin.actions : [])
      .filter((action) => action && typeof action.id === 'string' && action.id.length > 0)
      .map((action) => actionEntry(pluginId, action));
    if (actions.length === 0) continue;
    const pluginName = typeof plugin.name === 'string' && plugin.name.trim().length > 0
      ? plugin.name.trim()
      : pluginId;
    groups.push({
      kind: 'group',
      key: pluginId,
      label: `${pluginName} (${actions.length} action${actions.length === 1 ? '' : 's'})`.slice(0, MAX_LABEL_LENGTH),
      pluginName,
      reason: null,
      actions,
    });
  }
  return groups;
}

export async function readInstalledPluginGroups(path, { readFile = readFileAsync } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  return installedPluginGroups(text);
}
