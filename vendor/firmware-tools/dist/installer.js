// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import { acceptApk, inspectApkFile } from './apk.js';
import { ALREADY_RUNS_STUDIO_POCKET, identifyDeviceImage } from './device.js';
import { DRAM_CONFIG_LINE, ensureDownloadAgent, PRELOADER_DETECTED_LINE, PreloaderNeededError, preloaderOverride } from './da.js';
import { debugfsQuery, e2fsck } from './e2fs.js';
import { InstallerError } from './errors.js';
import { buildFlashPlan, checkCompatibility } from './flashplan.js';
import { measureLayout, windowForManifest, writeLayout } from './layout.js';
import { targetPartition } from './manifest.js';
import { cidTail, HEAD_TAIL_BYTES, parseEmmcCid, parseMtkLine, readWindowPlan, UNCHECKED_TOOL_LINE, writePlan } from './mtk.js';
import { patchSystemImage, quoteHostPath, TARGET_APK } from './patch.js';
import { parseScatter } from './scatter.js';
import { prepareStock, StockError } from './stock.js';
import { adoptLegacyUnit, currentUnit, isCid, LEGACY_UNIT, migrateFlatLayout, packageDir, readUnit, removeTree, resolveUnit, setCurrentUnit, TMP_DIR, unitDir, writeUnit } from './units.js';
import { verifyPatchedImage } from './verify.js';
/**
 * The guided installer's engine. Pure orchestration over FirmwarePlatform.
 *
 * Device-sourced flow (the product path since 2026-10-19; no ROM download), one folder per
 * player under units/<eMMC CID>/ (see ./units.ts); every function takes an optional unitId and
 * otherwise works on the player read last:
 *   readDeviceSystem          read a window of the player's eMMC over mtkclient → measure where
 *                             the system partition is (two markers) → keep it as this unit's
 *                             restore image → identify the build and the stock launcher → fsck
 *   prepareInstallFromDevice  patch that copy with the player APK → independently verify
 *   planWrite / executeWrite  one mtkclient session: a probe read that names the player (a
 *                             different one aborts it), write the image, read head and tail
 *                             (and optionally the whole image) back
 *   verifyWrite               compare the read-backs with the image
 *
 * Package flow (prepareInstall / planFlash) is kept for the manual Windows kit built from the
 * archive zip; it lives in <firmware>/package/, apart from every player. Nothing here writes to a device except executeWrite, which only ever runs a
 * plan produced by planWrite after the caller has obtained the user's explicit approval.
 */
export const OUT_DIR = 'out';
export const STOCK_DIR = 'stock';
export const DEVICE_DIR = 'device';
export const PATCHED_IMAGE = 'system.studiopocket.img';
export const STOCK_IMAGE = 'system.img';
export const WINDOW_IMAGE = 'window.img';
export const IDENTITY_FILE = 'device-identity.json';
/** Scratch name for the system partition cut out of a read, before it is identified and routed. */
export const READ_IMAGE = 'read.img';
/** Where a read of a player that already runs Studio Pocket goes; never mixed with stock/ or the device reports. */
export const UPGRADE_DIR = 'upgrade';
export const UPGRADE_REPORT_FILE = 'read-report.json';
export const UPGRADE_IMAGE = 'system.img';
export const PROBE_FILE = 'identity-probe.bin';
export const HEAD_FILE = 'verify-head.bin';
export const TAIL_FILE = 'verify-tail.bin';
export const FULL_FILE = 'verify-full.img';
export const SCATTER_FILE = 'MT6582_Android_scatter.txt';
export const REPORT_FILE = 'build-report.json';
export const RECORD_FILE = 'install-record.json';
export const DOWNLOAD_AGENT = 'MTK_AllInOne_DA.bin';
export const FLASH_TOOL_EXE = 'flash_tool.exe';
/** How many mtkclient log lines a report keeps. */
export const MTK_LOG_KEEP = 200;
export { InstallerError };
/** The player already runs exactly the APK being installed; nothing was prepared. */
export class UpToDateError extends InstallerError {
}
/** A write session was killed during its probe read: a different player answered. Nothing was written. */
export class WrongPlayerError extends InstallerError {
    expected;
    connected;
    outcome = 'refused: wrong player';
    constructor(message, expected, connected) {
        super(message);
        this.expected = expected;
        this.connected = connected;
    }
}
/** A write session was killed because the player never said which it was before a command ran. Nothing was written. */
export class UnconfirmedPlayerError extends InstallerError {
    outcome = 'refused: unconfirmed player';
}
/** The mtkclient in use has no working player identity check (runner code -4). */
export class UncheckedToolError extends InstallerError {
    sessionStarted;
    outcome = 'refused: unchecked tool';
    /**
     * False when the runner flags the -4 as probe-refused (RunResult.probeRefused): the tool failed the
     * capability probe and was never handed the plan, so nothing was written. Without the flag, the line rule
     * is the fallback: false only when the run's last line is the probe-path line (UNCHECKED_TOOL_LINE). Any
     * other last line, including none at all, counts as started (the session ran and was stopped at its first
     * command) and gets the cautious message. This fails safe: on the desktop the last line arrives as a
     * job-log event and the result on another channel, with no ordering guarantee, and a lost line must never
     * tell a parent "nothing was written" after a session that started.
     */
    constructor(message, sessionStarted) {
        super(message);
        this.sessionStarted = sessionStarted;
    }
}
export async function prepareInstall(p, inputs, cb) {
    const { manifest, firmwareDir } = inputs;
    await migrateFlatLayout(p, firmwareDir);
    const base = packageDir(p, firmwareDir);
    const stockDir = p.join(base, STOCK_DIR);
    const outDir = p.join(base, OUT_DIR);
    await p.mkdirp(stockDir);
    await p.mkdirp(outDir);
    cb.stage('verify-stock');
    const stock = await prepareStock(p, inputs.source, manifest, base, cb.log, (e) => cb.progress({ 'hash-zip': 'Checking the firmware package', extract: 'Unpacking system.img', 'hash-system': 'Checking system.img' }[e.stage], e.bytes, e.total));
    const compatibility = checkCompatibility(manifest, stock.scatter);
    if (compatibility.length)
        throw new InstallerError(`stock package incompatible: ${compatibility.join('; ')}`);
    // Keep an untouched stock copy inside the firmware dir so Restore never depends on the
    // user still having the zip. When the source was the zip this is already where it was extracted.
    cb.stage('copy-stock');
    const stockImage = p.join(stockDir, STOCK_IMAGE);
    const scatterPath = p.join(stockDir, SCATTER_FILE);
    if (stock.systemImage !== stockImage) {
        cb.log(`keeping a copy of stock system.img in ${stockDir}`);
        const size = (await p.stat(stock.systemImage)).size;
        await p.copyFile(stock.systemImage, stockImage, (bytes, total) => cb.progress('Copying stock system.img for restore', bytes, total || size));
        await p.writeText(scatterPath, await p.readText(stock.scatterPath));
    }
    cb.stage('patch');
    const out = p.join(outDir, PATCHED_IMAGE);
    const patched = await patchSystemImage(p, {
        stockImage, apk: inputs.apk, out, workDir: p.join(firmwareDir, 'work'), log: cb.log,
        onProgress: (e) => cb.progress(e.stage === 'copy' ? 'Copying system.img' : 'Hashing the prepared image', e.bytes, e.total),
    });
    cb.stage('verify');
    const verification = await verifyPatchedImage(p, { image: out, expectedApkSha256: patched.apkSha256, partitionSizeBytes: Number.parseInt(targetPartition(manifest).size, 16), log: cb.log });
    const apkInfo = await p.stat(inputs.apk);
    const report = {
        firmwareVersion: manifest.firmwareVersion,
        builtAt: new Date().toISOString(),
        generator: 'studio-pocket firmware-tools/0.2.0',
        stock: { origin: 'package', ...(stock.zipSha256 ? { zipSha256: stock.zipSha256 } : {}), systemSha256: stock.systemSha256, scatterSha256: stock.scatterSha256, systemImage: stockImage, scatterPath },
        apk: { path: inputs.apk, sha256: patched.apkSha256, sizeBytes: apkInfo.size, ...(inputs.apkVersion ? { version: inputs.apkVersion } : {}), packageName: patched.apkPackageName, signerSha256: patched.apkSignerSha256 },
        output: { path: out, sha256: patched.outSha256, sizeBytes: patched.outBytes, fsckFixExit: patched.fsckCode },
        compatibility,
        verification,
        debugfsScript: patched.script,
    };
    await p.writeText(p.join(outDir, REPORT_FILE), JSON.stringify(report, null, 2) + '\n');
    cb.stage('done');
    if (!verification.ok)
        throw new InstallerError(`the prepared image failed verification: ${verification.problems.join('; ')}`);
    return report;
}
/**
 * The unit a loader reads: the given one, else the current one; null when no player has been
 * read yet. Reports name absolute paths, but a unit's files are always where its folder says
 * (a report migrated from the flat layout still names the old place), so the loaders below
 * re-anchor every path to the folder the report was found in.
 */
