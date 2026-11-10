// SPDX-License-Identifier: GPL-3.0-only
import { installPlayerConnectionGuide } from './player-connection.js';
export function installPlayerUpdateUI({ api, guarded, getState }) {
  const $ = (id) => document.getElementById(id);
  const request = (method, ...args) => api.invoke(method, ...args);
  let lastToken;
  const dialog = $('player-update-dialog');
  const connectionGuide = installPlayerConnectionGuide();
  $('player-show-guide').onclick = () => connectionGuide.show(getState().playerUpdate);
  $('view-player-progress').onclick = () => dialog.showModal();
  $('manage-player').onclick = () => dialog.showModal();
  $('player-update-close').onclick = () => dialog.close();
  $('player-choose-backup').onclick = guarded(() => request('playerBackupFolder'));
  $('player-open-backup').onclick = guarded(() => request('playerBackups'));
  $('player-official-release').onclick = guarded(() => request('playerRelease'));
  $('player-get-files').onclick = guarded(() => request('playerDownload'));
  $('player-read').onclick = guarded(() => request('playerPrepare'));
  $('player-reuse-backup').onclick = guarded(() => request('playerReuseBackup'));
  $('player-review').onclick = guarded(() => request('playerReview'));
  $('player-eject').onclick = guarded(() => request('eject'));
  $('player-cancel').onclick = guarded(() => request('playerCancel'));
  $('player-write').onclick = guarded(async () => {
    const token = getState().playerUpdate?.token;
    await request('playerWrite', $('player-confirm-write').value, token);
  });
  $('player-confirm-write').oninput = () => render(getState());
  function render(state) {
    const p = state.playerUpdate;
    $('manage-player').disabled = !p?.supported;
    $('player-card-status').textContent = !p?.supported
      ? 'Player updates are available in the Mac app.'
      : p.running
        ? p.label
        : p.pendingWrite
          ? 'An interrupted player update needs attention.'
          : p.phase === 'complete'
            ? `Studio Pocket ${p.completedVersion ?? p.version} update verified.`
            : `Update an existing Studio Pocket player to version ${p.version}.`;
    $('view-player-progress').hidden = !p?.running && !p?.pendingWrite && p?.phase !== 'prepared';
    $('manage-player').textContent = p?.running
      ? 'View update progress…'
      : p?.pendingWrite || p?.phase === 'prepared' || p?.phase === 'resume'
        ? 'Continue player update…'
        : p?.error
          ? 'Review update error…'
          : 'Update player software…';
    if (!p) return;
    connectionGuide.render(p);
    $('player-detail-lines').textContent = [
      ...(p.details ?? []),
      ...(p.error ? [p.error] : []),
    ].join('\n');
    $('player-operation-details').hidden = !p.details?.length && !p.error;
    $('player-show-guide').hidden = !p.running || p.connectionPhase !== 'waiting';
    if (p.token !== lastToken) {
      $('player-confirm-write').value = '';
      lastToken = p.token;
    }
    const busy = !!state.busy || p.running || state.preparation?.running;
    $('player-backup-path').textContent = p.firmwareDir || 'Choose a folder on your Mac.';
    $('player-choose-backup').disabled = busy || p.pendingWrite;
    $('player-open-backup').hidden = !p.firmwareDir;
    $('player-get-files').disabled = busy || !p.firmwareDir;
    $('player-get-files').textContent = 'Check update files';
    $('player-read').disabled = busy || !p.firmwareDir || p.pendingWrite;
    $('player-reuse-backup').disabled = busy || !p.savedBackupId || p.pendingWrite;
    $('player-reuse-note').textContent = p.savedBackupId
      ? `Saved backup: player …${p.savedBackupId.slice(-8)}. Verified on your Mac before use; the full player read is skipped.`
      : 'Choose the folder containing a complete Pocket Drop player backup to use it again.';
    $('player-backup-step').hidden = p.running && p.action === 'write';
    $('player-prepare-step').hidden = p.running && p.action === 'write';
    $('player-eject').disabled = busy || !state.device.connected;
    $('player-review').hidden = !p.hasSavedUpdate && !['resume', 'prepared'].includes(p.phase);
    $('player-review').disabled = busy;
    $('player-review').textContent = p.pendingWrite
      ? 'Review update to retry'
      : 'Review saved update';
    $('player-cancel').hidden = !p.running || p.action === 'write';
    $('player-progress-section').hidden = !p.label && !p.error && !p.details?.length;
    $('player-update-status').textContent = p.label || 'Ready';
    $('player-update-status').classList.toggle('working', p.running);
    $('player-update-progress').hidden = !p.running && p.phase !== 'complete';
    if (p.percent === null || p.percent === undefined)
      $('player-update-progress').removeAttribute('value');
    else $('player-update-progress').value = p.percent;
    $('player-update-error').hidden = !p.error;
    $('player-update-error').textContent = p.error || '';
    $('player-update-recovery').hidden = !p.pendingWrite;
    $('player-write-section').hidden = p.phase !== 'prepared';
    $('player-confirm-write').disabled = busy;
    $('player-write').disabled = busy || !p.token || $('player-confirm-write').value !== 'WRITE';
    $('player-checklist').replaceChildren(
      ...(p.summary?.checklist ?? []).map((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        return item;
      }),
    );
    $('player-identity').textContent = p.summary
      ? 'Prepared for player …' + p.summary.unitId.slice(-8)
      : '';
    $('player-sleep-note').hidden = !p.running;
    updateElapsed();
  }
  function updateElapsed() {
    const p = getState().playerUpdate;
    if (!p?.startedAt) return;
    const seconds = Math.floor((Date.now() - p.startedAt) / 1000);
    $('player-operation-elapsed').textContent = p.running
      ? `Elapsed ${Math.floor(seconds / 60)}m ${seconds % 60}s · ${p.connectionPhase === 'waiting' ? 'waiting for the USB reader connection' : p.label}`
      : 'Last operation log · retained after closing this window';
  }
  setInterval(updateElapsed, 1000);
  return { render };
}
