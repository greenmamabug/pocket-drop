// SPDX-License-Identifier: GPL-3.0-only
export function installPlayerConnectionGuide() {
  const $ = (id) => document.getElementById(id),
    dialog = $('player-connection-guide');
  let seen = '',
    active = '',
    timer;
  const dismiss = () => {
    seen = active;
    clearTimeout(timer);
    dialog.close();
  };
  $('player-guide-background').onclick = dismiss;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismiss();
  });
  function show(p) {
    if (!p?.running) return;
    active = `${p.startedAt}:${p.connectionAttempt ?? 0}`;
    clearTimeout(timer);
    dialog.classList.remove('detected');
    $('player-guide-title').textContent = 'Waiting for your player';
    $('player-guide-status').textContent = p.connectionMissed
      ? 'The player was seen but the connection was missed. Press the reset pinhole again.'
      : 'Keep the USB data cable connected. Power the player off, then gently press its reset pinhole with a straightened paper clip.';
    $('player-guide-diagram').hidden = false;
    $('player-guide-success').hidden = true;
    if (!dialog.open) dialog.showModal();
  }
  return {
    show,
    render(p) {
      if (!p?.running) {
        clearTimeout(timer);
        if (dialog.open) dialog.close();
        return;
      }
      const attempt = `${p.startedAt}:${p.connectionAttempt ?? 0}`;
      if (p.connectionPhase === 'waiting') {
        if (active !== attempt || (!dialog.open && seen !== attempt)) show(p);
        if (dialog.open && p.connectionMissed)
          $('player-guide-status').textContent =
            'The connection was missed. Keep the cable connected and press the reset pinhole again.';
      } else if (
        dialog.open &&
        ['handshake', 'da', 'read', 'write'].includes(p.connectionPhase) &&
        !dialog.classList.contains('detected')
      ) {
        dialog.classList.add('detected');
        $('player-guide-title').textContent = 'Player detected';
        $('player-guide-status').textContent =
          'Connection detected. Pocket Drop is continuing the update steps.';
        $('player-guide-diagram').hidden = true;
        $('player-guide-success').hidden = false;
        seen = attempt;
        timer = setTimeout(() => dialog.close(), 1600);
      }
    },
  };
}
