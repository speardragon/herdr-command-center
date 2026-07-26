import assert from 'node:assert/strict';
import { access, constants, readFile } from 'node:fs/promises';
import test from 'node:test';

import { CONFIG_FILE_NAME, PLUGIN_ID, POPUP_ENTRYPOINT_ID } from '../src/plugin.mjs';

const manifestUrl = new URL('../herdr-plugin.toml', import.meta.url);

test('manifest identity matches the shared plugin constants', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  assert.match(text, new RegExp(`^id = "${PLUGIN_ID}"$`, 'mu'));
  assert.match(text, new RegExp(`^id = "${POPUP_ENTRYPOINT_ID}"$`, 'mu'));
  assert.match(text, /^min_herdr_version = "0\.7\.5"$/mu);
  assert.match(text, /^platforms = \["macos", "linux"\]$/mu);
  assert.equal(CONFIG_FILE_NAME, 'commands.json');
});

test('manifest declares a popup pane with an explicit size', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  assert.match(text, /^placement = "popup"$/mu);
  assert.match(text, /^width = \d+$/mu);
  assert.match(text, /^height = \d+$/mu);
});

test('manifest entrypoints exist and are plain node invocations', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  for (const file of ['bin/open.mjs', 'bin/popup.mjs', 'bin/edit-config.mjs']) {
    assert.match(text, new RegExp(`command = \\["node", "${file.replace('.', '\\.')}"\\]`));
    await access(new URL(`../${file}`, import.meta.url), constants.R_OK);
  }
  // bin/run.mjs is spawned by the popup, not by herdr, so it is intentionally
  // absent from the manifest — but it must still exist.
  await access(new URL('../bin/run.mjs', import.meta.url), constants.R_OK);
  assert.doesNotMatch(text, /\["bash", "-c"/);
});

test('manifest declares both operator actions', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  for (const action of ['open', 'edit-config']) {
    assert.match(text, new RegExp(`^id = "${action}"$`, 'mu'));
  }
});

test('manifest build pipeline checks Node and runs the tests', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  assert.match(text, /Node\.js >= 22 required/);
  assert.match(text, /command = \["npm", "test"\]/);
});
