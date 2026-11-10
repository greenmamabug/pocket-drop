// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { spawn } from 'node:child_process';
import { constants as cryptoConstants, createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePlan } from '../src/mtk.js';
import { bundledToolDir, locateE2fsTools, nodePlatform, probeTool, runMtk } from '../src/node.js';

describe('bundled e2fsprogs folder', () => {
    let saved: string | undefined;
    beforeEach(() => { saved = process.env.STUDIO_POCKET_E2FS_DIR; delete process.env.STUDIO_POCKET_E2FS_DIR; });
    afterEach(() => { if (saved === undefined) delete process.env.STUDIO_POCKET_E2FS_DIR; else process.env.STUDIO_POCKET_E2FS_DIR = saved; });

    it('takes STUDIO_POCKET_E2FS_DIR when it is set', () => {
        process.env.STUDIO_POCKET_E2FS_DIR = '/opt/e2fs-test';
        expect(bundledToolDir('darwin')).toBe('/opt/e2fs-test');
    });

    it('otherwise uses the desktop bundle folder for the platform when it exists', () => {
        const seen: string[] = [];
        const exists = (dir: string) => { seen.push(dir); return true; };
        expect(bundledToolDir('darwin', exists)).toBe(path.resolve(import.meta.dirname, '../../../apps/desktop/src-tauri/resources/e2fsprogs/macos'));
        expect(bundledToolDir('linux', exists)).toBe(path.resolve(import.meta.dirname, '../../../apps/desktop/src-tauri/resources/e2fsprogs/linux'));
        expect(seen).toEqual([
            path.resolve(import.meta.dirname, '../../../apps/desktop/src-tauri/resources/e2fsprogs/macos'),
            path.resolve(import.meta.dirname, '../../../apps/desktop/src-tauri/resources/e2fsprogs/linux'),
        ]);
    });

    it("falls back to the repo's build/e2fsprogs/<os> when the desktop folder does not exist", () => {
        const none = () => false;
        expect(bundledToolDir('darwin', none)).toBe(path.resolve(import.meta.dirname, '../../../build/e2fsprogs/macos'));
        expect(bundledToolDir('linux', none)).toBe(path.resolve(import.meta.dirname, '../../../build/e2fsprogs/linux'));
        expect(bundledToolDir('win32', none)).toBe(path.resolve(import.meta.dirname, '../../../build/e2fsprogs/windows'));
    });

    it('still prefers STUDIO_POCKET_E2FS_DIR over the fallback', () => {
        process.env.STUDIO_POCKET_E2FS_DIR = '/opt/e2fs-test';
        expect(bundledToolDir('linux', () => false)).toBe('/opt/e2fs-test');
    });
});

