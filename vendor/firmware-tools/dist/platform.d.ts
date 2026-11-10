/**
 * Everything firmware-tools needs from the host, so the same logic runs under Node (CLI,
 * tests) and inside the desktop webview (scoped Tauri commands). No module in this package
 * other than ./node.ts and ./cli.ts imports a Node built-in.
 */
export interface RunResult {
    /**
     * Exit code; -1 failed to run, -2 a different player answered (killed, or mtkclient refused: exit 102),
     * -3 no player id was printed before the first read (killed, or mtkclient refused: exit 103),
     * -4 the mtkclient in use has no player identity check: normally refused by the capability probe before the plan
     * was handed over (last line UNCHECKED_TOOL_LINE); as a second net, a tool that passed the probe but started a
     * command without confirming the player is killed (last line UNCHECKED_TOOL_STARTED_LINE).
     */
    code: number;
    /**
     * True only on the probe-path -4: the tool failed the capability probe and was never handed the plan.
     * Absent or false everywhere else (including the second-net -4). Runners set it so the installer need not
     * rely on the last log line, which on the desktop travels on a different channel from the result.
     */
    probeRefused?: boolean;
    stdout: string;
    stderr: string;
}
export interface E2fsTools {
    debugfs: string;
    e2fsck: string;
    dumpe2fs: string;
}
export type E2fsToolName = 'debugfs' | 'e2fsck' | 'dumpe2fs';
/**
 * One mtkclient "script" run: the lines are written to `<dir>/<id>.mtk` and mtkclient is
 * started in script mode with cwd = dir (it drops `.state` and `hwparam.json` there). Each
 * line is `ro <hex start> <hex length> <file>` or `wo <hex start> <hex length> <image>`;
 * see ./mtk.ts for the only two plan shapes this package produces.
 */
export interface MtkPlan {
    id: string;
    dir: string;
    lines: string[];
    /**
     * The download agent mtkclient is given by path (`--loader <daFile>`, before `script`): the file
     * ensureDownloadAgent (./da.ts) fetched and checked. The bundles carry no Loader/ folder.
     */
    daFile?: string;
    /** STUDIO_POCKET_PRELOADER_FILE, passed as `--preloader <file>` (the player asked for a DRAM configuration). */
    preloaderFile?: string;
}
/** Advanced users' overrides from the host's environment; a variable that is not set is absent. */
export interface FirmwareOverrides {
    /** STUDIO_POCKET_DA_FILE: a download agent to use instead of the fetched one (still hash-checked). */
    daFile?: string;
    /** STUDIO_POCKET_DA_FILE_UNCHECKED=1: use daFile even when its hash is not the pinned one. */
    daFileUnchecked?: boolean;
    /** STUDIO_POCKET_PRELOADER_FILE: a preloader image for mtkclient's DRAM configuration. */
    preloaderFile?: string;
}
export interface MtkAvailability {
    ok: boolean;
    detail: string;
    binary?: string;
}
export interface FirmwarePlatform {
    join(...parts: string[]): string;
    dirname(p: string): string;
    basename(p: string): string;
    readText(file: string): Promise<string>;
    writeText(file: string, text: string): Promise<void>;
    stat(file: string): Promise<{
        exists: boolean;
        size: number;
        isDir: boolean;
    }>;
    readdir(dir: string): Promise<{
        name: string;
        isDir: boolean;
    }[]>;
    /** Up to `len` bytes from `offset`; shorter at end of file. */
    readBytes(file: string, offset: number, len: number): Promise<Uint8Array>;
    copyFile(from: string, to: string, onProgress?: (bytes: number, total: number) => void): Promise<void>;
    /** Copies exactly `len` bytes from `offset` of `from` into a new file `to` (shorter if the source ends). */
    copyRange(from: string, offset: number, len: number, to: string, onProgress?: (bytes: number, total: number) => void): Promise<void>;
    truncate(file: string, size: number): Promise<void>;
    remove(file: string): Promise<void>;
    /** Moves a file within the firmware folder, replacing `to` if it exists. */
    rename(from: string, to: string): Promise<void>;
    mkdirp(dir: string): Promise<void>;
    sha256File(file: string, onProgress?: (bytes: number) => void): Promise<string>;
    /** SHA-256 (lowercase hex) of bytes in memory. */
    sha256Bytes(data: Uint8Array): Promise<string>;
    /** Raw SHA-1 or SHA-256 digest of bytes in memory (APK v1 signature digests). */
    digestBytes(algorithm: 'sha1' | 'sha256', data: Uint8Array): Promise<Uint8Array>;
    /**
     * RSASSA-PKCS1-v1_5 verification of `signature` over `data` with an RSA public key given as
     * SubjectPublicKeyInfo DER. Never throws: anything the host cannot parse or handle is `false`.
     */
    verifyRsaPkcs1(spkiDer: Uint8Array, hash: 'sha1' | 'sha256', data: Uint8Array, signature: Uint8Array): Promise<boolean>;
    /** Decompresses raw DEFLATE data (a zip entry stored with method 8). */
    inflateRaw(data: Uint8Array): Promise<Uint8Array>;
    /** Extracts exactly the named entries (flattened) into `destDir`. */
    zipExtract(zip: string, names: string[], destDir: string, onProgress?: (bytes: number, total: number) => void): Promise<void>;
    /** Where the e2fsprogs binaries are; throws ToolError-like when any is missing. */
    locateE2fsTools(): Promise<E2fsTools>;
    /** Runs one e2fsprogs tool with an argv; `script` lines replace the literal `<script>` argument. */
    runE2fs(tool: E2fsToolName, args: string[], script?: string[]): Promise<RunResult>;
    /**
     * Downloads `url` (http/https, redirects followed) into `dest`, replacing it. Rejects on any HTTP
     * error or a body cut short; the caller checks the content's hash.
     */
    downloadFile(url: string, dest: string, onProgress?: (bytes: number, total: number) => void): Promise<void>;
    /** STUDIO_POCKET_DA_FILE and friends, read from the host's environment on each call. */
    overrides(): Promise<FirmwareOverrides>;
    /** Whether mtkclient can be run from here, and where it is. */
    mtkAvailable(): Promise<MtkAvailability>;
    /**
     * Runs one mtkclient script plan, streaming every output line (split on \n and \r so
     * progress bars arrive as they are drawn) to `onLog`; resolves with the exit code. With
     * `expectCid`, mtkclient is told the expected id (STUDIO_POCKET_EXPECT_CID) and the session is
     * killed (code -2 / -3 / -4, final log line says why) when the printed eMMC id differs, is
     * missing before the first read, or the tool starts its plan without confirming the player.
     */
    runMtk(plan: MtkPlan, onLog: (line: string) => void, options?: {
        expectCid?: string;
    }): Promise<RunResult>;
    /** A directory for short-lived files (readbacks, context files). */
    tmpDir(): string;
    /** Unique suffix for temp file names. */
    uniqueId(): string;
}
