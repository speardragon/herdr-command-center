import { appendFile as appendFileAsync, mkdir as mkdirAsync } from 'node:fs/promises';
import { dirname } from 'node:path';

// The runner is detached with no terminal, so this JSONL file is the only place a
// failed command can explain itself. It must never throw: a logging problem must
// not stop the command the user actually asked for.
export function createLogger(logFilePath, {
  appendFile = appendFileAsync,
  mkdir = mkdirAsync,
  now = Date.now,
} = {}) {
  return {
    async write(event, detail = {}) {
      try {
        const line = JSON.stringify({ at: new Date(now()).toISOString(), event, ...detail });
        await mkdir(dirname(logFilePath), { recursive: true });
        await appendFile(logFilePath, `${line}\n`, 'utf8');
      } catch {
        // Intentionally silent.
      }
    },
  };
}
