// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addWakeFlags, buildKeyLayoutScript, KEY_LAYOUT, missingWakeFlags, WAKE_SCAN_CODES } from '../src/keylayout.js';
import { debugfsScript, findTool, locateE2fsTools, patchSystemImage, run, verifyPatchedImage } from '../src/node.js';
import { fixture } from './fake-apk.js';

/** Lines in the shape of the stock Y2 mtk-kpd.kl (columns, flags, no final newline). */
const STOCK = [
    'key 399   GRAVE',
    'key 158   BACK',
    'key 107   ENDCALL           WAKE',
    'key 108   DPAD_DOWN',
    'key 103   DPAD_UP',
    'key 105   DPAD_LEFT',
    'key 106   DPAD_RIGHT',
    'key 115   VOLUME_UP         WAKE_DROPPED',
    'key 116   POWER             WAKE',
    '',
    'key 28    ENTER',
    '',
    'key 164   MEDIA_PLAY_PAUSE    WAKE',
].join('\n');

describe('addWakeFlags', () => {
    it('adds WAKE to the arrow, centre and back buttons and changes nothing else, the ring included', () => {
        const edit = addWakeFlags(STOCK);
        expect(edit.changed.sort((a, b) => a - b)).toEqual([...WAKE_SCAN_CODES].sort((a, b) => a - b));
        expect(edit.untouched).toEqual([]);
        const before = STOCK.split('\n');
        const after = edit.text.split('\n');
        expect(after).toHaveLength(before.length);
        expect(after[1]).toBe('key 158   BACK              WAKE');
        expect(after[5]).toBe('key 105   DPAD_LEFT         WAKE');
        expect(after[10]).toBe('key 28    ENTER             WAKE');
        // The ring (108 down, 103 up) turns too easily by accident to wake the screen.
        for (const i of [0, 2, 3, 4, 7, 8, 9, 11, 12]) expect(after[i]).toBe(before[i]);
        expect(edit.text.endsWith('\n')).toBe(false);
    });

    it('is idempotent: a layout that already wakes is left as it is', () => {
        const once = addWakeFlags(STOCK).text;
        const twice = addWakeFlags(once);
        expect(twice.changed).toEqual([]);
        expect(twice.text).toBe(once);
    });

    it('leaves a wake key with some other flag alone and reports it, along with a missing one', () => {
        const edit = addWakeFlags('key 158   BACK              VIRTUAL\nkey 105   DPAD_LEFT');
        expect(edit.text).toBe('key 158   BACK              VIRTUAL\nkey 105   DPAD_LEFT         WAKE');
        expect(edit.untouched.sort((a, b) => a - b)).toEqual([28, 106, 158]);
    });

    it('names the keys that do not wake', () => {
        expect(missingWakeFlags(STOCK).sort((a, b) => a - b)).toEqual([28, 105, 106, 158]);
        expect(missingWakeFlags(addWakeFlags(STOCK).text)).toEqual([]);
    });

    it('replaces the file as root:root 0644 with the system_file label, like the APK', () => {
        expect(buildKeyLayoutScript('"/w/mtk-kpd.kl"', '"/w/ctx"')).toEqual([
            'rm /usr/keylayout/mtk-kpd.kl',
            'cd /usr/keylayout',
            'write "/w/mtk-kpd.kl" mtk-kpd.kl',
            'sif mtk-kpd.kl mode 0100644',
            'sif mtk-kpd.kl uid 0',
            'sif mtk-kpd.kl gid 0',
            'ea_set -f "/w/ctx" mtk-kpd.kl security.selinux',
        ]);
    });
});

const mke2fs = await findTool('mke2fs');
const tools = await locateE2fsTools().catch(() => null);

describe.skipIf(!(mke2fs && tools))('the key layout in a patched system image', () => {
    it('install adds WAKE, verification checks it, an upgrade leaves it, and a stock layout fails verification', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'myo kl-'));
        try {
            const stock = path.join(dir, 'system.img');
            const launcher = path.join(dir, 'MyLauncher.apk');
            const apk = path.join(dir, 'StudioPocket.apk');
            const kl = path.join(dir, 'stock.kl');
            await writeFile(launcher, Buffer.alloc(64 * 1024, 0x41));
            await writeFile(apk, fixture('signed-apksigner.apk'));
            await writeFile(kl, STOCK);
            expect((await run(mke2fs!, ['-q', '-t', 'ext4', '-b', '4096', '-O', '^has_journal', stock, '16M'])).code).toBe(0);
            await debugfsScript(tools!, stock, ['mkdir /priv-app', 'mkdir /app', 'mkdir /usr', 'mkdir /usr/keylayout', 'cd /priv-app', `write "${launcher}" MyLauncher.apk`, 'cd /usr/keylayout', `write "${kl}" mtk-kpd.kl`], true);

            const out = path.join(dir, 'out.img');
            const result = await patchSystemImage({ stockImage: stock, apk, out, workDir: path.join(dir, 'work'), tools: tools! });
            expect(result.wakeKeysAdded.sort((a, b) => a - b)).toEqual([28, 105, 106, 158]);
            const report = await verifyPatchedImage({ image: out, expectedApkSha256: result.apkSha256, partitionSizeBytes: 0x33400000, tools: tools! });
            expect(report.problems).toEqual([]);
            expect(report.details.wakeKeys).toBe('all');

            const back = path.join(dir, 'back.kl');
            await debugfsScript(tools!, out, [`dump ${KEY_LAYOUT} "${back}"`], false);
            expect(await readFile(back, 'utf8')).toBe(addWakeFlags(STOCK).text);
            const stat = (await debugfsScript(tools!, out, [`stat ${KEY_LAYOUT}`, `ea_get ${KEY_LAYOUT} security.selinux`], false)).stdout;
            expect(stat).toMatch(/Mode:\s+0644/);
            expect(stat).toMatch(/User:\s+0\s+Group:\s+0/);
            expect(stat).toContain('u:object_r:system_file:s0');

            const upgraded = await patchSystemImage({ stockImage: out, apk, out: path.join(dir, 'up.img'), workDir: path.join(dir, 'work2'), mode: 'upgrade', tools: tools! });
            expect(upgraded.wakeKeysAdded).toEqual([]);

            // An image whose layout never got the change (the stock one, with only the launcher swapped) fails verification.
            await debugfsScript(tools!, out, ['rm /usr/keylayout/mtk-kpd.kl', 'cd /usr/keylayout', `write "${kl}" mtk-kpd.kl`], true);
            const bad = await verifyPatchedImage({ image: out, expectedApkSha256: result.apkSha256, partitionSizeBytes: 0x33400000, tools: tools! });
            expect(bad.problems.join('\n')).toMatch(/mtk-kpd\.kl: scan code\(s\) .* do not wake the screen/);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
