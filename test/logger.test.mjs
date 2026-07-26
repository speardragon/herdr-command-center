import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLogger } from '../src/logger.mjs';

test('createLogger appends one JSON line per event and creates the directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-log-'));
  const file = join(dir, 'nested', 'run.log');
  const logger = createLogger(file, { now: () => 1_700_000_000_000 });
  await logger.write('shell', { id: 'open-in-vs-code', cwd: '/tmp' });
  await logger.write('failed', { message: 'nope' });

  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), {
    at: '2023-11-14T22:13:20.000Z',
    event: 'shell',
    id: 'open-in-vs-code',
    cwd: '/tmp',
  });
  assert.equal(JSON.parse(lines[1]).event, 'failed');
});

test('createLogger swallows write failures so logging can never break a run', async () => {
  const logger = createLogger('/tmp/cc-unused.log', {
    mkdir: async () => { throw new Error('read-only'); },
    appendFile: async () => { throw new Error('read-only'); },
  });
  await logger.write('shell', { id: 'x' });
});

test('createLogger tolerates a detail object that cannot be serialized', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-log-'));
  const file = join(dir, 'run.log');
  const logger = createLogger(file);
  const cyclic = {};
  cyclic.self = cyclic;
  await logger.write('shell', { cyclic });
  await logger.write('shell', { id: 'ok' });
  assert.match(await readFile(file, 'utf8'), /"id":"ok"/u);
});
