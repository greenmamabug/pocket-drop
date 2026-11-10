// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import { execFile, spawn } from 'node:child_process';
import { access, constants, copyFile, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { constants as cryptoConstants, createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inflateRaw } from 'node:zlib';
import { ToolError } from './e2fs.js';
import { DA_FILE_ENV, DA_FILE_UNCHECKED_ENV, PRELOADER_FILE_ENV } from './da.js';
import { cidTail, confirmedTail, IDENTITY_CONFIRMED, IDENTITY_GATE_LINE, identityGate, MTK_EXIT_UNCONFIRMED, MTK_EXIT_WRONG_PLAYER, parseEmmcCid, PROBE_TIMEOUT_MS, stripAnsi, UNCHECKED_TOOL_LINE, UNCHECKED_TOOL_STARTED_LINE } from './mtk.js';
import { parseManifest } from './manifest.js';
import { identifyImage as identifyImageWith } from './ext4.js';
import { prepareStock as prepareStockWith } from './stock.js';
import { patchSystemImage as patchSystemImageWith } from './patch.js';
import { verifyPatchedImage as verifyPatchedImageWith } from './verify.js';
import { debugfsScript as debugfsScriptWith } from './e2fs.js';
/**
 * Runs an external tool with an argument vector. There is deliberately no shell
 * involved anywhere in this package: paths and names are passed as discrete argv
 * entries, so nothing a caller supplies can be interpreted as a command.
 */
export function run(file, args, options = {}) {
    return new Promise((resolve) => {
        execFile(file, args, { cwd: options.cwd, maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
            const code = error && typeof error.code === 'number'
                ? error.code
                : error ? -1 : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}
/** Folder names for the bundled e2fsprogs, the same as Rust's `std::env::consts::OS` except macOS and Windows. */
const BUNDLED_FOLDER_NAMES = { darwin: 'macos', win32: 'windows' };
/**
 * Where `scripts/build-e2fsprogs.sh` puts e2fsprogs, searched before PATH so the CLI runs the same
 * binaries as the app: the desktop app's resources folder when it exists, else the repo's
 * `build/e2fsprogs/<os>` (the script's output in a tree without the desktop app, such as the public
 * repo). STUDIO_POCKET_E2FS_DIR replaces both: a build made elsewhere, or an unpacked release archive.
 * Read on each call, so a test or the CLI can set it after import.
 */
export function bundledToolDir(platform = process.platform, exists = existsSync) {
    const override = process.env.STUDIO_POCKET_E2FS_DIR;
    if (override)
        return override;
    const folder = BUNDLED_FOLDER_NAMES[platform] ?? platform;
    const desktop = fileURLToPath(new URL(`../../../apps/desktop/src-tauri/resources/e2fsprogs/${folder}`, import.meta.url));
    return exists(desktop) ? desktop : fileURLToPath(new URL(`../../../build/e2fsprogs/${folder}`, import.meta.url));
}
/** Extra directories searched for e2fsprogs on hosts where it is keg-only (Homebrew). */
export const EXTRA_TOOL_DIRS = [
    '/opt/homebrew/opt/e2fsprogs/sbin',
    '/opt/homebrew/opt/e2fsprogs/bin',
    '/usr/local/opt/e2fsprogs/sbin',
    '/usr/local/opt/e2fsprogs/bin',
    '/sbin',
    '/usr/sbin',
];
/** Searches `firstDirs`, then PATH, then `extraDirs`, for an executable `name`. */
export async function findTool(name, extraDirs = EXTRA_TOOL_DIRS, firstDirs = []) {
    const dirs = [...firstDirs, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), ...extraDirs];
    for (const dir of dirs) {
        const candidate = path.join(dir, name);
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        }
        catch {
            // keep looking
        }
    }
    return null;
}
export async function locateE2fsTools(bundledDirs = [bundledToolDir()]) {
    const find = (name) => findTool(name, EXTRA_TOOL_DIRS, bundledDirs);
    const [debugfs, e2fsck, dumpe2fs] = await Promise.all([find('debugfs'), find('e2fsck'), find('dumpe2fs')]);
    const missing = [['debugfs', debugfs], ['e2fsck', e2fsck], ['dumpe2fs', dumpe2fs]].filter(([, p]) => !p).map(([n]) => n);
    if (missing.length) {
        throw new ToolError(`missing e2fsprogs tool(s): ${missing.join(', ')} (build them with scripts/build-e2fsprogs.sh, or macOS: brew install e2fsprogs; Linux: apt install e2fsprogs)`);
    }
    return { debugfs: debugfs, e2fsck: e2fsck, dumpe2fs: dumpe2fs };
}
/** Streaming SHA-256 of a file, hex encoded. Images are ~860 MB so never read them whole. */
export function sha256File(file, onProgress) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        let bytes = 0;
        createReadStream(file)
            .on('data', (chunk) => { hash.update(chunk); bytes += chunk.length; onProgress?.(bytes); })
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}
export function sha256Bytes(data) {
    return createHash('sha256').update(data).digest('hex');
}
/**
 * mtkclient: `STUDIO_POCKET_MTK_BIN`, else the repo's patched venv
 * (firmware/tools/mtkclient-venv/bin/mtk, see scripts/patch-mtkclient.py), else PATH.
 */
export async function findMtk() {
    const env = process.env.STUDIO_POCKET_MTK_BIN;
    if (env)
        return env;
    const venv = new URL('../../../firmware/tools/mtkclient-venv/bin/mtk', import.meta.url).pathname;
    try {
        await access(venv, constants.X_OK);
        return venv;
    }
    catch {
        return findTool('mtk');
    }
}
export async function mtkAvailable() {
    const binary = await findMtk();
    if (!binary)
        return { ok: false, detail: 'mtkclient not found: set STUDIO_POCKET_MTK_BIN or create firmware/tools/mtkclient-venv (docs/development/flashing-macos.md)' };
    try {
        await access(binary, constants.X_OK);
    }
    catch {
        return { ok: false, detail: `mtkclient at ${binary} is not executable`, binary };
    }
    return { ok: true, detail: binary, binary };
}
/**
 * mtkclient's global options go BEFORE the `script` subcommand (its subparser takes none):
 * `--loader <daFile>` (the download agent by path; the bundles have no Loader/ folder) and
 * `--preloader <file>` (STUDIO_POCKET_PRELOADER_FILE). Mirrors `argv_for` in apps/desktop/src-tauri/src/mtkclient.rs.
 */
export function mtkArgv(planFile, platform = process.platform, files = {}) {
    return [
        ...(platform === 'win32' ? [] : ['--serialport', 'DETECT']),
        ...(files.daFile ? ['--loader', files.daFile] : []),
        ...(files.preloaderFile ? ['--preloader', files.preloaderFile] : []),
        'script', planFile,
    ];
}
/** How long a download may go without receiving a byte before it is abandoned. There is no overall cap. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
/**
 * GET `url` (redirects followed) streamed into `dest`, replacing it; a non-2xx answer, a body
 * shorter than its Content-Length or `idleMs` without a byte (the timer restarts on every chunk)
 * rejects and removes `dest`.
 */
export async function downloadFile(url, dest, onProgress, idleMs = DOWNLOAD_IDLE_TIMEOUT_MS) {
    if (!/^https?:\/\//.test(url))
        throw new Error(`only http and https urls are allowed: ${url}`);
    const controller = new AbortController();
    const { signal } = controller;
    let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), idleMs); };
    let out = null;
    try {
        arm();
        const response = await fetch(url, { redirect: 'follow', signal });
        if (!response.ok || !response.body)
            throw new Error(`HTTP ${response.status}`);
        const declared = Number(response.headers.get('content-length') ?? NaN);
        const total = Number.isFinite(declared) ? declared : 0;
        out = await open(dest, 'w');
        let bytes = 0;
        arm();
        for await (const chunk of response.body) {
            arm();
            await out.write(chunk);
            bytes += chunk.length;
            onProgress?.(bytes, total);
        }
        await out.close();
        out = null;
        if (total && bytes !== total)
            throw new Error(`download incomplete: ${bytes} of ${total} bytes`);
    }
    catch (error) {
        await out?.close().catch(() => undefined);
        await rm(dest, { force: true });
        if (signal.aborted)
            throw new Error(`no bytes for ${idleMs / 1000} s`);
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
/** STUDIO_POCKET_DA_FILE, STUDIO_POCKET_DA_FILE_UNCHECKED and STUDIO_POCKET_PRELOADER_FILE, read now. */
export function envOverrides(env = process.env) {
    const value = (name) => env[name]?.trim() || undefined;
    const daFile = value(DA_FILE_ENV);
    const preloaderFile = value(PRELOADER_FILE_ENV);
    return {
        ...(daFile ? { daFile: path.resolve(daFile) } : {}),
        ...(value(DA_FILE_UNCHECKED_ENV) === '1' ? { daFileUnchecked: true } : {}),
        ...(preloaderFile ? { preloaderFile: path.resolve(preloaderFile) } : {}),
    };
}
/**
 * Feeds `stream` to `sink` as it arrives and calls `emit` with each trimmed, non-empty line,
 * split on \n and \r so progress bars arrive promptly.
 */
function pumpLines(stream, sink, emit) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        sink(chunk);
        buf += chunk;
        let idx;
        while ((idx = buf.search(/[\r\n]/)) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line)
                emit(line);
        }
    });
    stream.on('end', () => { const line = buf.trim(); if (line)
        emit(line); });
}
/**
 * The capability probe: runs `binary` with no arguments and STUDIO_POCKET_PROBE=1 (cwd `cwd`, `env`
 * otherwise as the session's), and resolves true only when it exits 0 having printed exactly
 * IDENTITY_GATE_LINE. A patched mtkclient answers before parsing any argument or opening a port;
 * an unpatched one prints its usage and exits 2. Only lines starting `Studio Pocket - ` reach `onLog`,
 * so an old tool's usage text never reaches a parent-facing screen. A probe still running after
 * `timeoutMs` is killed and fails. Rejects when the tool cannot be started at all.
 */
