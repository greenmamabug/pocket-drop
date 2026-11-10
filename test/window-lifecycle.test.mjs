import test from 'node:test';
import assert from 'node:assert/strict';
import { showWindow, preventBusyQuit, createQuitCleanup } from '../app/window-lifecycle.mjs';
test('quit/activation callbacks never access a destroyed Electron window, including busy transfer', () => {
  const window = {
    isDestroyed: () => true,
    show() {
      throw new Error('Object has been destroyed');
    },
    focus() {
      throw new Error('Object has been destroyed');
    },
  };
  assert.equal(showWindow(window, { focus: true }), false);
  let prevented = false;
  assert.equal(
    preventBusyQuit({ preventDefault: () => (prevented = true) }, { busy: true }, window),
    true,
  );
  assert.ok(prevented);
  assert.equal(
    preventBusyQuit(
      {
        preventDefault() {
          throw new Error('Unexpected');
        },
      },
      { busy: false },
      window,
    ),
    false,
  );
  assert.equal(showWindow(null), false);
});
test('quit is prevented between audio and collection stages even after audio copy releases its busy flag', () => {
  let prevented = false,
    shown = false;
  const window = { isDestroyed: () => false, show: () => (shown = true) };
  assert.equal(
    preventBusyQuit(
      { preventDefault: () => (prevented = true) },
      { busy: false, compositeSync: true },
      window,
    ),
    true,
  );
  assert.ok(prevented && shown);
});

test('quit waits for one background cleanup and resumes once without accessing a window', async () => {
  let finish,
    calls = 0,
    quits = 0,
    prevented = 0;
  const gate = new Promise((resolve) => (finish = resolve)),
    cleanup = createQuitCleanup({
      close: async () => {
        calls++;
        await gate;
      },
      quit: () => quits++,
    });
  const event = { preventDefault: () => prevented++ };
  assert.ok(cleanup(event));
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.ok(cleanup(event));
  assert.equal(calls, 1);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quits, 1);
  assert.equal(cleanup(event), false);
  assert.equal(prevented, 2);
});
