// SPDX-License-Identifier: GPL-3.0-only
export function liveWindow(window) {
  return !!window && !window.isDestroyed();
}
export function showWindow(window, { focus = false } = {}) {
  if (!liveWindow(window)) return false;
  window.show();
  if (focus) window.focus();
  return true;
}
export function preventBusyQuit(event, library, window) {
  if (!mustFinishBeforeQuit(library)) return false;
  event.preventDefault();
  showWindow(window);
  return true;
}
export function createQuitCleanup({ close, quit, report = () => {} }) {
  let closing = false,
    closed = false;
  return (event) => {
    if (closed) return false;
    event.preventDefault();
    if (!closing) {
      closing = true;
      Promise.resolve()
        .then(close)
        .catch(report)
        .finally(() => {
          closed = true;
          quit();
        });
    }
    return true;
  };
}

/** Work that must finish/cancel before closing; passive indexing is drained separately. */
export function mustFinishBeforeQuit(library) {
  return !!(library?.busy || library?.compositeSync || library?.preparation?.running);
}
export function shouldHideOnClose(library, { openOnConnect, quitting }) {
  return !!openOnConnect && !quitting && !mustFinishBeforeQuit(library);
}
