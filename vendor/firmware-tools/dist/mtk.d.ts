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
export declare const HEAD_TAIL_BYTES = 1048576;
export declare function hex(n: number): string;
/** One read of `length` bytes from `windowStart` into `outFile`. */
export declare function readWindowPlan(windowStart: number, length: number, outFile: string): string[];
export declare const PROBE_BYTES = 4194304;
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
export declare function writePlan(start: number, size: number, image: string, files: WritePlanFiles, imageLength?: number): string[];
/** mtkclient prints the eMMC id on every session, before it handles any command. */
export declare const CID_LINE: RegExp;
export declare function parseEmmcCid(line: string): string | null;
export declare const cidTail: (cid: string) => string;
/** Drops the ANSI colour codes mtkclient's logger wraps some lines in. */
export declare const stripAnsi: (line: string) => string;
/**
 * What the patched mtkclient (scripts/patch-mtkclient.py) prints once it has checked the
 * player against STUDIO_POCKET_EXPECT_CID. Its logger may prefix it (`Main - …`), so it is
 * matched anywhere in the line.
 */
export declare const IDENTITY_CONFIRMED = "Studio Pocket - player identity confirmed";
export declare function confirmedTail(line: string): string | null;
export type IdentityVerdict = 'ok' | 'wrong' | 'unconfirmed' | 'confirmed' | 'unchecked' | null;
/**
 * Stateful per-session check of the printed eMMC id against the expected one. 'unconfirmed'
 * means a command began (or a read/write progressed) before any id line was seen; 'unchecked'
 * means it began after a matching id line but without mtkclient's own confirmation, i.e. the
 * tool has no identity check of its own. A confirmation whose tail is not the expected id's tail
 * is 'wrong'. Mirrors `IdentityGate` in apps/desktop/src-tauri/src/mtkclient.rs.
 */
export declare function identityGate(expect: string): (line: string) => IdentityVerdict;
/**
 * What a patched mtkclient prints when run with STUDIO_POCKET_PROBE=1 and no arguments (patch 10,
 * scripts/patch-mtkclient.py). `1` is the gate version; the runners require this exact line.
 */
export declare const IDENTITY_GATE_LINE = "Studio Pocket - identity gate 1";
/** How long the capability probe may take before the tool is killed and refused. */
export declare const PROBE_TIMEOUT_MS = 30000;
/** The runner's last line when the tool failed the capability probe: no plan was handed over. */
export declare const UNCHECKED_TOOL_LINE = "the mtkclient in use has no player identity check; nothing was written. Rebuild the bundle (scripts/build-mtkclient.sh) or re-run scripts/setup-mtkclient-venv.sh";
/**
 * The runner's last line when a tool that passed the probe still ran its plan without confirming
 * the player (the reactive second net): the plan was handed over and stopped at its first command.
 */
export declare const UNCHECKED_TOOL_STARTED_LINE = "the mtkclient in use ran its plan without confirming the player; the session was stopped at its first command. Rebuild the bundle (scripts/build-mtkclient.sh) or re-run scripts/setup-mtkclient-venv.sh";
/** Exit codes of the patched mtkclient when it refuses a plan itself. */
export declare const MTK_EXIT_WRONG_PLAYER = 102;
export declare const MTK_EXIT_UNCONFIRMED = 103;
export type MtkPhase = 'waiting' | 'handshake' | 'da' | 'read' | 'write' | 'done' | 'error';
export interface MtkProgress {
    phase: MtkPhase;
    /** 0–100 when the line carries a percentage, otherwise null. */
    percent: number | null;
    detail?: string;
    /** Waiting again after the player's port was seen and lost: it needs another restart. */
    missed?: true;
}
/** Classifies one mtkclient output line; null for lines that carry nothing useful. */
export declare function parseMtkLine(raw: string): MtkProgress | null;
/**
 * The progress to show after [next]: a plain "waiting" line (mtkclient repeats its hint after
 * every miss) keeps an earlier miss, so the user is still told to restart the player again.
 */
export declare function nextMtkProgress(prev: MtkProgress | null, next: MtkProgress): MtkProgress;
