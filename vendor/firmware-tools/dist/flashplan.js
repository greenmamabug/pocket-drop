// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import { targetPartition } from './manifest.js';
import { findPartition } from './scatter.js';
export class FlashPlanError extends Error {
}
export function checkCompatibility(manifest, scatter) {
    const problems = [];
    if (scatter.general.platform !== manifest.platform.soc)
        problems.push(`scatter platform ${scatter.general.platform} != ${manifest.platform.soc}`);
    if (scatter.general.project !== manifest.platform.mediatekProject)
        problems.push(`scatter project ${scatter.general.project} != ${manifest.platform.mediatekProject}`);
    if (scatter.general.storage !== 'EMMC')
        problems.push(`scatter storage ${scatter.general.storage} != EMMC`);
    const target = targetPartition(manifest);
    const actual = findPartition(scatter, target.name);
    if (!actual) {
        problems.push(`scatter has no ${target.name} partition`);
        return problems;
    }
    if (actual.index !== target.index)
        problems.push(`${target.name} index ${actual.index} != manifest ${target.index}`);
    if (actual.physicalStart !== Number.parseInt(target.physicalStart, 16))
        problems.push(`${target.name} start 0x${actual.physicalStart.toString(16)} != ${target.physicalStart}`);
    if (actual.size !== Number.parseInt(target.size, 16))
        problems.push(`${target.name} size 0x${actual.size.toString(16)} != ${target.size}`);
    if (!actual.isDownload || actual.operationType !== 'UPDATE')
        problems.push(`${target.name} is not a downloadable UPDATE partition`);
    const expected = Number.parseInt(manifest.linearAddressOffset, 16);
    if (actual.linearStart - actual.physicalStart !== expected)
        problems.push(`${target.name} linear/physical offset is not ${manifest.linearAddressOffset}`);
    return problems;
}
const xmlEscape = (value) => value.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
export function buildFlashPlan(input) {
    const target = targetPartition(input.manifest);
    const requested = input.partitionName ?? target.name;
    if (requested !== target.name) {
        throw new FlashPlanError(`refusing to plan a write to ${requested}: only ${target.name} may be written`);
    }
    const problems = checkCompatibility(input.manifest, input.scatter);
    if (problems.length)
        throw new FlashPlanError(`scatter does not match manifest: ${problems.join('; ')}`);
    const partition = findPartition(input.scatter, target.name);
    // ROM index must match the scatter SYS number (Updater CE comment: Y1 indexes brick the Y2).
    const spFlashToolXml = [
        '<?xml version="1.0" encoding="UTF-8" ?>',
        '<flashtool-config version="2.0">',
        '    <general>',
        `        <chip-name>${xmlEscape(input.scatter.general.platform)}</chip-name>`,
        '        <storage-type>EMMC</storage-type>',
        `        <download-agent>${xmlEscape(input.downloadAgentPath)}</download-agent>`,
        `        <scatter>${xmlEscape(input.scatterPath)}</scatter>`,
        '        <authentication></authentication>',
        '        <certification></certification>',
        '        <rom-list>',
        `            <rom index="${partition.index}" enable="true">${xmlEscape(input.imagePath)}</rom>`,
        '        </rom-list>',
        '        <connection type="BromUSB" high-speed="true" power="AutoDetect" da_log_level="Info" da_log_channel="UART" timeout-count="3600000" com-port="" />',
        '        <checksum-level>none</checksum-level>',
        '        <log-info log_on="true" log_path="SP_FT_Logs" clean_hours="720" />',
        '    </general>',
        '    <commands>',
        '        <download-only>',
        '            <da-download-all />',
        '        </download-only>',
        '    </commands>',
        '</flashtool-config>',
        '',
    ].join('\n');
    // By partition NAME, never by offset: mtkclient's legacy addressing is linear (user-area), so the
    // scatter's physical_start_addr lands in SEC_RO, and the first Y2 read back on 2026-10-19 had
    // ANDROID 0x880000 bytes before the scatter's linear address anyway. mtkclient resolves the
    // name against the table it reads from the device (docs/development/flashing-macos.md).
    const mtkclientScript = `w ${partition.name} ${input.imagePath}\n`;
    return {
        partitionName: partition.name,
        scatterIndex: partition.index,
        physicalStart: partition.physicalStart,
        sizeBytes: partition.size,
        imagePath: input.imagePath,
        spFlashToolXml,
        mtkclientScript,
        checklist: [
            'Mode is Download Only (never Format All + Download, never Firmware Upgrade).',
            `Only ${partition.name} (SYS${partition.index}) is ticked; every other row is unticked.`,
            `${partition.name} points at ${input.imagePath}.`,
            'The scatter loaded is the stock MT6582_Android_scatter.txt from the same firmware version.',
            'The device is fully powered off before Download is clicked and the cable connected.',
            'A verified stock system.img is available for restore before starting.',
        ],
    };
}
//# sourceMappingURL=flashplan.js.map