// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION, PLAYLIST_FORMAT, type PlaylistManifest } from '@studio-pocket/library-format';
import { checkLibrary } from '@studio-pocket/library-format/node';
import { applySync, ensureDeviceMarker, planTransfer } from '../src/node.js';
import type { SourceLibrary } from '../src/source.js';

const planFor = (r: string, source: SourceLibrary, options: { verifyHashes?: boolean } = {}) => planTransfer(r, { send: source.playlists, remove: [] }, options);

/**
 * A large library (many playlists, long track lists) through plan + apply + re-plan, to catch
 * anything accidentally quadratic before the first real family library hits it. Files are
 * tiny; what is exercised is the bookkeeping, not disk bandwidth.
 */
const PLAYLISTS = 60;
const TRACKS = 50; // 3,000 tracks

async function bigSource(dir: string): Promise<SourceLibrary> {
    const playlists: SourceLibrary['playlists'] = [];
    for (let p = 0; p < PLAYLISTS; p++) {
        const id = `pl-${p.toString().padStart(3, '0')}`;
        const pdir = path.join(dir, id);
        await mkdir(pdir, { recursive: true });
        const tracks: PlaylistManifest['tracks'] = [];
        const manifest: PlaylistManifest = { format: PLAYLIST_FORMAT, formatVersion: FORMAT_VERSION, id, title: `Playlist ${p}`, cover: null, icon: null, tracks };
        const entries = [];
        for (let t = 0; t < TRACKS; t++) {
            const data = Buffer.from(`${id}-${t}-`.repeat(40));
            const file = path.join(pdir, `t${t}.mp3`);
            await writeFile(file, data);
            const entry = { id: `t${t}`, title: `Track ${t}`, file: `tracks/t${t}.mp3`, durationMs: 1000, sizeBytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), mimeType: 'audio/mpeg' as const };
            tracks.push(entry);
            entries.push({ entry, localPath: file });
        }
        playlists.push({ manifest, tracks: entries });
    }
    return { generator: 'scale-test', playlists };
}

describe('scale', () => {
    it(`plans and applies ${PLAYLISTS} playlists × ${TRACKS} tracks in reasonable time`, async () => {
        const work = await mkdtemp(path.join(os.tmpdir(), 'myo-scale-'));
        try {
            const source = await bigSource(path.join(work, 'src'));
            const volume = path.join(work, 'vol');
            await ensureDeviceMarker(volume, 'scale');
            const root = path.join(volume, 'STUDIOPOCKET');
            const t0 = Date.now();
            const plan = await planFor(root, source);
            const result = await applySync(plan, { generator: 'scale' });
            const applyMs = Date.now() - t0;
            expect(result.index.playlists.length).toBe(PLAYLISTS);
            expect(result.skipped).toEqual([]);
            const t1 = Date.now();
            const again = await planFor(root, source, { verifyHashes: true });
            const replanMs = Date.now() - t1;
            expect(again.playlists.every((p) => p.kind === 'keep')).toBe(true);
            const check = await checkLibrary(root);
            expect(check.playlists.filter((p) => p.ok).length).toBe(PLAYLISTS);
            // Generous bounds: this is a smoke test for complexity, not a benchmark.
            expect(applyMs).toBeLessThan(60_000);
            expect(replanMs).toBeLessThan(60_000);
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    }, 180_000);
});
