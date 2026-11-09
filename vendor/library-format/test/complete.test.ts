// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLibrary, checkPlaylistDir } from '../src/node.js';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'library', 'STUDIOPOCKET');

describe('completeness check', () => {
    it('accepts complete playlists and hides the truncated one', async () => {
        const check = await checkLibrary(root, { verifyHashes: true });
        expect(check.problems).toEqual([]);
        expect(check.syncLockPresent).toBe(false);
        const byId = Object.fromEntries(check.playlists.map((p) => [p.id, p]));
        expect(byId.bedtime!.ok).toBe(true);
        expect(byId.songs!.ok).toBe(true);
        expect(byId.broken!.ok).toBe(false);
        expect(byId.broken!.problems[0]).toMatch(/tracks\/t2\.mp3 is \d+ B, expected \d+/);
    });

    it('fails a dir with no manifest', async () => {
        const check = await checkPlaylistDir(path.join(root, 'playlists', 'nope'), { id: 'nope' });
        expect(check.ok).toBe(false);
        expect(check.manifest).toBeNull();
    });

    it('treats missing artwork as non-fatal', async () => {
        const check = await checkPlaylistDir(path.join(root, 'playlists', 'songs'), { id: 'songs' });
        expect(check.ok).toBe(true);
        expect(check.manifest!.cover).toBe('cover.jpg');
    });

    it('a playlist with update.lock is reported as interrupted but its manifest is still returned', async () => {
        const tmp = await mkdtemp(path.join(os.tmpdir(), 'myo-complete-'));
        try {
            await cp(path.join(root, 'playlists', 'bedtime'), path.join(tmp, 'bedtime'), { recursive: true });
            await writeFile(path.join(tmp, 'bedtime', 'update.lock'), 'x\n');
            const check = await checkPlaylistDir(path.join(tmp, 'bedtime'), { id: 'bedtime' });
            expect(check.ok).toBe(false);
            expect(check.problems).toContain('update interrupted (update.lock present)');
            expect(check.manifest!.id).toBe('bedtime');
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }
    });
});
