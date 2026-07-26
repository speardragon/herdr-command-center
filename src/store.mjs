import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { LEGACY_CONFIG_FILE_NAME } from './plugin.mjs';
import { ConfigError, defaultConfig, normalizeConfig } from './schema.mjs';
import { parseConfigToml, renderConfigToml } from './toml-config.mjs';
import { applyCommands } from './toml-edit.mjs';

async function readRaw(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ConfigError(`${basename(file)} could not be read (${error?.code ?? 'unknown error'})`);
  }
}

function normalizeNamed(parsed, file) {
  try {
    return normalizeConfig(parsed);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new ConfigError(`${basename(file)}: ${error.message}`);
  }
}

export async function loadStore(file) {
  const raw = await readRaw(file);
  if (raw === null) return { doc: defaultConfig(), raw: null };
  return { doc: normalizeNamed(parseConfigToml(raw, basename(file)), file), raw };
}

async function writeAtomic(file, raw) {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  // Write-then-rename so a crash mid-write can never leave a half-written config
  // that the next popup would refuse to load.
  const temporary = join(directory, `.${basename(file)}.${process.pid}.tmp`);
  await writeFile(temporary, raw, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}

export async function saveStore(file, doc, { expectedRaw = null } = {}) {
  const normalized = normalizeConfig(doc);
  if (typeof expectedRaw === 'string') {
    const current = await readRaw(file);
    if (current !== null && current !== expectedRaw) {
      throw new ConfigError(
        `${basename(file)} changed on disk since it was loaded; reopen Command Center to pick up the new file`,
      );
    }
  }
  // Splice individual [[commands]] blocks into the text we loaded so the user's
  // comments, ordering and spacing survive. Only fall back to a whole-file
  // render when there is no prior text, or when something outside the command
  // blocks changed and a splice could not express it.
  let raw;
  if (typeof expectedRaw === 'string') {
    let previousEditor = null;
    try {
      previousEditor = normalizeConfig(parseConfigToml(expectedRaw, basename(file))).editor;
    } catch {
      previousEditor = null;
    }
    const editorUnchanged = Array.isArray(previousEditor)
      && previousEditor.length === normalized.editor.length
      && previousEditor.every((entry, index) => entry === normalized.editor[index]);
    raw = editorUnchanged
      ? applyCommands(expectedRaw, normalized.commands)
      : renderConfigToml(normalized);
  } else {
    raw = renderConfigToml(normalized);
  }
  await writeAtomic(file, raw);
  return { raw };
}

// Tasks 1-12 shipped commands.json. Convert it once, and rename rather than
// delete it: this is a file the user may have hand-written.
async function migrateLegacy(file) {
  const legacy = join(dirname(file), LEGACY_CONFIG_FILE_NAME);
  const raw = await readRaw(legacy).catch(() => null);
  if (raw === null) return null;
  let doc;
  try {
    doc = normalizeConfig(JSON.parse(raw));
  } catch {
    return null;
  }
  await writeAtomic(file, renderConfigToml(doc));
  await rename(legacy, `${legacy}.bak`).catch(() => {});
  return doc;
}

export async function ensureStore(file) {
  const loaded = await loadStore(file);
  if (loaded.raw !== null) return { doc: loaded.doc, raw: loaded.raw };
  const migrated = await migrateLegacy(file);
  if (migrated) {
    const raw = await readRaw(file);
    return { doc: migrated, raw: raw ?? renderConfigToml(migrated) };
  }
  const saved = await saveStore(file, loaded.doc);
  return { doc: loaded.doc, raw: saved.raw };
}
