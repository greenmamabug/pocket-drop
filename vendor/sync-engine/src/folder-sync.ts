// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import os from 'node:os';
import path from 'node:path';
import { applySync as runApply, ensureDeviceMarker, inspectDevice, planTransfer } from './node.js';
import { SyncError, type ApplyResult } from './apply.js';
import { buildFolderLibrary } from './folder.js';
import { nodeFolderDeps } from './folder-node.js';

export interface SyncFolderOptions {
    folder: string;
    volume: string;
    create: boolean;
    generator: string;
    copy?: (from: string, to: string) => Promise<void>;
}

export interface VolumeEnv {
    platform?: NodeJS.Platform;
    homedir?: string;
    systemDrive?: string;
    systemRoot?: string;
}

/**
 * The places that are never a player: the system drive's root, the home folder and (on Windows) the
 * Windows folder. On POSIX every filesystem root is refused. Any other Windows drive root is a valid
 * volume, because that is where the player mounts.
 */
export function refuseUnsafeVolume(volume: string, env: VolumeEnv = {}): void {
    const platform = env.platform ?? process.platform;
    const home = env.homedir ?? os.homedir();
    const win = platform === 'win32';
    const p = win ? path.win32 : path.posix;
    const key = (v: string): string => {
        // A bare `E:` means the drive's current folder; for a player volume it is the drive root.
        const r = p.resolve(win && /^[a-z]:$/i.test(v) ? `${v}\\` : v);
        const root = p.parse(r).root;
        const trimmed = r.length > root.length ? r.replace(/[\\/]+$/, '') : r;
        return win ? trimmed.toLowerCase() : trimmed;
    };
    const resolved = key(volume);
    const unsafe = [key(home)];
    if (win) {
        const drive = env.systemDrive ?? process.env.SystemDrive ?? 'C:';
        unsafe.push(key(`${drive}\\`));
        const root = env.systemRoot ?? process.env.SystemRoot;
        if (root) unsafe.push(key(root));
    } else {
        unsafe.push(key(p.parse(p.resolve(volume)).root));
    }
    if (unsafe.includes(resolved)) {
        throw new SyncError(`refusing to use ${p.resolve(volume)} as the player`);
    }
}

/** The stderr lines studio-pocket-sync prints after a sync: each note and cleanup warning, then how many obsolete files went. */
export function syncReportLines(result: Pick<ApplyResult, 'warnings' | 'cleaned'> & { notes: string[] }): string[] {
    return [
        ...result.notes.map((n) => `note: ${n}`),
        ...result.warnings.map((w) => `warning: ${w}`),
        ...(result.cleaned.length ? [`cleaned ${result.cleaned.length} file(s)`] : []),
    ];
}

export async function syncFolder(opts: SyncFolderOptions): Promise<ApplyResult & { notes: string[] }> {
    refuseUnsafeVolume(opts.volume);
    const info = await inspectDevice(opts.volume);
    if (!info.marker && !info.hasLibrary && !opts.create) {
        throw new SyncError(`${opts.volume} holds no Studio Pocket library; if this is the player, run again with --create`);
    }
    // Everything that can fail on the computer fails here, before the device is touched.
    const library = await buildFolderLibrary(opts.folder, nodeFolderDeps);
    if (opts.create) await ensureDeviceMarker(opts.volume, opts.generator);
    const plan = await planTransfer(info.root, { send: library.playlists, remove: [] });
    const result = await runApply(plan, { generator: opts.generator, ...(opts.copy ? { copy: opts.copy } : {}) });
    return { ...result, notes: library.notes ?? [] };
}