export async function probeTool(binary, cwd, env, onLog, timeoutMs = PROBE_TIMEOUT_MS) {
    return (await runProbe(binary, cwd, env, onLog, timeoutMs)).passed;
}
/** Pocket Drop: retain startup failures for the app's error details. Never opens a player. */
export async function probeToolReport(binary, cwd, env, onLog, timeoutMs = PROBE_TIMEOUT_MS) {
    return runProbe(binary, cwd, env, onLog, timeoutMs);
}
/** `probeTool`, keeping everything the tool printed so a refused run's result can carry it. */
function runProbe(binary, cwd, env, onLog, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, [], { cwd, env: { ...env, STUDIO_POCKET_PROBE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let answered = false;
        let settled = false;
        const settle = (passed, code = null, signal = null, timedOut = false) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ passed, stdout, stderr, code, signal, timedOut });
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            // Do not wait for the pipes: a grandchild of the tool could hold them open.
            child.stdout?.destroy();
            child.stderr?.destroy();
            settle(false, null, 'SIGKILL', true);
        }, timeoutMs);
        const emit = (line) => {
            if (settled)
                return;
            const plain = stripAnsi(line).trim();
            if (!plain.startsWith('Studio Pocket - '))
                return;
            onLog(line);
            if (plain === IDENTITY_GATE_LINE)
                answered = true;
        };
        pumpLines(child.stdout, (c) => { stdout = (stdout + c).slice(-32 * 1024); }, emit);
        pumpLines(child.stderr, (c) => { stderr = (stderr + c).slice(-32 * 1024); }, emit);
        child.on('error', (error) => { if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
        } });
        child.on('close', (code, signal) => settle(answered && code === 0, code, signal));
    });
}
/**
 * Runs one mtkclient script plan with cwd = plan.dir, streaming lines split on \n and \r.
 * With `expectCid` the tool must first pass the capability probe (`probeTool`): one that fails it
 * is refused with -4 and UNCHECKED_TOOL_LINE before the plan file is even written. The session
 * then gets STUDIO_POCKET_EXPECT_CID so the patched tool checks the player itself (exit 102 another
 * player, 103 none printed), and the gate kills the session on a wrong or missing id or a
 * confirmation naming another player. As a second net, a tool that passed the probe but reaches
 * its first command without its own confirmation is killed with -4 and UNCHECKED_TOOL_STARTED_LINE.
 */
