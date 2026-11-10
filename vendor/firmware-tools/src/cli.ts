#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { identifyImage, loadManifest, mtkAvailable, nodePlatform, patchSystemImage, prepareStock, sha256File, verifyPatchedImage } from './node.js';
import { executeWrite, InstallerError, loadDeviceReadReport, planWrite, prepareInstallFromDevice, prepareUpgradeFromDevice, readDeviceSystem, recordInstall, restoreAvailableFor, UncheckedToolError, UnconfirmedPlayerError, UpToDateError, WrongPlayerError } from './installer.js';
import { currentUnit, LEGACY_UNIT, listUnits, readUnit } from './units.js';
import type { UnitInfo } from './units.js';
import { parseMtkLine } from './mtk.js';
import { ensureDownloadAgent, PRELOADER_FILE_ENV, preloaderOverride } from './da.js';
import { targetPartition } from './manifest.js';
import { parseScatter } from './scatter.js';
import { buildFlashPlan, checkCompatibility } from './flashplan.js';

/**
 * studio-pocket-firmware: the installer engine from the command line. The device-sourced commands
 * (read-device, prepare-device, write) are the product path; `write` is the only one that
 * changes a device and asks for a typed WRITE first (docs/development/flashing-macos.md).
 */
const usage = `usage:
  studio-pocket-firmware mtk-check [--firmware-dir <dir>]                 where mtkclient is (STUDIO_POCKET_MTK_BIN, the repo venv, or PATH); with
                                                                --firmware-dir, also fetch and check MediaTek's download agent into <dir>/tools/da/
                                                                (read-device and write do that on first use; STUDIO_POCKET_DA_FILE overrides it)
  studio-pocket-firmware units --firmware-dir <dir>                       list the players read so far (one folder each under units/)
  studio-pocket-firmware read-device --firmware-dir <dir> [--manifests <json,…>]
                                                                read-only: read the player's system partition over mtkclient (restart the
                                                                player with the cable in when it waits), measure the layout, keep the
                                                                image as the restore copy, identify the build. Read-only.
  studio-pocket-firmware prepare-device --firmware-dir <dir> --apk <apk> [--apk-version <v>] [--unit <id>] [--allow-new-signer]
                                                                patch the kept copy with the player APK and verify it
  studio-pocket-firmware prepare-upgrade --firmware-dir <dir> --apk <apk> [--apk-version <v>] [--unit <id>] [--allow-new-signer]
                                                                after read-device found Studio Pocket installed: replace its APK and verify
  studio-pocket-firmware write --firmware-dir <dir> --action install|restore|upgrade [--unit <id>] [--verify full] [--yes]
                                                                write the prepared image (or the kept original) back and verify
                                                                the first and last MiB (--verify full: the whole image). Refuses a player
                                                                other than the unit's. Asks you to type WRITE unless --yes.
  read-device names the player itself (unit <id>); the other commands take --unit <id>, default: the player read last.

  studio-pocket-firmware inspect <image>                                  identify an image (ext4 / sparse) and print its superblock

manual SP Flash Tool kit (not the supported install path):
  studio-pocket-firmware verify-stock <rom_y2.zip|dir> --manifest <json> --work <dir>
                                                                hash-check the stock package and its scatter
  studio-pocket-firmware patch --stock <system.img> --apk <apk> --out <image> --work <dir>
                                                                replace the stock launcher with the APK (debugfs, offline)
  studio-pocket-firmware verify --image <image> --apk <apk> --manifest <json>
                                                                independently re-open and check a patched image
  studio-pocket-firmware flash-plan --manifest <json> --scatter <txt> --image <image> --da <MTK_AllInOne_DA.bin> --out <dir>
                                                                write the Download-Only / ANDROID-only SP Flash Tool XML and checklist
  studio-pocket-firmware build --stock <rom_y2.zip|dir> --apk <apk> --manifest <json> --work <dir> --out <dir>
                                                                verify-stock + patch + verify + flash-plan in one go
`;

export function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Record<string, string> } {
    const [command = '', ...rest] = argv;
    const positional: string[] = [];
    const flags: Record<string, string> = {};
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]!;
        if (arg.startsWith('--')) {
            const value = rest[i + 1];
            if (value === undefined || value.startsWith('--')) flags[arg.slice(2)] = 'true';
            else { flags[arg.slice(2)] = value; i++; }
        } else positional.push(arg);
    }
    return { command, positional, flags };
}

const day = (iso: string): string => iso.slice(0, 10);

