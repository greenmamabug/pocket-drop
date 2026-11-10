import { type DeviceIdentity } from './device.js';
import { type DownloadAgentPin } from './da.js';
import { InstallerError } from './errors.js';
import { type FlashPlan } from './flashplan.js';
import { type DeviceLayout } from './layout.js';
import { type FirmwareManifest } from './manifest.js';
import { type MtkProgress } from './mtk.js';
import type { FirmwarePlatform, MtkPlan } from './platform.js';
import { StockError } from './stock.js';
import { type VerifyReport } from './verify.js';
/**
 * The guided installer's engine. Pure orchestration over FirmwarePlatform.
 *
 * Device-sourced flow (the product path since 2026-10-19; no ROM download), one folder per
 * player under units/<eMMC CID>/ (see ./units.ts); every function takes an optional unitId and
 * otherwise works on the player read last:
 *   readDeviceSystem          read a window of the player's eMMC over mtkclient → measure where
 *                             the system partition is (two markers) → keep it as this unit's
 *                             restore image → identify the build and the stock launcher → fsck
 *   prepareInstallFromDevice  patch that copy with the player APK → independently verify
 *   planWrite / executeWrite  one mtkclient session: a probe read that names the player (a
 *                             different one aborts it), write the image, read head and tail
 *                             (and optionally the whole image) back
 *   verifyWrite               compare the read-backs with the image
 *
 * Package flow (prepareInstall / planFlash) is kept for the manual Windows kit built from the
 * archive zip; it lives in <firmware>/package/, apart from every player. Nothing here writes to a device except executeWrite, which only ever runs a
 * plan produced by planWrite after the caller has obtained the user's explicit approval.
 */
