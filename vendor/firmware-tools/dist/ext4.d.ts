import type { FirmwarePlatform } from './platform.js';
/**
 * Just enough ext4 and Android-sparse header parsing to identify an image
 * without e2fsprogs. The installer refuses anything it cannot positively identify.
 */
export interface Ext4Superblock {
    inodesCount: number;
    blocksCount: number;
    freeBlocks: number;
    freeInodes: number;
    blockSize: number;
    volumeName: string;
    fsBytes: number;
    /** s_uuid as 32 hex chars. */
    uuid: string;
    /** s_mnt_cnt: how often the filesystem has been mounted since the last check. */
    mountCount: number;
}
export type ImageKind = {
    kind: 'ext4';
    superblock: Ext4Superblock;
} | {
    kind: 'sparse';
    blockSize: number;
    totalBlocks: number;
    totalChunks: number;
    expandedBytes: number;
} | {
    kind: 'unknown';
};
export declare const EXT4_MAGIC = 61267;
export declare const SPARSE_MAGIC = 3978755898;
export declare function parseSuperblock(buffer: Uint8Array): Ext4Superblock | null;
/** Bytes needed from the start of a filesystem to parse its primary superblock. */
export declare const SUPERBLOCK_PROBE_BYTES = 2048;
export declare function parseSparseHeader(buffer: Uint8Array): Extract<ImageKind, {
    kind: 'sparse';
}> | null;
export declare function identifyBytes(head: Uint8Array): ImageKind;
export declare function identifyImage(p: FirmwarePlatform, path: string): Promise<ImageKind>;
