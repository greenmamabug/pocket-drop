// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import pinJson from './da-pin.json' with { type: 'json' };
import { InstallerError } from './errors.js';
export const DA_FILE_ENV = 'STUDIO_POCKET_DA_FILE';
export const DA_FILE_UNCHECKED_ENV = 'STUDIO_POCKET_DA_FILE_UNCHECKED';
export const PRELOADER_FILE_ENV = 'STUDIO_POCKET_PRELOADER_FILE';
/** Where the fetched agent is kept, under the firmware dir. */
export const DA_DIR = ['tools', 'da'];
/** The pinned download agent, checked for shape. */
export function downloadAgentPin() {
    const pin = pinJson;
    if (!/^[0-9a-f]{64}$/.test(pin.sha256) || !/^[0-9a-f]{40}$/.test(pin.upstreamCommit) || !/^[A-Za-z0-9_.-]+$/.test(pin.file)
        || !pin.url.startsWith('https://') || !pin.url.includes(pin.upstreamCommit) || !pin.url.endsWith(`/${pin.file}`) || !Number.isSafeInteger(pin.sizeBytes)) {
        throw new Error('da-pin.json is malformed');
    }
    return pin;
}
/** Fetching, finding or checking the download agent failed; nothing reached the player. */
export class DownloadAgentError extends InstallerError {
    kind;
    folder;
    constructor(message, kind, folder) {
        super(message);
        this.kind = kind;
        this.folder = folder;
    }
}
/** What mtkclient's legacy DA path prints when the agent asks for a DRAM configuration (Library/DA/legacy/dalegacy_lib.py). */
export const DRAM_CONFIG_LINE = 'DRAM config needed';
/** What it prints when it found a matching image in its own Loader/Preloader/ (a venv; never the bundles). */
export const PRELOADER_DETECTED_LINE = 'Detected preloader:';
export const PRELOADER_NEEDED = `The player asked for its DRAM configuration, which needs a preloader file that Studio Pocket does not distribute; nothing was written. Advanced users can point ${PRELOADER_FILE_ENV} at this player's preloader image (it is passed to mtkclient as --preloader) and try again.`;
/** A session stopped because mtkclient needed a preloader (DRAM_CONFIG_LINE) and none was given. Nothing was written. */
export class PreloaderNeededError extends InstallerError {
    outcome = 'refused: preloader needed';
    constructor() {
        super(PRELOADER_NEEDED);
    }
}
const message = (error) => (error instanceof Error ? error.message : String(error));
const cannotWrite = (folder, error) => new DownloadAgentError(`Could not write the MediaTek download agent into ${folder}: ${message(error)}.`, 'filesystem', folder);
const overrideHint = (pin) => `Advanced users can download ${pin.file} themselves and point ${DA_FILE_ENV} at it (it must have SHA-256 ${pin.sha256}).`;
export async function ensureDownloadAgent(p, firmwareDir, log = () => undefined, options = {}) {
    const pin = options.pin ?? downloadAgentPin();
    const { onProgress } = options;
    const overrides = await p.overrides();
    if (overrides.daFile) {
        const file = overrides.daFile;
        const st = await p.stat(file);
        if (!st.exists || st.isDir)
            throw new DownloadAgentError(`${DA_FILE_ENV} names ${file}, which is not a file.`, 'mismatch');
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
        if ((await p.sha256File(dest)) === pin.sha256)
            return dest;
        log(`the kept download agent ${dest} does not match the pinned hash; fetching it again`);
        await p.remove(dest).catch((error) => { throw cannotWrite(dir, error); });
    }
    await p.mkdirp(dir).catch((error) => { throw cannotWrite(dir, error); });
    // One part file per run: two fetches into one firmware folder never write, hash or rename each other's.
    const part = `${dest}.${p.uniqueId()}.part`;
    log(`Fetching the MediaTek download agent from upstream mtkclient (${pin.url})`);
    try {
        try {
            await p.downloadFile(pin.url, part, onProgress);
        }
        catch (error) {
            throw new DownloadAgentError(`Could not download the MediaTek download agent from ${pin.url}: ${message(error)}. ${overrideHint(pin)}`, 'offline');
        }
        const got = await p.sha256File(part);
        if (got !== pin.sha256) {
            throw new DownloadAgentError(`The downloaded MediaTek download agent has SHA-256 ${got}, not the expected ${pin.sha256}, so it was deleted. ${overrideHint(pin)}`, 'mismatch');
        }
        await p.rename(part, dest).catch((error) => { throw cannotWrite(dir, error); });
    }
    catch (error) {
        await p.remove(part).catch(() => undefined);
        throw error;
    }
    log(`Fetched the MediaTek download agent from upstream mtkclient (${pin.upstreamCommit}), sha256 ok`);
    return dest;
}
/** STUDIO_POCKET_PRELOADER_FILE when set (it must be a file), else undefined. */
export async function preloaderOverride(p) {
    const file = (await p.overrides()).preloaderFile;
    if (!file)
        return undefined;
    const st = await p.stat(file);
    if (!st.exists || st.isDir)
        throw new InstallerError(`${PRELOADER_FILE_ENV} names ${file}, which is not a file.`);
    return file;
}
//# sourceMappingURL=da.js.map