export declare const OUT_DIR = "out";
export declare const STOCK_DIR = "stock";
export declare const DEVICE_DIR = "device";
export declare const PATCHED_IMAGE = "system.studiopocket.img";
export declare const STOCK_IMAGE = "system.img";
export declare const WINDOW_IMAGE = "window.img";
export declare const IDENTITY_FILE = "device-identity.json";
/** Scratch name for the system partition cut out of a read, before it is identified and routed. */
export declare const READ_IMAGE = "read.img";
/** Where a read of a player that already runs Studio Pocket goes; never mixed with stock/ or the device reports. */
export declare const UPGRADE_DIR = "upgrade";
export declare const UPGRADE_REPORT_FILE = "read-report.json";
export declare const UPGRADE_IMAGE = "system.img";
export declare const PROBE_FILE = "identity-probe.bin";
export declare const HEAD_FILE = "verify-head.bin";
export declare const TAIL_FILE = "verify-tail.bin";
export declare const FULL_FILE = "verify-full.img";
export declare const SCATTER_FILE = "MT6582_Android_scatter.txt";
export declare const REPORT_FILE = "build-report.json";
export declare const RECORD_FILE = "install-record.json";
export declare const DOWNLOAD_AGENT = "MTK_AllInOne_DA.bin";
export declare const FLASH_TOOL_EXE = "flash_tool.exe";
/** How many mtkclient log lines a report keeps. */
export declare const MTK_LOG_KEEP = 200;
export type FlashAction = 'install' | 'restore' | 'upgrade';
export type StockOrigin = 'package' | 'device';
export interface PrepareInputs {
    /** rom_y2.zip or a directory holding system.img + the scatter file. */
    source: string;
    manifest: FirmwareManifest;
    apk: string;
    apkVersion?: string;
    firmwareDir: string;
}
export type PrepareStage = 'verify-stock' | 'copy-stock' | 'patch' | 'verify' | 'done';
export interface PrepareCallbacks {
    log: (line: string) => void;
    stage: (stage: PrepareStage) => void;
    progress: (label: string, bytes: number, total: number) => void;
}
export interface PrepareReport {
    firmwareVersion: string;
    builtAt: string;
    generator: string;
    stock: {
        origin: StockOrigin;
        zipSha256?: string;
        systemSha256: string;
        scatterSha256?: string;
        systemImage: string;
        scatterPath?: string;
        unitUuid?: string;
    };
    apk: {
        path: string;
        sha256: string;
        sizeBytes: number;
        version?: string;
        packageName: string;
        signerSha256: string;
    };
    output: {
        path: string;
        sha256: string;
        sizeBytes: number;
        fsckFixExit: number;
    };
    compatibility: string[];
    verification: VerifyReport;
    debugfsScript: string[];
    /** Set for an upgrade: the APK that was installed before. */
    upgradeFrom?: {
        apkSha256: string;
    };
}
export { InstallerError };
/** The player already runs exactly the APK being installed; nothing was prepared. */
export declare class UpToDateError extends InstallerError {
}
/** A write session was killed during its probe read: a different player answered. Nothing was written. */
export declare class WrongPlayerError extends InstallerError {
    readonly expected: string;
    readonly connected: string | null;
    readonly outcome = "refused: wrong player";
    constructor(message: string, expected: string, connected: string | null);
}
/** A write session was killed because the player never said which it was before a command ran. Nothing was written. */
export declare class UnconfirmedPlayerError extends InstallerError {
    readonly outcome = "refused: unconfirmed player";
}
/** The mtkclient in use has no working player identity check (runner code -4). */
export declare class UncheckedToolError extends InstallerError {
    readonly sessionStarted: boolean;
    readonly outcome = "refused: unchecked tool";
    /**
     * False when the runner flags the -4 as probe-refused (RunResult.probeRefused): the tool failed the
     * capability probe and was never handed the plan, so nothing was written. Without the flag, the line rule
     * is the fallback: false only when the run's last line is the probe-path line (UNCHECKED_TOOL_LINE). Any
     * other last line, including none at all, counts as started (the session ran and was stopped at its first
     * command) and gets the cautious message. This fails safe: on the desktop the last line arrives as a
     * job-log event and the result on another channel, with no ordering guarantee, and a lost line must never
     * tell a parent "nothing was written" after a session that started.
     */
    constructor(message: string, sessionStarted: boolean);
}
export declare function prepareInstall(p: FirmwarePlatform, inputs: PrepareInputs, cb: PrepareCallbacks): Promise<PrepareReport>;
/** The unit's last install build report, if the images it names still exist with the recorded sizes. */
export declare function loadPrepareReport(p: FirmwarePlatform, firmwareDir: string, unitId?: string): Promise<PrepareReport | null>;
/** The unit's last upgrade build report (upgrade/out/), if its images still exist. */
export declare function loadUpgradePrepareReport(p: FirmwarePlatform, firmwareDir: string, unitId?: string): Promise<PrepareReport | null>;
/** The package flow's build report (package/out/), if its images still exist. */
export declare function loadPackagePrepareReport(p: FirmwarePlatform, firmwareDir: string): Promise<PrepareReport | null>;
export type DeviceReadStage = 'read' | 'measure' | 'extract' | 'identify' | 'fsck' | 'done';
export interface DeviceReadCallbacks {
    log: (line: string) => void;
    stage: (stage: DeviceReadStage) => void;
    progress: (label: string, bytes: number, total: number) => void;
    /** Every mtkclient line, already classified (null when the line carries nothing). */
    mtk?: (progress: MtkProgress | null, line: string) => void;
}
export interface DeviceReadInputs {
    firmwareDir: string;
    /** Every firmware this build can patch; the window is taken from them and the build matched against them. */
    manifests: FirmwareManifest[];
    /** Tests only: the download agent's pin (a local server and a stand-in file). */
    daPin?: DownloadAgentPin;
}
export interface DeviceReadReport {
    readAt: string;
    state: 'stock';
    /** The folder under units/: the eMMC CID, or 'legacy' for a read migrated from the flat layout. */
    unitId: string;
    /** The eMMC CID the session printed; null in reports migrated from the flat layout. */
    emmcCid: string | null;
    layout: DeviceLayout;
    identity: DeviceIdentity;
    /** This unit's own system partition exactly as read (only checked, never repaired), kept for restore. */
    stockImage: string;
    stockSha256: string;
    stockSizeBytes: number;
    /** e2fsck -fn exit on the raw read; 4 or more: errors the prepared copy's e2fsck -fy repairs. */
    fsckExit: number;
    mtkLog: string[];
}
/** A read of a player that already runs Studio Pocket: the source of an upgrade, never a restore image. */
export interface UpgradeReadReport {
    readAt: string;
    state: 'studiopocket';
    unitId: string;
    emmcCid: string | null;
    layout: DeviceLayout;
    identity: DeviceIdentity;
    /** The installed system image as read, under the unit's upgrade/. */
    image: string;
    imageSha256: string;
    imageSizeBytes: number;
    installedApkSha256: string;
    fsckExit: number;
    mtkLog: string[];
}
export type AnyDeviceReadReport = DeviceReadReport | UpgradeReadReport;
/**
 * The read (read-only): reads the window into tmp/read-<id>/ (the player's eMMC id is not known
 * until the session prints it; read folders a killed read left behind are removed first),
 * measures the layout and cuts the system partition out there. Only after identifying it,
 * checking it and hashing it is the player's units/<cid>/ written (unit.json, current-unit) and
 * the image routed: a stock unit's goes to stock/ as its restore copy, exactly as read (with
 * device-identity.json and device-layout.json); a unit that already runs Studio Pocket goes to
 * upgrade/ with its own report and nothing else is touched. A refused read leaves no unit and
 * never leaves a half-replaced restore copy.
 * Throws InstallerError (with the last mtkclient error line) when the device could not be
 * read, when the session printed no eMMC id, when the end marker is missing, or when the
 * content is not a firmware this tool knows.
 */
