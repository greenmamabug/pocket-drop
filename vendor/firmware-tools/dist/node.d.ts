import type { E2fsTools, FirmwareOverrides, FirmwarePlatform, MtkAvailability, MtkPlan, RunResult } from './platform.js';
import { type FirmwareManifest } from './manifest.js';
import { type ImageKind } from './ext4.js';
import { type StockInputs } from './stock.js';
import { type PatchOptions, type PatchResult } from './patch.js';
import { type VerifyOptions, type VerifyReport } from './verify.js';
/**
 * Runs an external tool with an argument vector. There is deliberately no shell
 * involved anywhere in this package: paths and names are passed as discrete argv
 * entries, so nothing a caller supplies can be interpreted as a command.
 */
export declare function run(file: string, args: string[], options?: {
    cwd?: string;
    maxBuffer?: number;
}): Promise<RunResult>;
/**
 * Where `scripts/build-e2fsprogs.sh` puts e2fsprogs, searched before PATH so the CLI runs the same
 * binaries as the app: the desktop app's resources folder when it exists, else the repo's
 * `build/e2fsprogs/<os>` (the script's output in a tree without the desktop app, such as the public
 * repo). STUDIO_POCKET_E2FS_DIR replaces both: a build made elsewhere, or an unpacked release archive.
 * Read on each call, so a test or the CLI can set it after import.
 */
export declare function bundledToolDir(platform?: NodeJS.Platform, exists?: (dir: string) => boolean): string;
/** Extra directories searched for e2fsprogs on hosts where it is keg-only (Homebrew). */
export declare const EXTRA_TOOL_DIRS: string[];
/** Searches `firstDirs`, then PATH, then `extraDirs`, for an executable `name`. */
export declare function findTool(name: string, extraDirs?: string[], firstDirs?: string[]): Promise<string | null>;
export declare function locateE2fsTools(bundledDirs?: string[]): Promise<E2fsTools>;
/** Streaming SHA-256 of a file, hex encoded. Images are ~860 MB so never read them whole. */
export declare function sha256File(file: string, onProgress?: (bytes: number) => void): Promise<string>;
export declare function sha256Bytes(data: Uint8Array | string): string;
/**
 * mtkclient: `STUDIO_POCKET_MTK_BIN`, else the repo's patched venv
 * (firmware/tools/mtkclient-venv/bin/mtk, see scripts/patch-mtkclient.py), else PATH.
 */
export declare function findMtk(): Promise<string | null>;
export declare function mtkAvailable(): Promise<MtkAvailability>;
/**
 * mtkclient's global options go BEFORE the `script` subcommand (its subparser takes none):
 * `--loader <daFile>` (the download agent by path; the bundles have no Loader/ folder) and
 * `--preloader <file>` (STUDIO_POCKET_PRELOADER_FILE). Mirrors `argv_for` in apps/desktop/src-tauri/src/mtkclient.rs.
 */
export declare function mtkArgv(planFile: string, platform?: NodeJS.Platform, files?: Pick<MtkPlan, 'daFile' | 'preloaderFile'>): string[];
/** How long a download may go without receiving a byte before it is abandoned. There is no overall cap. */
export declare const DOWNLOAD_IDLE_TIMEOUT_MS = 60000;
/**
 * GET `url` (redirects followed) streamed into `dest`, replacing it; a non-2xx answer, a body
 * shorter than its Content-Length or `idleMs` without a byte (the timer restarts on every chunk)
 * rejects and removes `dest`.
 */
export declare function downloadFile(url: string, dest: string, onProgress?: (bytes: number, total: number) => void, idleMs?: number): Promise<void>;
/** STUDIO_POCKET_DA_FILE, STUDIO_POCKET_DA_FILE_UNCHECKED and STUDIO_POCKET_PRELOADER_FILE, read now. */
export declare function envOverrides(env?: NodeJS.ProcessEnv): FirmwareOverrides;
/**
 * The capability probe: runs `binary` with no arguments and STUDIO_POCKET_PROBE=1 (cwd `cwd`, `env`
 * otherwise as the session's), and resolves true only when it exits 0 having printed exactly
 * IDENTITY_GATE_LINE. A patched mtkclient answers before parsing any argument or opening a port;
 * an unpatched one prints its usage and exits 2. Only lines starting `Studio Pocket - ` reach `onLog`,
 * so an old tool's usage text never reaches a parent-facing screen. A probe still running after
 * `timeoutMs` is killed and fails. Rejects when the tool cannot be started at all.
 */
export declare function probeTool(binary: string, cwd: string, env: NodeJS.ProcessEnv, onLog: (line: string) => void, timeoutMs?: number): Promise<boolean>;
/** Pocket Drop: retain startup failures for the app's error details. Never opens a player. */
export declare function probeToolReport(binary: string, cwd: string, env: NodeJS.ProcessEnv, onLog: (line: string) => void, timeoutMs?: number): Promise<MtkProbeReport>;
export interface MtkProbeReport {
    passed: boolean;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    code: number | null;
    signal: string | null;
}
/**
 * Runs one mtkclient script plan with cwd = plan.dir, streaming lines split on \n and \r.
 * With `expectCid` the tool must first pass the capability probe (`probeTool`): one that fails it
 * is refused with -4 and UNCHECKED_TOOL_LINE before the plan file is even written. The session
 * then gets STUDIO_POCKET_EXPECT_CID so the patched tool checks the player itself (exit 102 another
 * player, 103 none printed), and the gate kills the session on a wrong or missing id or a
 * confirmation naming another player. As a second net, a tool that passed the probe but reaches
 * its first command without its own confirmation is killed with -4 and UNCHECKED_TOOL_STARTED_LINE.
 */
export declare function runMtk(plan: MtkPlan, onLog: (line: string) => void, options?: {
    expectCid?: string;
}): Promise<RunResult>;
export declare const nodePlatform: FirmwarePlatform;
/** Node conveniences: the functions above bound to the Node file system, with plain paths. */
export declare const loadManifest: (file: string) => Promise<FirmwareManifest>;
export declare const identifyImage: (file: string) => Promise<ImageKind>;
export declare const prepareStock: (source: string, manifest: FirmwareManifest, workDir: string, log?: (line: string) => void) => Promise<StockInputs>;
export declare const patchSystemImage: (options: PatchOptions & {
    tools?: E2fsTools;
}) => Promise<PatchResult>;
export declare const verifyPatchedImage: (options: VerifyOptions & {
    tools?: E2fsTools;
}) => Promise<VerifyReport>;
export declare const debugfsScript: (_tools: E2fsTools | null, image: string, commands: string[], write: boolean) => Promise<RunResult>;