async function loaderUnit(p, firmwareDir, unitId) {
    if (unitId !== undefined)
        return resolveUnit(p, firmwareDir, unitId);
    // An unreadable current-unit counts as "no player read yet" rather than an error.
    const current = await currentUnit(p, firmwareDir);
    return current && (isCid(current) || current === LEGACY_UNIT) ? current : null;
}
async function loadPrepareReportFile(p, file, stockImage) {
    if (!(await p.stat(file)).exists)
        return null;
    try {
        const report = JSON.parse(await p.readText(file));
        report.output.path = p.join(p.dirname(file), PATCHED_IMAGE);
        report.stock.systemImage = stockImage;
        if (report.stock.scatterPath)
            report.stock.scatterPath = p.join(p.dirname(stockImage), SCATTER_FILE);
        const out = await p.stat(report.output.path);
        const stock = await p.stat(report.stock.systemImage);
        if (!out.exists || out.size !== report.output.sizeBytes || !stock.exists)
            return null;
        if (!report.stock.origin)
            report.stock.origin = 'package';
        return report;
    }
    catch {
        return null;
    }
}
/** The unit's last install build report, if the images it names still exist with the recorded sizes. */
export async function loadPrepareReport(p, firmwareDir, unitId) {
    const id = await loaderUnit(p, firmwareDir, unitId);
    if (!id)
        return null;
    const dir = unitDir(p, firmwareDir, id);
    return loadPrepareReportFile(p, p.join(dir, OUT_DIR, REPORT_FILE), p.join(dir, STOCK_DIR, STOCK_IMAGE));
}
/** The unit's last upgrade build report (upgrade/out/), if its images still exist. */
export async function loadUpgradePrepareReport(p, firmwareDir, unitId) {
    const id = await loaderUnit(p, firmwareDir, unitId);
    if (!id)
        return null;
    const dir = p.join(unitDir(p, firmwareDir, id), UPGRADE_DIR);
    return loadPrepareReportFile(p, p.join(dir, OUT_DIR, REPORT_FILE), p.join(dir, UPGRADE_IMAGE));
}
/** The package flow's build report (package/out/), if its images still exist. */
export async function loadPackagePrepareReport(p, firmwareDir) {
    const base = packageDir(p, firmwareDir);
    return loadPrepareReportFile(p, p.join(base, OUT_DIR, REPORT_FILE), p.join(base, STOCK_DIR, STOCK_IMAGE));
}
function lastErrorLine(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const parsed = parseMtkLine(lines[i]);
        if (parsed?.phase === 'error')
            return parsed.detail ?? lines[i];
    }
    return lines.slice(-3).join(' | ') || 'no output';
}
function keepTail(lines) {
    return lines.length > MTK_LOG_KEEP ? lines.slice(-MTK_LOG_KEEP) : lines;
}
/**
 * mtkclient's script mode splits each line on spaces with no quoting, and the app data
 * directory on macOS has a space in its path. So plans never carry absolute paths: every
 * file is named relative to plan.dir (mtkclient runs with that cwd), and the names below are
 * all space-free by construction.
 */