export declare function readDeviceSystem(p: FirmwarePlatform, inputs: DeviceReadInputs, cb: DeviceReadCallbacks): Promise<AnyDeviceReadReport>;
/** The unit's last stock read, if its kept copy still exists at the recorded size. */
export declare function loadDeviceReadReport(p: FirmwarePlatform, firmwareDir: string, unitId?: string): Promise<DeviceReadReport | null>;
/** The unit's last read while it ran Studio Pocket, if its image still exists at the recorded size. */
export declare function loadUpgradeReadReport(p: FirmwarePlatform, firmwareDir: string, unitId?: string): Promise<UpgradeReadReport | null>;
/**
 * Whether the stock copy kept on this computer belongs to the player that was read for an
 * upgrade. The debugfs patch keeps the ext4 UUID, so an installed unit carries the UUID of
 * its own stock filesystem; start and size must match too.
 */
export declare function restoreAvailableFor(stock: DeviceReadReport | null, upgrade: UpgradeReadReport): boolean;
export interface PrepareFromDeviceInputs {
    firmwareDir: string;
    /** The player to prepare for; default: the one read last. */
    unitId?: string;
    apk: string;
    apkVersion?: string;
    /** Upgrade only: accept an APK signed with a different key than the installed one (CLI --allow-new-signer; the desktop never sets it). */
    allowNewSigner?: boolean;
}
/** Why an upgrade signed with another key is refused: Android would not install it over the old one's data. */
export declare const NEW_SIGNER_REFUSAL = "The new Studio Pocket is signed with a different key than the one on the player. Restore the player to its original software first, then set it up again.";
/** Why an upgrade is refused when the installed APK's signer cannot be read: the key check cannot be made. */
export declare const UNREADABLE_SIGNER_REFUSAL = "The signing key of the Studio Pocket already on the player could not be read, so the upgrade cannot be checked. Restore the player to its original software first, then set it up again, or run with --allow-new-signer from the command line.";
/** Patches the unit's own system image (from readDeviceSystem) and verifies the result. */
export declare function prepareInstallFromDevice(p: FirmwarePlatform, inputs: PrepareFromDeviceInputs, cb: PrepareCallbacks): Promise<PrepareReport>;
/**
 * Replaces the installed StudioPocket.apk in the image read from the player (readDeviceSystem with
 * state 'studiopocket') and verifies the result. Throws UpToDateError before touching anything when
 * the player already runs this APK.
 */
export declare function prepareUpgradeFromDevice(p: FirmwarePlatform, inputs: PrepareFromDeviceInputs, cb: PrepareCallbacks): Promise<PrepareReport>;
export interface WriteInputs {
    firmwareDir: string;
    action: FlashAction;
    /** The player to write; default: the one read last. */
    unitId?: string;
    /** 'edges' (default) reads the first and last MiB back; 'full' also reads the whole image back. */
    verify?: 'edges' | 'full';
}
export interface WriteArtifacts {
    action: FlashAction;
    imagePath: string;
    imageSha256: string;
    imageSizeBytes: number;
    layout: DeviceLayout;
    unitUuid: string;
    firmwareVersion: string;
    plan: MtkPlan;
    firmwareDir: string;
    /** The unit written: an eMMC CID, or 'legacy'. */
    unitId: string;
    /** The eMMC CID the session must report before anything is written; null for the legacy unit. */
    expectCid: string | null;
    verify: 'edges' | 'full';
    probeFile: string;
    headFile: string;
    tailFile: string;
    /** The whole-image read-back, when verify is 'full'. */
    fullFile?: string;
    checklist: string[];
}
/**
 * Builds the one mtkclient session that writes the image and reads head and tail back. The
 * image is re-hashed so a plan can never name an image that changed since it was verified,
 * and it must fit the partition measured on the unit it came from.
 */
