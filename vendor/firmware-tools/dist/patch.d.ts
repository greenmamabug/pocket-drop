import type { FirmwarePlatform } from './platform.js';
/**
 * Replacing the stock launcher in an ext4 system image, offline, with debugfs.
 * This is the Y2Player method (MIT, tools/firmware/integrate_launcher.py; notice in
 * docs/licensing/Y2Player-MIT.txt) ported
 * to a pure function plus one runner. Only the system partition image is touched;
 * boot, preloader, recovery and NVRAM are never read or written by this code.
 */
export declare const STOCK_LAUNCHER = "/priv-app/MyLauncher.apk";
export declare const STOCK_LAUNCHER_ODEX = "/priv-app/MyLauncher.odex";
export declare const TARGET_APK_NAME = "StudioPocket.apk";
export declare const TARGET_APK = "/priv-app/StudioPocket.apk";
/** Matches every stock file in /system/priv-app; includes the trailing NUL the kernel stores. */
export declare const SELINUX_CONTEXT = "u:object_r:system_file:s0\0";
export declare const APK_MODE = "0100644";
/** install: replace the stock launcher; upgrade: replace an installed StudioPocket.apk. */
export type PatchMode = 'install' | 'upgrade';
export interface PatchPlan {
    /** Absolute path of the APK on the host, written into the image. */
    apkPath: string;
    /** Absolute path of a file containing SELINUX_CONTEXT bytes. */
    contextPath: string;
    /** Whether MyLauncher.odex exists in the image (stock 3.2.1 has none). */
    removeOdex: boolean;
    /** Default 'install'. */
    mode?: PatchMode;
}
/**
 * Host paths inside a debugfs script are double-quoted: debugfs' parser splits on
 * whitespace but honours quotes, and the desktop's data directory contains a space.
 */
export declare function quoteHostPath(value: string): string;
/** The exact debugfs command sequence. Pure, so tests can pin it. */
export declare function buildDebugfsScript(plan: PatchPlan): string[];
export interface PatchOptions {
    stockImage: string;
    apk: string;
    out: string;
    workDir: string;
    /** Default 'install'. */
    mode?: PatchMode;
    log?: (line: string) => void;
    onProgress?: (e: {
        stage: 'copy' | 'hash';
        bytes: number;
        total: number;
    }) => void;
}
export interface PatchResult {
    out: string;
    outBytes: number;
    stockSha256: string;
    apkSha256: string;
    outSha256: string;
    /** From the APK inspection (./apk.ts) that cleared it for writing. */
    apkPackageName: string;
    apkSignerSha256: string;
    fsckCode: number;
    script: string[];
    /** Scan codes that gained WAKE in the key layout (./keylayout.ts); empty when nothing needed changing. */
    wakeKeysAdded: number[];
}
export declare function patchSystemImage(p: FirmwarePlatform, options: PatchOptions): Promise<PatchResult>;
