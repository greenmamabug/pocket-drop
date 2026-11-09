/**
 * Studio Pocket on-device library format, version 1.
 * Documented in docs/architecture/library-format.md. Any change to these shapes is a
 * format version bump; the player refuses versions it does not know.
 */
export declare const LIBRARY_FORMAT: "studiopocket-library";
export declare const PLAYLIST_FORMAT: "studiopocket-playlist";
export declare const DEVICE_FORMAT: "studiopocket-device";
export declare const STATE_FORMAT: "studiopocket-state";
export declare const FORMAT_VERSION: 1;
/** Root folder name on the player's USB mass-storage volume. */
export declare const ROOT_DIR = "STUDIOPOCKET";
export declare const LIBRARY_FILE = "library.json";
export declare const PLAYLISTS_DIR = "playlists";
export declare const PLAYLIST_MANIFEST_FILE = "manifest.json";
export declare const TRACKS_DIR = "tracks";
export declare const STATE_DIR = "state";
export declare const DEVICE_FILE = "device.json";
/** Present while the desktop is writing. Not an error for the player, only a hint. */
export declare const SYNC_LOCK_FILE = "sync.lock";
/** Written in a playlist folder before its replaced files are renamed live and removed after its manifest is written; readers treat the playlist as incomplete while it exists. */
export declare const PLAYLIST_UPDATE_LOCK_FILE = "update.lock";
/** Suffix for files still being written; never listed, always ignored and cleaned up. */
export declare const PARTIAL_SUFFIX = ".part";
export interface LibraryIndex {
    format: typeof LIBRARY_FORMAT;
    formatVersion: typeof FORMAT_VERSION;
    generatedAt: string;
    generator: string;
    playlists: LibraryIndexEntry[];
}
export interface LibraryIndexEntry {
    id: string;
    title: string;
    /** Relative to the root, forward slashes: `playlists/<id>`. */
    dir: string;
    trackCount: number;
    totalBytes: number;
    /** SHA-256 of the playlist's manifest.json bytes; changes whenever content changes. */
    manifestSha256: string;
}
export interface PlaylistManifest {
    format: typeof PLAYLIST_FORMAT;
    formatVersion: typeof FORMAT_VERSION;
    id: string;
    title: string;
    author?: string;
    /** Where this came from, for the desktop's "already on device / changed" comparison. */
    source?: {
        kind: 'yoto-myo' | 'local';
        cardId?: string;
        updatedAt?: string;
    };
    /** Relative to the playlist dir, or null when absent. */
    cover: string | null;
    icon: string | null;
    tracks: TrackEntry[];
}
export declare const ICONS_DIR = "icons";
export interface TrackEntry {
    id: string;
    title: string;
    /** Relative to the playlist dir: `tracks/<id>.<ext>`. */
    file: string;
    /** Optional 16x16 pixel icon, relative to the playlist dir: `icons/<name>.png`. Missing or unreadable = default glyph. */
    icon?: string;
    durationMs: number;
    sizeBytes: number;
    sha256: string;
    mimeType: 'audio/mpeg' | 'audio/mp4' | 'audio/aac';
}
export interface DeviceMarker {
    format: typeof DEVICE_FORMAT;
    formatVersion: typeof FORMAT_VERSION;
    deviceId: string;
    createdAt: string;
    createdBy: string;
    playerVersion?: string;
}
/** Written only by the player; the desktop preserves it across syncs. */
export interface PlaybackState {
    format: typeof STATE_FORMAT;
    formatVersion: typeof FORMAT_VERSION;
    playlistId: string;
    trackIndex: number;
    positionMs: number;
    updatedAt: string;
}
export declare const GROUPS_FORMAT: "studiopocket-groups";
export declare const RECENT_FORMAT: "studiopocket-recent";
/** Desktop-owned: the groups and what is in them. Written atomically (.part + rename). */
export declare const GROUPS_FILE = "groups.json";
/** Each group's optional 16x16 icon: `groups/<file name>`. */
export declare const GROUPS_DIR = "groups";
/** Player-owned: last played playlist ids, most recent first. The desktop preserves it. */
export declare const RECENT_FILE = "recent.json";
export declare const MAX_GROUPS = 30;
export declare const MAX_GROUP_TITLE = 40;
export declare const MAX_ICON_REF = 100;
/** The player's system groups; a user group can never take these ids. */
export declare const RESERVED_GROUP_IDS: readonly string[];
/** The player keeps this many entries in recent.json and shows this many in Recent. */
export declare const RECENT_KEEP = 5;
/** Readers accept up to this many entries (and use the first RECENT_KEEP on the player). */
export declare const MAX_RECENT = 20;
export interface PlaylistGroup {
    id: string;
    title: string;
    /** `groups/<name>.png`, or null for the player's built-in folder glyph. Missing file = glyph. */
    icon: string | null;
    /** Which icon was picked, for the desktop only (`yoto:<mediaId>`); the player ignores it. */
    iconRef?: string;
    /** Playlist ids in cover-flow order. Ids not in library.json are allowed and ignored. */
    playlists: string[];
}
export interface GroupsFile {
    format: typeof GROUPS_FORMAT;
    formatVersion: typeof FORMAT_VERSION;
    updatedAt: string;
    generator: string;
    /** Order here is order on the player, between Recent and All. */
    groups: PlaylistGroup[];
}
export interface RecentFile {
    format: typeof RECENT_FORMAT;
    formatVersion: typeof FORMAT_VERSION;
    updatedAt: string;
    /** Most recent first. */
    playlists: string[];
}
