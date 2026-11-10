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
export declare const KEY_LAYOUT = "/usr/keylayout/mtk-kpd.kl";
export declare const KEY_LAYOUT_DIR = "/usr/keylayout";
export declare const KEY_LAYOUT_NAME = "mtk-kpd.kl";
/** Linux scan codes measured on a Y2 (Y2Keys.kt): back/forward arrows, centre, back. The ring (103, 108) is left out on purpose. */
export declare const WAKE_SCAN_CODES: readonly number[];
export interface WakeEdit {
    text: string;
    /** Scan codes whose line gained WAKE; empty when the file already had them all. */
    changed: number[];
    /** Wake scan codes with no line in the file, or a line with some other flag (left as they are). */
    untouched: number[];
}
/** Adds WAKE to the wake keys' lines; every other line, and the file's line endings, stay byte-for-byte. */
export declare function addWakeFlags(text: string): WakeEdit;
/** The wake keys whose line in [text] lacks WAKE: what verification reports. */
export declare function missingWakeFlags(text: string): number[];
/** Replaces the layout file with [hostPath], owned root:root 0644 and labelled [contextPath], as stock. */
export declare function buildKeyLayoutScript(hostPath: string, contextPath: string): string[];
