// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLibrary } from '../src/node.js';
import { FormatError, parseWith, validateGroups, validateRecent } from '../src/validate.js';
import { GROUPS_DIR, GROUPS_FILE, MAX_GROUPS, RECENT_FILE, RESERVED_GROUP_IDS } from '../src/types.js';

const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures');
const root = path.join(fixtures, 'library', 'STUDIOPOCKET');

const group = (id: string, playlists: string[] = [], extra: Record<string, unknown> = {}) => ({ id, title: id, playlists, ...extra });
const groupsFile = (groups: unknown[]) => ({ format: 'studiopocket-groups', formatVersion: 1, updatedAt: '2026-10-22T07:00:00Z', generator: 'test', groups });

describe('groups.json', () => {
    it('accepts the shared fixture', async () => {
        const file = parseWith(validateGroups, await readFile(path.join(root, GROUPS_FILE), 'utf8'), GROUPS_FILE);
        expect(file.groups.map((g) => g.id)).toEqual(['g-bedtime', 'g-music', 'g-empty']);
        expect(file.groups[0]).toMatchObject({ title: 'Bedtime', icon: 'groups/g-bedtime.png', iconRef: 'yoto:fixture-moon', playlists: ['bedtime', 'gone-away'] });
        expect(file.groups[1]!.icon).toBeNull();
        expect(file.groups[1]!.iconRef).toBeUndefined();
        expect(file.groups[2]!.playlists).toEqual([]);
    });

    it('treats an absent or null icon as no icon and only allows groups/<name>', () => {
        expect(validateGroups(groupsFile([group('a')])).groups[0]!.icon).toBeNull();
        expect(validateGroups(groupsFile([group('a', [], { icon: null })])).groups[0]!.icon).toBeNull();
        expect(validateGroups(groupsFile([group('a', [], { icon: 'groups/a.png' })])).groups[0]!.icon).toBe('groups/a.png');
        expect(() => validateGroups(groupsFile([group('a', [], { icon: 'icons/a.png' })]))).toThrow(/groups\[0\]\.icon: must be groups\/<name>/);
        expect(() => validateGroups(groupsFile([group('a', [], { icon: 'groups/../a.png' })]))).toThrow(FormatError);
    });

    it('enforces the bounds', () => {
        expect(validateGroups(groupsFile(Array.from({ length: MAX_GROUPS }, (_, i) => group(`g-${i}`)))).groups).toHaveLength(MAX_GROUPS);
        expect(() => validateGroups(groupsFile(Array.from({ length: MAX_GROUPS + 1 }, (_, i) => group(`g-${i}`))))).toThrow(/max 30/);
        expect(validateGroups(groupsFile([{ ...group('a'), title: 'x'.repeat(40) }])).groups[0]!.title).toHaveLength(40);
        expect(() => validateGroups(groupsFile([{ ...group('a'), title: 'x'.repeat(41) }]))).toThrow(/groups\[0\]\.title/);
        expect(() => validateGroups(groupsFile([{ ...group('a'), title: '' }]))).toThrow(/groups\[0\]\.title/);
        expect(() => validateGroups(groupsFile([group('a', [], { iconRef: 'y'.repeat(101) })]))).toThrow(/iconRef/);
    });

    it('rejects reserved, invalid and duplicate group ids', () => {
        for (const reserved of RESERVED_GROUP_IDS) expect(() => validateGroups(groupsFile([group(reserved)]))).toThrow(/reserved/);
        expect(() => validateGroups(groupsFile([group('Bad Id')]))).toThrow(/groups\[0\]\.id/);
        expect(() => validateGroups(groupsFile([group('a'), group('a')]))).toThrow(/group ids must be unique/);
    });

    it('allows a playlist in at most one group', () => {
        expect(() => validateGroups(groupsFile([group('a', ['p', 'p'])]))).toThrow(/groups\[0\]\.playlists: playlist ids must be unique/);
        expect(() => validateGroups(groupsFile([group('a', ['p']), group('b', ['q', 'p'])]))).toThrow(/groups\[1\]\.playlists: p is already in group a/);
        expect(() => validateGroups(groupsFile([group('a', ['Nope'])]))).toThrow(/groups\[0\]\.playlists\[0\]/);
    });

    it('checks the header', () => {
        expect(() => validateGroups({ ...groupsFile([]), format: 'studiopocket-library' })).toThrow(/format must be "studiopocket-groups"/);
        expect(() => validateGroups({ ...groupsFile([]), formatVersion: 2 })).toThrow(/unsupported formatVersion 2/);
        expect(() => validateGroups({ ...groupsFile([]), groups: {} })).toThrow(/groups must be an array/);
    });
});

