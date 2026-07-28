import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// resolveEditors hides a configured editor it cannot find on PATH, so any test
// about picking between candidates needs them to really be there. Real files
// with the executable bit set, because that is what onPath checks for.
export async function fakePath(dir, names) {
  const bin = join(dir, 'fake-bin');
  await mkdir(bin, { recursive: true });
  for (const name of names) {
    const file = join(bin, name);
    await writeFile(file, '#!/bin/sh\n', 'utf8');
    await chmod(file, 0o755);
  }
  return bin;
}
