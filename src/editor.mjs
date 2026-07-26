export function editorSpawn(editor, filePath) {
  if (
    !Array.isArray(editor)
    || editor.length === 0
    || editor.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new TypeError('editor must be a non-empty array of non-empty strings');
  }
  const [file, ...rest] = editor;
  return { file, args: [...rest, filePath] };
}

// Detached and unref'd: the runner exits immediately after launching the editor,
// and VS Code must survive that exit.
export async function openInEditor(filePath, { editor, spawn, env = process.env, log } = {}) {
  const { file, args } = editorSpawn(editor, filePath);
  const child = spawn(file, args, { detached: true, stdio: 'ignore', shell: false, env });
  child?.unref?.();
  if (typeof log === 'function') await log('open-config', { editor: file, path: filePath });
  return { status: 'started' };
}
