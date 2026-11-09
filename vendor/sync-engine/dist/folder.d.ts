import { type TrackEntry } from '@studio-pocket/library-format';
import type { SourceLibrary } from './source.js';
export interface FolderEntry {
    name: string;
    path: string;
    isDir: boolean;
}
export interface AudioProbe {
    codec?: string | undefined;
    durationSeconds?: number | undefined;
}
export interface FolderDeps {
    list(dir: string): Promise<FolderEntry[]>;
    sha256(file: string): Promise<string>;
    size(file: string): Promise<number>;
    /** `mimeType`, when given, says what the bytes are; otherwise the file name extension does. */
    probe(file: string, mimeType?: TrackEntry['mimeType']): Promise<AudioProbe>;
    /** The file's first `maxBytes` bytes (fewer when it is shorter). */
    read(file: string, maxBytes: number): Promise<Uint8Array>;
}
export declare class FolderError extends Error {
}
/** `Café: "Songs" / 2026?` → `caf-songs-2026`; a name with no ASCII letters → `p-` + 12 hex of its hash. */
export declare function playlistSlug(folderName: string): string;
export declare function buildFolderLibrary(folder: string, deps: FolderDeps): Promise<SourceLibrary>;
