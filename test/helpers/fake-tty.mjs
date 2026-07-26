// Minimal stand-ins for a raw-mode TTY pair, so the popup loop can be driven
// key-by-key from a test without a real terminal.

export function createFakeStdin(chunks = [], { endAfterQueue = true } = {}) {
  const queue = [...chunks];
  const listeners = new Map();
  let finished = false;
  let pending = null;

  const settle = (result) => {
    const resolve = pending;
    pending = null;
    resolve(result);
  };

  return {
    isTTY: true,
    rawModeHistory: [],
    destroyed: false,
    setRawMode(value) {
      this.rawModeHistory.push(value);
      return this;
    },
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    removeListener(event) {
      listeners.delete(event);
      return this;
    },
    emit(event, payload) {
      listeners.get(event)?.(payload);
    },
    destroy() {
      this.destroyed = true;
      finished = true;
      if (pending) settle({ value: undefined, done: true });
    },
    push(chunk) {
      if (pending) settle({ value: Buffer.from(chunk), done: false });
      else queue.push(chunk);
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (queue.length > 0) {
            return Promise.resolve({ value: Buffer.from(queue.shift()), done: false });
          }
          if (finished || endAfterQueue) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { pending = resolve; });
        },
        return: () => {
          finished = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

export function createFakeStdout({ columns = 78, rows = 24 } = {}) {
  const frames = [];
  return {
    isTTY: true,
    columns,
    rows,
    frames,
    write(text, callback) {
      frames.push(String(text));
      if (typeof callback === 'function') callback(null);
      return true;
    },
    on() { return this; },
    removeListener() { return this; },
    // The popup also writes cursor bookkeeping that paints nothing, so tests that
    // care about what the user sees want the last frame, not the last write.
    get renderedFrames() { return frames.filter((frame) => frame.includes('\u001b[2J')); },
    get lastFrame() { return this.renderedFrames.at(-1) ?? ''; },
  };
}

export function createFakeStderr() {
  const lines = [];
  return {
    lines,
    write(text) { lines.push(String(text)); return true; },
    on() { return this; },
    removeListener() { return this; },
  };
}

export function createFakeProcess(pid = 4242) {
  const handlers = [];
  return {
    pid,
    handlers,
    once(event, handler) { handlers.push([event, handler]); return this; },
    on(event, handler) { handlers.push([event, handler]); return this; },
    removeListener(event, handler) {
      const index = handlers.findIndex(([name, fn]) => name === event && fn === handler);
      if (index >= 0) handlers.splice(index, 1);
      return this;
    },
    fire(event) {
      for (const [name, handler] of [...handlers]) if (name === event) handler();
    },
  };
}