function relativeToDeviceDir(file) {
    if (/\s/.test(file))
        throw new InstallerError(`plan paths must not contain whitespace: ${file}`);
    return file;
}
/** Forgets a unit's upgrade read and prepared upgrade (the player no longer runs that image). */
async function dropUpgradeReports(p, unitFolder) {
    await p.remove(p.join(unitFolder, UPGRADE_DIR, UPGRADE_REPORT_FILE)).catch(() => undefined);
    await p.remove(p.join(unitFolder, UPGRADE_DIR, OUT_DIR, REPORT_FILE)).catch(() => undefined);
}
async function runPlan(p, plan, onLine, options) {
    for (const line of plan.lines) {
        if (line.split(' ').length !== 4)
            throw new InstallerError(`malformed plan line: ${line}`);
    }
    const lines = [];
    let emmcCid = null;
    let dramConfigNeeded = false;
    let preloaderFound = false;
    let commandStarted = false;
    const result = await p.runMtk(plan, (line) => {
        lines.push(line);
        emmcCid ??= parseEmmcCid(line);
        if (line.includes(DRAM_CONFIG_LINE))
            dramConfigNeeded = true;
        if (line.includes(PRELOADER_DETECTED_LINE))
            preloaderFound = true;
        const progress = parseMtkLine(line);
        if (progress?.phase === 'read' || progress?.phase === 'write')
            commandStarted = true;
        onLine?.(progress, line);
    }, options);
    // The bundles carry no preloader images, so mtkclient cannot answer the agent's DRAM request
    // itself and stops during the agent's upload, before its first command; say why rather than pass
    // on its error line. Not when a preloader was given or mtkclient found one in its own folder
    // (a venv), and never once a command ran: then "nothing was written" might not be true.
    if (dramConfigNeeded && !plan.preloaderFile && !preloaderFound && !commandStarted && result.code !== 0)
        throw new PreloaderNeededError();
    return { result, lines, emmcCid };
}
/**
 * The read (read-only): reads the window into tmp/read-<id>/ (the player's eMMC id is not known
 * until the session prints it; read folders a killed read left behind are removed first),
 * measures the layout and cuts the system partition out there. Only after identifying it,
 * checking it and hashing it is the player's units/<cid>/ written (unit.json, current-unit) and
 * the image routed: a stock unit's goes to stock/ as its restore copy, exactly as read (with
 * device-identity.json and device-layout.json); a unit that already runs Studio Pocket goes to
 * upgrade/ with its own report and nothing else is touched. A refused read leaves no unit and
 * never leaves a half-replaced restore copy.
 * Throws InstallerError (with the last mtkclient error line) when the device could not be
 * read, when the session printed no eMMC id, when the end marker is missing, or when the
 * content is not a firmware this tool knows.
 */