export declare function planWrite(p: FirmwarePlatform, inputs: WriteInputs, log?: (line: string) => void): Promise<WriteArtifacts>;
export interface WriteVerification {
    ok: boolean;
    head: 'match' | 'differs' | 'missing';
    tail: 'match' | 'differs' | 'missing';
    /** The whole-image read-back; 'skipped' unless the write asked for it. */
    full: 'match' | 'differs' | 'skipped';
    detail: string;
}
/**
 * Compares the head/tail read-backs with the image (tail beyond the image length counts as
 * zeros) and, for a full verification, the hash of the whole read-back with the image's.
 */
export declare function verifyWrite(p: FirmwarePlatform, a: WriteArtifacts): Promise<WriteVerification>;
export interface WriteOutcome {
    code: number;
    mtkLog: string[];
    verification: WriteVerification;
    /** The eMMC CID the session printed, or null when it printed none. */
    emmcCid: string | null;
    /**
     * Whether the legacy unit took the session's CID ('none': not a legacy write, or not
     * verified, or no CID printed). A failed adoption never undoes a verified write; the
     * legacy unit then stays as it was.
     */
    adoption: 'none' | 'done' | {
        error: string;
    };
}
/**
 * THE destructive step. Runs the plan from planWrite in one mtkclient session and verifies
 * the read-backs. Callers must have obtained explicit human approval before calling this.
 *
 * With an expected CID the runner first probes the mtkclient in use for its identity gate and
 * refuses one without it before handing over the plan (UncheckedToolError, sessionStarted false).
 * It kills the session during the probe read when another player answers (WrongPlayerError) or
 * none says which it is (UnconfirmedPlayerError), or, as a second net, when a tool that passed the
 * probe starts its plan without confirming the player itself (UncheckedToolError, sessionStarted
 * true); nothing has been written then, and the caller records the refusal. After a verified write from the
 * legacy unit, the CID the session printed is adopted (units/legacy/ becomes units/<cid>/).
 */
export declare function executeWrite(p: FirmwarePlatform, a: WriteArtifacts, onMtk?: (progress: MtkProgress | null, line: string) => void): Promise<WriteOutcome>;
export interface FlashInputs {
    manifest: FirmwareManifest;
    /** The firmware dir; the package flow reads and writes under its package/. */
    firmwareDir: string;
    action: FlashAction;
    /** Path of SP Flash Tool's flash_tool.exe, or null when the plan is for manual use. */
    flashToolExe: string | null;
}
export interface FlashArtifacts {
    action: FlashAction;
    plan: FlashPlan;
    imagePath: string;
    imageSha256: string;
    xmlPath: string;
    checklistPath: string;
    downloadAgentPath: string;
    downloadAgentPresent: boolean;
}
/**
 * Writes the console-mode XML for one action. Re-hashes the image it points at so a plan can
 * never reference an image that changed since it was verified. Package-origin reports only:
 * a device-sourced image has no scatter to plan against (and the scatter is not the unit's layout).
 */
export declare function planFlash(p: FirmwarePlatform, inputs: FlashInputs, log?: (line: string) => void): Promise<FlashArtifacts>;
export interface InstallRecordEntry {
    at: string;
    action: FlashAction | 'prepare' | 'read';
    firmwareVersion: string;
    stockSystemSha256: string;
    imageSha256: string;
    apkSha256?: string;
    apkVersion?: string;
    /** SHA-256 of the APK's signing certificate (./apk.ts). */
    apkSigner?: string;
    /** What the tool reported: exit code, or 'manual' when the user flashed by hand. */
    outcome: string;
    origin?: StockOrigin;
    /** ext4 UUID of the unit's system filesystem as read: identifies the player across sessions. */
    unitUuid?: string;
    /** The units/ folder the entry is about (eMMC CID or 'legacy'). */
    unitId?: string;
    deviceId?: string;
    notes?: string;
}
/** Appends to install-record.json (one history per computer, at the top of the firmware dir). */
export declare function recordInstall(p: FirmwarePlatform, firmwareDir: string, entry: InstallRecordEntry): Promise<InstallRecordEntry[]>;
export declare function readInstallRecord(p: FirmwarePlatform, firmwareDir: string): Promise<InstallRecordEntry[]>;
export { StockError };
