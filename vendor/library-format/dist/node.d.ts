import type { LibraryFs } from './fs.js';
import { type LibraryCheck, type PlaylistCheck } from './complete.js';
import type { LibraryIndexEntry } from './types.js';
export declare function sha256File(file: string): Promise<string>;
/** The package's shared fixtures (a library and audio that the player and the desktop tests both read). Same relative place from src/ and dist/. */
export declare const fixturesDir: () => string;
export declare const nodeLibraryFs: LibraryFs;
/** Node conveniences: the functions above bound to the Node file system, with plain paths. */
export declare const checkPlaylistDir: (dir: string, entry: Pick<LibraryIndexEntry, "id"> & Partial<LibraryIndexEntry>, options?: {
    verifyHashes?: boolean;
}) => Promise<PlaylistCheck>;
export declare const checkLibrary: (root: string, options?: {
    verifyHashes?: boolean;
}) => Promise<LibraryCheck>;
