import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { ConfigError, defaultConfig, normalizeConfig, serializeConfig } from './schema.mjs';

async function readRaw(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ConfigError(`${basename(file)} could not be read (${error?.code ?? 'unknown error'})`);
  }
}

export async function loadStore(file) {
  const raw = await readRaw(file);
  if (raw === null) return { doc: defaultConfig(), raw: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${basename(file)} is not valid JSON`);
  }
  try {
    return { doc: normalizeConfig(parsed), raw };
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new ConfigError(`${basename(file)}: ${error.message}`);
  }
}

export async function saveStore(file, doc, { expectedRaw = null } = {}) {
  const normalized = normalizeConfig(doc);
  const raw = serializeConfig(normalized);
  if (typeof expectedRaw === 'string') {
    const current = await readRaw(file);
    if (current !== null && current !== expectedRaw) {
      throw new ConfigError(
        `${basename(file)} changed on disk since it was loaded; reopen Command Center to pick up the new file`,
      );
    }
  }
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  // Write-then-rename so a crash mid-write can never leave a half-written
  // config that the next popup would refuse to load.
  const temporary = join(directory, `.${basename(file)}.${process.pid}.tmp`);
  await writeFile(temporary, raw, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
  return { raw };
}

export async function ensureStore(file) {
  const loaded = await loadStore(file);
  if (loaded.raw !== null) return { doc: loaded.doc, raw: loaded.raw };
  const saved = await saveStore(file, loaded.doc);
  return { doc: loaded.doc, raw: saved.raw };
}
