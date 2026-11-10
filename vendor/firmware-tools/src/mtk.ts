// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

/**
 * mtkclient script plans and log parsing. Pure: no I/O.
 *
 * Addresses are mtkclient's *linear* user-area offsets (measured on hardware, see
 * docs/development/flashing-macos.md: the scatter's physical_start_addr is a different partition in this addressing). Only two plan
 * shapes exist: a read-only window read, and a write followed by head/tail read-backs. The
 * grammar the host side validates is one command per line:
 *   ro 0x<start> 0x<length> <output file>
 *   wo 0x<start> 0x<length> <image file>
 */
export const HEAD_TAIL_BYTES = 0x100000;

export function hex(n: number): string {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`not a non-negative safe integer: ${n}`);
    return `0x${n.toString(16)}`;
}

/** One read of `length` bytes from `windowStart` into `outFile`. */
export function readWindowPlan(windowStart: number, length: number, outFile: string): string[] {
    return [`ro ${hex(windowStart)} ${hex(length)} ${outFile}`];
}

export const PROBE_BYTES = 0x400000;

export interface WritePlanFiles {
    probe: string;
    head: string;
    tail: string;
    /** When set, the plan ends with a read-back of the whole image (`imageLength` bytes). */
    full?: string;
}

/**
 * A 4 MiB probe read at `start` first (so the session's player identity is known before
 * anything is written), then write `image` at `start` (mtkclient writes the file's length,
 * which must not exceed `size`), then read the first and the last MiB of the partition back
 * for verification, and optionally the whole image.
 */
export function writePlan(start: number, size: number, image: string, files: WritePlanFiles, imageLength?: number): string[] {
    if (size < HEAD_TAIL_BYTES) throw new RangeError('partition smaller than one MiB');
    if (files.full !== undefined && imageLength === undefined) throw new RangeError('full verification needs the image length');
    const lines = [
        `ro ${hex(start)} ${hex(PROBE_BYTES)} ${files.probe}`,
        `wo ${hex(start)} ${hex(size)} ${image}`,
        `ro ${hex(start)} ${hex(HEAD_TAIL_BYTES)} ${files.head}`,
        `ro ${hex(start + size - HEAD_TAIL_BYTES)} ${hex(HEAD_TAIL_BYTES)} ${files.tail}`,
    ];
    if (files.full !== undefined) lines.push(`ro ${hex(start)} ${hex(imageLength!)} ${files.full}`);
    return lines;
}

/** mtkclient prints the eMMC id on every session, before it handles any command. */
export const CID_LINE = /^m_emmc_cid = ([0-9a-fA-F]{32})\b/;

export function parseEmmcCid(line: string): string | null {
    const m = CID_LINE.exec(line);
    return m ? m[1]!.toLowerCase() : null;
}

export const cidTail = (cid: string): string => cid.slice(-8);

/** Drops the ANSI colour codes mtkclient's logger wraps some lines in. */
export const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * What the patched mtkclient (scripts/patch-mtkclient.py) prints once it has checked the
 * player against STUDIO_POCKET_EXPECT_CID. Its logger may prefix it (`Main - …`), so it is
 * matched anywhere in the line.
 */
export const IDENTITY_CONFIRMED = 'Studio Pocket - player identity confirmed';

/**
 * The 8-hex tail the confirmation line carries (`…2345abcd`), lowercased; null when it has none.
 * Up to four non-hex characters may stand for the ellipsis, which a console code page can mangle.
 */
const CONFIRMED_TAIL = /Studio Pocket - player identity confirmed\s*[^\s0-9a-fA-F]{0,4}([0-9a-fA-F]{8})\b/;

export function confirmedTail(line: string): string | null {
    const m = CONFIRMED_TAIL.exec(line);
    return m ? m[1]!.toLowerCase() : null;
}

export type IdentityVerdict = 'ok' | 'wrong' | 'unconfirmed' | 'confirmed' | 'unchecked' | null;

/**
 * Stateful per-session check of the printed eMMC id against the expected one. 'unconfirmed'
 * means a command began (or a read/write progressed) before any id line was seen; 'unchecked'
 * means it began after a matching id line but without mtkclient's own confirmation, i.e. the
 * tool has no identity check of its own. A confirmation whose tail is not the expected id's tail
 * is 'wrong'. Mirrors `IdentityGate` in apps/desktop/src-tauri/src/mtkclient.rs.
 */
export function identityGate(expect: string): (line: string) => IdentityVerdict {
    const want = expect.toLowerCase();
    let cidSeen = false;
    let confirmed = false;
    return (raw) => {
        const line = stripAnsi(raw);
        const cid = parseEmmcCid(line);
        if (cid !== null) {
            if (cidSeen) return null;
            if (cid === want) { cidSeen = true; return 'ok'; }
            return 'wrong';
        }
        if (line.includes(IDENTITY_CONFIRMED)) {
            if (confirmedTail(line) !== cidTail(want)) return 'wrong';
            if (confirmed) return null;
            confirmed = true;
            return 'confirmed';
        }
        if (line.includes('Handling da commands') || /Progress:.*\b(Read|Write):/.test(line)) {
            if (!cidSeen) return 'unconfirmed';
            if (!confirmed) return 'unchecked';
        }
        return null;
    };
}

