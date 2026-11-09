// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseWith, validatePlaylistManifest } from '@studio-pocket/library-format';
import type { SourceLibrary, SourcePlaylist } from '../src/source.js';

export const fixtureRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../library-format/fixtures/library/STUDIOPOCKET');

/** Builds a SourceLibrary from the committed fixtures, as the desktop would from its cache. */
export async function sourceFromFixtures(ids: string[]): Promise<SourceLibrary> {
    const playlists: SourcePlaylist[] = [];
    for (const id of ids) {
        const dir = path.join(fixtureRoot, 'playlists', id);
        const manifest = parseWith(validatePlaylistManifest, await readFile(path.join(dir, 'manifest.json'), 'utf8'), id);
        const playlist: SourcePlaylist = { manifest, tracks: manifest.tracks.map((entry) => ({ entry, localPath: path.join(dir, entry.file), ...(entry.icon ? { iconPath: path.join(dir, entry.icon) } : {}) })) };
        if (manifest.cover) playlist.coverPath = path.join(dir, manifest.cover);
        if (manifest.icon) playlist.iconPath = path.join(dir, manifest.icon);
        playlists.push(playlist);
    }
    return { generator: 'sync-engine/test', playlists };
}
