#!/usr/bin/env node

// Restores the macOS input source once the popup process dies — by ANY path:
// esc, running a command, herdr killing the pane, Ctrl-C, even SIGKILL. It is
// spawned detached, in its own session, so herdr tearing down the popup's
// process group cannot take the restore down with it.
//
//   node restore-input.mjs <popup-pid> <previous-source-id>

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { restoreAfterExit } from '../src/input-source.mjs';
import { waitForProcessExit } from '../src/wait.mjs';

await restoreAfterExit({
  pid: Number(process.argv[2]),
  previous: process.argv[3],
  execFile: promisify(execFileCallback),
  waitForExit: waitForProcessExit,
});