/**
 * What a patched mtkclient prints when run with STUDIO_POCKET_PROBE=1 and no arguments (patch 10,
 * scripts/patch-mtkclient.py). `1` is the gate version; the runners require this exact line.
 */
export const IDENTITY_GATE_LINE = 'Studio Pocket - identity gate 1';

/** How long the capability probe may take before the tool is killed and refused. */
export const PROBE_TIMEOUT_MS = 30_000;

/** The runner's last line when the tool failed the capability probe: no plan was handed over. */
export const UNCHECKED_TOOL_LINE = 'the mtkclient in use has no player identity check; nothing was written. Rebuild the bundle (scripts/build-mtkclient.sh) or re-run scripts/setup-mtkclient-venv.sh';

/**
 * The runner's last line when a tool that passed the probe still ran its plan without confirming
 * the player (the reactive second net): the plan was handed over and stopped at its first command.
 */
export const UNCHECKED_TOOL_STARTED_LINE = 'the mtkclient in use ran its plan without confirming the player; the session was stopped at its first command. Rebuild the bundle (scripts/build-mtkclient.sh) or re-run scripts/setup-mtkclient-venv.sh';

/** Exit codes of the patched mtkclient when it refuses a plan itself. */
export const MTK_EXIT_WRONG_PLAYER = 102;
export const MTK_EXIT_UNCONFIRMED = 103;

export type MtkPhase = 'waiting' | 'handshake' | 'da' | 'read' | 'write' | 'done' | 'error';

export interface MtkProgress {
    phase: MtkPhase;
    /** 0–100 when the line carries a percentage, otherwise null. */
    percent: number | null;
    detail?: string;
    /** Waiting again after the player's port was seen and lost: it needs another restart. */
    missed?: true;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const PERCENT = /(\d{1,3}(?:\.\d+)?)%\s*(Read|Write|Stage 2|Stage 1)?/;

/** Classifies one mtkclient output line; null for lines that carry nothing useful. */
export function parseMtkLine(raw: string): MtkProgress | null {
    const line = raw.replace(ANSI, '').trim();
    if (!line) return null;

    if (/Handshake failed, retrying/.test(line)) return { phase: 'waiting', percent: null, missed: true };
    if (/Status: Waiting for PreLoader|Power off the phone before connecting|Port - Hint/.test(line)) {
        return { phase: 'waiting', percent: null };
    }
    if (/^\.+$/.test(line)) return null;

    const pct = line.match(PERCENT);
    if (/Progress:|^Done /.test(line) && pct) {
        const percent = Math.min(100, Math.round(Number.parseFloat(pct[1]!)));
        const what = pct[2] ?? '';
        if (/Stage/.test(what)) return { phase: 'da', percent, detail: what };
        if (what === 'Read') return { phase: 'read', percent };
        if (what === 'Write') return { phase: 'write', percent };
        return { phase: 'da', percent };
    }

    if (/Dumped offset .* as /.test(line)) return { phase: 'done', percent: 100, detail: line.replace(/^.*Dumped offset/, 'Dumped offset') };
    if (/^Wrote .* to offset /.test(line)) return { phase: 'done', percent: 100, detail: line };

    if (/Failed to write|Data ack failed|Sync error|Traceback|Error on sending|Failed to upload|Error reading|Couldn't send|Error reading gpt|no PassInfo|not acked|unrecognized arguments|\berror:/i.test(line)) {
        return { phase: 'error', percent: null, detail: line.replace(/^\w+ - (\[LIB\]: )?/, '') };
    }

    if (/Detected 0x[0-9a-f]+:0x[0-9a-f]+ device at: (\S+)/i.test(line)) {
        const port = line.match(/device at: (\S+)/)?.[1];
        return { phase: 'handshake', percent: null, ...(port ? { detail: port } : {}) };
    }
    if (/Device detected :\)|Handshake successful|Detected regular mode|Device is in Preloader-Mode|Device is unprotected/.test(line)) {
        return { phase: 'handshake', percent: null };
    }
    if (/Writing offset 0x[0-9a-f]+ with length/i.test(line)) return { phase: 'write', percent: 0 };
    if (/Uploading legacy da|Uploading legacy stage|Uploading stage 2|Jumping to|Got loader sync|Reading nand info|Reading emmc info|Setting stage 2 config|Waiting for response|Flash info/.test(line)) {
        return { phase: 'da', percent: null };
    }
    if (/Successfully uploaded stage 2|Connected to stage2/.test(line)) return { phase: 'da', percent: 100 };
    return null;
}

/**
 * The progress to show after [next]: a plain "waiting" line (mtkclient repeats its hint after
 * every miss) keeps an earlier miss, so the user is still told to restart the player again.
 */
export function nextMtkProgress(prev: MtkProgress | null, next: MtkProgress): MtkProgress {
    return prev?.missed && next.phase === 'waiting' && !next.missed ? prev : next;
}