describe('locateE2fsTools', () => {
    it.skipIf(process.platform === 'win32')('prefers the bundled folder over PATH and Homebrew', async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'e2fs-bundled-'));
        try {
            const bundled = path.join(dir, 'macos');
            await mkdir(bundled);
            for (const t of ['debugfs', 'e2fsck', 'dumpe2fs']) {
                await writeFile(path.join(bundled, t), '#!/bin/sh\n');
                await chmod(path.join(bundled, t), 0o755);
            }
            expect(await locateE2fsTools([bundled])).toEqual({ debugfs: path.join(bundled, 'debugfs'), e2fsck: path.join(bundled, 'e2fsck'), dumpe2fs: path.join(bundled, 'dumpe2fs') });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('runMtk identity gate', () => {
    const CID = '1500aa0100a1b2c3d4e5f6012345abcd';
    const keys = ['STUDIO_POCKET_MTK_BIN', 'FAKE_MTK_DEVICE', 'FAKE_MTK_CID', 'FAKE_MTK_NO_CID', 'FAKE_MTK_SLOW', 'FAKE_MTK_UNPATCHED', 'FAKE_MTK_NO_CONFIRM', 'FAKE_MTK_LEGACY_LINE', 'REFUSER_EXIT', 'STUDIO_POCKET_EXPECT_CID', 'STUDIO_POCKET_PROBE'] as const;
    /** Makes an in-test script answer the capability probe the way a patched mtkclient does. */
    const PROBE_ANSWER = 'if [ "${STUDIO_POCKET_PROBE:-}" = 1 ]; then echo \'Studio Pocket - identity gate 1\'; exit 0; fi\n';
    const saved: Record<string, string | undefined> = {};
    let dir: string;
    let device: string;
    let original: Buffer;
    let plan: { id: string; dir: string; lines: string[] };
    const lines: string[] = [];

    beforeEach(async () => {
        for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
        lines.length = 0;
        dir = await mkdtemp(path.join(os.tmpdir(), 'mtk-gate-'));
        device = path.join(dir, 'device.bin');
        original = Buffer.alloc(0x400000, 0x11);
        await writeFile(device, original);
        await writeFile(path.join(dir, 'img.bin'), Buffer.alloc(0x100000, 0x22));
        await mkdir(path.join(dir, 'plan'));
        process.env.STUDIO_POCKET_MTK_BIN = path.resolve(import.meta.dirname, 'fixtures/fake-mtk.sh');
        process.env.FAKE_MTK_DEVICE = device;
        plan = { id: 'gate', dir: path.join(dir, 'plan'), lines: writePlan(0, 0x400000, '../img.bin', { probe: 'identity-probe.bin', head: 'head.bin', tail: 'tail.bin' }) };
    });
    afterEach(async () => {
        for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        await rm(dir, { recursive: true, force: true });
    });

    it.skipIf(process.platform === 'win32')('kills the session during the probe when a different player answers; nothing is written', async () => {
        process.env.FAKE_MTK_CID = '0000000000000000000000000000beef';
        process.env.FAKE_MTK_SLOW = '1';
        const result = await runMtk(plan, (l) => lines.push(l), { expectCid: CID });
        expect(result.code).toBe(-2);
        expect(lines.at(-1)).toBe('wrong player: expected …2345abcd, connected …0000beef');
        expect(await readFile(device)).toEqual(original);
    });

    it.skipIf(process.platform === 'win32')('kills the session when no id was printed before the first read', async () => {
        process.env.FAKE_MTK_NO_CID = '1';
        process.env.FAKE_MTK_SLOW = '1';
        const result = await runMtk(plan, (l) => lines.push(l), { expectCid: CID });
        expect(result.code).toBe(-3);
        expect(lines.at(-1)).toBe('could not confirm which player is connected');
        expect(await readFile(device)).toEqual(original);
    });

    it.skipIf(process.platform === 'win32')('kills an unchecked tool that printed no id on the probe\'s Read progress (-3)', async () => {
        // Script mode prints no "Handling da commands": the first Read progress is the trigger, as on hardware.
        process.env.FAKE_MTK_NO_CID = '1';
        process.env.FAKE_MTK_NO_CONFIRM = '1';
        process.env.FAKE_MTK_SLOW = '1';
        const result = await runMtk(plan, (l) => lines.push(l), { expectCid: CID });
        expect(result.code).toBe(-3);
        expect(lines.at(-1)).toBe('could not confirm which player is connected');
        expect(lines.at(-2)).toMatch(/^Progress:.*Read:/);
        expect(lines.some((l) => l.includes('Handling da commands'))).toBe(false);
        expect((await readFile(device)).equals(original)).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('passes a session whose id matches, stage-2 progress first', async () => {
        const result = await runMtk(plan, (l) => lines.push(l), { expectCid: CID });
        expect(result.code).toBe(0);
        expect((await stat(path.join(plan.dir, 'identity-probe.bin'))).size).toBe(0x400000);
    });

    it.skipIf(process.platform === 'win32')('runs without an expected id exactly as before', async () => {
        const result = await runMtk(plan, (l) => lines.push(l));
        expect(result.code).toBe(0);
    });

    it.skipIf(process.platform === 'win32')('a wrong player is refused even when the log consumer is slow', async () => {
        // The consumer blocks the event loop for 3 s on the id line, so the runner cannot kill
        // in time; only the tool's own check (STUDIO_POCKET_EXPECT_CID) keeps the device unchanged.
        process.env.FAKE_MTK_CID = '0000000000000000000000000000beef';
        const block = new Int32Array(new SharedArrayBuffer(4));
        const result = await runMtk(plan, (l) => { lines.push(l); if (l.startsWith('m_emmc_cid')) Atomics.wait(block, 0, 0, 3000); }, { expectCid: CID });
        expect(result.code).toBe(-2);
        expect(lines.at(-1)).toBe('wrong player: expected …2345abcd, connected …0000beef');
        // A boolean, not toEqual: a failed 4 MiB buffer diff takes vitest minutes to print.
        expect((await readFile(device)).equals(original)).toBe(true);
    }, 15_000);

    it.skipIf(process.platform === 'win32')('the legacy "Handling da commands" line, when a tool prints it, is the earlier trigger for -4', async () => {
        process.env.FAKE_MTK_NO_CONFIRM = '1';
        process.env.FAKE_MTK_LEGACY_LINE = '1';
        process.env.FAKE_MTK_SLOW = '1';
        const result = await runMtk(plan, (l) => lines.push(l), { expectCid: CID });
        expect(result.code).toBe(-4);
        expect(lines.at(-2)).toBe('Main - Handling da commands ...');
        expect(lines.some((l) => /Progress:.*Read:/.test(l))).toBe(false);
        expect((await readFile(device)).equals(original)).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('a confirmation naming another player is killed with -2 and its tail is shown', async () => {
        const liar = path.join(dir, 'liar.sh');
        await writeFile(liar, `#!/bin/sh\n${PROBE_ANSWER}echo "m_emmc_cid = ${CID}"\necho "Main - Studio Pocket - player identity confirmed \u20262345abce"\nsleep 30\necho never\n`);
        await chmod(liar, 0o755);
        process.env.STUDIO_POCKET_MTK_BIN = liar;
        const result = await runMtk(plan, (l) => lines.push(l), { expectCid: CID });
        expect(result.code).toBe(-2);
        expect(lines.at(-1)).toBe('wrong player: expected …2345abcd, connected …2345abce');
        expect(lines).not.toContain('never');
    });

    it.skipIf(process.platform === 'win32')('child exit 102/103 map to -2/-3 with the standard last line', async () => {
        // No id line and no DA-stage line: only the exit code can produce these results.
        const refuser = path.join(dir, 'refuser.sh');
        await writeFile(refuser, `#!/bin/sh\n${PROBE_ANSWER}echo "Port - Handshake successful."\necho "Studio Pocket - refusing to run the plan"\nexit "$REFUSER_EXIT"\n`);
        await chmod(refuser, 0o755);
        process.env.STUDIO_POCKET_MTK_BIN = refuser;
        process.env.REFUSER_EXIT = '102';
        let result = await runMtk(plan, (l) => lines.push(l), { expectCid: CID });
        expect(result.code).toBe(-2);
        expect(lines.at(-1)).toBe('wrong player: expected …2345abcd, connected …unknown');
        lines.length = 0;
        process.env.REFUSER_EXIT = '103';
        result = await runMtk(plan, (l) => lines.push(l), { expectCid: CID });
        expect(result.code).toBe(-3);
        expect(lines.at(-1)).toBe('could not confirm which player is connected');
        // Without an expectation the exit code is passed through.
        lines.length = 0;
        result = await runMtk(plan, (l) => lines.push(l));
        expect(result.code).toBe(103);
    });

    it.skipIf(process.platform === 'win32')('the child sees the expected id only when one is given', async () => {
        const envDump = path.join(dir, 'env.sh');
        await writeFile(envDump, `#!/bin/sh\n${PROBE_ANSWER}echo "expect=\${STUDIO_POCKET_EXPECT_CID:-none}"\nexit 0\n`);
        await chmod(envDump, 0o755);
        process.env.STUDIO_POCKET_MTK_BIN = envDump;
        await runMtk(plan, (l) => lines.push(l), { expectCid: CID });
        expect(lines).toContain(`expect=${CID}`);
        lines.length = 0;
        await runMtk(plan, (l) => lines.push(l));
        expect(lines).toContain('expect=none');
    });

    it.skipIf(process.platform === 'win32')('an unpatched tool is refused by the probe before any plan is handed over, even with a slow log consumer', async () => {
        // The reviewer's reproduction: without the probe the kill came after the first write.
        process.env.FAKE_MTK_UNPATCHED = '1';
        const block = new Int32Array(new SharedArrayBuffer(4));
        const result = await runMtk(plan, (l) => { lines.push(l); if (l.startsWith('m_emmc_cid')) Atomics.wait(block, 0, 0, 3000); }, { expectCid: CID });
        expect(result.code).toBe(-4);
        expect(result.probeRefused).toBe(true);
        expect(lines.at(-1)).toBe('the mtkclient in use has no player identity check; nothing was written. Rebuild the bundle (scripts/build-mtkclient.sh) or re-run scripts/setup-mtkclient-venv.sh');
        expect(lines.some((l) => l.startsWith('m_emmc_cid'))).toBe(false);
        expect(lines).toHaveLength(1); // the usage text of an old tool is not forwarded; only the -4 line
        expect(result.stderr).toContain('usage: mtk'); // but the result still carries what the tool printed
        expect(existsSync(path.join(plan.dir, 'gate.mtk'))).toBe(false); // no plan file was written
        expect((await readFile(device)).equals(original)).toBe(true);
    }, 15_000);

    it.skipIf(process.platform === 'win32')('the probe answer is logged, the session then runs, and STUDIO_POCKET_PROBE never reaches the session', async () => {
        process.env.STUDIO_POCKET_PROBE = '1'; // a stale value in the parent must not leak
        const result = await runMtk(plan, (l) => lines.push(l), { expectCid: CID });
        expect(result.code).toBe(0);
        expect(lines[0]).toBe('Studio Pocket - identity gate 1');
        expect(lines).toContain('Studio Pocket - player identity confirmed …2345abcd');
        expect((await stat(path.join(plan.dir, 'identity-probe.bin'))).size).toBe(0x400000);
        // A session that shows the variable it sees.
        const shower = path.join(dir, 'shower.sh');
        await writeFile(shower, `#!/bin/sh\n${PROBE_ANSWER}echo "probe=\${STUDIO_POCKET_PROBE:-none}"\nexit 0\n`);
        await chmod(shower, 0o755);
        process.env.STUDIO_POCKET_MTK_BIN = shower;
        lines.length = 0;
        expect((await runMtk(plan, (l) => lines.push(l), { expectCid: CID })).code).toBe(0);
        expect(lines).toEqual(['Studio Pocket - identity gate 1', 'probe=none']);
    });

    it.skipIf(process.platform === 'win32')('a tool that answers the probe but never confirms is still killed at its first read (-4, second net)', async () => {
        process.env.FAKE_MTK_NO_CONFIRM = '1';
        process.env.FAKE_MTK_SLOW = '1';
        const result = await runMtk(plan, (l) => lines.push(l), { expectCid: CID });
        expect(result.code).toBe(-4);
        expect(result.probeRefused ?? false).toBe(false);
        expect(lines.at(-1)).toBe('the mtkclient in use ran its plan without confirming the player; the session was stopped at its first command. Rebuild the bundle (scripts/build-mtkclient.sh) or re-run scripts/setup-mtkclient-venv.sh');
        expect(lines.at(-2)).toMatch(/^Progress:.*Read:/);
        expect(lines).not.toContain('Studio Pocket - player identity confirmed …2345abcd');
        expect(lines.some((l) => l.includes('Handling da commands'))).toBe(false);
        expect((await readFile(device)).equals(original)).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('without an expectation there is no probe', async () => {
        process.env.FAKE_MTK_UNPATCHED = '1';
        const result = await runMtk(plan, (l) => lines.push(l));
        expect(result.code).toBe(0);
        expect(lines.some((l) => l.includes('identity gate'))).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('a tool that cannot be started is a failed run (-1), not a refused one', async () => {
        process.env.STUDIO_POCKET_MTK_BIN = path.join(dir, 'missing-mtk');
        const result = await runMtk(plan, (l) => lines.push(l), { expectCid: CID });
        expect(result.code).toBe(-1);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^error: .*ENOENT/);
    });

    it.skipIf(process.platform === 'win32')('a probe that does not answer in time is killed and fails', async () => {
        const sleeper = path.join(dir, 'sleeper.sh');
        // exec: the kill reaches the sleep itself, so no stray process outlives the test.
        await writeFile(sleeper, `#!/bin/sh\nexec sleep 30\n`);
        await chmod(sleeper, 0o755);
        const started = Date.now();
        const ok = await probeTool(sleeper, dir, { ...process.env }, (l) => lines.push(l), 1000);
        expect(ok).toBe(false);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(lines).toEqual([]);
    });
});

describe('fake-mtk identity check (stands in for the patched mtkclient)', () => {
    const CID = '1500aa0100a1b2c3d4e5f6012345abcd';
    const fake = path.resolve(import.meta.dirname, 'fixtures/fake-mtk.sh');
    let dir: string;
    let device: string;
    let planFile: string;
    let out: string;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'fake-mtk-cid-'));
        device = path.join(dir, 'device.bin');
        out = path.join(dir, 'probe.bin');
        planFile = path.join(dir, 'plan.mtk');
        await writeFile(device, Buffer.alloc(0x2000, 0x11));
        await writeFile(planFile, `ro 0x0 0x1000 ${out}\n`);
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    // Only the variables named here reach the fake: a STUDIO_POCKET_EXPECT_CID or FAKE_MTK_* in the
    // test process's own environment must not change the outcome.
    const run = (env: Record<string, string>) => new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn(fake, ['--serialport', 'DETECT', 'script', planFile], { env: { PATH: process.env.PATH ?? '', FAKE_MTK_DEVICE: device, ...env } });
        let stdout = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout }));
    });
    // The capability probe: no arguments and no FAKE_MTK_DEVICE, as the runners will start it.
    const probe = (env: Record<string, string>) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(fake, [], { env: { PATH: process.env.PATH ?? '', STUDIO_POCKET_PROBE: '1', ...env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    const exists = (f: string) => stat(f).then(() => true, () => false);

    it.skipIf(process.platform === 'win32')('fake-mtk refuses a wrong STUDIO_POCKET_EXPECT_CID by itself (exit 102) and confirms a matching one, case-insensitively', async () => {
        const wrong = await run({ STUDIO_POCKET_EXPECT_CID: CID, FAKE_MTK_CID: '0000000000000000000000000000BEEF' });
        expect(wrong.code).toBe(102);
        expect(wrong.stdout).toContain('Studio Pocket - wrong player: expected \u20262345abcd, connected \u20260000beef; refusing to run the plan');
        expect(wrong.stdout).not.toContain('Dumped offset');
        expect(await exists(out)).toBe(false);

        const right = await run({ STUDIO_POCKET_EXPECT_CID: CID.toUpperCase() });
        expect(right.code).toBe(0);
        expect(right.stdout).toContain('Studio Pocket - player identity confirmed \u20262345abcd');
        expect(right.stdout.indexOf('player identity confirmed')).toBeLessThan(right.stdout.indexOf('Dumped offset'));
        expect((await stat(out)).size).toBe(0x1000);
    });

    it.skipIf(process.platform === 'win32')('fake-mtk with FAKE_MTK_UNPATCHED=1 prints no confirmation and runs the plan', async () => {
        const result = await run({ STUDIO_POCKET_EXPECT_CID: CID, FAKE_MTK_CID: '0000000000000000000000000000beef', FAKE_MTK_UNPATCHED: '1' });
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain('Studio Pocket - ');
        expect((await stat(out)).size).toBe(0x1000);
    });

    it.skipIf(process.platform === 'win32')('fake-mtk answers the capability probe (STUDIO_POCKET_PROBE=1, no arguments) and exits 0', async () => {
        const r = await probe({});
        expect(r.code).toBe(0);
        expect(r.stdout.trim()).toBe('Studio Pocket - identity gate 1');
    });

    it.skipIf(process.platform === 'win32')('fake-mtk with FAKE_MTK_UNPATCHED=1 fails the probe like an old mtkclient (usage, exit 2)', async () => {
        const r = await probe({ FAKE_MTK_UNPATCHED: '1' });
        expect(r.code).toBe(2);
        expect(r.stdout).not.toContain('identity gate');
        expect(r.stderr).toMatch(/^usage: mtk/);
    });

    it.skipIf(process.platform === 'win32')('fake-mtk with FAKE_MTK_NO_CONFIRM=1 answers the probe but prints no confirmation and runs the plan', async () => {
        expect((await probe({ FAKE_MTK_NO_CONFIRM: '1' })).code).toBe(0);
        const result = await run({ STUDIO_POCKET_EXPECT_CID: CID, FAKE_MTK_NO_CONFIRM: '1' });
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain('player identity confirmed');
    });

    it.skipIf(process.platform === 'win32')('fake-mtk with FAKE_MTK_NO_CID=1 and an expectation exits 103', async () => {
        const result = await run({ STUDIO_POCKET_EXPECT_CID: CID, FAKE_MTK_NO_CID: '1' });
        expect(result.code).toBe(103);
        expect(result.stdout).toContain('Studio Pocket - could not confirm which player is connected; refusing to run the plan');
        expect(await exists(out)).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('fake-mtk without STUDIO_POCKET_EXPECT_CID runs the plan as before', async () => {
        const result = await run({});
        expect(result.code).toBe(0);
        expect(result.stdout).not.toContain('Studio Pocket - ');
    });
});

describe('platform digests and RSA verification', () => {
    const data = new TextEncoder().encode('META-INF/MANIFEST.MF digest input');

    it('digestBytes matches node:crypto for sha1 and sha256', async () => {
        for (const algorithm of ['sha1', 'sha256'] as const) {
            const digest = await nodePlatform.digestBytes(algorithm, data);
            expect(digest).toBeInstanceOf(Uint8Array);
            expect(Buffer.from(digest).toString('hex')).toBe(createHash(algorithm).update(data).digest('hex'));
        }
        expect((await nodePlatform.digestBytes('sha1', data)).length).toBe(20);
        expect((await nodePlatform.digestBytes('sha256', data)).length).toBe(32);
    });

    it('verifyRsaPkcs1 accepts a signature made with the matching key and rejects a flipped bit, without throwing on garbage', async () => {
        const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const spki = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));
        for (const hash of ['sha1', 'sha256'] as const) {
            const signature = new Uint8Array(sign(hash, data, privateKey));
            expect(await nodePlatform.verifyRsaPkcs1(spki, hash, data, signature)).toBe(true);

            const flipped = signature.slice();
            flipped[flipped.length - 1] ^= 0x01;
            expect(await nodePlatform.verifyRsaPkcs1(spki, hash, data, flipped)).toBe(false);

            await expect(nodePlatform.verifyRsaPkcs1(new Uint8Array([0x30, 0x03, 0x01, 0x02, 0x03]), hash, data, signature)).resolves.toBe(false);
        }
        const other = new Uint8Array(sign('sha256', data, privateKey));
        expect(await nodePlatform.verifyRsaPkcs1(spki, 'sha1', data, other)).toBe(false);
    });

    it('verifyRsaPkcs1 is RSASSA-PKCS1-v1_5 only: an EC key or an RSA-PSS key never verifies', async () => {
        const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const ecSpki = new Uint8Array(ec.publicKey.export({ format: 'der', type: 'spki' }));
        const ecdsa = new Uint8Array(sign('sha256', data, ec.privateKey));
        expect(await nodePlatform.verifyRsaPkcs1(ecSpki, 'sha256', data, ecdsa)).toBe(false);

        const pss = generateKeyPairSync('rsa-pss', { modulusLength: 2048 });
        const pssSpki = new Uint8Array(pss.publicKey.export({ format: 'der', type: 'spki' }));
        const pssSignature = new Uint8Array(sign('sha256', data, { key: pss.privateKey, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING }));
        expect(await nodePlatform.verifyRsaPkcs1(pssSpki, 'sha256', data, pssSignature)).toBe(false);
    });
});
