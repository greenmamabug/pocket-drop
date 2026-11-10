import type { FirmwarePlatform, RunResult } from './platform.js';
/** Thin, argv-only wrappers around e2fsprogs. GPL tools are invoked, never linked or copied. */
export declare class ToolError extends Error {
}
/** Runs a debugfs command script (one command per line) against an image. */
export declare function debugfsScript(p: FirmwarePlatform, image: string, commands: string[], write: boolean): Promise<RunResult>;
export declare function debugfsQuery(p: FirmwarePlatform, image: string, command: string): Promise<string>;
/**
 * e2fsck exit codes: 0 clean, 1 errors corrected, 2 corrected + reboot advised,
 * 4 uncorrected, 8 operational error, 16 usage, 32 cancelled, 128 shared library.
 */
export declare function e2fsck(p: FirmwarePlatform, image: string, mode: 'fix' | 'check'): Promise<RunResult>;
export declare function dumpe2fsHeader(p: FirmwarePlatform, image: string): Promise<Record<string, string>>;
