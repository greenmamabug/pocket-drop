// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspect, openArchive, fingerprint, tree, safeName, convertChrome } from './archive.mjs';
import { flexibleMetadata, byAudioPath } from './flexible-audio.mjs';
import { nodeFolderDeps } from '../vendor/sync-engine/dist/folder-node.js';
import { numberedMetadata } from './numbered-archive.mjs';
import { text } from './catalog.mjs';
import { probeDuration } from './audio-probe.mjs';

export async function trackDocument(source, { signal } = {}) {
  const info = await inspect(source),
    archive = await openArchive(source);
  let extracted;
  try {
    extracted = await archive.extract(undefined, { signal });
  } finally {
    archive.close();
  }
  try {
    let metadata,
      prefix = info.prefix;
    if (info.format === 'chrome')
      metadata = convertChrome(
        info,
        (await tree(extracted.root)).map((f) => f.name),
      );
    else if (info.format === 'website') metadata = info.meta;
    else if (info.format === 'numbered') {
      metadata = (await numberedMetadata(extracted.root, info)).metadata;
      prefix = '';
    } else {
      metadata = (
        await flexibleMetadata(extracted.root, info, { cancelled: () => signal?.aborted })
      ).metadata;
      prefix = '';
    }
    const ordered = [...metadata.tracks].sort((a, b) => a.index - b.index),
      audio = info.audioFiles.filter((n) => n.startsWith(prefix + 'audio/')).sort(byAudioPath);
    const names = (await tree(extracted.root)).filter(
      (f) => /\.png$/i.test(f.name) && f.size <= 10 * 1024 ** 2,
    );
    const icons = [];
    for (const file of names) {
      if (file.name === info.coverName) continue;
      const b = await nodeFolderDeps.read(path.join(extracted.root, file.name), 24);
      if (
        b.length === 24 &&
        b.readUInt32BE(0) === 0x89504e47 &&
        ((b.readUInt32BE(16) === 16 && b.readUInt32BE(20) === 16) ||
          info.numbered?.images.includes(file.name) ||
          Object.values(info.iconAssignments ?? {}).includes(file.name))
      )
        icons.push(file.name);
    }
    const numberedIcons = icons.filter((n) => n.startsWith(prefix + 'icons/')).sort(byAudioPath);
    const tracks = ordered.map((t, i) => ({
      key: typeof t.audio === 'string' ? prefix + safeName(t.audio) : audio[i],
      title: t.title,
      iconKey:
        typeof t.icon === 'string' && icons.includes(prefix + t.icon)
          ? prefix + t.icon
          : metadata.format !== 'myo-studio-archive' && numberedIcons.length === ordered.length
            ? numberedIcons[i]
            : null,
      excluded: false,
    }));
    if (
      !tracks.length ||
      tracks.length > 500 ||
      new Set(tracks.map((t) => t.key)).size !== tracks.length ||
      tracks.some((t) => !info.audioFiles.includes(t.key))
    )
      throw new Error('Cannot match every track to an audio file.');
    return {
      info,
      root: await fs.realpath(extracted.root),
      tracks,
      icons,
      cleanup: extracted.cleanup,
      isFolder: (await fs.lstat(source)).isDirectory(),
    };
  } catch (error) {
    await extracted.cleanup();
    throw error;
  }
}
// Open names and saved metadata without extracting or probing the audio payload.
export async function quickDocument(source, knownInfo) {
  const info = knownInfo ?? (await inspect(source)),
    archive = await openArchive(source),
    isFolder = (await fs.lstat(source)).isDirectory();
  try {
    const names = archive.entries.map((e) => e.name);
    let metadata,
      prefix = info.prefix;
    if (info.format === 'chrome') metadata = convertChrome(info, names);
    else if (info.format === 'website') metadata = info.meta;
    else {
      prefix = '';
      metadata = {
        tracks:
          info.format === 'numbered'
            ? info.numbered.tracks.map((t, index) => ({
                index,
                title: t.title,
                audio: t.key,
                icon: t.iconKey,
              }))
            : info.audioFiles.map((key, index) => ({
                index,
                title: path.posix.basename(key, path.posix.extname(key)),
                audio: key,
                icon: info.iconAssignments?.[key],
              })),
      };
    }
    const ordered = [...metadata.tracks].sort((a, b) => a.index - b.index),
      audio = info.audioFiles.filter((n) => n.startsWith(prefix + 'audio/')).sort(byAudioPath);
    const assigned = new Set(ordered.map((t) => (t.icon ? prefix + safeName(t.icon) : null)));
    const candidates = archive.entries
      .filter(
        (e) =>
          e.name !== info.coverName &&
          /\.png$/i.test(e.name) &&
          e.size <= 10 * 1024 ** 2 &&
          (assigned.has(e.name) || e.size <= 256 * 1024),
      )
      .map((e) => e.name);
    const numberedIcons = candidates
      .filter((n) => n.startsWith(prefix + 'icons/'))
      .sort(byAudioPath);
    const preferred = new Set([
      ...assigned,
      ...(numberedIcons.length === ordered.length ? numberedIcons : []),
    ]);
    const icons = [
      ...candidates.filter((n) => preferred.has(n)),
      ...candidates.filter((n) => !preferred.has(n)),
    ].slice(0, 500);
    const tracks = ordered.map((t, i) => ({
      key: typeof t.audio === 'string' ? prefix + safeName(t.audio) : audio[i],
      title: t.title,
      iconKey:
        typeof t.icon === 'string' && icons.includes(prefix + t.icon)
          ? prefix + t.icon
          : metadata.format !== 'myo-studio-archive' && numberedIcons.length === ordered.length
            ? numberedIcons[i]
            : null,
      excluded: false,
    }));
    if (
      !tracks.length ||
      tracks.length > 500 ||
      new Set(tracks.map((t) => t.key)).size !== tracks.length ||
      tracks.some((t) => !info.audioFiles.includes(t.key))
    )
      throw new Error('Cannot match every track to an audio file.');
    const root = isFolder ? await fs.realpath(source) : null,
      pending = new Map(),
      controller = new AbortController(),
      audioReady = new Map();
    let closed = false;
    const readGroup = async (group, members) => {
      if (closed) throw new Error('Audio details expired.');
      if (!pending.has(group))
        pending.set(
          group,
          (async () => {
            if (info.sourceFingerprint && (await fingerprint(source)) !== info.sourceFingerprint)
              throw new Error('The original archive changed. Reopen Audio details.');
            return archive.extract(members, { signal: controller.signal });
          })(),
        );
      const item = await pending.get(group);
      if (closed) throw new Error('Audio details expired.');
      return await fs.realpath(item.root);
    };
    const file = async (name) => {
      if (closed || !names.includes(name))
        throw new Error('Audio details expired. Reopen the item.');
      if (isFolder) return path.join(root, name);
      // Solid 7z archives must not be decompressed once for every thumbnail.
      const group = icons.includes(name) ? '\0artwork' : name,
        members = group === '\0artwork' ? icons : [name];
      if (audioReady.has(name)) return audioReady.get(name);
      return path.join(await readGroup(group, members), name);
    };
    const sizes = new Map(archive.entries.map((e) => [e.name, e.size]));
    for (const track of tracks) track.size = sizes.get(track.key) ?? null;
    const audioFiles = async (keys) => {
      if (keys.some((key) => !info.audioFiles.includes(key)))
        throw new Error('Unknown audio track.');
      if (!keys.length) return new Map();
      const base = isFolder ? root : await readGroup('\0audio-metrics', keys);
      for (const key of keys) audioReady.set(key, path.join(base, key));
      return audioReady;
    };
    return {
      info,
      root,
      tracks,
      icons,
      isFolder,
      file,
      audioFiles,
      abort: () => controller.abort(),
      cleanup: async () => {
        closed = true;
        controller.abort();
        const items = await Promise.allSettled([...pending.values()]);
        for (const item of items) if (item.status === 'fulfilled') await item.value.cleanup();
        archive.close();
      },
    };
  } catch (error) {
    archive.close();
    throw error;
  }
}
export class Editor {
  constructor(catalog) {
    this.catalog = catalog;
    this.media = new Map();
    this.sessions = new Map();
    this.pendingMetrics = new Set();
    this.opening = false;
    this.probe = probeDuration;
  }
  url(file, owner) {
    const token = randomUUID();
    this.media.set(token, { file, owner });
    return 'pocket-media://preview/' + token;
  }
  async mediaFile(token) {
    const media = this.media.get(token);
    return typeof media?.file === 'function' ? media.file() : media?.file;
  }
  asset(ref) {
    if (typeof ref !== 'string' || !/^asset:[a-f0-9-]{36}\.png$/.test(ref))
      throw new Error('Invalid artwork reference.');
    return path.join(this.catalog.folder, 'artwork', ref.slice(6));
  }
  async open(row, source, knownInfo, knownManifest) {
    if (this.opening) throw new Error('Audio details are already opening.');
    this.opening = true;
    try {
      return await this.openDocument(row, source, knownInfo, knownManifest);
    } finally {
      this.opening = false;
    }
  }
  async openDocument(row, source, knownInfo, knownManifest) {
    await this.closeAll();
    const fp = await fingerprint(source),
      doc = await quickDocument(source, knownInfo?.sourceFingerprint === fp ? knownInfo : null),
      id = randomUUID(),
      saved = this.catalog.get(row.key),
      prior = saved.edits;
    doc.info.sourceFingerprint = fp;
    const byKey = new Map(doc.tracks.map((t) => [t.key, t]));
    const tracks = [
      ...(prior?.tracks ?? [])
        .filter((t) => byKey.has(t.key))
        .map((t) => ({ ...byKey.get(t.key), ...t })),
      ...doc.tracks.filter((t) => !prior?.tracks.some((p) => p.key === t.key)),
    ];
    const measured = saved.durations?.fp === fp ? { ...saved.durations.tracks } : {};
    const active = prior?.tracks.filter((t) => !t.excluded) ?? doc.tracks;
    const reliableOrder =
      prior ||
      doc.info.format !== 'folder' ||
      (new Set(doc.tracks.map((t) => t.title)).size === doc.tracks.length &&
        knownManifest?.tracks.every((t, i) => t.title === doc.tracks[i]?.title));
    if (
      knownInfo?.sourceFingerprint === fp &&
      reliableOrder &&
      knownManifest?.tracks.length === active.length
    )
      for (let i = 0; i < active.length; i++)
        measured[active[i].key] ??= knownManifest.tracks[i].durationMs;
    const session = {
      id,
      rowKey: row.key,
      source,
      fp,
      doc,
      measured,
      metricErrors: {},
      metricsAbort: new AbortController(),
      allowedAssets: new Set(
        [prior?.coverRef, ...tracks.map((t) => t.iconKey)].filter((n) => n?.startsWith('asset:')),
      ),
    };
    this.sessions.set(id, session);
    const icons = doc.icons.map((key) => ({
      key,
      url: this.url(() => doc.file(key), id),
      name: path.posix.basename(key),
    }));
    for (const key of session.allowedAssets)
      if (tracks.some((t) => t.iconKey === key))
        icons.push({ key, url: this.url(this.asset(key), id), name: 'Custom icon' });
    return {
      id,
      rowKey: row.key,
      convertedKeys: row.convertedKeys ?? [],
      needsConversion: row.needsConversion,
      title: prior?.title || row.title,
      tags: saved.tags ?? [],
      cover: prior?.coverRef ? this.url(this.asset(prior.coverRef), id) : doc.info.cover,
      coverRef: prior?.coverRef ?? null,
      coverMode: prior?.coverMode ?? 'fit',
      coverPosition: prior?.coverPosition ?? 50,
      icons,
      tracks: tracks.map((t) => ({
        ...t,
        durationMs: measured[t.key] ?? null,
        url: this.url(() => doc.file(t.key), id),
        filename: path.posix.basename(t.key),
      })),
      defaults: { title: doc.info.title, tracks: doc.tracks, cover: doc.info.cover },
      canTrashOriginals: doc.isFolder,
      notice:
        prior &&
        (prior.tracks.length !== doc.tracks.length ||
          prior.tracks.some((t) => !doc.tracks.some((n) => n.key === t.key)))
          ? 'The source files changed. Review this track list before saving.'
          : doc.info.notes?.join(' ') || null,
    };
  }
  session(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Audio details expired. Reopen the item.');
    return s;
  }
  metrics(id) {
    const s = this.session(id);
    if (!s.metricsStarted) {
      s.metricsStarted = true;
      s.metricsRunning = true;
      s.metricsTask = this.measureTracks(s)
        .catch((error) => {
          if (!s.metricsAbort.signal.aborted) s.metricsError = error.message;
        })
        .finally(() => {
          s.metricsRunning = false;
          this.pendingMetrics.delete(s.metricsTask);
        });
      this.pendingMetrics.add(s.metricsTask);
    }
    return {
      running: s.metricsRunning,
      error: s.metricsError ?? null,
      tracks: s.doc.tracks.map((t) => ({
        key: t.key,
        size: t.size,
        durationMs: s.measured[t.key] ?? null,
        error: s.metricErrors[t.key] ?? s.metricsError ?? null,
        unavailable: !!s.metricErrors[t.key],
      })),
    };
  }
  async persistMetrics(s) {
    if (!Object.keys(s.measured).length || (await fingerprint(s.source).catch(() => null)) !== s.fp)
      return;
    const old = this.catalog.get(s.rowKey).durations,
      tracks = { ...(old?.fp === s.fp ? old.tracks : {}), ...s.measured };
    await this.catalog.set(s.rowKey, {
      durations: {
        fp: s.fp,
        tracks,
        complete: s.doc.info.audioFiles.every(
          (key) => Number.isFinite(tracks[key]) && tracks[key] > 0,
        ),
      },
    });
  }
  async measureTracks(s) {
    const check = () => {
      if (s.metricsAbort.signal.aborted || !this.sessions.has(s.id))
        throw new Error('Track details closed.');
    };
    try {
      const missing = s.doc.tracks.filter((t) => !Number.isFinite(s.measured[t.key]));
      check();
      if (missing.length) {
        const files = await s.doc.audioFiles(missing.map((t) => t.key));
        check();
        let completed = 0;
        for (const track of missing) {
          check();
          try {
            const value = await this.probe(files.get(track.key));
            check();
            if (!Number.isFinite(value) || value <= 0) throw new Error('Length unavailable.');
            s.measured[track.key] = Math.round(value);
          } catch (error) {
            check();
            s.metricErrors[track.key] = error.message;
          }
          if (++completed % 5 === 0) await this.persistMetrics(s);
        }
      }
    } finally {
      await this.persistMetrics(s);
    }
  }
  async drainMetrics() {
    await Promise.allSettled([...this.pendingMetrics]);
  }
  cancelAllMetrics() {
    for (const s of this.sessions.values()) {
      s.metricsAbort.abort();
      s.doc.abort?.();
    }
  }
  async save(id, input) {
    const s = this.session(id);
    if ((await fingerprint(s.source)) !== s.fp)
      throw new Error('The original files changed. Reopen Audio details before saving.');
    if (!Array.isArray(input.tracks) || input.tracks.length !== s.doc.tracks.length)
      throw new Error(
        'Keep every original track listed; use Delete from this version to exclude a track.',
      );
    const keys = new Set(s.doc.tracks.map((t) => t.key)),
      seen = new Set();
    const tracks = input.tracks.map((t) => {
      if (!keys.has(t.key) || seen.has(t.key)) throw new Error('Invalid or repeated track.');
      seen.add(t.key);
      if (t.iconKey !== null && !s.doc.icons.includes(t.iconKey) && !s.allowedAssets.has(t.iconKey))
        throw new Error('Choose an icon from this item or import an icon.');
      return {
        key: t.key,
        title: text(t.title),
        iconKey: t.iconKey,
        excluded: t.excluded === true,
      };
    });
    if (!tracks.some((t) => !t.excluded))
      throw new Error('Keep at least one track in this audio item.');
    const coverRef = input.coverRef ?? null;
    if (coverRef && !s.allowedAssets.has(coverRef))
      throw new Error('Choose artwork using Change cover.');
    const edits = {
      title: text(input.title),
      tracks,
      coverRef,
      coverMode: input.coverMode === 'fill' ? 'fill' : 'fit',
      coverPosition: Math.max(0, Math.min(100, Number(input.coverPosition) || 0)),
    };
    const tags = [
      ...new Set((Array.isArray(input.tags) ? input.tags : []).map((t) => text(t, 40))),
    ];
    if (tags.length > 30) throw new Error('Use up to 30 tags.');
    await this.catalog.set(s.rowKey, {
      edits,
      tags,
      searchTracks: tracks.filter((t) => !t.excluded).map((t) => t.title),
    });
    return edits;
  }
  async close(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.metricsAbort.abort();
    s.doc.abort?.();
    for (const [token, m] of this.media) if (m.owner === id) this.media.delete(token);
    await s.doc.cleanup();
  }
  async closeAll() {
    for (const id of [...this.sessions.keys()]) await this.close(id);
  }
}
