// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FormatError, parseWith, validateGroups, validateLibraryIndex, validatePlaybackState, validatePlaylistManifest, validateDeviceMarker, validateRecent } from '../src/validate.js';

const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures');
const root = path.join(fixtures, 'library', 'STUDIOPOCKET');

describe('validators accept the shared fixtures', () => {
    it('library.json', async () => {
        const index = parseWith(validateLibraryIndex, await readFile(path.join(root, 'library.json'), 'utf8'), 'library.json');
        expect(index.playlists.map((p) => p.id)).toEqual(['bedtime', 'songs', 'broken']);
        expect(index.playlists[0]!.trackCount).toBe(3);
    });

    it('every manifest.json', async () => {
        for (const id of ['bedtime', 'songs', 'broken']) {
            const manifest = parseWith(validatePlaylistManifest, await readFile(path.join(root, 'playlists', id, 'manifest.json'), 'utf8'), id);
            expect(manifest.id).toBe(id);
            expect(manifest.tracks.length).toBeGreaterThan(0);
        }
    });

    it('device.json and state', async () => {
        expect(parseWith(validateDeviceMarker, await readFile(path.join(root, 'device.json'), 'utf8'), 'device.json').deviceId).toBe('fixture-device-0001');
        expect(parseWith(validatePlaybackState, await readFile(path.join(root, 'state', 'bedtime.json'), 'utf8'), 'state')).toMatchObject({ playlistId: 'bedtime', trackIndex: 1, positionMs: 1500 });
    });
});

describe('validators reject every invalid fixture', () => {
    it('with a FormatError naming the path', async () => {
        const dir = path.join(fixtures, 'invalid');
        const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
        expect(files.length).toBeGreaterThanOrEqual(6);
        for (const file of files) {
            const text = await readFile(path.join(dir, file), 'utf8');
            const validator = file.startsWith('library') ? validateLibraryIndex : file.startsWith('groups') ? validateGroups : file.startsWith('recent') ? validateRecent : validatePlaylistManifest;
            expect(() => parseWith(validator, text, file), file).toThrow(FormatError);
        }
    });

    it('reports the offending field', () => {
        expect(() => validatePlaylistManifest({ format: 'studiopocket-playlist', formatVersion: 1, id: 'Bad ID', title: 't', tracks: [{ id: 't1', title: 'x', file: 'tracks/t1.mp3', durationMs: 1, sizeBytes: 1, sha256: '0'.repeat(64), mimeType: 'audio/mpeg' }] })).toThrow(/manifest\.id/);
        expect(() => validateLibraryIndex({ format: 'studiopocket-library', formatVersion: 1, generatedAt: 'x', generator: 'y', playlists: 'no' })).toThrow(/playlists must be an array/);
    });
});

describe('track icons', () => {
    it('accepts an optional icons/<name>.png and rejects other locations', async () => {
        const { validateTrack } = await import('../src/validate.js');
        const base = { id: 'a', title: 'A', file: 'tracks/a.mp3', durationMs: 1, sizeBytes: 1, sha256: 'a'.repeat(64), mimeType: 'audio/mpeg' };
        expect(validateTrack(base).icon).toBeUndefined();
        expect(validateTrack({ ...base, icon: null }).icon).toBeUndefined();
        expect(validateTrack({ ...base, icon: 'icons/a.png' }).icon).toBe('icons/a.png');
        expect(() => validateTrack({ ...base, icon: 'tracks/a.png' })).toThrow(/icons\//);
        expect(() => validateTrack({ ...base, icon: '../a.png' })).toThrow();
    });
});
