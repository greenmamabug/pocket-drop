import type { FirmwarePlatform } from './platform.js';
/**
 * Independent re-open of a patched image. Mirrors Y2Player's verify_images.py (MIT; notice in
 * docs/licensing/Y2Player-MIT.txt):
 * stock launcher gone, our APK present with root:root 0644 and the system_file
 * label, byte-identical readback, clean fsck, and partition-size fit.
 */
export interface VerifyOptions {
    image: string;
    expectedApkSha256: string;
    partitionSizeBytes: number;
    log?: (line: string) => void;
}
export interface VerifyReport {
    ok: boolean;
    problems: string[];
    details: Record<string, string>;
}
export declare function verifyPatchedImage(p: FirmwarePlatform, options: VerifyOptions): Promise<VerifyReport>;
