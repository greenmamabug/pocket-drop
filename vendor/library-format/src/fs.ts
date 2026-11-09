// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

/**
 * The minimal filesystem the format checks need. Node binds it to `node:fs` (see ./node.ts);
 * the desktop app binds it to scoped Tauri commands so the same checking code runs inside the
 * webview, where there is no Node.
 */
export interface FileInfo {
    exists: boolean;
    size: number;
    isDir: boolean;
}

export interface LibraryFs {
    /** Joins path segments with the platform separator. Never resolves `..`. */
    join(...parts: string[]): string;
    readText(file: string): Promise<string>;
    stat(file: string): Promise<FileInfo>;
    sha256File(file: string): Promise<string>;
}

/** Pure-JS join for callers that only ever deal with forward slashes (device-relative paths). */
export function posixJoin(...parts: string[]): string {
    return parts.filter((p) => p.length > 0).join('/').replace(/\/+/g, '/');
}
