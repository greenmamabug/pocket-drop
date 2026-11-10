// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DA_DIR, DownloadAgentError, downloadAgentPin, ensureDownloadAgent, type DownloadAgentPin } from '../src/da.js';
import { downloadFile, envOverrides, mtkArgv, nodePlatform } from '../src/node.js';
import type { FirmwareOverrides, FirmwarePlatform } from '../src/platform.js';

/** ensureDownloadAgent against a local HTTP server (never upstream): fetch, check, keep, override. */
const BODY = Buffer.from('a stand-in for the MediaTek download agent\n');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let server: Server;
let base: string;
let requests: string[] = [];
let dir: string;
const stalled: import('node:http').ServerResponse[] = [];

beforeAll(async () => {
    server = createServer((req, res) => {
        requests.push(req.url ?? '');
        if (req.url === '/da.bin') res.writeHead(200, { 'content-length': BODY.length }).end(BODY);
        else if (req.url === '/moved') res.writeHead(302, { location: '/da.bin' }).end();
        else if (req.url === '/short') { res.writeHead(200, { 'content-length': BODY.length + 10 }); res.write(BODY); res.destroy(); }
        // A server that sends a little and then nothing: the client's idle timeout must end it.
        else if (req.url === '/stall') { res.writeHead(200, { 'content-length': BODY.length * 2 }); res.write(BODY); stalled.push(res); }
        else if (req.url === '/slow') { res.writeHead(200, { 'content-length': BODY.length }); setTimeout(() => res.end(BODY), 50); }
        else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => { stalled.forEach((r) => r.destroy()); return new Promise<void>((r) => server.close(() => r())); });
beforeEach(async () => { requests = []; dir = await mkdtemp(path.join(os.tmpdir(), 'myo da-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const pinFor = (urlPath: string, body: Buffer = BODY): DownloadAgentPin => ({ ...downloadAgentPin(), url: `${base}${urlPath}`, sha256: sha(body), sizeBytes: body.length });
const withOverrides = (o: FirmwareOverrides): FirmwarePlatform => ({ ...nodePlatform, overrides: async () => o });
const none = withOverrides({});
const kept = (fw: string) => path.join(fw, ...DA_DIR, downloadAgentPin().file);

describe('the pinned download agent', () => {
    it('is MediaTek\'s mt6590 legacy DA at the mtkclient commit the bundles are built from, by hash', async () => {
        const pin = downloadAgentPin();
        const mtkPin = JSON.parse(await readFile(new URL('../../../scripts/mtkclient-pin.json', import.meta.url), 'utf8')) as { commit: string };
        expect(pin).toMatchObject({ file: 'MTK_AllInOne_DA_mt6590.bin', upstreamCommit: mtkPin.commit, sha256: '49a1413765ed0e21fbd2c62f0e295665d0236eeb255846bd77f3329a3a86cc64' });
        expect(pin.url).toBe(`https://raw.githubusercontent.com/bkerler/mtkclient/${mtkPin.commit}/mtkclient/Loader/MTK_AllInOne_DA_mt6590.bin`);
    });
});

describe('ensureDownloadAgent', () => {
    it('fetches a file with the pinned hash into tools/da/ and logs it', async () => {
        const lines: string[] = [];
        const progress: number[] = [];
        const file = await ensureDownloadAgent(none, dir, (l) => lines.push(l), { pin: pinFor('/da.bin'), onProgress: (b) => progress.push(b) });
        expect(file).toBe(kept(dir));
        expect(await readFile(file)).toEqual(BODY);
        expect(await readdir(path.dirname(file))).toEqual([path.basename(file)]);   // no .part left
        expect(requests).toEqual(['/da.bin']);
        expect(progress.at(-1)).toBe(BODY.length);
        expect(lines.at(-1)).toBe(`Fetched the MediaTek download agent from upstream mtkclient (${downloadAgentPin().upstreamCommit}), sha256 ok`);
    });

    it('follows a redirect', async () => {
        expect(await readFile(await ensureDownloadAgent(none, dir, undefined, { pin: { ...pinFor('/da.bin'), url: `${base}/moved` } }))).toEqual(BODY);
        expect(requests).toEqual(['/moved', '/da.bin']);
    });

    it('deletes a download with the wrong hash and names the expected hash and the override', async () => {
        const pin = { ...pinFor('/da.bin'), sha256: 'f'.repeat(64) };
        const error = await ensureDownloadAgent(none, dir, undefined, { pin }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DownloadAgentError);
        expect((error as Error).message).toContain(`has SHA-256 ${sha(BODY)}, not the expected ${'f'.repeat(64)}, so it was deleted`);
        expect((error as Error).message).toContain('STUDIO_POCKET_DA_FILE');
        expect(error).toMatchObject({ kind: 'mismatch' });
        expect(await readdir(path.join(dir, ...DA_DIR))).toEqual([]);
    });

    it('says the firmware folder could not be written when tools/da/ cannot be made, naming it', async () => {
        await writeFile(path.join(dir, 'tools'), 'a file where the folder should be');
        const error = await ensureDownloadAgent(none, dir, undefined, { pin: pinFor('/da.bin') }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DownloadAgentError);
        expect(error).toMatchObject({ kind: 'filesystem', folder: path.join(dir, ...DA_DIR) });
        expect((error as Error).message).toContain(`Could not write the MediaTek download agent into ${path.join(dir, ...DA_DIR)}`);
        expect(requests).toEqual([]);
    });

    it('two fetches into one folder at once each use their own part file, and both end with the checked file', async () => {
        const pin = pinFor('/slow');
        const [a, b] = await Promise.all([ensureDownloadAgent(none, dir, undefined, { pin }), ensureDownloadAgent(none, dir, undefined, { pin })]);
        expect(a).toBe(kept(dir));
        expect(b).toBe(kept(dir));
        expect(requests).toEqual(['/slow', '/slow']);
        expect(await readFile(kept(dir))).toEqual(BODY);
        expect(await readdir(path.dirname(kept(dir)))).toEqual([path.basename(kept(dir))]);
    });

    it('turns an HTTP error or a cut-short body into DownloadAgentError and leaves no file', async () => {
        for (const urlPath of ['/missing', '/short']) {
            const error = await ensureDownloadAgent(none, dir, undefined, { pin: pinFor(urlPath) }).catch((e: unknown) => e);
            expect(error).toBeInstanceOf(DownloadAgentError);
            expect((error as Error).message).toMatch(/Could not download the MediaTek download agent .*STUDIO_POCKET_DA_FILE/);
            expect(error).toMatchObject({ kind: 'offline' });
            expect(await readdir(path.join(dir, ...DA_DIR))).toEqual([]);
        }
    });

    it('makes no request when the kept file has the pinned hash, and fetches again when it does not', async () => {
        const pin = pinFor('/da.bin');
        await mkdir(path.dirname(kept(dir)), { recursive: true });
        await writeFile(kept(dir), BODY);
        expect(await ensureDownloadAgent(none, dir, undefined, { pin })).toBe(kept(dir));
        expect(requests).toEqual([]);
        await writeFile(kept(dir), 'damaged');
        const lines: string[] = [];
        expect(await readFile(await ensureDownloadAgent(none, dir, (l) => lines.push(l), { pin }))).toEqual(BODY);
        expect(requests).toEqual(['/da.bin']);
        expect(lines[0]).toMatch(/does not match the pinned hash; fetching it again/);
    });

    it('uses STUDIO_POCKET_DA_FILE when it has the pinned hash, refuses it otherwise unless unchecked, and never fetches', async () => {
        const pin = pinFor('/da.bin');
        const own = path.join(dir, 'my agent.bin');
        await writeFile(own, BODY);
        const lines: string[] = [];
        expect(await ensureDownloadAgent(withOverrides({ daFile: own }), dir, (l) => lines.push(l), { pin })).toBe(own);
        expect(lines).toEqual([`Using the MediaTek download agent at ${own} (STUDIO_POCKET_DA_FILE), sha256 ok`]);

        await writeFile(own, 'something else');
        await expect(ensureDownloadAgent(withOverrides({ daFile: own }), dir, undefined, { pin })).rejects.toThrow(`has SHA-256 ${sha('something else')}, not the expected ${pin.sha256}. Set STUDIO_POCKET_DA_FILE_UNCHECKED=1 to use it anyway.`);
        const warned: string[] = [];
        expect(await ensureDownloadAgent(withOverrides({ daFile: own, daFileUnchecked: true }), dir, (l) => warned.push(l), { pin })).toBe(own);
        expect(warned[0]).toMatch(/^warning: .*without checking its hash \(STUDIO_POCKET_DA_FILE_UNCHECKED=1\)/);
        await expect(ensureDownloadAgent(withOverrides({ daFile: path.join(dir, 'nope.bin'), daFileUnchecked: true }), dir, undefined, { pin })).rejects.toThrow(/STUDIO_POCKET_DA_FILE names .*nope\.bin, which is not a file/);
        expect(requests).toEqual([]);
    });
});

describe('the Node platform', () => {
    it('reads the overrides from the environment, resolved', () => {
        expect(envOverrides({})).toEqual({});
        expect(envOverrides({ STUDIO_POCKET_DA_FILE: 'da.bin', STUDIO_POCKET_DA_FILE_UNCHECKED: '1', STUDIO_POCKET_PRELOADER_FILE: '/p/pl.bin' })).toEqual({ daFile: path.resolve('da.bin'), daFileUnchecked: true, preloaderFile: '/p/pl.bin' });
        expect(envOverrides({ STUDIO_POCKET_DA_FILE: ' ', STUDIO_POCKET_DA_FILE_UNCHECKED: 'yes' })).toEqual({});
    });

    it('downloadFile gives up on a server that stops sending, after its idle time, and removes the file', async () => {
        const dest = path.join(dir, 'stalled.bin');
        const started = Date.now();
        await expect(downloadFile(`${base}/stall`, dest, undefined, 200)).rejects.toThrow('no bytes for 0.2 s');
        expect(Date.now() - started).toBeLessThan(5000);
        await expect(readFile(dest)).rejects.toThrow();
    });

    it('downloadFile replaces the destination and refuses other schemes', async () => {
        const dest = path.join(dir, 'out.bin');
        await writeFile(dest, 'old and longer than the new body, which must replace it entirely');
        await downloadFile(`${base}/da.bin`, dest);
        expect(await readFile(dest)).toEqual(BODY);
        await expect(downloadFile('file:///etc/passwd', dest)).rejects.toThrow(/only http and https/);
    });

    it('mtkArgv passes the download agent and the preloader before script', () => {
        expect(mtkArgv('/f/plan.mtk', 'darwin', { daFile: '/a b/da.bin' })).toEqual(['--serialport', 'DETECT', '--loader', '/a b/da.bin', 'script', '/f/plan.mtk']);
        expect(mtkArgv('C:\\f\\plan.mtk', 'win32', { daFile: 'C:\\da.bin', preloaderFile: 'C:\\pl.bin' })).toEqual(['--loader', 'C:\\da.bin', '--preloader', 'C:\\pl.bin', 'script', 'C:\\f\\plan.mtk']);
        expect(mtkArgv('/f/plan.mtk', 'linux')).toEqual(['--serialport', 'DETECT', 'script', '/f/plan.mtk']);
    });
});
