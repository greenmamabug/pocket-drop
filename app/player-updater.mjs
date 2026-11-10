// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJson } from './atomic-json.mjs';
import { PlayerRunner } from './player-runner.mjs';
import { PLAYER_VERSION } from './player-release.mjs';
import { validateBackupFolder } from './player-backups.mjs';

export class PlayerUpdater {
  constructor({
    library,
    folder,
    runner = new PlayerRunner(),
    pause = async () => {},
    resume = () => {},
    record = () => {},
    preventSleep = () => () => {},
    platform = process.platform,
    arch = process.arch,
  }) {
    Object.assign(this, { library, folder, runner, pause, resume, record, preventSleep, arch });
    this.file = path.join(folder, 'player-update.json');
    this.state = {
      phase: 'idle',
      supported: platform === 'darwin' && ['x64', 'arm64'].includes(arch),
      version: PLAYER_VERSION,
      running: false,
      firmwareDir: null,
    };
  }
  publish(patch = {}) {
    this.state = { ...this.state, ...patch };
    this.library.playerUpdate = this.state;
    this.library.publish();
  }
  async saveJournal() {
    await writeJson(this.file, this.journal);
    // Flush the recovery marker before a helper can write to the player.
    for (const target of [this.file, path.dirname(this.file)]) {
      const handle = await fs.open(target, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (
        !path.isAbsolute(saved.firmwareDir) ||
        saved.version !== PLAYER_VERSION ||
        !/^[0-9a-f]{32}$/.test(saved.unitId) ||
        !/^[0-9a-f]{64}$/.test(saved.imageSha256)
      )
        throw new Error('The saved player update is not recognized.');
      this.journal = saved;
      this.publish({
        firmwareDir: saved.firmwareDir,
        phase: saved.completed ? 'complete' : 'resume',
        pendingWrite: !!saved.pendingWrite,
        label: saved.completed
          ? 'Player update verified'
          : saved.pendingWrite
            ? 'The previous update did not finish verification. Review and retry the prepared update.'
            : 'A prepared update is saved. Review it to continue.',
      });
    } catch (error) {
      if (error.code !== 'ENOENT') this.publish({ error: error.message });
    }
    this.publish();
    return this;
  }
  assertIdle() {
    if (!this.state.supported)
      throw new Error('Player software updates are available in the Mac app.');
    if (
      this.state.running ||
      this.library.busy ||
      this.library.compositeSync ||
      this.library.preparation?.running
    )
      throw new Error('Finish the current operation before updating player software.');
  }
  async chooseFolder(folder) {
    return this.run('folder', async () => {
      if (this.journal?.pendingWrite)
        throw new Error('Retry the pending update before changing its backup folder.');
      const real = await validateBackupFolder(folder);
      if (
        real === '/' ||
        real === '/Volumes' ||
        real.startsWith('/Volumes/') ||
        real === this.library.inbox ||
        real.startsWith(this.library.inbox + path.sep)
      )
        throw new Error(
          'Choose a backup folder on your Mac, outside the Inbox and player storage.',
        );
      const stat = await fs.stat(real);
      if (!stat.isDirectory()) throw new Error('Choose a folder for player backups.');
      await fs.writeFile(
        path.join(real, '.pocket-drop-backups.json'),
        '{"format":"pocket-drop-player-backups","version":1}\n',
        { mode: 0o600 },
      );
      // Clear a previously prepared selection before switching to another player's backup.
      await fs.rm(this.file, { force: true });
      this.journal = null;
      this.token = null;
      let hasSavedUpdate = false;
      try {
        const unit = (await fs.readFile(path.join(real, 'current-unit'), 'utf8')).trim();
        if (/^[0-9a-f]{32}$/.test(unit))
          hasSavedUpdate = (
            await fs.stat(path.join(real, 'units', unit, 'upgrade', 'out', 'build-report.json'))
          ).isFile();
      } catch {}
      this.publish({
        firmwareDir: real,
        phase: 'idle',
        label: 'Backup folder selected. Download the update files or start the backup when ready.',
        summary: null,
        token: null,
        error: null,
        pendingWrite: false,
        hasSavedUpdate,
      });
    });
  }
  async run(action, work) {
    this.assertIdle();
    this.cancelRequested = false;
    this.token = null;
    this.library.busy = true;
    this.library.operation = 'player-update';
    this.publish({
      running: true,
      action,
      error: null,
      token: null,
      percent: null,
      startedAt: Date.now(),
      label: 'Starting player operation…',
    });
    let releaseSleep = () => {};
    try {
      releaseSleep = this.preventSleep();
      await this.pause();
      await this.library.stopScan();
      return await work();
    } catch (error) {
      this.record('player-update-error', error);
      this.publish({
        phase: this.journal && !this.journal.completed ? 'resume' : 'error',
        error: error.message,
        pendingWrite: !!this.journal?.pendingWrite,
        token: null,
      });
      throw error;
    } finally {
      try {
        releaseSleep();
      } catch (error) {
        this.record('player-sleep-cleanup', error);
      }
      this.library.busy = false;
      this.library.operation = null;
      this.publish({ running: false });
      this.resume();
    }
  }
  job(action, extra = {}) {
    if (this.cancelRequested) throw new Error('Player operation cancelled. Nothing was written.');
    return this.runner.run(
      {
        action,
        cache: path.join(this.folder, 'player-downloads'),
        arch: this.arch,
        firmwareDir: this.state.firmwareDir,
        ...extra,
      },
      (event) => {
        if (event.line) this.record('player-tool', event.line);
        if (event.label)
          this.publish({ label: event.label, percent: event.percent, lastProgressAt: Date.now() });
      },
    );
  }
  download() {
    return this.run('download', async () => {
      await this.job('download');
      this.publish({
        phase: this.journal && !this.journal.completed ? 'resume' : 'downloaded',
        filesReady: true,
        label: 'Official update files verified',
        percent: 100,
      });
    });
  }
  prepare() {
    return this.run('prepare', async () => {
      if (!this.state.firmwareDir) throw new Error('Choose a backup folder first.');
      if (this.journal?.pendingWrite)
        throw new Error('Retry the pending update before reading another player.');
      if ((await this.library.device.connectionStatus()).connected)
        throw new Error('Eject Pocket first, then power it off with the data cable connected.');
      this.token = null;
      // An old prepared selection must not remain armed if this read/prepare fails.
      await fs.rm(this.file, { force: true });
      this.journal = null;
      this.publish({ phase: 'preparing', token: null, summary: null });
      const summary = await this.job('prepare');
      if (summary.current) {
        this.publish({
          phase: 'current',
          label: 'This player already runs Studio Pocket ' + PLAYER_VERSION,
          percent: 100,
        });
        return;
      }
      this.journal = {
        ...summary,
        firmwareDir: this.state.firmwareDir,
        pendingWrite: false,
        completed: false,
      };
      await this.saveJournal();
      this.reviewed(summary);
    });
  }
  reviewed(summary) {
    this.token = randomUUID();
    this.publish({
      phase: 'prepared',
      summary,
      token: this.token,
      label: 'Backup saved and update prepared. Nothing has been written to the player.',
      percent: 100,
    });
  }
  review() {
    return this.run('review', async () => {
      if ((!this.journal || this.journal.completed) && !this.state.hasSavedUpdate)
        throw new Error('Read and prepare an update first.');
      this.token = null;
      this.publish({ token: null });
      const summary = await this.job('review', {
        unitId: this.journal?.unitId,
        expected: this.journal,
      });
      this.journal = {
        ...this.journal,
        ...summary,
        firmwareDir: this.state.firmwareDir,
        pendingWrite: !!this.journal?.pendingWrite,
        completed: false,
      };
      await this.saveJournal();
      this.reviewed(summary);
    });
  }
  write(confirmation, token) {
    this.assertIdle();
    if (
      confirmation !== 'WRITE' ||
      !this.token ||
      token !== this.token ||
      this.state.phase !== 'prepared'
    )
      throw new Error('Review the update, then type WRITE to confirm.');
    this.token = null;
    return this.run('write', async () => {
      const expected = { ...this.journal };
      this.journal = { ...expected, pendingWrite: true };
      await this.saveJournal(); // Recovery marker flushed BEFORE any write.
      this.publish({
        phase: 'writing',
        pendingWrite: true,
        token: null,
        label: 'Starting update — do not unplug',
      });
      const result = await this.job('write', { unitId: expected.unitId, expected, confirmation });
      if (!result.verified)
        throw new Error('The player update was not verified. Retry the prepared update.');
      this.journal = { ...this.journal, pendingWrite: false, completed: true };
      await this.saveJournal();
      this.publish({
        phase: 'complete',
        pendingWrite: false,
        label: 'Player update verified. Unplug the cable and turn the player on.',
        percent: 100,
      });
      await this.library.log(
        'Studio Pocket ' + PLAYER_VERSION + ' player update verified.',
        'success',
      );
    });
  }
  cancel() {
    if (this.state.running && this.state.action === 'write')
      throw new Error('Wait for the player write to finish verification. Do not unplug.');
    this.cancelRequested = true;
    this.runner.cancel();
  }
}