/** One line per player for `units`: id, firmware, first/last seen, whether Studio Pocket runs on it. */
export function formatUnits(units: UnitInfo[], current: string | null): string[] {
    return units.map((u) => [
        `${u.unitId}  ${u.firmwareVersion ?? 'unknown'}  first ${day(u.firstSeen)}  last ${day(u.lastSeen)}  ${u.installed ? 'runs Studio Pocket' : 'stock'}`,
        u.unitId === LEGACY_UNIT ? '(identity unverified)' : '',
        u.unitId === current ? '(current)' : '',
    ].filter(Boolean).join('  '));
}

const need = (flags: Record<string, string>, name: string): string => {
    const value = flags[name];
    if (!value) throw new Error(`--${name} is required\n\n${usage}`);
    return value;
};

const log = (line: string) => console.log(line);
const defaultManifests = ['y2-stock-3.2.1.json', 'y2-stock-3.2.0-fm.json'].map((n) => new URL(`./manifests/${n}`, import.meta.url).pathname);

function mtkEcho(progress: ReturnType<typeof parseMtkLine>, line: string): void {
    if (progress?.phase === 'read' || progress?.phase === 'write') {
        if (progress.percent !== null) process.stdout.write(`\r${progress.phase} ${progress.percent}%   `);
        return;
    }
    if (progress) console.log(`\n[mtk ${progress.phase}] ${progress.missed ? 'missed the player: press the reset pinhole again' : (progress.detail ?? line)}`);
}

async function confirmWrite(): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => rl.question('Type WRITE to write to the connected player, anything else to abort: ', resolve));
    rl.close();
    return answer.trim() === 'WRITE';
}