export async function readDeviceSystem(p, inputs, cb) {
    const { firmwareDir, manifests } = inputs;
    if (!manifests.length)
        throw new InstallerError('no firmware manifests to identify the player against');
    const windows = manifests.map(windowForManifest);
    const window = windows[0];
    if (windows.some((w) => w.start !== window.start || w.length !== window.length)) {
        throw new InstallerError('the firmware manifests disagree about the read window');
    }
    await migrateFlatLayout(p, firmwareDir);
    await removeStaleReads(p, firmwareDir);
    const mtkFiles = await sessionFiles(p, firmwareDir, cb.log, inputs.daPin);
    const tmp = p.join(firmwareDir, TMP_DIR, `read-${p.uniqueId()}`);
    await p.mkdirp(tmp);
    try {
        return await readIntoUnit(p, firmwareDir, manifests, window, tmp, mtkFiles, cb);
    }
    finally {
        await removeTree(p, tmp).catch(() => undefined);
    }
}
/** Read folders left by a read that never finished (the app quit mid-read); other tmp/ files are not ours. */
async function removeStaleReads(p, firmwareDir) {
    const tmpRoot = p.join(firmwareDir, TMP_DIR);
    if (!(await p.stat(tmpRoot)).exists)
        return;
    for (const entry of await p.readdir(tmpRoot)) {
        if (entry.isDir && entry.name.startsWith('read-'))
            await removeTree(p, p.join(tmpRoot, entry.name)).catch(() => undefined);
    }
}
/** The files every mtkclient session is given by path: the download agent (fetched on first use) and the preloader override. */
async function sessionFiles(p, firmwareDir, log, pin) {
    const daFile = await ensureDownloadAgent(p, firmwareDir, log, pin ? { pin } : {});
    const preloaderFile = await preloaderOverride(p);
    return { daFile, ...(preloaderFile ? { preloaderFile } : {}) };
}
async function readIntoUnit(p, firmwareDir, manifests, window, tmp, mtkFiles, cb) {
    const tmpWindow = p.join(tmp, WINDOW_IMAGE);
    cb.stage('read');
    cb.log(`reading 0x${window.length.toString(16)} bytes from 0x${window.start.toString(16)} (the scatter's ANDROID address minus the boot-region offset, up to its CACHE address)`);
    const { result, lines, emmcCid } = await runPlan(p, { id: 'read-window', dir: tmp, lines: readWindowPlan(window.start, window.length, relativeToDeviceDir(WINDOW_IMAGE)), ...mtkFiles }, (progress, line) => {
        if (progress?.phase === 'read' && progress.percent !== null)
            cb.progress('Reading the player', progress.percent, 100);
        cb.mtk?.(progress, line);
    });
    const windowStat = await p.stat(tmpWindow);
    if (result.code !== 0 || !windowStat.exists || windowStat.size < window.length) {
        throw new InstallerError(`could not read the player (mtkclient exit ${result.code}): ${lastErrorLine(lines)}`);
    }
    if (!emmcCid)
        throw new InstallerError('could not identify the player (no eMMC id in the session); try again');
    cb.stage('measure');
    const layout = await measureLayout(p, tmpWindow, window.start);
    cb.log(`system partition at ${layout.hex.androidStart} + ${layout.hex.androidSize} (ends ${layout.hex.androidEnd}); end marker ${layout.endMarker ? `present (${layout.endMarker.size} B partition follows)` : 'MISSING'}`);
    if (!layout.trustedForWrite) {
        throw new InstallerError(`the partition after the system filesystem does not start where it should (${layout.hex.androidEnd}); this layout cannot be written safely`);
    }
    const readImage = p.join(tmp, READ_IMAGE);
    cb.stage('extract');
    await p.copyRange(tmpWindow, layout.android.start - window.start, layout.android.size, readImage, (bytes, total) => cb.progress('Copying the player’s system image out of the read', bytes, total));
    await p.remove(tmpWindow).catch(() => undefined);
    cb.stage('identify');
    const identity = await identifyDeviceImage(p, readImage, manifests);
    cb.log(`build ${identity.build || '?'} (${identity.displayId || '?'}${identity.fmRadio ? ', FM radio' : ''}), filesystem ${identity.fsUuid}`);
    const installed = identity.installedStudioPocket;
    // Only a confirmed installed APK (dumped and hashed) makes the "already runs" problem non-blocking;
    // if the dump failed, the image is neither stock nor a usable upgrade source.
    const blocking = identity.problems.filter((problem) => !(installed && problem.startsWith(ALREADY_RUNS_STUDIO_POCKET)));
    if (!identity.manifest || blocking.length) {
        await p.remove(readImage).catch(() => undefined);
        throw new InstallerError(`the player’s software is not one this tool can modify: ${blocking.join('; ') || 'unknown build'}`);
    }
    if (installed)
        cb.log(`Studio Pocket is installed (${installed.sha256.slice(0, 16)}…): this read is the source of an upgrade; the kept original is not touched`);
    // Check only: the kept copy stays exactly what was read. The prepared copy is repaired (patch.ts).
    cb.stage('fsck');
    const fsck = await e2fsck(p, readImage, 'check');
    cb.log(`e2fsck -fn on the read image: exit ${fsck.code}`);
    if (fsck.code >= 4)
        cb.log('the player’s system had filesystem errors; the copy kept is exact, the installed image will be repaired');
    const sizeBytes = (await p.stat(readImage)).size;
    const sha256 = await p.sha256File(readImage, (bytes) => cb.progress('Fingerprinting the read image', bytes, sizeBytes));
    const readAt = new Date().toISOString();
    // Only a read that is about to be kept files a unit: a refused read leaves none behind.
    // A read never adopts the legacy unit: the shared ext4 UUID is not evidence of the player.
    const unitId = emmcCid;
    const dir = unitDir(p, firmwareDir, unitId);
    const deviceDir = p.join(dir, DEVICE_DIR);
    await p.mkdirp(deviceDir);
    // Scratch files an interrupted read of an earlier version may have left in the unit.
    await p.remove(p.join(deviceDir, WINDOW_IMAGE)).catch(() => undefined);
    await p.remove(p.join(deviceDir, READ_IMAGE)).catch(() => undefined);
    const known = await readUnit(p, firmwareDir, unitId);
    cb.log(`player …${cidTail(emmcCid)}: ${known ? 'read before on this computer' : 'first read on this computer'}`);
    await writeUnit(p, firmwareDir, { unitId, emmcCid, fsUuid: layout.android.uuid, firmwareVersion: identity.manifest.firmwareVersion, firstSeen: known?.firstSeen ?? readAt, lastSeen: readAt, installed: Boolean(installed) });
    await setCurrentUnit(p, firmwareDir, unitId);
    if (installed) {
        const upgradeDir = p.join(dir, UPGRADE_DIR);
        await p.mkdirp(upgradeDir);
        const image = p.join(upgradeDir, UPGRADE_IMAGE);
        await p.rename(readImage, image);
        const report = { readAt, state: 'studiopocket', unitId, emmcCid, layout, identity, image, imageSha256: sha256, imageSizeBytes: sizeBytes, installedApkSha256: installed.sha256, fsckExit: fsck.code, mtkLog: keepTail(lines) };
        await p.writeText(p.join(upgradeDir, UPGRADE_REPORT_FILE), JSON.stringify(report, null, 2) + '\n');
        cb.stage('done');
        return report;
    }
    // A stock read supersedes any earlier upgrade read of this unit: its prepared image must
    // never be written over the original that is on the player now.
    await dropUpgradeReports(p, dir);
    const stockDir = p.join(dir, STOCK_DIR);
    await p.mkdirp(stockDir);
    const stockImage = p.join(stockDir, STOCK_IMAGE);
    await p.rename(readImage, stockImage);
    const report = { readAt, state: 'stock', unitId, emmcCid, layout, identity, stockImage, stockSha256: sha256, stockSizeBytes: sizeBytes, fsckExit: fsck.code, mtkLog: keepTail(lines) };
    await writeLayout(p, deviceDir, layout);
    await p.writeText(p.join(deviceDir, IDENTITY_FILE), JSON.stringify(report, null, 2) + '\n');
    cb.stage('done');
    return report;
}
/** The unit's last stock read, if its kept copy still exists at the recorded size. */
export async function loadDeviceReadReport(p, firmwareDir, unitId) {
    const id = await loaderUnit(p, firmwareDir, unitId);
    if (!id)
        return null;
    const dir = unitDir(p, firmwareDir, id);
    const file = p.join(dir, DEVICE_DIR, IDENTITY_FILE);
    if (!(await p.stat(file)).exists)
        return null;
    try {
        const report = JSON.parse(await p.readText(file));
        // Reports written before 2026-10-20 have no state; they were all stock reads.
        if (report.state !== undefined && report.state !== 'stock')
            return null;
        report.state = 'stock';
        report.unitId = id;
        report.emmcCid ??= null;
        report.stockImage = p.join(dir, STOCK_DIR, STOCK_IMAGE);
        const stock = await p.stat(report.stockImage);
        if (!stock.exists || stock.size !== report.stockSizeBytes || !report.layout?.trustedForWrite)
            return null;
        return report;
    }
    catch {
        return null;
    }
}
/** The unit's last read while it ran Studio Pocket, if its image still exists at the recorded size. */
export async function loadUpgradeReadReport(p, firmwareDir, unitId) {
    const id = await loaderUnit(p, firmwareDir, unitId);
    if (!id)
        return null;
    const dir = p.join(unitDir(p, firmwareDir, id), UPGRADE_DIR);
    const file = p.join(dir, UPGRADE_REPORT_FILE);
    if (!(await p.stat(file)).exists)
        return null;
    try {
        const report = JSON.parse(await p.readText(file));
        if (report.state !== 'studiopocket')
            return null;
        report.unitId = id;
        report.emmcCid ??= null;
        report.image = p.join(dir, UPGRADE_IMAGE);
        const image = await p.stat(report.image);
        if (!image.exists || image.size !== report.imageSizeBytes || !report.layout?.trustedForWrite)
            return null;
        return report;
    }
    catch {
        return null;
    }
}
/**
 * Whether the stock copy kept on this computer belongs to the player that was read for an
 * upgrade. The debugfs patch keeps the ext4 UUID, so an installed unit carries the UUID of
 * its own stock filesystem; start and size must match too.
 */
