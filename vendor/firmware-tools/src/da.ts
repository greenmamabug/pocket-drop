// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import pinJson from './da-pin.json' with { type: 'json' };
import { InstallerError } from './errors.js';
import type { FirmwarePlatform } from './platform.js';

/**
 * MediaTek's download agent (DA): the program mtkclient uploads into the player's RAM to read and
 * write its eMMC. Studio Pocket does not distribute it. The user's machine fetches the one file
 * the Y2 needs from upstream mtkclient at the commit the bundles are built from, checks it against
 * the SHA-256 committed in ./da-pin.json, keeps it in `<firmware dir>/tools/da/`, and hands it to
 * mtkclient by path (`--loader`). Once it is there no request is made again; the file is re-hashed
 * before every session. No OEM preloader is distributed or fetched: the Y2 is reached in preloader
 * mode, whose own preloader has set up DRAM, so mtkclient never looks for one (see PRELOADER_NEEDED).
 */
export interface DownloadAgentPin {
    file: string;
    url: string;
    sha256: string;
    sizeBytes: number;
    upstreamCommit: string;
    note: string;
}

export const DA_FILE_ENV = 'STUDIO_POCKET_DA_FILE';
export const DA_FILE_UNCHECKED_ENV = 'STUDIO_POCKET_DA_FILE_UNCHECKED';
export const PRELOADER_FILE_ENV = 'STUDIO_POCKET_PRELOADER_FILE';
/** Where the fetched agent is kept, under the firmware dir. */
export const DA_DIR = ['tools', 'da'] as const;

/** The pinned download agent, checked for shape. */
export function downloadAgentPin(): DownloadAgentPin {
    const pin = pinJson as DownloadAgentPin;
    if (!/^[0-9a-f]{64}$/.test(pin.sha256) || !/^[0-9a-f]{40}$/.test(pin.upstreamCommit) || !/^[A-Za-z0-9_.-]+$/.test(pin.file)
        || !pin.url.startsWith('https://') || !pin.url.includes(pin.upstreamCommit) || !pin.url.endsWith(`/${pin.file}`) || !Number.isSafeInteger(pin.sizeBytes)) {
        throw new Error('da-pin.json is malformed');
    }
    return pin;
}

/**
 * Why the download agent could not be had: 'offline' the download failed (no connection, a blocked
 * host, an HTTP error, a stall); 'mismatch' a file (downloaded, or STUDIO_POCKET_DA_FILE's) is not the
 * pinned one; 'filesystem' the firmware folder could not be written (`folder` names it).
 */
export type DownloadAgentErrorKind = 'offline' | 'mismatch' | 'filesystem';

/** Fetching, finding or checking the download agent failed; nothing reached the player. */
export class DownloadAgentError extends InstallerError {
    constructor(message: string, public readonly kind: DownloadAgentErrorKind, public readonly folder?: string) {
        super(message);
    }
}

/** What mtkclient's legacy DA path prints when the agent asks for a DRAM configuration (Library/DA/legacy/dalegacy_lib.py). */
export const DRAM_CONFIG_LINE = 'DRAM config needed';
/** What it prints when it found a matching image in its own Loader/Preloader/ (a venv; never the bundles). */
export const PRELOADER_DETECTED_LINE = 'Detected preloader:';

export const PRELOADER_NEEDED = `The player asked for its DRAM configuration, which needs a preloader file that Studio Pocket does not distribute; nothing was written. Advanced users can point ${PRELOADER_FILE_ENV} at this player's preloader image (it is passed to mtkclient as --preloader) and try again.`;

