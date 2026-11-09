// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import { createHash } from 'node:crypto';
import path from 'node:path';
import { FORMAT_VERSION, PLAYLIST_FORMAT, validatePlaylistManifest } from '@studio-pocket/library-format';
export class FolderError extends Error {
}
const MIME_BY_EXTENSION = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac' };
// Codec names as music-metadata reports them for the fixtures (checked in folder.test.ts).
const PLAYABLE_CODEC = /^(MPEG (1|2|2\.5) Layer 3|MPEG-4\/AAC|AAC)/i;
// Files that sit in music folders but are not audio: ignored (and reported), unlike audio the
// player cannot play (.opus, .flac, .wav, ...), which refuses the sync.
const NON_AUDIO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.txt', '.nfo', '.m3u', '.m3u8', '.cue', '.pdf', '.ini', '.db', '.url', '.json']);
const NON_AUDIO_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);
const isZip = (e) => path.extname(e.name).toLowerCase() === '.zip';
const isNonAudio = (e) => isZip(e) || NON_AUDIO_NAMES.has(e.name.toLowerCase()) || NON_AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase());
const visible = (e) => !e.name.startsWith('.');
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const reason = (e) => (e instanceof Error ? e.message : String(e));
/** `Café: "Songs" / 2026?` → `caf-songs-2026`; a name with no ASCII letters → `p-` + 12 hex of its hash. */
export function playlistSlug(folderName) {
    const slug = folderName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
    return slug || `p-${createHash('sha256').update(folderName).digest('hex').slice(0, 12)}`;
}
function uniqueId(base, used) {
    let id = base;
    for (let n = 2; used.has(id); n++)
        id = `${base.slice(0, 40 - String(n).length - 1)}-${n}`;
    used.add(id);
    return id;
}
// MYO Studio downloads ("archives"): metadata.json, audio/, icons/ and an optional cover.
const ARCHIVE_FORMAT = 'myo-studio-archive';
const METADATA = 'metadata.json';
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const OPUS_ADVICE = 'the player cannot play Opus; download the AAC version of this playlist from MYO Studio';
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isArchiveTrack = (v) => isRecord(v) && typeof v.index === 'number' && Number.isFinite(v.index) && typeof v.title === 'string';
/**
 * The folder's MYO Studio metadata, when it is a download: `format: myo-studio-archive` (v2), or a
 * string `title` with a `tracks` array of `{ index, title }` objects (v1, before the format marker).
 * Anything else, including a metadata.json that does not parse, leaves the folder a plain playlist folder.
 */
