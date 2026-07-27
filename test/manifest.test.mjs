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
  assert.equal(CONFIG_FILE_NAME, 'commands.toml');
});

test('manifest declares a popup pane with an explicit size', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  assert.match(text, /^placement = "popup"$/mu);
  assert.match(text, /^width = "\d+%"$/mu);
  assert.match(text, /^height = "\d+%"$/mu);
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

test('manifest build pipeline checks Node, installs deps, then runs the tests', async () => {
  const text = await readFile(manifestUrl, 'utf8');
  assert.match(text, /Node\.js >= 22 required/);
  assert.match(text, /command = \["npm", "ci"\]/);
  assert.match(text, /command = \["npm", "test"\]/);
  assert.ok(
    text.indexOf('["npm", "ci"]') < text.indexOf('["npm", "test"]'),
    'npm ci must run before npm test or a fresh install has no dependencies',
  );
});

test('both READMEs document the herdr 0.7.5 action argument order', async () => {
  for (const name of ['README.md', 'README.ko.md']) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    for (const action of ['open', 'edit-config']) {
      assert.match(
        text,
        new RegExp(`herdr plugin action invoke ${action} --plugin ${PLUGIN_ID.replace('.', '\\.')}`),
        `${name} is missing the ${action} invocation`,
      );
    }
  }
});

test('both READMEs document the keybinding that opens the popup', async () => {
  for (const name of ['README.md', 'README.ko.md']) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.match(text, /type = "plugin_action"/u, name);
    assert.match(text, new RegExp(`command = "${PLUGIN_ID.replace('.', '\\.')}\\.open"`), name);
    assert.match(text, /herdr server reload-config/u, name);
  }
});

test('both READMEs state the version floors the manifest enforces', async () => {
  for (const name of ['README.md', 'README.ko.md']) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.match(text, /Node\.js 22\+/u, name);
    assert.match(text, /0\.7\.5\+/u, name);
  }
});

test('both READMEs document every config field and the migration', async () => {
  for (const name of ['README.md', 'README.ko.md']) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    for (const field of ['schema_version', 'editor', 'label', 'plugin_action', 'focused', 'workspace', 'description']) {
      assert.ok(text.includes(field), `${name} does not document ${field}`);
    }
    assert.ok(text.includes('[[commands]]'), `${name} does not show the TOML block shape`);
    assert.ok(text.includes('commands.json.bak'), `${name} does not explain the migration`);
    // One mention is the migration sentence itself; more than that means a stale
    // reference is still lying around in the troubleshooting or actions section.
    const stale = (text.replace(/commands\.json\.bak/gu, '').match(/commands\.json/gu) ?? []).length;
    assert.ok(stale <= 1, `${name} refers to commands.json ${stale} times outside the migration note`);
  }
});

test('every screenshot the READMEs reference exists and is described', async () => {
  const referenced = new Set();
  for (const name of ['README.md', 'README.ko.md']) {
    const text = await readFile(new URL(`../${name}`, import.meta.url), 'utf8');
    const images = [...text.matchAll(/!\[([^\]]*)\]\((docs\/[^)]+\.png)\)/gu)];
    assert.equal(images.length, 3, `${name} references ${images.length} screenshots, expected 3`);
    for (const [, alt, path] of images) {
      // alt text is the only description a screen reader gets
      assert.ok(alt.trim().length > 0, `${name} has an image with no alt text: ${path}`);
      await access(new URL(`../${path}`, import.meta.url), constants.R_OK);
      referenced.add(path);
    }
  }
  // both languages must show the same views, or one reader is shown less
  assert.equal(referenced.size, 3, `READMEs disagree on which screenshots to show: ${[...referenced]}`);
});

test('the screenshots are reproducible rather than hand-taken', async () => {
  await access(new URL('../tools/screenshots.py', import.meta.url), constants.R_OK);
  const tool = await readFile(new URL('../tools/screenshots.py', import.meta.url), 'utf8');
  assert.match(tool, /bin\/popup\.mjs/u, 'the generator must drive the real popup');
  for (const name of ['popup-list', 'popup-form', 'popup-error']) {
    assert.ok(tool.includes(name), `the generator does not produce ${name}`);
  }
});