export function restoreAvailableFor(stock, upgrade) {
    if (!stock)
        return false;
    const a = stock.layout.android;
    const b = upgrade.layout.android;
    return a.uuid === b.uuid && a.start === b.start && a.size === b.size;
}
/** Why an upgrade signed with another key is refused: Android would not install it over the old one's data. */
export const NEW_SIGNER_REFUSAL = 'The new Studio Pocket is signed with a different key than the one on the player. Restore the player to its original software first, then set it up again.';
/** Why an upgrade is refused when the installed APK's signer cannot be read: the key check cannot be made. */
export const UNREADABLE_SIGNER_REFUSAL = 'The signing key of the Studio Pocket already on the player could not be read, so the upgrade cannot be checked. Restore the player to its original software first, then set it up again, or run with --allow-new-signer from the command line.';
/** Inspects the replacement APK (./apk.ts) and refuses it before anything is copied or patched. */
async function checkReplacementApk(p, apk) {
    if (!(await p.stat(apk)).exists)
        throw new InstallerError(`the APK is missing: ${apk}`);
    const verdict = acceptApk(await inspectApkFile(p, apk));
    if (!verdict.ok)
        throw new InstallerError(verdict.refusal);
    return verdict;
}
/** The signer of the StudioPocket.apk inside a read image, dumped into `workDir` and removed again. */
async function installedApkSigner(p, image, workDir) {
    await p.mkdirp(workDir);
    const dumped = p.join(workDir, `installed-${p.uniqueId()}.apk`);
    try {
        await debugfsQuery(p, image, `dump ${TARGET_APK} ${quoteHostPath(dumped)}`);
        if (!(await p.stat(dumped)).exists)
            throw new InstallerError(`could not read ${TARGET_APK} back from the read image; read the player again`);
        return (await inspectApkFile(p, dumped)).signerSha256;
    }
    finally {
        await p.remove(dumped).catch(() => undefined);
    }
}
/** Patches the unit's own system image (from readDeviceSystem) and verifies the result. */
export async function prepareInstallFromDevice(p, inputs, cb) {
    const { firmwareDir } = inputs;
    await migrateFlatLayout(p, firmwareDir);
    const unitId = await resolveUnit(p, firmwareDir, inputs.unitId);
    const read = await loadDeviceReadReport(p, firmwareDir, unitId);
    if (!read)
        throw new InstallerError('the player has not been read on this computer yet; read it first');
    const manifest = read.identity.manifest;
    if (!manifest)
        throw new InstallerError('the kept image was not identified as a known firmware');
    const apk = await checkReplacementApk(p, inputs.apk);
    cb.log(`APK ${apk.packageName}, signer ${apk.signerSha256.slice(0, 16)}…`);
    const outDir = p.join(unitDir(p, firmwareDir, unitId), OUT_DIR);
    await p.mkdirp(outDir);
    cb.stage('verify-stock');
    cb.log(`checking the kept copy of the player’s system image (${read.stockSha256.slice(0, 16)}…)`);
    const stockSha256 = await p.sha256File(read.stockImage, (bytes) => cb.progress('Checking the kept copy', bytes, read.stockSizeBytes));
    if (stockSha256 !== read.stockSha256)
        throw new InstallerError('the kept copy of the player’s system image has changed since it was read; read the player again');
    cb.stage('patch');
    const out = p.join(outDir, PATCHED_IMAGE);
    const patched = await patchSystemImage(p, {
        stockImage: read.stockImage, apk: inputs.apk, out, workDir: p.join(firmwareDir, 'work'), log: cb.log,
        onProgress: (e) => cb.progress(e.stage === 'copy' ? 'Copying the system image' : 'Hashing the prepared image', e.bytes, e.total),
    });
    cb.stage('verify');
    const verification = await verifyPatchedImage(p, { image: out, expectedApkSha256: patched.apkSha256, partitionSizeBytes: read.layout.android.size, log: cb.log });
    const apkInfo = await p.stat(inputs.apk);
    const report = {
        firmwareVersion: manifest.firmwareVersion,
        builtAt: new Date().toISOString(),
        generator: 'studio-pocket firmware-tools/0.2.0',
        stock: { origin: 'device', systemSha256: stockSha256, systemImage: read.stockImage, unitUuid: read.layout.android.uuid },
        apk: { path: inputs.apk, sha256: patched.apkSha256, sizeBytes: apkInfo.size, ...(inputs.apkVersion ? { version: inputs.apkVersion } : {}), packageName: patched.apkPackageName, signerSha256: patched.apkSignerSha256 },
        output: { path: out, sha256: patched.outSha256, sizeBytes: patched.outBytes, fsckFixExit: patched.fsckCode },
        compatibility: [],
        verification,
        debugfsScript: patched.script,
    };
    await p.writeText(p.join(outDir, REPORT_FILE), JSON.stringify(report, null, 2) + '\n');
    cb.stage('done');
    if (!verification.ok)
        throw new InstallerError(`the prepared image failed verification: ${verification.problems.join('; ')}`);
    return report;
}
/**
 * Replaces the installed StudioPocket.apk in the image read from the player (readDeviceSystem with
 * state 'studiopocket') and verifies the result. Throws UpToDateError before touching anything when
 * the player already runs this APK.
 */
