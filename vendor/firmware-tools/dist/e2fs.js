// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
/** Thin, argv-only wrappers around e2fsprogs. GPL tools are invoked, never linked or copied. */
export class ToolError extends Error {
}
/** Runs a debugfs command script (one command per line) against an image. */
export function debugfsScript(p, image, commands, write) {
    const args = write ? ['-w', '-f', '<script>', image] : ['-f', '<script>', image];
    return p.runE2fs('debugfs', args, commands);
}
export async function debugfsQuery(p, image, command) {
    const result = await p.runE2fs('debugfs', ['-R', command, image]);
    return result.stdout;
}
/**
 * e2fsck exit codes: 0 clean, 1 errors corrected, 2 corrected + reboot advised,
 * 4 uncorrected, 8 operational error, 16 usage, 32 cancelled, 128 shared library.
 */
export function e2fsck(p, image, mode) {
    return p.runE2fs('e2fsck', [mode === 'fix' ? '-fy' : '-fn', image]);
}
export async function dumpe2fsHeader(p, image) {
    const result = await p.runE2fs('dumpe2fs', ['-h', image]);
    const values = {};
    for (const line of result.stdout.split('\n')) {
        const match = line.match(/^([^:]+):\s*(.*)$/);
        if (match && match[1] && match[2] !== undefined)
            values[match[1].trim()] = match[2].trim();
    }
    return values;
}
//# sourceMappingURL=e2fs.js.map