async function readArchive(entries, deps) {
    const file = entries.find((e) => !e.isDir && e.name === METADATA);
    if (!file)
        return null;
    let meta;
    try {
        meta = JSON.parse(new TextDecoder().decode(await deps.read(file.path, MAX_METADATA_BYTES)));
    }
    catch {
        return null;
    }
    if (!isRecord(meta))
        return null;
    const v2 = meta.format === ARCHIVE_FORMAT;
    const tracksOk = Array.isArray(meta.tracks) && meta.tracks.length > 0 && meta.tracks.every(isArchiveTrack);
    if (!v2 && !(typeof meta.title === 'string' && tracksOk))
        return null;
    if (!tracksOk)
        return { kind: 'broken', problem: `${file.path}: a MYO Studio download whose track list cannot be read` };
    return { kind: 'archive', archive: { v2, title: typeof meta.title === 'string' ? meta.title : '', cover: meta.cover, tracks: meta.tracks } };
}
/** A path from metadata.json, kept inside the download; null when it would leave it. */
function inside(dir, rel) {
    const full = path.resolve(dir, rel);
    const back = path.relative(dir, full);
    const leaves = back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back);
    return back && !leaves ? full : null;
}
function is16x16Png(b) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (b.length < 24 || sig.some((v, i) => b[i] !== v))
        return false;
    if (String.fromCharCode(b[12], b[13], b[14], b[15]) !== 'IHDR')
        return false;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return view.getUint32(16) === 16 && view.getUint32(20) === 16;
}
/** An ISO base media (MP4/M4A) file: its first box is `ftyp`. */
const isMp4 = (b) => b.length >= 8 && String.fromCharCode(...b.subarray(4, 8)) === 'ftyp';
/** The cover's file name on the player, from its bytes (a MYO Studio `cover.jpg` can hold PNG data). */
function coverName(b) {
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
        return 'cover.png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
        return 'cover.jpg';
    if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP')
        return 'cover.webp';
    return null;
}
class Builder {
    deps;
    problems = [];
    ignored = [];
    zips = [];
    notes = [];
    playlists = [];
    playlistIds = new Set();
    constructor(deps) {
        this.deps = deps;
    }
    ignore(files) {
        for (const f of files)
            (isZip(f) ? this.zips : this.ignored).push(f.path);
    }
    async refuseNested(entries) {
        for (const sub of entries.filter((e) => e.isDir)) {
            const hasAudio = (await this.deps.list(sub.path).catch(() => [])).some((e) => visible(e) && !e.isDir && !isNonAudio(e));
            if (hasAudio)
                this.problems.push(`${sub.path}: nested folders are not supported; put the audio files directly in the playlist folder`);
        }
    }
    /** One audio file as a track, or null after recording why it cannot be one. */
    async track(file, title, trackIds, fromArchive) {
        let ext = path.extname(file).toLowerCase();
        let mimeType = MIME_BY_EXTENSION[ext];
        if (!mimeType) {
            this.problems.push(fromArchive && ext === '.opus' ? `${file}: ${OPUS_ADVICE}` : `${file}: unsupported file type (the player plays MP3, M4A and AAC)`);
            return null;
        }
        // MYO Studio's AAC downloads are MP4 files named .aac: the bytes, not the name, say how to read them,
        // and they go on the player as .m4a (as the desktop stores MYO Studio's AAC).
        const mp4 = isMp4(await this.deps.read(file, 12).catch(() => new Uint8Array()));
        if (mp4) {
            ext = '.m4a';
            mimeType = 'audio/mp4';
        }
        const probe = await this.deps.probe(file, mp4 ? mimeType : undefined).catch(() => null);
        if (!probe || !PLAYABLE_CODEC.test(probe.codec ?? '') || !(probe.durationSeconds && probe.durationSeconds > 0)) {
            this.problems.push(fromArchive && /opus/i.test(probe?.codec ?? '') ? `${file}: ${OPUS_ADVICE}` : `${file}: cannot read this as ${ext.slice(1).toUpperCase()} audio with a duration`);
            return null;
        }
        try {
            const sha256 = await this.deps.sha256(file);
            const sizeBytes = await this.deps.size(file);
            const id = uniqueId(sha256.slice(0, 16), trackIds);
            return {
                entry: { id, title, file: `tracks/${id}${ext}`, durationMs: Math.round(probe.durationSeconds * 1000), sizeBytes, sha256, mimeType },
                localPath: file,
            };
        }
        catch (e) {
            this.problems.push(`${file}: ${reason(e)}`);
            return null;
        }
    }
    add(dir, title, tracks, cover) {
        if (tracks.length === 0)
            return;
        try {
            const manifest = {
                format: PLAYLIST_FORMAT, formatVersion: FORMAT_VERSION, id: uniqueId(playlistSlug(title), this.playlistIds),
                title, source: { kind: 'local' }, cover: cover?.name ?? null, icon: null, tracks: tracks.map((t) => t.entry),
            };
            this.playlists.push({ manifest: validatePlaylistManifest(manifest), tracks, ...(cover ? { coverPath: cover.path } : {}) });
        }
        catch (e) {
            this.problems.push(`${dir}: ${reason(e)}`);
        }
    }
    /** A folder inside the folder passed in: a MYO Studio download, or a plain playlist folder. */
    async folder(dir) {
        let entries;
        try {
            entries = (await this.deps.list(dir.path)).filter(visible);
        }
        catch (e) {
            this.problems.push(`${dir.path}: ${reason(e)}`);
            return;
        }
        const archive = await readArchive(entries, this.deps);
        if (archive)
            return this.archive(dir.path, entries, archive);
        const files = entries.filter((e) => !e.isDir).sort(byName);
        await this.refuseNested(entries);
        this.ignore(files.filter(isNonAudio));
        const tracks = [];
        const trackIds = new Set();
        for (const file of files.filter((f) => !isNonAudio(f))) {
            const t = await this.track(file.path, path.basename(file.name, path.extname(file.name)).trim() || 'Track', trackIds, false);
            if (t)
                tracks.push(t);
        }
        this.add(dir.path, dir.name, tracks);
    }
    async archive(dir, entries, read) {
        if (read.kind === 'broken') {
            this.problems.push(read.problem);
            return;
        }
        const { archive } = read;
        const meta = [...archive.tracks].sort((a, b) => a.index - b.index);
        const filesOf = async (name) => entries.some((e) => e.isDir && e.name === name) ? (await this.deps.list(path.join(dir, name))).filter((e) => visible(e) && !e.isDir).sort(byName) : [];
        const skippedIcons = [];
        let audio;
        let icons;
        try {
            if (archive.v2) {
                audio = [];
                for (const t of meta) {
                    const p = typeof t.audio === 'string' ? inside(dir, t.audio) : null;
                    if (!p)
                        this.problems.push(`${dir}: metadata.json track ${t.index} has no audio file inside the download`);
                    else
                        audio.push(p);
                }
                if (audio.length !== meta.length)
                    return;
                icons = meta.map((t) => (typeof t.icon === 'string' ? inside(dir, t.icon) : null));
            }
            else {
                const audioFiles = await filesOf('audio');
                if (audioFiles.length !== meta.length) {
                    this.problems.push(`${dir}: metadata.json lists ${meta.length} tracks but audio/ holds ${audioFiles.length} files`);
                    return;
                }
                audio = audioFiles.map((f) => f.path);
                const iconFiles = await filesOf('icons');
                if (iconFiles.length > 0 && iconFiles.length !== meta.length)
                    skippedIcons.push(`${path.join(dir, 'icons')} (${iconFiles.length} icons for ${meta.length} tracks)`);
                icons = iconFiles.length === meta.length ? iconFiles.map((f) => f.path) : meta.map(() => null);
            }
        }
        catch (e) {
            this.problems.push(`${dir}: ${reason(e)}`);
            return;
        }
        const tracks = [];
        const trackIds = new Set();
        for (const [i, t] of meta.entries()) {
            const file = audio[i];
            if (archive.v2 && !(await this.deps.size(file).then(() => true, () => false))) {
                this.problems.push(`${file}: listed in metadata.json but missing`);
                continue;
            }
            const track = await this.track(file, t.title.trim() || path.basename(file, path.extname(file)), trackIds, true);
            if (!track)
                continue;
            const icon = icons[i];
            if (icon) {
                if (is16x16Png(await this.deps.read(icon, 24).catch(() => new Uint8Array()))) {
                    track.entry.icon = `icons/${track.entry.id}.png`;
                    track.iconPath = icon;
                }
                else {
                    skippedIcons.push(icon);
                }
            }
            tracks.push(track);
        }
        if (skippedIcons.length)
            this.notes.push(`skipped ${skippedIcons.length} track icon(s) that are missing or not 16x16 PNGs; those tracks show the player's default glyph: ${skippedIcons.join(', ')}`);
        const coverRel = archive.v2
            ? (typeof archive.cover === 'string' ? archive.cover : null)
            : (['cover.jpg', 'cover.png'].find((n) => entries.some((e) => !e.isDir && e.name === n)) ?? null);
        const coverPath = coverRel ? inside(dir, coverRel) : null;
        let cover;
        if (coverPath) {
            const name = coverName(await this.deps.read(coverPath, 12).catch(() => new Uint8Array()));
            if (name)
                cover = { name, path: coverPath };
            else
                this.notes.push(`${coverPath}: the cover is missing or not a JPEG, PNG or WebP picture; the playlist goes without it`);
        }
        // metadata.json, audio/, icons/ and the cover belong to the download; anything else is
        // reported as in a plain playlist folder.
        const own = new Set([METADATA, 'audio', 'icons', ...(coverPath && path.dirname(coverPath) === dir ? [path.basename(coverPath)] : [])]);
        const others = entries.filter((e) => !own.has(e.name));
        for (const f of others.filter((e) => !e.isDir)) {
            if (isNonAudio(f))
                this.ignore([f]);
            else
                this.problems.push(`${f.path}: not part of this MYO Studio download's track list (metadata.json)`);
        }
        await this.refuseNested(others);
        this.add(dir, archive.title.trim() || path.basename(dir), tracks, cover);
    }
}
export async function buildFolderLibrary(folder, deps) {
    if (path.extname(folder).toLowerCase() === '.zip')
        throw new FolderError(`${folder} is a zip file; unzip it first and point the command at the unzipped folder`);
    const b = new Builder(deps);
    const top = (await deps.list(folder)).filter(visible);
    const archive = await readArchive(top, deps);
    if (archive) {
        await b.archive(folder, top, archive);
    }
    else {
        for (const file of top.filter((e) => !e.isDir)) {
            if (isNonAudio(file))
                b.ignore([file]);
            else
                b.problems.push(`${file.path}: audio belongs inside a playlist folder`);
        }
        for (const dir of top.filter((e) => e.isDir).sort(byName))
            await b.folder(dir);
    }
    if (b.problems.length)
        throw new FolderError(`${b.problems.length} problem(s), nothing was written:\n${b.problems.join('\n')}`);
    if (b.playlists.length === 0)
        throw new FolderError(`no playlist folders with audio in ${folder}`);
    const notes = [
        ...(b.ignored.length ? [`ignored ${b.ignored.length} non-audio file(s): ${b.ignored.join(', ')}`] : []),
        ...(b.zips.length ? [`zip files are not opened; unzip them first: ${b.zips.join(', ')}`] : []),
        ...b.notes,
    ];
    return { generator: 'studio-pocket-sync', playlists: b.playlists, ...(notes.length ? { notes } : {}) };
}
//# sourceMappingURL=folder.js.map