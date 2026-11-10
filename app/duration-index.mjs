// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
import { probeDuration } from './audio-probe.mjs';
import { openArchive, fingerprint, inspect } from './archive.mjs';

export { durationFromManifest, preparedDurations, cachedDuration } from './audio-metadata.mjs';

// Quiet, sequential first-time discovery. Refresh and details never wait for it.
export class DurationIndex {
  constructor(
    library,
    catalog,
    { canWork = () => true, probe = probeDuration, delay = 2500 } = {},
  ) {
    this.library = library;
    this.catalog = catalog;
    this.canWork = canWork;
    this.probe = probe;
    this.delay = delay;
    this.failed = new Map();
    this.closed = false;
    this.changed = () => this.schedule();
    library.on('change', this.changed);
  }
  idle() {
    return (
      !this.closed && !this.library.busy && !this.library.preparation?.running && this.canWork()
    );
  }
  candidates() {
    return this.library.rows.filter(
      (row) =>
        row.local &&
        !row.hidden &&
        row.sourceFingerprint &&
        !['error', 'downloading', 'checking'].includes(row.status) &&
        row.durationMs == null &&
        this.failed.get(row.key) !== row.sourceFingerprint,
    );
  }
  schedule() {
    clearTimeout(this.timer);
    if (!this.idle()) {
      this.abort?.abort();
      return;
    }
    if (this.task || this.library.refreshing || this.library.scanning || !this.candidates().length)
      return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const row = this.candidates()[0];
      if (!row || !this.idle()) return;
      const abort = new AbortController();
      this.abort = abort;
      this.task = this.measure(row, abort.signal)
        .catch(() => {
          if (!abort.signal.aborted) this.failed.set(row.key, row.sourceFingerprint);
        })
        .finally(() => {
          this.task = null;
          this.abort = null;
          this.schedule();
        });
    }, this.delay);
    this.timer.unref?.();
  }
  pause() {
    clearTimeout(this.timer);
    this.abort?.abort();
  }
  async measure(row, signal) {
    const source = path.join(this.library.inbox, row.source),
      fp = await fingerprint(source),
      old = this.catalog.get(row.key).durations;
    const check = () => {
      if (signal?.aborted || !this.idle()) throw new Error('Length discovery paused.');
    };
    check();
    const entry = this.library.cache.get(source),
      info = entry?.fp === fp && entry.info ? entry.info : await inspect(source);
    if (!info.audioFiles.length || info.audioFiles.length > 500)
      throw new Error('Cannot measure this track list.');
    const tracks = Object.assign(Object.create(null), old?.fp === fp ? old.tracks : {}),
      archive = await openArchive(source);
    let extracted;
    try {
      extracted = await archive.extract(undefined, { signal });
      check();
      for (const key of info.audioFiles) {
        check();
        if (tracks[key] > 0) continue;
        const value = await this.probe(path.join(extracted.root, key));
        check();
        if (!Number.isFinite(value) || value <= 0)
          throw new Error('An audio duration could not be read.');
        tracks[key] = Math.round(value);
      }
      if ((await fingerprint(source)) !== fp)
        throw new Error('Audio changed during length discovery.');
      check();
      await this.catalog.set(row.key, { durations: { fp, tracks, complete: true } });
      this.library.rows = this.library.rows.map((current) =>
        current.key === row.key && current.sourceFingerprint === fp
          ? this.catalog.decorate(current)
          : current,
      );
      this.library.publish();
    } finally {
      // Preserve completed tracks when foreground work pauses a long book.
      if (
        signal?.aborted &&
        Object.keys(tracks).length &&
        (await fingerprint(source).catch(() => null)) === fp
      )
        await this.catalog
          .set(row.key, { durations: { fp, tracks, complete: false } })
          .catch(() => {});
      archive.close();
      await extracted?.cleanup();
    }
  }
  async close() {
    this.closed = true;
    this.library.off('change', this.changed);
    this.pause();
    await this.task;
  }
}
