// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import type { LibraryFs } from '@studio-pocket/library-format';

/**
 * Everything the sync engine touches on disk goes through this interface. Node binds it to
 * `node:fs` (./node.ts, used by tests and scripts); the desktop binds it to scoped Tauri
 * commands, so the engine itself never imports Node modules and runs inside the webview.
 */
export interface SyncFs extends LibraryFs {
    readdir(dir: string): Promise<{ name: string; isDir: boolean }[]>;
    mkdirp(dir: string): Promise<void>;
    writeFile(file: string, data: string | Uint8Array): Promise<void>;
    /** Whole-file read, for audio that has to be processed in memory (format conversion). */
    readBytes(file: string): Promise<Uint8Array>;
    rename(from: string, to: string): Promise<void>;
    /** Missing paths are not an error. */
    remove(path: string, recursive: boolean): Promise<void>;
    copyFile(from: string, to: string, onProgress?: (bytes: number) => void): Promise<void>;
    freeBytes(dir: string): Promise<number | null>;
    sha256Bytes(data: Uint8Array): Promise<string>;
    randomId(): string;
    /** Path of `to` relative to `root`, forward slashes (for progress reporting only). */
    relative(root: string, to: string): string;
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
