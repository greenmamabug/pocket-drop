// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileInfo, LibraryFs } from './fs.js';
import { checkLibrary as checkLibraryWith, checkPlaylistDir as checkPlaylistDirWith, type LibraryCheck, type PlaylistCheck } from './complete.js';
import type { LibraryIndexEntry } from './types.js';

export async function sha256File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
    });
}

/** The package's shared fixtures (a library and audio that the player and the desktop tests both read). Same relative place from src/ and dist/. */
export const fixturesDir = (): string => fileURLToPath(new URL('../fixtures', import.meta.url));

export const nodeLibraryFs: LibraryFs = {
    join: (...parts) => path.join(...parts),
    readText: (file) => readFile(file, 'utf8'),
    stat: async (file): Promise<FileInfo> => {
        const info = await stat(file).catch(() => null);
        return info ? { exists: true, size: info.size, isDir: info.isDirectory() } : { exists: false, size: 0, isDir: false };
    },
    sha256File,
};

/** Node conveniences: the functions above bound to the Node file system, with plain paths. */
export const checkPlaylistDir = (dir: string, entry: Pick<LibraryIndexEntry, 'id'> & Partial<LibraryIndexEntry>, options: { verifyHashes?: boolean } = {}): Promise<PlaylistCheck> =>
    checkPlaylistDirWith(nodeLibraryFs, dir, entry, options);
export const checkLibrary = (root: string, options: { verifyHashes?: boolean } = {}): Promise<LibraryCheck> =>
    checkLibraryWith(nodeLibraryFs, root, options);
