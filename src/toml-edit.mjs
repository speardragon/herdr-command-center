import { normalizeConfig } from './schema.mjs';
import { parseConfigToml, renderCommandBlock } from './toml-config.mjs';

// Only a bare, unindented header starts a block. `# [[commands]]` and any
// indented variant stay in opaque text, which is what lets a user comment a
// command out and have it survive every popup save.
const HEADER = /^\[\[commands\]\][ \t]*$/;
// Every field a command has. Omitting one would make a change to it look like
// no change at all, and the old block text would be reused verbatim.
const COMPARED_KEYS = Object.freeze(['id', 'slot', 'label', 'type', 'command', 'cwd', 'description']);

function isBlankOrComment(line) {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith('#');
}

// Trailing blank/comment lines belong to whatever comes next, not to the block
// above them — otherwise deleting the last command would take the user's
// commented-out block with it.
function peelTrailer(lines) {
  let end = lines.length;
  while (end > 1 && isBlankOrComment(lines[end - 1])) end -= 1;
  return { body: lines.slice(0, end), trailer: lines.slice(end) };
}

export function splitDocument(text) {
  const lines = String(text).split('\n');
  const segments = [];
  let pending = [];
  let block = null;
  const flushPending = () => {
    if (pending.length === 0) return;
    segments.push({ kind: 'opaque', text: pending.join('\n') });
    pending = [];
  };
  const flushBlock = () => {
    if (block === null) return;
    const { body, trailer } = peelTrailer(block);
    segments.push({ kind: 'command', text: body.join('\n') });
    block = null;
    pending = trailer;
  };
  for (const line of lines) {
    if (HEADER.test(line)) {
      flushBlock();
      flushPending();
      block = [line];
      continue;
    }
    if (block === null) pending.push(line);
    else block.push(line);
  }
  flushBlock();
  flushPending();
  return segments;
}

export function joinDocument(segments) {
  return segments.map((segment) => segment.text).join('\n');
}

function sameCommand(left, right) {
  if (!left || !right) return false;
  return COMPARED_KEYS.every((key) => left[key] === right[key]);
}

export function applyCommands(text, commands) {
  const segments = splitDocument(text);
  const slots = segments.filter((segment) => segment.kind === 'command');

  // Normalize the whole original document once, so each block's identity is
  // derived exactly the way the loader derived it, and slot N corresponds to
  // previous[N]. Reading the raw `id` key out of each block instead would fail
  // for every hand-written block that omits it — which is most of them — and
  // would silently reformat the user's file on the next save.
  let previous = [];
  try {
    previous = normalizeConfig(parseConfigToml(text)).commands;
  } catch {
    previous = [];
  }

  // Reuse the block a command already occupied so an untouched command keeps its
  // original text, and an edited one is rewritten in place.
  const claimed = new Set();
  const rendered = commands.map((command) => {
    const position = previous.findIndex((entry, index) => (
      !claimed.has(index) && index < slots.length && entry.id === command.id
    ));
    if (position < 0) return renderCommandBlock(command).replace(/\n$/u, '');
    claimed.add(position);
    return sameCommand(previous[position], command)
      ? slots[position].text
      : renderCommandBlock(command).replace(/\n$/u, '');
  });

  // Walk the original document, feeding the new blocks into the slots the old
  // ones occupied. Opaque segments are copied untouched, in place.
  const output = [];
  let next = 0;
  for (const segment of segments) {
    if (segment.kind === 'opaque') {
      output.push(segment);
      continue;
    }
    if (next < rendered.length) {
      output.push({ kind: 'command', text: rendered[next] });
      next += 1;
    }
    // Otherwise this slot's command was deleted: emit nothing.
  }
  // Anything left over is new; append it after a blank line. Segments join with
  // "\n", so an empty opaque segment is exactly one blank line — and when the
  // document already ends in one, no separator is needed.
  while (next < rendered.length) {
    if (output.length > 0 && !joinDocument(output).endsWith('\n')) {
      output.push({ kind: 'opaque', text: '' });
    }
    output.push({ kind: 'command', text: rendered[next] });
    next += 1;
  }
  const joined = joinDocument(output);
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}
