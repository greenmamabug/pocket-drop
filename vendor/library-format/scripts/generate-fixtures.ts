// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

/**
 * Builds fixtures/library/STUDIOPOCKET from fixtures/audio and fixtures/images. Deterministic
 * (fixed timestamps) so the output can be committed and used by both the TypeScript and the
 * Kotlin tests. Run with: pnpm fixtures
 */
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const fixtures = path.join(here, '..', 'fixtures');
const root = path.join(fixtures, 'library', 'STUDIOPOCKET');
const GENERATED_AT = '2026-10-18T12:00:00Z';

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

interface TrackSpec { id: string; title: string; src: string; durationMs: number; mimeType: string; icon?: string }
interface PlaylistSpec { id: string; title: string; author?: string; cover?: string; icon?: string; tracks: TrackSpec[]; truncateLast?: boolean }

const playlists: PlaylistSpec[] = [
    {
        id: 'bedtime', title: 'Bedtime stories', author: 'Mum', cover: 'cover-orange.jpg', icon: 'icon-green.png',
        tracks: [
            { id: 'ch1', title: 'Chapter one', src: 'tone-a4.mp3', durationMs: 3056, mimeType: 'audio/mpeg', icon: 'pixel-moon.png' },
            { id: 'ch2', title: 'Chapter two', src: 'tone-c5.mp3', durationMs: 4075, mimeType: 'audio/mpeg', icon: 'pixel-star.png' },
            { id: 'ch3', title: 'Chapter three', src: 'tone-g5.mp3', durationMs: 5067, mimeType: 'audio/mpeg' },
        ],
    },
    {
        id: 'songs', title: 'Silly songs', cover: 'cover-blue.jpg',
        tracks: [
            { id: 'song-1', title: 'The E song', src: 'tone-e5.mp3', durationMs: 2063, mimeType: 'audio/mpeg', icon: 'pixel-note.png' },
            { id: 'song-2', title: 'The AAC song', src: 'tone-e4.m4a', durationMs: 2000, mimeType: 'audio/mp4' },
        ],
    },
    {
        // Listed in library.json but the last track is truncated: must be hidden by every reader.
        id: 'broken', title: 'Interrupted transfer', truncateLast: true,
        tracks: [
            { id: 't1', title: 'Fine track', src: 'tone-a4.mp3', durationMs: 3056, mimeType: 'audio/mpeg' },
            { id: 't2', title: 'Truncated track', src: 'tone-g5.mp3', durationMs: 5067, mimeType: 'audio/mpeg' },
        ],
    },
];

await rm(root, { recursive: true, force: true });
const index: Record<string, unknown>[] = [];
for (const spec of playlists) {
    const dir = path.join(root, 'playlists', spec.id);
    await mkdir(path.join(dir, 'tracks'), { recursive: true });
    const tracks = [];
    for (const [i, t] of spec.tracks.entries()) {
        const ext = path.extname(t.src);
        const file = `tracks/${t.id}${ext}`;
        const data = await readFile(path.join(fixtures, 'audio', t.src));
        const truncated = spec.truncateLast && i === spec.tracks.length - 1;
        await writeFile(path.join(dir, file), truncated ? data.subarray(0, Math.floor(data.length / 2)) : data);
        const entry: Record<string, unknown> = { id: t.id, title: t.title, file, durationMs: t.durationMs, sizeBytes: data.length, sha256: sha256(data), mimeType: t.mimeType };
        if (t.icon) {
            await mkdir(path.join(dir, 'icons'), { recursive: true });
            await copyFile(path.join(fixtures, 'images', t.icon), path.join(dir, 'icons', `${t.id}.png`));
            entry.icon = `icons/${t.id}.png`;
        }
        tracks.push(entry);
    }
    if (spec.cover) await copyFile(path.join(fixtures, 'images', spec.cover), path.join(dir, 'cover.jpg'));
    if (spec.icon) await copyFile(path.join(fixtures, 'images', spec.icon), path.join(dir, 'icon.png'));
    const manifest: Record<string, unknown> = {
        format: 'studiopocket-playlist', formatVersion: 1, id: spec.id, title: spec.title,
        ...(spec.author ? { author: spec.author } : {}),
        source: { kind: 'local' },
        cover: spec.cover ? 'cover.jpg' : null, icon: spec.icon ? 'icon.png' : null, tracks,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(path.join(dir, 'manifest.json'), manifestBytes);
    index.push({ id: spec.id, title: spec.title, dir: `playlists/${spec.id}`, trackCount: tracks.length, totalBytes: tracks.reduce((n, t) => n + t.sizeBytes, 0), manifestSha256: sha256(manifestBytes) });
}
await writeFile(path.join(root, 'library.json'), JSON.stringify({ format: 'studiopocket-library', formatVersion: 1, generatedAt: GENERATED_AT, generator: 'library-format/fixtures', playlists: index }, null, 2) + '\n');
await writeFile(path.join(root, 'device.json'), JSON.stringify({ format: 'studiopocket-device', formatVersion: 1, deviceId: 'fixture-device-0001', createdAt: GENERATED_AT, createdBy: 'library-format/fixtures' }, null, 2) + '\n');
await mkdir(path.join(root, 'state'), { recursive: true });
await writeFile(path.join(root, 'state', 'bedtime.json'), JSON.stringify({ format: 'studiopocket-state', formatVersion: 1, playlistId: 'bedtime', trackIndex: 1, positionMs: 1500, updatedAt: GENERATED_AT }, null, 2) + '\n');
// Groups: one with an icon and an id that is not on the player, one whose only other playlist is
// the truncated one (so it shows just songs), and one that is empty (the player hides it).
await mkdir(path.join(root, 'groups'), { recursive: true });
await copyFile(path.join(fixtures, 'images', 'pixel-moon.png'), path.join(root, 'groups', 'g-bedtime.png'));
await writeFile(path.join(root, 'groups.json'), JSON.stringify({
    format: 'studiopocket-groups', formatVersion: 1, updatedAt: GENERATED_AT, generator: 'library-format/fixtures',
    groups: [
        { id: 'g-bedtime', title: 'Bedtime', icon: 'groups/g-bedtime.png', iconRef: 'yoto:fixture-moon', playlists: ['bedtime', 'gone-away'] },
        { id: 'g-music', title: 'Music', icon: null, playlists: ['broken', 'songs'] },
        { id: 'g-empty', title: 'Empty', playlists: [] },
    ],
}, null, 2) + '\n');
// Recent, as the player writes it: most recent first, including an id that has since been removed.
await writeFile(path.join(root, 'recent.json'), JSON.stringify({ format: 'studiopocket-recent', formatVersion: 1, updatedAt: GENERATED_AT, playlists: ['songs', 'gone-away', 'bedtime'] }, null, 2) + '\n');
// A stray partial file from an interrupted copy; readers ignore it, the sync engine removes it.
await writeFile(path.join(root, 'playlists', 'songs', 'tracks', 'song-3.mp3.part'), Buffer.alloc(1000));
console.log(`fixtures written to ${root}`);
for (const p of playlists) console.log(`  ${p.id}: ${p.tracks.length} tracks${p.truncateLast ? ' (last truncated)' : ''}`);
void stat;
