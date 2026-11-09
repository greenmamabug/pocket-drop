import type { PlaylistManifest, TrackEntry } from '@studio-pocket/library-format';
/**
 * What the desktop wants on the device: each playlist's manifest plus where the bytes
 * live on the computer. A front end builds this from its files (the folder command from a folder of playlists);
 * tests build it from the shared fixtures.
 */
export interface SourceTrack {
    entry: TrackEntry;
    /** Absolute path of the audio file on the computer. */
    localPath: string;
    /** Absolute path of the 16x16 icon on the computer, when `entry.icon` is set. */
    iconPath?: string;
}
export interface SourcePlaylist {
    manifest: PlaylistManifest;
    tracks: SourceTrack[];
    /** Absolute paths of artwork on the computer, when the manifest references them. */
    coverPath?: string;
    iconPath?: string;
}
export interface SourceLibrary {
    generator: string;
    playlists: SourcePlaylist[];
    /** Things worth telling the user that did not stop the build (e.g. files that were ignored). */
    notes?: string[];
}
