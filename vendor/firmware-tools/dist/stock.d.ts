import type { FirmwareManifest } from './manifest.js';
import { type Scatter } from './scatter.js';
import type { FirmwarePlatform } from './platform.js';
/**
 * Verifies a user-supplied stock firmware package against the manifest and extracts
 * the two files Studio Pocket needs. The package is never downloaded by this code.
 */
export interface StockInputs {
    systemImage: string;
    scatterPath: string;
    scatter: Scatter;
    systemSha256: string;
    scatterSha256: string;
    zipSha256?: string;
}
export declare class StockError extends Error {
}
export declare const STOCK_FILES: readonly ["system.img", "MT6582_Android_scatter.txt"];
export interface StockProgress {
    stage: 'hash-zip' | 'extract' | 'hash-system';
    bytes: number;
    total: number;
}
/**
 * `source` is either the stock zip (hashed against the manifest, then the two files are
 * extracted into `<workDir>/stock`) or a directory already holding them.
 */
export declare function prepareStock(p: FirmwarePlatform, source: string, manifest: FirmwareManifest, workDir: string, log?: (line: string) => void, onProgress?: (e: StockProgress) => void): Promise<StockInputs>;
/**
 * Which known firmware a user-supplied package is, by hash: the zip's SHA-256 for a zip, the
 * system.img's for an unpacked folder. Returns null when nothing matches, so callers can say
 * "not a supported firmware" with the versions they do know.
 */
export declare function identifyStock(p: FirmwarePlatform, source: string, manifests: FirmwareManifest[], onProgress?: (bytes: number, total: number) => void): Promise<{
    manifest: FirmwareManifest;
    sha256: string;
    kind: 'zip' | 'dir';
} | null>;
