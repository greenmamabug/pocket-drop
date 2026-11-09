import { type DeviceMarker, type GroupsFile, type LibraryIndex, type LibraryIndexEntry, type PlaybackState, type PlaylistGroup, type PlaylistManifest, type RecentFile, type TrackEntry } from './types.js';
/**
 * Hand-written validators (no schema library) so the same rules can be mirrored one-to-one
 * in the Kotlin parser. Every rule here has a counterpart in apps/player LibraryParser.
 */
export declare class FormatError extends Error {
    readonly path: string;
    constructor(message: string, path: string);
}
/** Short, FAT-safe, case-insensitive-safe identifiers. */
export declare const ID_PATTERN: RegExp;
/** File names inside a playlist dir: ASCII, no separators, no leading dot. */
export declare const FILE_NAME_PATTERN: RegExp;
export declare const SHA256_PATTERN: RegExp;
export declare const MIME_TYPES: Set<string>;
export declare const MAX_TITLE_LENGTH = 200;
export declare const MAX_TRACKS = 500;
export declare function validateTrack(value: unknown, path?: string): TrackEntry;
export declare function validatePlaylistManifest(value: unknown, path?: string): PlaylistManifest;
export declare function validateLibraryIndexEntry(value: unknown, path?: string): LibraryIndexEntry;
export declare function validateLibraryIndex(value: unknown, path?: string): LibraryIndex;
export declare function validateDeviceMarker(value: unknown, path?: string): DeviceMarker;
export declare function validatePlaybackState(value: unknown, path?: string): PlaybackState;
export declare function validateGroup(value: unknown, path?: string): PlaylistGroup;
/** groups.json: at most MAX_GROUPS groups, unique ids, and a playlist in at most one group. */
export declare function validateGroups(value: unknown, path?: string): GroupsFile;
/** recent.json: up to MAX_RECENT unique playlist ids, most recent first. */
export declare function validateRecent(value: unknown, path?: string): RecentFile;
/** Parses JSON text and validates; a syntax error is reported as a FormatError too. */
export declare function parseWith<T>(validator: (value: unknown, path?: string) => T, text: string, path: string): T;