describe('recent.json', () => {
    it('accepts the shared fixture', async () => {
        const recent = parseWith(validateRecent, await readFile(path.join(root, RECENT_FILE), 'utf8'), RECENT_FILE);
        expect(recent.playlists).toEqual(['songs', 'gone-away', 'bedtime']);
    });

    it('accepts up to 20 unique ids', () => {
        const base = { format: 'studiopocket-recent', formatVersion: 1, updatedAt: 'x' };
        expect(validateRecent({ ...base, playlists: [] }).playlists).toEqual([]);
        expect(validateRecent({ ...base, playlists: Array.from({ length: 20 }, (_, i) => `p-${i}`) }).playlists).toHaveLength(20);
        expect(() => validateRecent({ ...base, playlists: Array.from({ length: 21 }, (_, i) => `p-${i}`) })).toThrow(/max 20/);
        expect(() => validateRecent({ ...base, playlists: ['a', 'a'] })).toThrow(/unique/);
        expect(() => validateRecent({ ...base, playlists: ['A'] })).toThrow(/recent\.playlists\[0\]/);
    });
});

describe('checkLibrary and groups', () => {
    it('parses groups and recent alongside the library', async () => {
        const check = await checkLibrary(root);
        expect(check.problems).toEqual([]);
        expect(check.groups?.groups.map((g) => g.id)).toEqual(['g-bedtime', 'g-music', 'g-empty']);
        expect(check.recent?.playlists).toEqual(['songs', 'gone-away', 'bedtime']);
    });

    it('reports a bad groups.json, a missing group icon and a bad recent.json as non-fatal and still shows every playlist', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'myo-groups-'));
        try {
            await cp(root, dir, { recursive: true });
            await writeFile(path.join(dir, GROUPS_FILE), JSON.stringify(groupsFile([group('recent')])));
            await writeFile(path.join(dir, RECENT_FILE), '{ nope');
            const check = await checkLibrary(dir);
            expect(check.groups).toBeNull();
            expect(check.recent).toBeNull();
            expect(check.problems).toHaveLength(2);
            expect(check.problems.every((p) => p.endsWith('(non-fatal)'))).toBe(true);
            expect(check.problems[0]).toMatch(/^groups\.json\.groups\[0\]\.id/);
            expect(check.problems[1]).toMatch(/^recent\.json: invalid JSON/);
            expect(check.playlists.filter((p) => p.ok).map((p) => p.id)).toEqual(['bedtime', 'songs']);

            await writeFile(path.join(dir, GROUPS_FILE), JSON.stringify(groupsFile([group('a', ['songs'], { icon: `${GROUPS_DIR}/a.png` })])));
            await rm(path.join(dir, RECENT_FILE));
            const missingIcon = await checkLibrary(dir);
            expect(missingIcon.groups?.groups[0]!.id).toBe('a');
            expect(missingIcon.recent).toBeNull();
            expect(missingIcon.problems).toEqual(['missing group icon groups/a.png (non-fatal)']);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('treats absent files as no groups and nothing played yet', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'myo-groups-'));
        try {
            await cp(root, dir, { recursive: true });
            await rm(path.join(dir, GROUPS_FILE));
            await rm(path.join(dir, RECENT_FILE));
            const check = await checkLibrary(dir);
            expect(check.groups).toBeNull();
            expect(check.recent).toBeNull();
            expect(check.problems).toEqual([]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