export async function prepareUpgradeFromDevice(p, inputs, cb) {
    const { firmwareDir } = inputs;
    await migrateFlatLayout(p, firmwareDir);
    const unitId = await resolveUnit(p, firmwareDir, inputs.unitId);
    const read = await loadUpgradeReadReport(p, firmwareDir, unitId);
    if (!read)
        throw new InstallerError('the player has not been read on this computer yet; read it first');
    const manifest = read.identity.manifest;
    if (!manifest)
        throw new InstallerError('the read image was not identified as a known firmware');
    const apk = await checkReplacementApk(p, inputs.apk);
    cb.log(`APK ${apk.packageName}, signer ${apk.signerSha256.slice(0, 16)}…`);
    cb.stage('verify-stock');
    const apkSha256 = await p.sha256File(inputs.apk);
    if (apkSha256 === read.installedApkSha256)
        throw new UpToDateError('this player already runs this version of Studio Pocket; there is nothing to upgrade');
    cb.log(`checking the read image (${read.imageSha256.slice(0, 16)}…)`);
    const imageSha256 = await p.sha256File(read.image, (bytes) => cb.progress('Checking the read image', bytes, read.imageSizeBytes));
    if (imageSha256 !== read.imageSha256)
        throw new InstallerError('the read image has changed since it was read; read the player again');
    const workDir = p.join(firmwareDir, 'work');
    if (inputs.allowNewSigner) {
        cb.log('signer check skipped: a new signing key is allowed');
    }
    else {
        const installedSigner = await installedApkSigner(p, read.image, workDir);
        if (installedSigner === null)
            throw new InstallerError(UNREADABLE_SIGNER_REFUSAL);
        if (installedSigner !== apk.signerSha256)
            throw new InstallerError(NEW_SIGNER_REFUSAL);
    }
    const outDir = p.join(unitDir(p, firmwareDir, unitId), UPGRADE_DIR, OUT_DIR);
    await p.mkdirp(outDir);
    cb.stage('patch');
    const out = p.join(outDir, PATCHED_IMAGE);
    const patched = await patchSystemImage(p, {
        stockImage: read.image, apk: inputs.apk, out, workDir, log: cb.log, mode: 'upgrade',
        onProgress: (e) => cb.progress(e.stage === 'copy' ? 'Copying the system image' : 'Hashing the prepared image', e.bytes, e.total),
    });
    cb.stage('verify');
    const verification = await verifyPatchedImage(p, { image: out, expectedApkSha256: patched.apkSha256, partitionSizeBytes: read.layout.android.size, log: cb.log });
    const apkInfo = await p.stat(inputs.apk);
    const report = {
        firmwareVersion: manifest.firmwareVersion,
        builtAt: new Date().toISOString(),
        generator: 'studio-pocket firmware-tools/0.2.0',
        stock: { origin: 'device', systemSha256: imageSha256, systemImage: read.image, unitUuid: read.layout.android.uuid },
        apk: { path: inputs.apk, sha256: patched.apkSha256, sizeBytes: apkInfo.size, ...(inputs.apkVersion ? { version: inputs.apkVersion } : {}), packageName: patched.apkPackageName, signerSha256: patched.apkSignerSha256 },
        output: { path: out, sha256: patched.outSha256, sizeBytes: patched.outBytes, fsckFixExit: patched.fsckCode },
        compatibility: [],
        verification,
        debugfsScript: patched.script,
        upgradeFrom: { apkSha256: read.installedApkSha256 },
    };
    await p.writeText(p.join(outDir, REPORT_FILE), JSON.stringify(report, null, 2) + '\n');
    cb.stage('done');
    if (!verification.ok)
        throw new InstallerError(`the prepared image failed verification: ${verification.problems.join('; ')}`);
    return report;
}
async function writeSource(p, inputs, unitId) {
    if (inputs.action === 'upgrade') {
        const read = await loadUpgradeReadReport(p, inputs.firmwareDir, unitId);
        if (!read)
            throw new InstallerError('the player has not been read on this computer yet; read it first');
        const report = await loadUpgradePrepareReport(p, inputs.firmwareDir, unitId);
        if (!report)
            throw new InstallerError('no prepared upgrade found; prepare it first');
        if (report.stock.systemSha256 !== read.imageSha256)
            throw new InstallerError('the prepared upgrade was not made from the last read of this player; prepare it again');
        if (!report.verification.ok)
            throw new InstallerError('the prepared upgrade failed verification; prepare it again');
        return { layout: read.layout, imagePath: report.output.path, expectedSha256: report.output.sha256, firmwareVersion: report.firmwareVersion, folder: `${UPGRADE_DIR}/${OUT_DIR}` };
    }
    const read = await loadDeviceReadReport(p, inputs.firmwareDir, unitId);
    if (!read)
        throw new InstallerError('the player has not been read on this computer yet; read it first');
    if (inputs.action === 'install') {
        const report = await loadPrepareReport(p, inputs.firmwareDir, unitId);
        if (!report)
            throw new InstallerError('no prepared image found; prepare it first');
        if (report.stock.origin !== 'device' || report.stock.systemSha256 !== read.stockSha256) {
            throw new InstallerError('the prepared image was not made from this player’s own system image; prepare it again');
        }
        if (!report.verification.ok)
            throw new InstallerError('the prepared image failed verification; prepare it again');
        return { layout: read.layout, imagePath: report.output.path, expectedSha256: report.output.sha256, firmwareVersion: report.firmwareVersion, folder: OUT_DIR };
    }
    // Restore never reads the player. If the unit's newest read was a different filesystem
    // running Studio Pocket, the kept original belongs to another unit (and its offsets may differ).
    const upgradeRead = await loadUpgradeReadReport(p, inputs.firmwareDir, unitId);
    if (upgradeRead && upgradeRead.readAt > read.readAt && !restoreAvailableFor(read, upgradeRead)) {
        // The eMMC id's tail names each player; when it does not tell the two reads apart (same chip, or
        // an original read before per-player folders), the filesystem UUID's start does.
        const tellApart = read.emmcCid !== null && upgradeRead.emmcCid !== null && read.emmcCid !== upgradeRead.emmcCid;
        const tail = (r) => (tellApart && r.emmcCid ? cidTail(r.emmcCid) : r.layout.android.uuid.slice(0, 8));
        throw new InstallerError(`the player read last (player …${tail(upgradeRead)}) is not the one this original belongs to (player …${tail(read)}); choose that player's folder or read this one first`);
    }
    return { layout: read.layout, imagePath: read.stockImage, expectedSha256: read.stockSha256, firmwareVersion: read.identity.manifest?.firmwareVersion ?? 'unknown', folder: STOCK_DIR };
}
const WRITE_WHAT = {
    install: 'the Studio Pocket image',
    upgrade: 'the upgraded Studio Pocket image',
    restore: 'the player’s own original system image',
};
/**
 * Builds the one mtkclient session that writes the image and reads head and tail back. The
 * image is re-hashed so a plan can never name an image that changed since it was verified,
 * and it must fit the partition measured on the unit it came from.
 */
