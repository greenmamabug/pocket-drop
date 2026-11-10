// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
/**
 * The Y2's keypad layout, and the one change Studio Pocket makes to it: pressing a button wakes the screen.
 *
 * On Android 4.4 a key turns the screen on only when its line in the key layout file carries the
 * WAKE flag; without it, a press with the screen off is dropped before any app sees it. The stock
 * /system/usr/keylayout/mtk-kpd.kl flags only power (and the media keys, which Android never lets
 * turn the screen on: the player app handles play/pause itself). Install and upgrade add WAKE to
 * the arrow, centre and back buttons. Not to the ring: it turns at a brush, in a pocket or a bag,
 * and would keep lighting the screen. Restore writes the stock image back, file and all. With
 * the screen off a press of these keys only wakes it: Android does not pass that press on, so a
 * first press never skips a track by accident.
 */
export const KEY_LAYOUT = '/usr/keylayout/mtk-kpd.kl';
export const KEY_LAYOUT_DIR = '/usr/keylayout';
export const KEY_LAYOUT_NAME = 'mtk-kpd.kl';
/** Linux scan codes measured on a Y2 (Y2Keys.kt): back/forward arrows, centre, back. The ring (103, 108) is left out on purpose. */
export const WAKE_SCAN_CODES = [105, 106, 28, 158];
const KEY_LINE = /^(\s*key\s+)(\d+)(\s+)([A-Z0-9_]+)\s*$/;
/** Key labels start in the stock file's column 11; flags in column 29. */
const FLAG_COLUMN_WIDTH = 18;
/** Adds WAKE to the wake keys' lines; every other line, and the file's line endings, stay byte-for-byte. */
export function addWakeFlags(text) {
    const changed = [];
    const edited = text.split('\n').map((line) => {
        const m = line.match(KEY_LINE);
        const scan = m ? Number(m[2]) : NaN;
        if (!m || !WAKE_SCAN_CODES.includes(scan))
            return line;
        changed.push(scan);
        return `${m[1]}${m[2]}${m[3]}${m[4].padEnd(FLAG_COLUMN_WIDTH)}WAKE`;
    }).join('\n');
    return { text: edited, changed, untouched: missingWakeFlags(edited) };
}
const WAKE_LINE = /^\s*key\s+(\d+)\s+\S+\s+WAKE\s*$/;
/** The wake keys whose line in [text] lacks WAKE: what verification reports. */
export function missingWakeFlags(text) {
    const flagged = new Set();
    for (const line of text.split('\n')) {
        const m = line.match(WAKE_LINE);
        if (m)
            flagged.add(Number(m[1]));
    }
    return WAKE_SCAN_CODES.filter((c) => !flagged.has(c));
}
/** Replaces the layout file with [hostPath], owned root:root 0644 and labelled [contextPath], as stock. */
export function buildKeyLayoutScript(hostPath, contextPath) {
    return [
        `rm ${KEY_LAYOUT}`,
        `cd ${KEY_LAYOUT_DIR}`,
        `write ${hostPath} ${KEY_LAYOUT_NAME}`,
        `sif ${KEY_LAYOUT_NAME} mode 0100644`,
        `sif ${KEY_LAYOUT_NAME} uid 0`,
        `sif ${KEY_LAYOUT_NAME} gid 0`,
        `ea_set -f ${contextPath} ${KEY_LAYOUT_NAME} security.selinux`,
    ];
}
//# sourceMappingURL=keylayout.js.map