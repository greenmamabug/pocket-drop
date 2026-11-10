// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { collectionsPending, collectionRevision } from './collection-state.mjs';
import { preparedDurations } from './audio-metadata.mjs';
import { DurationIndex } from './duration-index.mjs';
import { FileEstimate } from './progress-estimate.mjs';
import { Editor, trackDocument } from './editor.mjs';
import { fingerprint, prepare, contentKey } from './archive.mjs';
import { revision } from './catalog.mjs';
import { describeProblem } from './problems.mjs';

export class Workspace {
  constructor(
    library,
    catalog,
    { renderCover = async (ref) => this.editor.asset(ref), notify = () => {} } = {},
  ) {
    this.library = library;
    this.catalog = catalog;
    this.editor = new Editor(catalog);
    this.renderCover = renderCover;
    this.notify = notify;
    library.transformPrepared = (prepared, row) => this.apply(prepared, row);
    library.on('change', () => {
      if (!this.publishingDuplicates) this.scheduleDuplicates();
    });
    this.durations = new DurationIndex(library, catalog, {
      canWork: () =>
        !this.preparingTask &&
        !this.syncingCollections &&
        !this.duplicateTask &&
        !this.openingDetails &&
        !this.editor.sessions.size,
    });
  }
  row(key) {
    const row = this.library.rows.find((r) => r.key === key);
    if (!row)
      throw new Error('This audio item is no longer in the library. Refresh and try again.');
    return row;
  }
  source(row) {
    if (!row.local)
      throw new Error('Add the original to your Inbox to edit or prepare this audio item.');
    return path.join(this.library.inbox, row.source);
  }
  async apply(prepared, row) {
    const edits = this.catalog.get(row.key).edits;
    if (!edits) return;
    const tracks = edits.tracks.filter((t) => !t.excluded);
    if (tracks.length !== prepared.playlist.tracks.length)
      throw new Error('Track edits do not match the source files. Reopen Audio details.');
    prepared.playlist.manifest.title = edits.title;
    for (let i = 0; i < tracks.length; i++) {
      const track = prepared.playlist.tracks[i];
      track.entry.title = tracks[i].title;
      if (tracks[i].iconKey?.startsWith('asset:')) {
        track.iconPath = this.editor.asset(tracks[i].iconKey);
        track.entry.icon = `icons/${track.entry.id}.png`;
      }
      if (!tracks[i].iconKey) {
        delete track.iconPath;
        delete track.entry.icon;
      }
    }
    prepared.playlist.manifest.tracks = prepared.playlist.tracks.map((t) => t.entry);
    if (edits.coverRef) {
      prepared.playlist.coverPath = await this.renderCover(edits.coverRef, edits);
      prepared.playlist.manifest.cover = 'cover.png';
    }
  }
  async open(key) {
    if (this.closed) throw new Error('Pocket Drop is closing.');
    if (this.openingDetails) throw new Error('Audio details are already opening.');
    if (this.library.busy || this.syncingCollections)
      throw new Error('Wait for the current device operation.');
    this.openingDetails = true;
    this.durations.pause();
    try {
      const row = this.row(key);
      return await this.editor.open(
        row,
        this.source(row),
        (() => {
          const entry = this.library.cache.get(this.source(row));
          return entry?.info ? { ...entry.info, sourceFingerprint: entry.fp } : null;
        })(),
        this.library.cache.get(this.source(row))?.manifest,
      );
    } finally {
      this.openingDetails = false;
      this.durations.schedule();
    }
  }
  async save(id, input) {
    if (this.closed) throw new Error('Pocket Drop is closing.');
    if (this.library.busy || this.preparingTask || this.syncingCollections)
      throw new Error('Finish or cancel the current operation before saving edits.');
    const result = await this.editor.save(id, input);
    const session = this.editor.session(id);
    if (!result.coverRef) await this.catalog.set(session.rowKey, { coverData: null });
    const cached = this.library.cache.get(session.source);
    if (cached) {
      delete cached.row.content;
      delete cached.row.preparedBytes;
      delete cached.manifest;
    }
    await this.library.scan(true);
    return result;
  }
  requireNoPreparation() {
    if (this.closed) throw new Error('Pocket Drop is closing.');
    if (this.syncingCollections) throw new Error('Wait for the current sync to finish.');
    if (this.preparingTask) throw new Error('Finish or cancel audio preparation before syncing.');
  }
  async prepareAudio(keys) {
    this.requireNoPreparation();
    if (this.library.busy || this.library.scanning)
      throw new Error('Wait for the current operation to finish.');
    if (!Array.isArray(keys) || !keys.length || keys.length > 500)
      throw new Error('Choose audio to prepare.');
    const rows = keys.map((k) => this.row(k));
    rows.forEach((r) => this.source(r));
    const startedAt = Date.now(),
      estimate = new FileEstimate(
        rows.reduce(
          (n, r) =>
            n +
            (this.catalog
              .get(r.key)
              .edits?.tracks.filter((t) => !t.excluded && /\.(opus|ogg)$/i.test(t.key)).length ??
              r.opusCount ??
              0),
          0,
        ),
      );
    let cancelled = false;
    const abort = new AbortController();
    this.cancelPreparation = () => {
      cancelled = true;
      abort.abort();
    };
    const progress = (value) => {
      this.library.preparation = {
        ...this.library.preparation,
        ...value,
        startedAt,
        elapsedMs: Date.now() - startedAt,
      };
      this.library.preparation.estimateAt = estimate.estimateAt;
      this.library.preparation.remainingMs = estimate.estimateAt
        ? Math.max(0, estimate.estimateAt - Date.now())
        : null;
      if (value.running !== undefined) this.library.publish();
      else this.library.publishProgress();
    };
    progress({ running: true, phase: 'Preparing audio', percent: 0, items: rows.length });
    const task = (async () => {
      await this.editor.closeAll();
      for (let i = 0; i < rows.length; i++) {
        if (cancelled) throw new Error('Audio preparation cancelled.');
        const row = rows[i],
          source = this.source(row),
          fp = await fingerprint(source),
          saved = this.catalog.get(row.key),
          editRevision = revision(saved.edits);
        progress({ phase: 'Preparing ' + row.title, percent: Math.round((i / rows.length) * 100) });
        const p = await prepare(source, {
          ...this.library.conversionOptions,
          convertOpus: this.library.convertOpus,
          conversionCache: this.library.conversionCache,
          editPlan: saved.edits,
          signal: abort.signal,
          cancelled: () => cancelled,
          onConversion: (e) => {
            estimate.update(row.key + ':' + e.index, e.phase);
            progress({
              phase:
                e.phase === 'Using converted audio'
                  ? 'Using prepared AAC audio'
                  : /\.ogg$/i.test(e.file)
                    ? 'Converting Ogg to AAC'
                    : 'Converting Opus to AAC',
              file: e.file,
              fileIndex: e.index,
              fileTotal: e.total,
              percent: Math.round(((i + e.percent) / rows.length) * 100),
            });
          },
        });
        try {
          await this.apply(p, row);
          if (
            (await fingerprint(source)) !== fp ||
            revision(this.catalog.get(row.key).edits) !== editRevision
          )
            throw new Error('Source or edits changed during preparation. Try again.');
          const bytes = p.playlist.tracks.reduce((n, t) => n + t.entry.sizeBytes, 0);
          await this.catalog.set(row.key, {
            durations: {
              fp,
              ...preparedDurations(p, saved.durations?.fp === fp ? saved.durations.tracks : {}),
            },
            prepared: {
              fp,
              editRevision,
              bytes,
              durationMs: p.playlist.manifest.tracks.reduce((n, t) => n + t.durationMs, 0),
              convertedKeys:
                saved.edits?.tracks
                  .filter((t) => !t.excluded && /\.(opus|ogg)$/i.test(t.key))
                  .map((t) => t.key) ?? p.info.opusFiles,
            },
            searchTracks: p.playlist.tracks.map((t) => t.entry.title),
          });
          const cached = this.library.cache.get(source);
          if (cached) cached.row.preparedBytes = bytes;
        } finally {
          await p.cleanup();
        }
      }
      progress({ running: false, phase: 'Audio is ready to sync', percent: 100, file: null });
      this.notify(
        'Audio preparation finished',
        `${rows.length} audio item${rows.length === 1 ? ' is' : 's are'} ready.`,
      );
      await this.library.log(
        'Audio preparation finished. ' + rows.length + ' item(s) ready.',
        'success',
      );
    })()
      .catch(async (error) => {
        progress({
          running: false,
          phase: cancelled ? 'Audio preparation cancelled' : 'Audio preparation needs attention',
          problem: describeProblem(error),
        });
        if (!cancelled)
          this.notify('Audio preparation needs attention', describeProblem(error).summary);
        await this.library.log(error.message, cancelled ? 'info' : 'error');
      })
      .finally(async () => {
        this.preparingTask = null;
        this.cancelPreparation = null;
        await this.library.scan(true);
      });
    this.preparingTask = task;
    return { started: true };
  }
  async undoRemoval() {
    this.requireNoPreparation();
    const undo = this.catalog.data.undo;
    if (!undo?.items?.length) throw new Error('There is no recent removal to undo.');
    if (!this.library.deviceState.connected || this.library.deviceState.deviceId !== undo.deviceId)
      throw new Error('Connect the same Pocket to restore this removal.');
    const keys = [];
    for (const item of undo.items) {
      const row = this.row(item.key);
      if (
        row.id !== item.id ||
        (await fingerprint(this.source(row))) !== item.fp ||
        revision(this.catalog.get(row.key).edits) !== item.revision
      )
        throw new Error(
          'An original or its edits changed since removal. Review it and sync it normally.',
        );
      keys.push(row.key);
    }
    await this.library.transfer(keys, 'sync', undo.deviceId);
    this.catalog.data.undo = null;
    await this.catalog.save();
    this.library.publish();
  }
  collectionPlan() {
    const groups = structuredClone(this.catalog.data.groups),
      ids = [...new Set(groups.flatMap((g) => g.playlists))],
      keys = [];
    for (const id of ids) {
      const rows = this.library.rows.filter((r) => r.id === id && !r.hidden),
        local = rows.find((r) => r.local),
        onPocket = rows.some((r) => r.onDevice);
      if (!onPocket || local?.edited) {
        if (
          !local ||
          !['ready', 'update', 'current', 'unverified', 'disconnected'].includes(local.status)
        )
          throw new Error(
            `Add the original for “${local?.title ?? id}” to your Inbox before syncing this collection.`,
          );
        keys.push(local.key);
      }
    }
    return {
      groups,
      keys,
      deviceId: this.library.deviceState.deviceId,
      revision: collectionRevision(this.catalog.data),
    };
  }
  async syncCollections(plan) {
    this.requireNoPreparation();
    if (this.syncingCollections || this.library.busy)
      throw new Error('Wait for the current operation.');
    if (!this.library.deviceState.connected) throw new Error('Connect Pocket to sync collections.');
    const unchanged = () => {
      if (
        this.library.deviceState.deviceId !== plan.deviceId ||
        collectionRevision(this.catalog.data) !== plan.revision
      )
        throw new Error('Pocket or its collections changed. Review Sync Collections again.');
    };
    unchanged();
    this.library.cancelled = false;
    this.syncingCollections = true;
    this.library.compositeSync = true;
    this.library.compositeCount = plan.keys.length;
    try {
      if (plan.keys.length) await this.library.transfer(plan.keys, 'sync', plan.deviceId);
      unchanged();
      this.library.busy = true;
      this.library.operation = 'collections';
      this.library.progress = { phase: 'Syncing collections', percent: 95 };
      this.library.publish();
      await this.writeCollections(plan.groups, plan.deviceId, plan.revision);
      await this.library.log('Collections synced to Pocket.', 'success');
      this.library.progress = { phase: 'Collections synced', percent: 100 };
    } finally {
      this.syncingCollections = false;
      this.library.compositeSync = false;
      this.library.compositeCount = 0;
      this.library.busy = false;
      this.library.operation = null;
      this.library.publish();
      await this.library.scan(true);
    }
  }
  async writeCollections(groups, deviceId, expectedRevision) {
    if (collectionRevision(this.catalog.data) !== expectedRevision)
      throw new Error('Collections changed. Review Sync again.');
    const icons = new Map();
    for (const group of groups) {
      const picture = this.catalog.data.collectionPictures?.[group.id];
      if (picture?.iconRef && group.icon) icons.set(group.icon, this.editor.asset(picture.iconRef));
    }
    await this.library.device.saveGroups(groups, {
      icons,
      ownedIds: this.catalog.data.ownedGroups,
      expectedDeviceId: deviceId,
      cancelled: () => this.library.cancelled,
    });
    this.catalog.data.collectionsSynced ??= {};
    this.catalog.data.collectionsSynced[deviceId] = expectedRevision;
    await this.catalog.save();
  }
  async syncAudio(keys, deviceId) {
    this.requireNoPreparation();
    if (this.syncingCollections || this.library.busy)
      throw new Error('Wait for the current operation.');
    const includeCollections = collectionsPending(this.library.deviceState, this.catalog.data),
      groups = structuredClone(this.catalog.data.groups),
      groupRevision = collectionRevision(this.catalog.data);
    if (!keys.length && !includeCollections)
      throw new Error('Choose audio or make collection changes before syncing.');
    this.library.cancelled = false;
    this.syncingCollections = true;
    this.library.compositeSync = true;
    this.library.compositeCount = keys.length;
    let audioFinished = false,
      started = Date.now();
    try {
      if (keys.length) {
        await this.library.transfer(keys, 'sync', deviceId);
        audioFinished = true;
      }
      if (includeCollections) {
        this.library.busy = true;
        this.library.operation = 'sync';
        this.library.operationCount = keys.length;
        this.library.operationStartedAt = started;
        this.library.progress = { phase: 'Syncing collections', percent: 95 };
        this.library.publish();
        await this.writeCollections(groups, deviceId, groupRevision);
        if (!keys.length)
          this.library.lastResult = {
            id: randomUUID(),
            kind: 'sync',
            tone: 'success',
            message: 'Collections synced to Pocket.',
            counts: { added: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0 },
            details: groups.map((g) => ({
              title: g.title,
              status: 'updated',
              message: 'Collection arrangement synced to Pocket.',
            })),
            warnings: [],
          };
        else
          this.library.lastResult = {
            ...this.library.lastResult,
            id: randomUUID(),
            message: this.library.lastResult.message + ' · collections synced',
          };
        this.library.progress = { phase: this.library.lastResult.message, percent: 100 };
        await this.library.log(
          'Collections synced to Pocket. Eject Pocket to load the changes.',
          'success',
        );
      }
    } catch (error) {
      if (includeCollections && (!keys.length || audioFinished)) {
        const previous = this.library.lastResult;
        this.library.lastResult = {
          ...(audioFinished ? previous : {}),
          id: randomUUID(),
          kind: 'sync',
          tone: 'warning',
          message: audioFinished
            ? 'Audio sync finished; collections need attention'
            : 'Collections need attention',
          details: audioFinished ? previous.details : [],
          warnings: [
            ...(audioFinished ? previous.warnings : []),
            'Collection changes were not confirmed. ' + error.message,
          ],
        };
        this.library.progress = {
          phase: this.library.lastResult.message,
          error: true,
          percent: audioFinished ? 90 : 0,
        };
        await this.library.log(this.library.lastResult.message + '. ' + error.message, 'error');
      }
      throw error;
    } finally {
      this.syncingCollections = false;
      this.library.compositeSync = false;
      this.library.compositeCount = 0;
      this.library.busy = false;
      this.library.operation = null;
      this.library.operationCount = 0;
      this.library.publish();
      await this.library.scan(true);
    }
  }
  duplicateCandidates() {
    const groups = new Map();
    for (const row of this.library.rows.filter(
      (r) =>
        r.local && !r.hidden && r.id && !['error', 'downloading', 'checking'].includes(r.status),
    )) {
      if (!groups.has(row.id)) groups.set(row.id, []);
      groups.get(row.id).push(row);
    }
    return [...groups.values()].filter((rows) => rows.length > 1 && rows.length <= 20);
  }
  duplicatePublish(value) {
    this.library.duplicates = value;
    this.publishingDuplicates = true;
    try {
      this.library.publish();
    } finally {
      this.publishingDuplicates = false;
    }
  }
  scheduleDuplicates() {
    clearTimeout(this.duplicateTimer);
    if (this.closed) return;
    if (
      this.library.busy ||
      this.syncingCollections ||
      this.preparingTask ||
      this.library.preparation?.running
    ) {
      this.duplicateAbort?.abort();
      return;
    }
    if (this.duplicateTask || this.library.refreshing || this.library.scanning) return;
    const candidates = this.duplicateCandidates(),
      signature = revision(
        candidates.map((rows) =>
          rows.map((r) => [r.key, r.sourceFingerprint, revision(this.catalog.get(r.key).edits)]),
        ),
      );
    if (signature === this.duplicateSignature) return;
    this.duplicateTimer = setTimeout(() => {
      this.duplicateTimer = null;
      this.duplicateTask = this.checkDuplicates(candidates, signature)
        .catch(() => {})
        .finally(() => {
          this.duplicateTask = null;
          this.scheduleDuplicates();
        });
    }, 1500);
    this.duplicateTimer.unref?.();
  }
  async checkDuplicates(candidates, signature) {
    const controller = new AbortController();
    this.duplicateAbort = controller;
    this.duplicatePublish({ checking: true, groups: [] });
    try {
      const groups = [];
      for (const rows of candidates) {
        const result = await this.compareDuplicates(
          rows.map((r) => r.key),
          { signal: controller.signal, useCache: true },
        );
        groups.push({ title: rows[0].title, items: result.items });
      }
      if (controller.signal.aborted) return;
      this.duplicateSignature = signature;
      this.duplicatePublish({ checking: false, groups });
    } catch (error) {
      this.duplicatePublish({
        checking: false,
        groups: [],
        message: controller.signal.aborted
          ? null
          : 'A possible duplicate could not be compared. Your originals are kept.',
      });
      if (!controller.signal.aborted) this.duplicateSignature = signature;
    } finally {
      this.duplicateAbort = null;
    }
  }
  async compareDuplicates(keys, { signal, useCache = false } = {}) {
    if (this.library.busy || this.preparingTask)
      throw new Error('Wait for the current operation to finish.');
    if (!Array.isArray(keys) || keys.length < 2 || keys.length > 20)
      throw new Error('Choose 2–20 matching imports to compare.');
    const records = [],
      cache = (this.catalog.data.duplicateChecks ??= {});
    const check = () => {
      if (signal?.aborted || this.library.busy || this.preparingTask)
        throw new Error('Duplicate check paused.');
    };
    for (const key of keys) {
      check();
      const row = this.row(key),
        source = this.source(row),
        fp = await fingerprint(source),
        cached = useCache ? cache[key] : null;
      let record;
      if (cached?.fp === fp) record = { ...cached.record };
      else {
        const doc = await trackDocument(source, { signal });
        try {
          const hashes = [];
          for (const t of doc.tracks) {
            check();
            const hash = createHash('sha256');
            for await (const chunk of createReadStream(path.join(doc.root, t.key), {
              highWaterMark: 1024 * 1024,
            })) {
              check();
              hash.update(chunk);
            }
            hashes.push(hash.digest('hex'));
          }
          record = {
            key,
            source: row.source,
            tracks: hashes.length,
            orderHash: revision(hashes),
            audioHash: revision([...hashes].sort()),
            metadataRevision: revision(
              doc.tracks.map((t) => ({ title: t.title, icon: t.iconKey })),
            ),
          };
          check();
          if ((await fingerprint(source)) !== fp)
            throw new Error('Original changed during duplicate comparison.');
          cache[key] = { fp, record };
        } finally {
          await doc.cleanup();
        }
      }
      records.push({
        ...record,
        title: row.title,
        editRevision: revision(this.catalog.get(key).edits),
      });
    }
    check();
    await this.catalog.save();
    return {
      items: records.map((r) => ({
        ...r,
        comparison:
          (r.orderHash === records[0].orderHash
            ? 'Identical audio in the same order'
            : r.audioHash === records[0].audioHash
              ? 'Same audio files, different order'
              : 'Different audio or edition') +
          (r.editRevision !== records[0].editRevision ||
          r.metadataRevision !== records[0].metadataRevision
            ? ' · names, icons, or saved edits differ'
            : ''),
      })),
    };
  }
  async close() {
    this.closed = true;
    clearTimeout(this.duplicateTimer);
    this.duplicateAbort?.abort();
    this.editor.cancelAllMetrics();
    const results = await Promise.allSettled([
      this.durations.close(),
      this.duplicateTask,
      this.editor.closeAll().then(() => this.editor.drainMetrics()),
    ]);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