export async function planWrite(p, inputs, log = () => undefined) {
    await migrateFlatLayout(p, inputs.firmwareDir);
    const unitId = await resolveUnit(p, inputs.firmwareDir, inputs.unitId);
    const src = await writeSource(p, inputs, unitId);
    const { layout, imagePath } = src;
    log(`checking ${p.basename(imagePath)}`);
    const imageSha256 = await p.sha256File(imagePath);
    if (imageSha256 !== src.expectedSha256)
        throw new InstallerError(`${p.basename(imagePath)} has changed since it was verified (hash mismatch)`);
    const imageSizeBytes = (await p.stat(imagePath)).size;
    if (imageSizeBytes > layout.android.size)
        throw new InstallerError(`${p.basename(imagePath)} (${imageSizeBytes} B) is larger than the partition (${layout.android.size} B)`);
    if (!layout.trustedForWrite)
        throw new InstallerError('the measured layout is not trusted for a write');
    const mtkFiles = await sessionFiles(p, inputs.firmwareDir, log);
    const base = unitDir(p, inputs.firmwareDir, unitId);
    const dir = p.join(base, DEVICE_DIR);
    await p.mkdirp(dir);
    const verify = inputs.verify ?? 'edges';
    const probeFile = p.join(dir, PROBE_FILE);
    const headFile = p.join(dir, HEAD_FILE);
    const tailFile = p.join(dir, TAIL_FILE);
    const fullFile = verify === 'full' ? p.join(dir, FULL_FILE) : undefined;
    for (const file of [probeFile, headFile, tailFile, p.join(dir, FULL_FILE)])
        await p.remove(file).catch(() => undefined);
    const unit = await readUnit(p, inputs.firmwareDir, unitId);
    // For a CID unit the folder name is the authority: it never writes unchecked.
    const expectCid = isCid(unitId) ? unitId : (unit?.emmcCid || null);
    const a = layout.android;
    // The image lives under <unit>/<folder>, the plan under <unit>/device.
    if (p.dirname(imagePath) !== p.join(base, ...src.folder.split('/'))) {
        throw new InstallerError(`${imagePath} is not where the plan expects it`);
    }
    const imageRelative = relativeToDeviceDir(`../${src.folder}/${p.basename(imagePath)}`);
    const files = {
        probe: relativeToDeviceDir(`../${DEVICE_DIR}/${PROBE_FILE}`),
        head: relativeToDeviceDir(HEAD_FILE),
        tail: relativeToDeviceDir(TAIL_FILE),
        ...(fullFile ? { full: relativeToDeviceDir(`../${DEVICE_DIR}/${FULL_FILE}`) } : {}),
    };
    const plan = { id: `write-${inputs.action}-${Date.now().toString(36)}`, dir, lines: writePlan(a.start, a.size, imageRelative, files, imageSizeBytes), ...mtkFiles };
    const identityLine = expectCid
        ? `The player's identity (…${cidTail(expectCid)}) is checked before anything is written: the tool refuses a different player before its first read, and the session is also stopped as soon as the player reports a different id.`
        : `This player was read before per-player backups, so its identity cannot be checked. Make sure the connected player is the one read on ${unit?.firstSeen.slice(0, 10) ?? 'an earlier day'}.`;
    const checklist = [
        `Only the system partition is written: ${layout.hex.androidStart} + ${layout.hex.androidSize}, measured on this player (filesystem ${a.uuid.slice(0, 8)}…).`,
        `The image is ${WRITE_WHAT[inputs.action]}, ${p.basename(imagePath)} (${imageSha256.slice(0, 16)}…), checked just now.`,
        identityLine,
        'The player is connected with a data cable and will be restarted with the cable in when the tool says it is waiting.',
        'Do not unplug during the write (about 4 minutes). An interrupted write is repaired by writing again.',
        'The first and the last MiB are read back and compared with the image afterwards.',
        ...(fullFile ? ['Then the whole image is read back and compared (about six minutes more).'] : []),
    ];
    return {
        action: inputs.action, imagePath, imageSha256, imageSizeBytes, layout, unitUuid: a.uuid, firmwareVersion: src.firmwareVersion, plan,
        firmwareDir: inputs.firmwareDir, unitId, expectCid, verify, probeFile, headFile, tailFile, ...(fullFile ? { fullFile } : {}), checklist,
    };
}
function sameBytes(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
/**
 * Compares the head/tail read-backs with the image (tail beyond the image length counts as
 * zeros) and, for a full verification, the hash of the whole read-back with the image's.
 */
export async function verifyWrite(p, a) {
    const size = a.layout.android.size;
    const headStat = await p.stat(a.headFile);
    const tailStat = await p.stat(a.tailFile);
    const fullWanted = a.verify === 'full' && a.fullFile !== undefined;
    if (!headStat.exists || !tailStat.exists) {
        return { ok: false, head: headStat.exists ? 'differs' : 'missing', tail: tailStat.exists ? 'differs' : 'missing', full: 'skipped', detail: 'the read-backs are missing: the session did not complete; treat the player as possibly half-written and write again' };
    }
    const imgHead = await p.readBytes(a.imagePath, 0, HEAD_TAIL_BYTES);
    const devHead = await p.readBytes(a.headFile, 0, HEAD_TAIL_BYTES);
    const tailOffset = size - HEAD_TAIL_BYTES;
    const imgTailRaw = tailOffset < a.imageSizeBytes ? await p.readBytes(a.imagePath, tailOffset, HEAD_TAIL_BYTES) : new Uint8Array(0);
    const imgTail = new Uint8Array(HEAD_TAIL_BYTES);
    imgTail.set(imgTailRaw.subarray(0, HEAD_TAIL_BYTES));
    const devTail = await p.readBytes(a.tailFile, 0, HEAD_TAIL_BYTES);
    const head = sameBytes(devHead, imgHead.subarray(0, HEAD_TAIL_BYTES)) ? 'match' : 'differs';
    const tail = sameBytes(devTail, imgTail) ? 'match' : 'differs';
    if (head !== 'match' || tail !== 'match') {
        return { ok: false, head, tail, full: 'skipped', detail: `head ${head}, tail ${tail}: do not start the player blindly; write again or restore` };
    }
    if (!fullWanted)
        return { ok: true, head, tail, full: 'skipped', detail: 'first and last MiB read back identical to the image' };
    const fullStat = await p.stat(a.fullFile);
    if (!fullStat.exists) {
        return { ok: false, head, tail, full: 'skipped', detail: 'the whole-image read-back is missing: the session did not complete; write again or restore' };
    }
    const fullSha256 = await p.sha256File(a.fullFile);
    if (fullStat.size !== a.imageSizeBytes || fullSha256 !== a.imageSha256) {
        return { ok: false, head, tail, full: 'differs', detail: `the whole image read back differs from the image (${fullStat.size} B, sha256 ${fullSha256.slice(0, 16)}…, expected ${a.imageSizeBytes} B, ${a.imageSha256.slice(0, 16)}…): do not start the player blindly; write again or restore` };
    }
    return { ok: true, head, tail, full: 'match', detail: 'the whole image read back identical' };
}
/**
 * THE destructive step. Runs the plan from planWrite in one mtkclient session and verifies
 * the read-backs. Callers must have obtained explicit human approval before calling this.
 *
 * With an expected CID the runner first probes the mtkclient in use for its identity gate and
 * refuses one without it before handing over the plan (UncheckedToolError, sessionStarted false).
 * It kills the session during the probe read when another player answers (WrongPlayerError) or
 * none says which it is (UnconfirmedPlayerError), or, as a second net, when a tool that passed the
 * probe starts its plan without confirming the player itself (UncheckedToolError, sessionStarted
 * true); nothing has been written then, and the caller records the refusal. After a verified write from the
 * legacy unit, the CID the session printed is adopted (units/legacy/ becomes units/<cid>/).
 */
export async function executeWrite(p, a, onMtk) {
    let run;
    let verification;
    try {
        // The agent is checked again here: the plan may have waited a while for the person's approval.
        const daFile = await ensureDownloadAgent(p, a.firmwareDir);
        run = await runPlan(p, { ...a.plan, daFile }, onMtk, a.expectCid ? { expectCid: a.expectCid } : undefined);
        if (run.result.code === -2 && a.expectCid) {
            throw new WrongPlayerError(`This is not the player this software belongs to (player …${cidTail(a.expectCid)}). Nothing was written. Connect that player, or read this one first.`, a.expectCid, run.emmcCid);
        }
        if (run.result.code === -3 && a.expectCid) {
            throw new UnconfirmedPlayerError('Could not confirm which player is connected; nothing was written. Restart the player and try again.');
        }
        if (run.result.code === -4 && a.expectCid) {
            // The runner's flag first; without it only the probe's own line proves no plan was handed over, and
            // anything else, even no line, counts as started.
            const started = run.result.probeRefused === true ? false : run.lines.at(-1) !== UNCHECKED_TOOL_LINE;
            throw new UncheckedToolError(started
                ? 'The mtkclient in use ran its plan without confirming the player; the session was stopped at its first command. Nothing should have been written, but read the player again before trusting it. Rebuild the bundle (scripts/build-mtkclient.sh) or re-run scripts/setup-mtkclient-venv.sh.'
                : 'The mtkclient in use has no player identity check, so nothing was written. Rebuild the bundle (scripts/build-mtkclient.sh) or re-run scripts/setup-mtkclient-venv.sh.', started);
        }
        verification = await verifyWrite(p, a);
    }
    finally {
        await p.remove(a.probeFile).catch(() => undefined);
        if (a.fullFile)
            await p.remove(a.fullFile).catch(() => undefined);
    }
    const { result, lines, emmcCid } = run;
    if (result.code !== 0 && verification.ok) {
        verification.ok = false;
        verification.detail = `mtkclient exit ${result.code}: ${lastErrorLine(lines)}`;
    }
    let adoption = 'none';
    let unitId = a.unitId;
    if (verification.ok && a.unitId === LEGACY_UNIT && emmcCid && (a.action === 'restore' || a.action === 'install')) {
        try {
            await adoptLegacyUnit(p, a.firmwareDir, emmcCid, a.action);
            adoption = 'done';
            unitId = emmcCid;
        }
        catch (e) {
            adoption = { error: e instanceof Error ? e.message : String(e) };
        }
    }
    // The player now runs its original: an upgrade read or prepared from what it ran before must not be offered.
    if (verification.ok && a.action === 'restore')
        await dropUpgradeReports(p, unitDir(p, a.firmwareDir, unitId));
    return { code: result.code, mtkLog: keepTail(lines), verification, emmcCid, adoption };
}
/**
 * Writes the console-mode XML for one action. Re-hashes the image it points at so a plan can
 * never reference an image that changed since it was verified. Package-origin reports only:
 * a device-sourced image has no scatter to plan against (and the scatter is not the unit's layout).
 */
export async function planFlash(p, inputs, log = () => undefined) {
    if (inputs.action === 'upgrade')
        throw new InstallerError('SP Flash Tool plans cover install and restore only; upgrades go through mtkclient (planWrite)');
    await migrateFlatLayout(p, inputs.firmwareDir);
    const report = await loadPackagePrepareReport(p, inputs.firmwareDir);
    if (!report)
        throw new InstallerError('no prepared firmware found; run Prepare first');
    if (report.firmwareVersion !== inputs.manifest.firmwareVersion)
        throw new InstallerError(`prepared firmware is ${report.firmwareVersion}, manifest is ${inputs.manifest.firmwareVersion}`);
    if (report.stock.origin !== 'package' || !report.stock.scatterPath)
        throw new InstallerError('SP Flash Tool plans need an image prepared from the firmware package; this one came from the player');
    const imagePath = inputs.action === 'install' ? report.output.path : report.stock.systemImage;
    const expected = inputs.action === 'install' ? report.output.sha256 : report.stock.systemSha256;
    log(`checking ${p.basename(imagePath)}`);
    const imageSha256 = await p.sha256File(imagePath);
    if (imageSha256 !== expected)
        throw new InstallerError(`${p.basename(imagePath)} has changed since it was prepared (hash mismatch); run Prepare again`);
    const scatterText = await p.readText(report.stock.scatterPath);
    const scatter = parseScatter(scatterText);
    const toolDir = inputs.flashToolExe ? p.dirname(inputs.flashToolExe) : null;
    const downloadAgentPath = toolDir ? p.join(toolDir, DOWNLOAD_AGENT) : `[SP Flash Tool folder]/${DOWNLOAD_AGENT}`;
    const downloadAgentPresent = toolDir ? (await p.stat(downloadAgentPath)).exists : false;
    if (inputs.flashToolExe && p.basename(inputs.flashToolExe).toLowerCase() !== FLASH_TOOL_EXE)
        throw new InstallerError(`expected ${FLASH_TOOL_EXE}, got ${p.basename(inputs.flashToolExe)}`);
    const plan = buildFlashPlan({ manifest: inputs.manifest, scatter, imagePath, scatterPath: report.stock.scatterPath, downloadAgentPath });
    const outDir = p.join(packageDir(p, inputs.firmwareDir), OUT_DIR);
    const xmlPath = p.join(outDir, `spflash-${inputs.action}-android-only.xml`);
    const checklistPath = p.join(outDir, `FLASH-CHECKLIST-${inputs.action}.txt`);
    const checklist = [...plan.checklist];
    if (inputs.action === 'restore')
        checklist[2] = `${plan.partitionName} points at the untouched stock system.img (${imageSha256.slice(0, 12)}…).`;
    await p.writeText(xmlPath, plan.spFlashToolXml);
    await p.writeText(checklistPath, checklist.map((c, i) => `${i + 1}. ${c}`).join('\n') + '\n');
    await p.writeText(p.join(outDir, `mtkclient-${inputs.action}-android-only.script`), plan.mtkclientScript);
    return { action: inputs.action, plan: { ...plan, checklist }, imagePath, imageSha256, xmlPath, checklistPath, downloadAgentPath, downloadAgentPresent };
}
/** Appends to install-record.json (one history per computer, at the top of the firmware dir). */
export async function recordInstall(p, firmwareDir, entry) {
    const file = p.join(firmwareDir, RECORD_FILE);
    const entries = await readInstallRecord(p, firmwareDir);
    entries.push(entry);
    await p.writeText(file, JSON.stringify({ version: 1, entries }, null, 2) + '\n');
    return entries;
}
export async function readInstallRecord(p, firmwareDir) {
    await migrateFlatLayout(p, firmwareDir);
    const file = p.join(firmwareDir, RECORD_FILE);
    if (!(await p.stat(file)).exists)
        return [];
    try {
        const parsed = JSON.parse(await p.readText(file));
        return Array.isArray(parsed.entries) ? parsed.entries : [];
    }
    catch {
        return [];
    }
}
export { StockError };
//# sourceMappingURL=installer.js.map