// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
import { PlayerUpdater } from './player-updater.mjs';
import { PLAYER_RELEASE } from './player-release.mjs';

export async function installPlayerUpdates({
  app,
  library,
  workspace,
  handle,
  dialog,
  shell,
  win,
  pause,
  resume,
  record,
  powerSaveBlocker,
}) {
  const updater = await new PlayerUpdater({
    library,
    folder: app.getPath('userData'),
    pause,
    resume,
    record,
    preventSleep: () => {
      const id = powerSaveBlocker.start('prevent-app-suspension');
      return () => {
        if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
      };
    },
  }).load();
  handle('playerBackupFolder', async () => {
    updater.assertIdle();
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a player backup folder on your Mac',
      defaultPath: path.join(app.getPath('documents'), 'Pocket Drop Player Backups'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!result.canceled) await updater.chooseFolder(result.filePaths[0]);
  });
  handle('playerDownload', () => updater.download());
  handle('playerPrepare', () => {
    if (workspace.editor.sessions.size || workspace.openingDetails)
      throw new Error('Close audio details before updating player software.');
    return updater.prepare();
  });
  handle('playerReview', () => updater.review());
  handle('playerWrite', (confirmation, token) => updater.write(confirmation, token));
  handle('playerCancel', () => updater.cancel());
  handle('playerRelease', () => shell.openExternal(PLAYER_RELEASE));
  handle('playerBackups', () =>
    updater.state.firmwareDir ? shell.openPath(updater.state.firmwareDir) : undefined,
  );
  return updater;
}