async function main(argv: string[]): Promise<number> {
    const { command, positional, flags } = parseArgs(argv);
    switch (command) {
        case 'mtk-check': {
            const a = await mtkAvailable();
            console.log(a.ok ? `mtkclient: ${a.detail}` : `mtkclient unavailable: ${a.detail}`);
            if (!a.ok) return 1;
            if (!flags['firmware-dir']) {
                console.log('download agent: not checked (pass --firmware-dir <dir>; read-device and write fetch it on first use)');
                return 0;
            }
            const daFile = await ensureDownloadAgent(nodePlatform, path.resolve(flags['firmware-dir']), log);
            console.log(`download agent: ${daFile}`);
            const preloader = await preloaderOverride(nodePlatform);
            if (preloader) console.log(`preloader (${PRELOADER_FILE_ENV}): ${preloader}`);
            return 0;
        }
        case 'units': {
            const firmwareDir = path.resolve(need(flags, 'firmware-dir'));
            const lines = formatUnits(await listUnits(nodePlatform, firmwareDir), await currentUnit(nodePlatform, firmwareDir));
            if (!lines.length) { console.log('no players read yet'); return 1; }
            lines.forEach((l) => console.log(l));
            return 0;
        }
        case 'read-device': {
            const firmwareDir = path.resolve(need(flags, 'firmware-dir'));
            const files = flags.manifests ? flags.manifests.split(',').map((f) => path.resolve(f)) : defaultManifests;
            const manifests = await Promise.all(files.map(loadManifest));
            const report = await readDeviceSystem(nodePlatform, { firmwareDir, manifests }, {
                log, stage: (s) => console.log(`\n== ${s}`), progress: (label, bytes, total) => process.stdout.write(`\r${label}: ${total ? Math.round((bytes / total) * 100) : bytes}%   `), mtk: mtkEcho,
            });
            console.log(`\nunit ${report.unitId} (${(await readUnit(nodePlatform, firmwareDir, report.unitId))?.firstSeen === report.readAt ? 'created' : 'updated'})`);
            console.log(JSON.stringify({ ...report, identity: { ...report.identity, manifest: report.identity.manifest?.firmwareVersion ?? null }, mtkLog: undefined }, null, 2));
            if (report.state === 'studiopocket') {
                const canRestore = restoreAvailableFor(await loadDeviceReadReport(nodePlatform, firmwareDir), report);
                console.log(`\nStudio Pocket is installed on this player (APK ${report.installedApkSha256.slice(0, 16)}…); the read is kept at ${report.image} for an upgrade (prepare-upgrade).`);
                console.log(canRestore ? 'This firmware dir holds this player’s original software: restore stays possible.' : 'This firmware dir does NOT hold this player’s original software, so it cannot restore it. The computer that set the player up still can.');
                return 0;
            }
            console.log(`MATCH: the player carries ${report.identity.manifest?.firmwareVersion} (build ${report.identity.build}); its system image is kept at ${report.stockImage}`);
            return 0;
        }
        case 'prepare-device': {
            const firmwareDir = path.resolve(need(flags, 'firmware-dir'));
            const report = await prepareInstallFromDevice(nodePlatform, { firmwareDir, ...(flags.unit ? { unitId: flags.unit } : {}), apk: path.resolve(need(flags, 'apk')), ...(flags['apk-version'] ? { apkVersion: flags['apk-version'] } : {}), ...(flags['allow-new-signer'] === 'true' ? { allowNewSigner: true } : {}) }, {
                log, stage: (s) => console.log(`== ${s}`), progress: () => undefined,
            });
            console.log(JSON.stringify({ ...report, debugfsScript: undefined }, null, 2));
            return report.verification.ok ? 0 : 1;
        }
        case 'prepare-upgrade': {
            const firmwareDir = path.resolve(need(flags, 'firmware-dir'));
            try {
                const report = await prepareUpgradeFromDevice(nodePlatform, { firmwareDir, ...(flags.unit ? { unitId: flags.unit } : {}), apk: path.resolve(need(flags, 'apk')), ...(flags['apk-version'] ? { apkVersion: flags['apk-version'] } : {}), ...(flags['allow-new-signer'] === 'true' ? { allowNewSigner: true } : {}) }, {
                    log, stage: (s) => console.log(`== ${s}`), progress: () => undefined,
                });
                console.log(JSON.stringify({ ...report, debugfsScript: undefined }, null, 2));
                return report.verification.ok ? 0 : 1;
            } catch (e) {
                if (e instanceof UpToDateError) { console.log(e.message); return 0; }
                throw e;
            }
        }
        case 'write': {
            const firmwareDir = path.resolve(need(flags, 'firmware-dir'));
            const action = need(flags, 'action');
            if (action !== 'install' && action !== 'restore' && action !== 'upgrade') throw new Error('--action must be install, restore or upgrade');
            const verify = flags.verify ?? 'edges';
            if (verify !== 'edges' && verify !== 'full') throw new Error('--verify must be edges or full');
            const artifacts = await planWrite(nodePlatform, { firmwareDir, action, verify, ...(flags.unit ? { unitId: flags.unit } : {}) }, log);
            console.log(`\nTHIS WRITES THE SYSTEM PARTITION OF THE CONNECTED PLAYER (${action}).`);
            artifacts.checklist.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
            if (flags.yes !== 'true' && !(await confirmWrite())) { console.log('aborted, nothing written'); return 1; }
            console.log('When mtkclient says it is waiting, restart the player with the cable connected. Do NOT unplug during the write.');
            try {
                const outcome = await executeWrite(nodePlatform, artifacts, mtkEcho);
                console.log(`\nmtkclient exit ${outcome.code}; head ${outcome.verification.head}, tail ${outcome.verification.tail}, whole image ${outcome.verification.full}`);
                if (outcome.verification.ok) console.log(artifacts.verify === 'full' ? 'WRITE VERIFIED (whole image)' : 'WRITE VERIFIED (first and last MiB)');
                else console.log(`WRITE NOT VERIFIED: ${outcome.verification.detail}`);
                if (typeof outcome.adoption === 'object') console.log(`warning: the player's folder could not be renamed after the write: ${outcome.adoption.error}`);
                return outcome.verification.ok ? 0 : 2;
            } catch (e) {
                if (e instanceof WrongPlayerError || e instanceof UnconfirmedPlayerError || e instanceof UncheckedToolError) {
                    await recordInstall(nodePlatform, firmwareDir, {
                        at: new Date().toISOString(), action, firmwareVersion: artifacts.firmwareVersion, stockSystemSha256: '', imageSha256: artifacts.imageSha256,
                        outcome: e.outcome, unitUuid: artifacts.unitUuid, unitId: artifacts.unitId,
                    });
                    console.error(e.message);
                    return 1;
                }
                throw e;
            }
        }
        case 'inspect': {
            const image = positional[0] ?? need(flags, 'image');
            const kind = await identifyImage(image);
            console.log(JSON.stringify({ image, ...kind, sha256: await sha256File(image) }, null, 2));
            return 0;
        }
        case 'verify-stock': {
            const manifest = await loadManifest(need(flags, 'manifest'));
            const stock = await prepareStock(positional[0] ?? need(flags, 'stock'), manifest, need(flags, 'work'), log);
            const problems = checkCompatibility(manifest, stock.scatter);
            console.log(JSON.stringify({ ...stock, scatter: undefined, compatible: problems.length === 0, problems }, null, 2));
            return problems.length ? 1 : 0;
        }
        case 'patch': {
            const result = await patchSystemImage({ stockImage: need(flags, 'stock'), apk: need(flags, 'apk'), out: need(flags, 'out'), workDir: need(flags, 'work'), log });
            console.log(JSON.stringify(result, null, 2));
            return 0;
        }
        case 'verify': {
            const manifest = await loadManifest(need(flags, 'manifest'));
            const report = await verifyPatchedImage({
                image: need(flags, 'image'),
                expectedApkSha256: await sha256File(need(flags, 'apk')),
                partitionSizeBytes: Number.parseInt(targetPartition(manifest).size, 16),
            });
            console.log(JSON.stringify(report, null, 2));
            return report.ok ? 0 : 1;
        }
        case 'flash-plan': {
            const manifest = await loadManifest(need(flags, 'manifest'));
            const scatterPath = path.resolve(need(flags, 'scatter'));
            const scatter = parseScatter(await readFile(scatterPath, 'utf8'));
            const outDir = need(flags, 'out');
            await writePlan(outDir, buildFlashPlan({ manifest, scatter, imagePath: path.resolve(need(flags, 'image')), scatterPath, downloadAgentPath: path.resolve(need(flags, 'da')) }));
            return 0;
        }
        case 'build': {
            const manifest = await loadManifest(need(flags, 'manifest'));
            const work = need(flags, 'work');
            const outDir = need(flags, 'out');
            const apk = path.resolve(need(flags, 'apk'));
            const stock = await prepareStock(need(flags, 'stock'), manifest, work, log);
            const problems = checkCompatibility(manifest, stock.scatter);
            if (problems.length) throw new Error(`stock package incompatible: ${problems.join('; ')}`);
            await mkdir(outDir, { recursive: true });
            const out = path.join(path.resolve(outDir), 'system.studiopocket.img');
            const patched = await patchSystemImage({ stockImage: stock.systemImage, apk, out, workDir: work, log });
            log('verifying');
            const report = await verifyPatchedImage({ image: out, expectedApkSha256: patched.apkSha256, partitionSizeBytes: Number.parseInt(targetPartition(manifest).size, 16) });
            const plan = buildFlashPlan({ manifest, scatter: stock.scatter, imagePath: out, scatterPath: path.resolve(stock.scatterPath), downloadAgentPath: path.join(path.dirname(path.resolve(stock.scatterPath)), 'MTK_AllInOne_DA.bin') });
            await writePlan(outDir, plan);
            const summary = {
                firmwareVersion: manifest.firmwareVersion,
                stock: { zipSha256: stock.zipSha256, systemSha256: stock.systemSha256, scatterSha256: stock.scatterSha256 },
                apk: { path: apk, sha256: patched.apkSha256 },
                output: { path: out, sha256: patched.outSha256, fsckFixExit: patched.fsckCode },
                debugfsScript: patched.script,
                verification: report,
                builtAt: new Date().toISOString(),
            };
            await writeFile(path.join(outDir, 'build-report.json'), JSON.stringify(summary, null, 2) + '\n');
            console.log(JSON.stringify(summary, null, 2));
            return report.ok ? 0 : 1;
        }
        default:
            console.error(usage);
            return 2;
    }
}

async function writePlan(outDir: string, plan: ReturnType<typeof buildFlashPlan>): Promise<void> {
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'spflash-download-only-android.xml'), plan.spFlashToolXml);
    await writeFile(path.join(outDir, 'mtkclient-android-only.script'), plan.mtkclientScript);
    await writeFile(path.join(outDir, 'FLASH-CHECKLIST.txt'), plan.checklist.map((c, i) => `${i + 1}. ${c}`).join('\n') + '\n');
    console.log(`flash plan written to ${outDir} (partition ${plan.partitionName}, SYS${plan.scatterIndex}, 0x${plan.physicalStart.toString(16)} + 0x${plan.sizeBytes.toString(16)})`);
}

/** True when this module is the script node was asked to run, including through a symlink or pnpm's .bin shim. */
function isEntryPoint(): boolean {
    if (!process.argv[1]) return false;
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isEntryPoint()) {
    main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error: Error) => {
        console.error(error instanceof InstallerError ? error.message : `error: ${error.message}`);
        process.exit(1);
    });
}