export async function runMtk(plan, onLog, options) {
    const binary = await findMtk();
    if (!binary)
        throw new ToolError('mtkclient not found (set STUDIO_POCKET_MTK_BIN)');
    await mkdir(plan.dir, { recursive: true });
    const expectCid = options?.expectCid;
    const env = { ...process.env };
    delete env.STUDIO_POCKET_PROBE;
    if (expectCid)
        env.STUDIO_POCKET_EXPECT_CID = expectCid;
    else
        delete env.STUDIO_POCKET_EXPECT_CID;
    if (expectCid) {
        let probe;
        try {
            probe = await runProbe(binary, plan.dir, env, onLog, PROBE_TIMEOUT_MS);
        }
        catch (error) {
            // Not startable at all: the same answer as the session gives below.
            const message = error.message;
            onLog(`error: ${message}`);
            return { code: -1, stdout: '', stderr: message };
        }
        if (!probe.passed) {
            onLog(UNCHECKED_TOOL_LINE);
            return { code: -4, probeRefused: true, stdout: probe.stdout, stderr: probe.stderr };
        }
    }
    const planFile = path.join(plan.dir, `${plan.id}.mtk`);
    await writeFile(planFile, plan.lines.join('\n') + '\n', 'utf8');
    return new Promise((resolve) => {
        const child = spawn(binary, mtkArgv(planFile, process.platform, plan), { cwd: plan.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const gate = expectCid ? identityGate(expectCid) : null;
        /** The id the session printed, for the wrong-player line when the tool refused by exit code. */
        let connected = null;
        let killed = null;
        const wrongPlayer = (shown) => `wrong player: expected …${cidTail(expectCid.toLowerCase())}, connected …${shown ? cidTail(shown) : 'unknown'}`;
        const emit = (line) => {
            if (killed)
                return;
            onLog(line);
            if (!gate)
                return;
            const plain = stripAnsi(line);
            connected ??= parseEmmcCid(plain);
            const verdict = gate(line);
            if (verdict === 'wrong') {
                // A confirmation naming another player: show the tail it carries.
                killed = { code: -2, message: wrongPlayer(plain.includes(IDENTITY_CONFIRMED) ? confirmedTail(plain) : parseEmmcCid(plain)) };
            }
            else if (verdict === 'unconfirmed') {
                killed = { code: -3, message: 'could not confirm which player is connected' };
            }
            else if (verdict === 'unchecked') {
                killed = { code: -4, message: UNCHECKED_TOOL_STARTED_LINE };
            }
            if (killed)
                child.kill('SIGKILL');
        };
        pumpLines(child.stdout, (s) => { stdout += s; }, emit);
        pumpLines(child.stderr, (s) => { stderr += s; }, emit);
        child.on('error', (error) => { onLog(`error: ${error.message}`); resolve({ code: -1, stdout, stderr: stderr + error.message }); });
        child.on('close', (code) => {
            if (!killed && gate && code === MTK_EXIT_WRONG_PLAYER)
                killed = { code: -2, message: wrongPlayer(connected) };
            else if (!killed && gate && code === MTK_EXIT_UNCONFIRMED)
                killed = { code: -3, message: 'could not confirm which player is connected' };
            if (killed) {
                onLog(killed.message);
                resolve({ code: killed.code, stdout, stderr });
            }
            else {
                resolve({ code: code ?? -1, stdout, stderr });
            }
        });
    });
}
let counter = 0;
const inflateRawAsync = promisify(inflateRaw);
export const nodePlatform = {
    join: (...parts) => path.join(...parts),
    dirname: (p) => path.dirname(p),
    basename: (p) => path.basename(p),
    readText: (file) => readFile(file, 'utf8'),
    writeText: (file, text) => writeFile(file, text, 'utf8'),
    readdir: async (dir) => (await readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() })),
    stat: async (file) => {
        const info = await stat(file).catch(() => null);
        return info ? { exists: true, size: info.size, isDir: info.isDirectory() } : { exists: false, size: 0, isDir: false };
    },
    readBytes: async (file, offset, len) => {
        const handle = await open(file, 'r');
        try {
            const buffer = new Uint8Array(len);
            const { bytesRead } = await handle.read(buffer, 0, len, offset);
            return buffer.subarray(0, bytesRead);
        }
        finally {
            await handle.close();
        }
    },
    copyFile: async (from, to, onProgress) => {
        await copyFile(from, to);
        if (onProgress) {
            const s = (await stat(to)).size;
            onProgress(s, s);
        }
    },
    copyRange: async (from, offset, len, to, onProgress) => {
        const src = await open(from, 'r');
        try {
            const dst = await open(to, 'w');
            try {
                const chunk = new Uint8Array(8 * 1024 * 1024);
                let done = 0;
                while (done < len) {
                    const want = Math.min(chunk.length, len - done);
                    const { bytesRead } = await src.read(chunk, 0, want, offset + done);
                    if (bytesRead === 0)
                        break;
                    await dst.write(chunk, 0, bytesRead);
                    done += bytesRead;
                    onProgress?.(done, len);
                }
            }
            finally {
                await dst.close();
            }
        }
        finally {
            await src.close();
        }
    },
    truncate: (file, size) => truncate(file, size),
    // Like the desktop bridge: a file, or an empty directory (never a tree).
    remove: async (file) => {
        if ((await stat(file).catch(() => null))?.isDirectory())
            await rmdir(file);
        else
            await rm(file, { force: true });
    },
    rename: (from, to) => rename(from, to),
    mkdirp: async (dir) => { await mkdir(dir, { recursive: true }); },
    sha256File,
    sha256Bytes: async (data) => createHash('sha256').update(data).digest('hex'),
    digestBytes: async (algorithm, data) => new Uint8Array(createHash(algorithm).update(data).digest()),
    // RSASSA-PKCS1-v1_5 only, like WebCrypto on the desktop: `verify` would otherwise pick ECDSA
    // or PSS from an EC or RSA-PSS key and accept what Android 4.4 refuses.
    verifyRsaPkcs1: async (spkiDer, hash, data, signature) => {
        try {
            const key = createPublicKey({ key: Buffer.from(spkiDer), format: 'der', type: 'spki' });
            if (key.asymmetricKeyType !== 'rsa')
                return false;
            return verify(hash, data, { key, padding: cryptoConstants.RSA_PKCS1_PADDING }, signature);
        }
        catch {
            return false;
        }
    },
    inflateRaw: async (data) => new Uint8Array(await inflateRawAsync(data)),
    zipExtract: async (zip, names, destDir) => {
        const unzip = await findTool('unzip', ['/usr/bin']);
        if (!unzip)
            throw new ToolError('unzip is required to open the firmware zip');
        await mkdir(destDir, { recursive: true });
        const result = await run(unzip, ['-o', '-j', '-q', zip, ...names, '-d', destDir]);
        if (result.code !== 0)
            throw new ToolError(`unzip failed (${result.code}): ${result.stderr || result.stdout}`);
    },
    locateE2fsTools,
    runE2fs: async (tool, args, script) => {
        const tools = await locateE2fsTools();
        let scriptFile = null;
        let argv = args;
        if (script) {
            scriptFile = path.join(os.tmpdir(), `myo-debugfs-${process.pid}-${Date.now()}-${counter++}.txt`);
            await writeFile(scriptFile, script.join('\n') + '\n', 'utf8');
            argv = args.map((a) => (a === '<script>' ? scriptFile : a));
        }
        try {
            return await run(tools[tool], argv);
        }
        finally {
            if (scriptFile)
                await unlink(scriptFile).catch(() => undefined);
        }
    },
    downloadFile: (url, dest, onProgress) => downloadFile(url, dest, onProgress),
    overrides: async () => envOverrides(),
    mtkAvailable,
    runMtk,
    tmpDir: () => os.tmpdir(),
    uniqueId: () => `${process.pid}-${Date.now()}-${counter++}`,
};
/** Node conveniences: the functions above bound to the Node file system, with plain paths. */
export const loadManifest = async (file) => parseManifest(await readFile(file, 'utf8'));
export const identifyImage = (file) => identifyImageWith(nodePlatform, file);
export const prepareStock = (source, manifest, workDir, log) => prepareStockWith(nodePlatform, path.resolve(source), manifest, path.resolve(workDir), log);
export const patchSystemImage = (options) => patchSystemImageWith(nodePlatform, { ...options, stockImage: path.resolve(options.stockImage), apk: path.resolve(options.apk), out: path.resolve(options.out), workDir: path.resolve(options.workDir) });
export const verifyPatchedImage = (options) => verifyPatchedImageWith(nodePlatform, { ...options, image: path.resolve(options.image) });
export const debugfsScript = (_tools, image, commands, write) => debugfsScriptWith(nodePlatform, image, commands, write);
//# sourceMappingURL=node.js.map