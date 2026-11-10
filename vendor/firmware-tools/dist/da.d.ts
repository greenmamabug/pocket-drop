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
export declare const DA_FILE_ENV = "STUDIO_POCKET_DA_FILE";
export declare const DA_FILE_UNCHECKED_ENV = "STUDIO_POCKET_DA_FILE_UNCHECKED";
export declare const PRELOADER_FILE_ENV = "STUDIO_POCKET_PRELOADER_FILE";
/** Where the fetched agent is kept, under the firmware dir. */
export declare const DA_DIR: readonly ["tools", "da"];
/** The pinned download agent, checked for shape. */
export declare function downloadAgentPin(): DownloadAgentPin;
/**
 * Why the download agent could not be had: 'offline' the download failed (no connection, a blocked
 * host, an HTTP error, a stall); 'mismatch' a file (downloaded, or STUDIO_POCKET_DA_FILE's) is not the
 * pinned one; 'filesystem' the firmware folder could not be written (`folder` names it).
 */
export type DownloadAgentErrorKind = 'offline' | 'mismatch' | 'filesystem';
/** Fetching, finding or checking the download agent failed; nothing reached the player. */
export declare class DownloadAgentError extends InstallerError {
    readonly kind: DownloadAgentErrorKind;
    readonly folder?: string | undefined;
    constructor(message: string, kind: DownloadAgentErrorKind, folder?: string | undefined);
}
/** What mtkclient's legacy DA path prints when the agent asks for a DRAM configuration (Library/DA/legacy/dalegacy_lib.py). */
export declare const DRAM_CONFIG_LINE = "DRAM config needed";
/** What it prints when it found a matching image in its own Loader/Preloader/ (a venv; never the bundles). */
export declare const PRELOADER_DETECTED_LINE = "Detected preloader:";
export declare const PRELOADER_NEEDED = "The player asked for its DRAM configuration, which needs a preloader file that Studio Pocket does not distribute; nothing was written. Advanced users can point STUDIO_POCKET_PRELOADER_FILE at this player's preloader image (it is passed to mtkclient as --preloader) and try again.";
/** A session stopped because mtkclient needed a preloader (DRAM_CONFIG_LINE) and none was given. Nothing was written. */
export declare class PreloaderNeededError extends InstallerError {
    readonly outcome = "refused: preloader needed";
    constructor();
}
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
export declare function ensureDownloadAgent(p: FirmwarePlatform, firmwareDir: string, log?: (line: string) => void, options?: EnsureDownloadAgentOptions): Promise<string>;
/** STUDIO_POCKET_PRELOADER_FILE when set (it must be a file), else undefined. */
export declare function preloaderOverride(p: FirmwarePlatform): Promise<string | undefined>;
