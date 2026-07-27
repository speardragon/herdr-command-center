import { homedir as osHomedir } from 'node:os';
import { isAbsolute } from 'node:path';

const MAX_CONTEXT_BYTES = 64_000;

function usableDir(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!isAbsolute(value) || value.includes('\u0000')) return null;
  return value;
}

function usableId(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\u0000') ? value : null;
}

function parseContextJson(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CONTEXT_BYTES) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

// Cwds and the pane fields are carried. `pane` commands need to know which pane
// to type into, and whether an agent owns it — shell commands only need a
// directory, and `herdr plugin action invoke` resolves the focused pane itself.
export function readContext(env = process.env) {
  const forwarded = parseContextJson(env.COMMAND_CENTER_CONTEXT_JSON);
  const injected = parseContextJson(env.HERDR_PLUGIN_CONTEXT_JSON);
  const source = forwarded ?? injected ?? {};
  return {
    focusedPaneCwd: usableDir(source.focusedPaneCwd)
      ?? usableDir(source.focused_pane_cwd)
      ?? usableDir(env.HERDR_ACTIVE_PANE_CWD),
    workspaceCwd: usableDir(source.workspaceCwd) ?? usableDir(source.workspace_cwd),
    // Carried for `pane` commands: which pane to type into, and whether an agent
    // owns it. HERDR_PANE_ID is deliberately not a fallback — inside the popup
    // that is the popup's own pane.
    focusedPaneId: usableId(source.focusedPaneId)
      ?? usableId(source.focused_pane_id)
      ?? usableId(env.HERDR_ACTIVE_PANE_ID),
    focusedPaneAgent: usableId(source.focusedPaneAgent) ?? usableId(source.focused_pane_agent),
  };
}

export function serializeContext(context) {
  return JSON.stringify({
    focusedPaneCwd: usableDir(context?.focusedPaneCwd),
    workspaceCwd: usableDir(context?.workspaceCwd),
    focusedPaneId: usableId(context?.focusedPaneId),
    focusedPaneAgent: usableId(context?.focusedPaneAgent),
  });
}

export function resolveCwd(command, context, { homedir = osHomedir } = {}) {
  // 'focused' and 'workspace' are not absolute paths, so usableDir rejects them
  // here and the mode branches below decide.
  const explicit = usableDir(command?.cwd);
  if (explicit) return explicit;
  const focused = usableDir(context?.focusedPaneCwd);
  const workspace = usableDir(context?.workspaceCwd);
  if (command?.cwd === 'workspace') return workspace ?? focused ?? homedir();
  return focused ?? workspace ?? homedir();
}