/** A session stopped because mtkclient needed a preloader (DRAM_CONFIG_LINE) and none was given. Nothing was written. */
export class PreloaderNeededError extends InstallerError {
    readonly outcome = 'refused: preloader needed';
    constructor() {
        super(PRELOADER_NEEDED);
    }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const cannotWrite = (folder: string, error: unknown) => new DownloadAgentError(`Could not write the MediaTek download agent into ${folder}: ${message(error)}.`, 'filesystem', folder);

const overrideHint = (pin: DownloadAgentPin) => `Advanced users can download ${pin.file} themselves and point ${DA_FILE_ENV} at it (it must have SHA-256 ${pin.sha256}).`;

/**
 * The download agent's path, fetching it when needed:
 *  1. STUDIO_POCKET_DA_FILE, which must exist and have the pinned SHA-256 (STUDIO_POCKET_DA_FILE_UNCHECKED=1
 *     skips the hash and logs a warning);
 *  2. `<firmwareDir>/tools/da/<file>` when present with the pinned SHA-256 (re-hashed every time; no request);
 *  3. otherwise downloaded to `<file>.<unique id>.part` (one per run), checked, and renamed into place; any
 *     failure removes that part file. A wrong hash deletes the download.
 * Throws DownloadAgentError, whose message names the expected hash and the override variable.
 */
export interface EnsureDownloadAgentOptions {
    onProgress?: (bytes: number, total: number) => void;
    /** Tests only: a pin naming a local server. */
    pin?: DownloadAgentPin;
}

export async function ensureDownloadAgent(p: FirmwarePlatform, firmwareDir: string, log: (line: string) => void = () => undefined, options: EnsureDownloadAgentOptions = {}): Promise<string> {
    const pin = options.pin ?? downloadAgentPin();
    const { onProgress } = options;
    const overrides = await p.overrides();
    if (overrides.daFile) {
        const file = overrides.daFile;
        const st = await p.stat(file);
        if (!st.exists || st.isDir) throw new DownloadAgentError(`${DA_FILE_ENV} names ${file}, which is not a file.`, 'mismatch');
        if (overrides.daFileUnchecked) {
            log(`warning: using the download agent at ${file} (${DA_FILE_ENV}) without checking its hash (${DA_FILE_UNCHECKED_ENV}=1)`);
            return file;
        }
        const got = await p.sha256File(file);
        if (got !== pin.sha256) {
            throw new DownloadAgentError(`${file} (${DA_FILE_ENV}) has SHA-256 ${got}, not the expected ${pin.sha256}. Set ${DA_FILE_UNCHECKED_ENV}=1 to use it anyway.`, 'mismatch');
        }
        log(`Using the MediaTek download agent at ${file} (${DA_FILE_ENV}), sha256 ok`);
        return file;
    }
    const dir = p.join(firmwareDir, ...DA_DIR);
    const dest = p.join(dir, pin.file);
    const kept = await p.stat(dest);
    if (kept.exists && !kept.isDir) {
        if ((await p.sha256File(dest)) === pin.sha256) return dest;
        log(`the kept download agent ${dest} does not match the pinned hash; fetching it again`);
        await p.remove(dest).catch((error: unknown) => { throw cannotWrite(dir, error); });
    }
    await p.mkdirp(dir).catch((error: unknown) => { throw cannotWrite(dir, error); });
    // One part file per run: two fetches into one firmware folder never write, hash or rename each other's.
    const part = `${dest}.${p.uniqueId()}.part`;
    log(`Fetching the MediaTek download agent from upstream mtkclient (${pin.url})`);
    try {
        try {
            await p.downloadFile(pin.url, part, onProgress);
        } catch (error) {
            throw new DownloadAgentError(`Could not download the MediaTek download agent from ${pin.url}: ${message(error)}. ${overrideHint(pin)}`, 'offline');
        }
        const got = await p.sha256File(part);
        if (got !== pin.sha256) {
            throw new DownloadAgentError(`The downloaded MediaTek download agent has SHA-256 ${got}, not the expected ${pin.sha256}, so it was deleted. ${overrideHint(pin)}`, 'mismatch');
        }
        await p.rename(part, dest).catch((error: unknown) => { throw cannotWrite(dir, error); });
    } catch (error) {
        await p.remove(part).catch(() => undefined);
        throw error;
    }
    log(`Fetched the MediaTek download agent from upstream mtkclient (${pin.upstreamCommit}), sha256 ok`);
    return dest;
}

/** STUDIO_POCKET_PRELOADER_FILE when set (it must be a file), else undefined. */
export async function preloaderOverride(p: FirmwarePlatform): Promise<string | undefined> {
    const file = (await p.overrides()).preloaderFile;
    if (!file) return undefined;
    const st = await p.stat(file);
    if (!st.exists || st.isDir) throw new InstallerError(`${PRELOADER_FILE_ENV} names ${file}, which is not a file.`);
    return file;
}
