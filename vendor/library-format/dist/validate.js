// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import { DEVICE_FORMAT, FORMAT_VERSION, GROUPS_DIR, GROUPS_FORMAT, LIBRARY_FORMAT, MAX_GROUPS, MAX_GROUP_TITLE, MAX_ICON_REF, MAX_RECENT, PLAYLIST_FORMAT, RECENT_FORMAT, RESERVED_GROUP_IDS, STATE_FORMAT, } from './types.js';
/**
 * Hand-written validators (no schema library) so the same rules can be mirrored one-to-one
 * in the Kotlin parser. Every rule here has a counterpart in apps/player LibraryParser.
 */
export class FormatError extends Error {
    path;
    constructor(message, path) {
        super(`${path}: ${message}`);
        this.path = path;
    }
}
/** Short, FAT-safe, case-insensitive-safe identifiers. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** File names inside a playlist dir: ASCII, no separators, no leading dot. */
export const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const MIME_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/aac']);
export const MAX_TITLE_LENGTH = 200;
export const MAX_TRACKS = 500;
const obj = (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new FormatError('expected an object', path);
    return value;
};
const str = (o, key, path, max = MAX_TITLE_LENGTH) => {
    const v = o[key];
    if (typeof v !== 'string' || v.length === 0 || v.length > max)
        throw new FormatError(`expected a non-empty string (max ${max})`, `${path}.${key}`);
    return v;
};
const int = (o, key, path, min = 0) => {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min)
        throw new FormatError(`expected an integer >= ${min}`, `${path}.${key}`);
    return v;
};
const header = (o, format, path) => {
    if (o.format !== format)
        throw new FormatError(`format must be "${format}"`, `${path}.format`);
    if (o.formatVersion !== FORMAT_VERSION)
        throw new FormatError(`unsupported formatVersion ${String(o.formatVersion)} (this build understands ${FORMAT_VERSION})`, `${path}.formatVersion`);
};
const id = (o, key, path) => {
    const v = str(o, key, path, 40);
    if (!ID_PATTERN.test(v))
        throw new FormatError('invalid id (a-z, 0-9, "-", max 40)', `${path}.${key}`);
    return v;
};
const relFile = (o, key, path, requiredDir) => {
    const v = str(o, key, path, 160);
    const parts = v.split('/');
    if (parts.some((p) => !FILE_NAME_PATTERN.test(p)))
        throw new FormatError('invalid relative file path', `${path}.${key}`);
    if (requiredDir && (parts.length !== 2 || parts[0] !== requiredDir))
        throw new FormatError(`must be ${requiredDir}/<name>`, `${path}.${key}`);
    return v;
};
export function validateTrack(value, path = 'track') {
    const o = obj(value, path);
    const mimeType = str(o, 'mimeType', path, 32);
    if (!MIME_TYPES.has(mimeType))
        throw new FormatError(`unsupported mimeType ${mimeType}`, `${path}.mimeType`);
    const sha256 = str(o, 'sha256', path, 64);
    if (!SHA256_PATTERN.test(sha256))
        throw new FormatError('expected hex SHA-256', `${path}.sha256`);
    const track = {
        id: id(o, 'id', path),
        title: str(o, 'title', path),
        file: relFile(o, 'file', path, 'tracks'),
        durationMs: int(o, 'durationMs', path),
        sizeBytes: int(o, 'sizeBytes', path, 1),
        sha256,
        mimeType: mimeType,
    };
    if (o.icon !== undefined && o.icon !== null)
        track.icon = relFile(o, 'icon', path, 'icons');
    return track;
}
export function validatePlaylistManifest(value, path = 'manifest') {
    const o = obj(value, path);
    header(o, PLAYLIST_FORMAT, path);
    const tracksRaw = o.tracks;
    if (!Array.isArray(tracksRaw) || tracksRaw.length === 0 || tracksRaw.length > MAX_TRACKS)
        throw new FormatError(`tracks must be a non-empty array (max ${MAX_TRACKS})`, `${path}.tracks`);
    const tracks = tracksRaw.map((t, i) => validateTrack(t, `${path}.tracks[${i}]`));
    const ids = new Set(tracks.map((t) => t.id));
    if (ids.size !== tracks.length)
        throw new FormatError('track ids must be unique', `${path}.tracks`);
    const files = new Set(tracks.map((t) => t.file));
    if (files.size !== tracks.length)
        throw new FormatError('track files must be unique', `${path}.tracks`);
    const manifest = {
        format: PLAYLIST_FORMAT,
        formatVersion: FORMAT_VERSION,
        id: id(o, 'id', path),
        title: str(o, 'title', path),
        cover: o.cover === null || o.cover === undefined ? null : relFile(o, 'cover', path),
        icon: o.icon === null || o.icon === undefined ? null : relFile(o, 'icon', path),
        tracks,
    };
    if (o.author !== undefined)
        manifest.author = str(o, 'author', path);
    if (o.source !== undefined) {
        const s = obj(o.source, `${path}.source`);
        if (s.kind !== 'yoto-myo' && s.kind !== 'local')
            throw new FormatError('kind must be yoto-myo or local', `${path}.source.kind`);
        manifest.source = { kind: s.kind };
        if (s.cardId !== undefined)
            manifest.source.cardId = str(s, 'cardId', `${path}.source`, 100);
        if (s.updatedAt !== undefined)
            manifest.source.updatedAt = str(s, 'updatedAt', `${path}.source`, 40);
    }
    return manifest;
}
export function validateLibraryIndexEntry(value, path = 'entry') {
    const o = obj(value, path);
    const entryId = id(o, 'id', path);
    const dir = str(o, 'dir', path, 60);
    if (dir !== `playlists/${entryId}`)
        throw new FormatError(`dir must be playlists/${entryId}`, `${path}.dir`);
    const manifestSha256 = str(o, 'manifestSha256', path, 64);
    if (!SHA256_PATTERN.test(manifestSha256))
        throw new FormatError('expected hex SHA-256', `${path}.manifestSha256`);
    return { id: entryId, title: str(o, 'title', path), dir, trackCount: int(o, 'trackCount', path, 1), totalBytes: int(o, 'totalBytes', path, 1), manifestSha256 };
}
export function validateLibraryIndex(value, path = 'library') {
    const o = obj(value, path);
    header(o, LIBRARY_FORMAT, path);
    const raw = o.playlists;
    if (!Array.isArray(raw))
        throw new FormatError('playlists must be an array', `${path}.playlists`);
    const playlists = raw.map((p, i) => validateLibraryIndexEntry(p, `${path}.playlists[${i}]`));
    if (new Set(playlists.map((p) => p.id)).size !== playlists.length)
        throw new FormatError('playlist ids must be unique', `${path}.playlists`);
    return { format: LIBRARY_FORMAT, formatVersion: FORMAT_VERSION, generatedAt: str(o, 'generatedAt', path, 40), generator: str(o, 'generator', path, 100), playlists };
}
export function validateDeviceMarker(value, path = 'device') {
    const o = obj(value, path);
    header(o, DEVICE_FORMAT, path);
    const marker = { format: DEVICE_FORMAT, formatVersion: FORMAT_VERSION, deviceId: str(o, 'deviceId', path, 64), createdAt: str(o, 'createdAt', path, 40), createdBy: str(o, 'createdBy', path, 100) };
    if (o.playerVersion !== undefined)
        marker.playerVersion = str(o, 'playerVersion', path, 40);
    return marker;
}
export function validatePlaybackState(value, path = 'state') {
    const o = obj(value, path);
    header(o, STATE_FORMAT, path);
    return { format: STATE_FORMAT, formatVersion: FORMAT_VERSION, playlistId: id(o, 'playlistId', path), trackIndex: int(o, 'trackIndex', path), positionMs: int(o, 'positionMs', path), updatedAt: str(o, 'updatedAt', path, 40) };
}
const idList = (o, key, path, max) => {
    const raw = o[key];
    if (!Array.isArray(raw) || (max !== undefined && raw.length > max))
        throw new FormatError(`${key} must be an array${max !== undefined ? ` (max ${max})` : ''}`, `${path}.${key}`);
    const ids = raw.map((v, i) => {
        if (typeof v !== 'string' || !ID_PATTERN.test(v))
            throw new FormatError('invalid id (a-z, 0-9, "-", max 40)', `${path}.${key}[${i}]`);
        return v;
    });
    if (new Set(ids).size !== ids.length)
        throw new FormatError('playlist ids must be unique', `${path}.${key}`);
    return ids;
};
export function validateGroup(value, path = 'group') {
    const o = obj(value, path);
    const groupId = id(o, 'id', path);
    if (RESERVED_GROUP_IDS.includes(groupId))
        throw new FormatError(`"${groupId}" is reserved for the player's own group`, `${path}.id`);
    const group = {
        id: groupId,
        title: str(o, 'title', path, MAX_GROUP_TITLE),
        icon: o.icon === null || o.icon === undefined ? null : relFile(o, 'icon', path, GROUPS_DIR),
        playlists: idList(o, 'playlists', path),
    };
    if (o.iconRef !== undefined)
        group.iconRef = str(o, 'iconRef', path, MAX_ICON_REF);
    return group;
}
/** groups.json: at most MAX_GROUPS groups, unique ids, and a playlist in at most one group. */
export function validateGroups(value, path = 'groups') {
    const o = obj(value, path);
    header(o, GROUPS_FORMAT, path);
    const raw = o.groups;
    if (!Array.isArray(raw) || raw.length > MAX_GROUPS)
        throw new FormatError(`groups must be an array (max ${MAX_GROUPS})`, `${path}.groups`);
    const groups = raw.map((g, i) => validateGroup(g, `${path}.groups[${i}]`));
    if (new Set(groups.map((g) => g.id)).size !== groups.length)
        throw new FormatError('group ids must be unique', `${path}.groups`);
    const owner = new Map();
    groups.forEach((g, i) => {
        for (const p of g.playlists) {
            const other = owner.get(p);
            if (other !== undefined)
                throw new FormatError(`${p} is already in group ${other}`, `${path}.groups[${i}].playlists`);
            owner.set(p, g.id);
        }
    });
    return { format: GROUPS_FORMAT, formatVersion: FORMAT_VERSION, updatedAt: str(o, 'updatedAt', path, 40), generator: str(o, 'generator', path, 100), groups };
}
/** recent.json: up to MAX_RECENT unique playlist ids, most recent first. */
export function validateRecent(value, path = 'recent') {
    const o = obj(value, path);
    header(o, RECENT_FORMAT, path);
    return { format: RECENT_FORMAT, formatVersion: FORMAT_VERSION, updatedAt: str(o, 'updatedAt', path, 40), playlists: idList(o, 'playlists', path, MAX_RECENT) };
}
/** Parses JSON text and validates; a syntax error is reported as a FormatError too. */
export function parseWith(validator, text, path) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        throw new FormatError(`invalid JSON: ${error.message}`, path);
    }
    return validator(value, path);
}
//# sourceMappingURL=validate.js.map