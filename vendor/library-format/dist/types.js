// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
/**
 * Studio Pocket on-device library format, version 1.
 * Documented in docs/architecture/library-format.md. Any change to these shapes is a
 * format version bump; the player refuses versions it does not know.
 */
export const LIBRARY_FORMAT = 'studiopocket-library';
export const PLAYLIST_FORMAT = 'studiopocket-playlist';
export const DEVICE_FORMAT = 'studiopocket-device';
export const STATE_FORMAT = 'studiopocket-state';
export const FORMAT_VERSION = 1;
/** Root folder name on the player's USB mass-storage volume. */
export const ROOT_DIR = 'STUDIOPOCKET';
export const LIBRARY_FILE = 'library.json';
export const PLAYLISTS_DIR = 'playlists';
export const PLAYLIST_MANIFEST_FILE = 'manifest.json';
export const TRACKS_DIR = 'tracks';
export const STATE_DIR = 'state';
export const DEVICE_FILE = 'device.json';
/** Present while the desktop is writing. Not an error for the player, only a hint. */
export const SYNC_LOCK_FILE = 'sync.lock';
/** Written in a playlist folder before its replaced files are renamed live and removed after its manifest is written; readers treat the playlist as incomplete while it exists. */
export const PLAYLIST_UPDATE_LOCK_FILE = 'update.lock';
/** Suffix for files still being written; never listed, always ignored and cleaned up. */
export const PARTIAL_SUFFIX = '.part';
export const ICONS_DIR = 'icons';
/*
 * Playlist groups (added 2026-10-21, still format version 1): two optional files at the root.
 * Players that predate them ignore them, as they ignore track icons.
 */
export const GROUPS_FORMAT = 'studiopocket-groups';
export const RECENT_FORMAT = 'studiopocket-recent';
/** Desktop-owned: the groups and what is in them. Written atomically (.part + rename). */
export const GROUPS_FILE = 'groups.json';
/** Each group's optional 16x16 icon: `groups/<file name>`. */
export const GROUPS_DIR = 'groups';
/** Player-owned: last played playlist ids, most recent first. The desktop preserves it. */
export const RECENT_FILE = 'recent.json';
export const MAX_GROUPS = 30;
export const MAX_GROUP_TITLE = 40;
export const MAX_ICON_REF = 100;
/** How a user group's tile looks on the player (added 2026-11, still format version 1). */
export const GROUP_DISPLAYS = ['icon', 'image', 'covers', 'recent'];
/** At most this many chosen covers per group (first = top card). */
export const MAX_GROUP_COVERS = 3;
/** The player's system groups; a user group can never take these ids. */
export const RESERVED_GROUP_IDS = ['recent', 'all'];
/** The player keeps this many entries in recent.json and shows this many in Recent. */
export const RECENT_KEEP = 5;
/** Readers accept up to this many entries (and use the first RECENT_KEEP on the player). */
export const MAX_RECENT = 20;
//# sourceMappingURL=types.js.map