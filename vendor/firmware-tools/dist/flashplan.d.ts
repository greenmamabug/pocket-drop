import type { FirmwareManifest } from './manifest.js';
import type { Scatter } from './scatter.js';
/**
 * The MANUAL SP Flash Tool kit (not the supported install path; the desktop installer and
 * `studio-pocket-firmware write` are). Its mtkclient script line is the partition-name `w` line
 * (`w <partition> <image>`), which is what this kit emits.
 *
 * Produces the inputs a person (the manual kit) or an installer front end needs to
 * write ONLY the ANDROID partition. Nothing in this module talks to a device.
 */
export interface FlashPlan {
    partitionName: string;
    scatterIndex: number;
    physicalStart: number;
    sizeBytes: number;
    imagePath: string;
    /** SP Flash Tool console-mode XML: Download Only, single ROM entry. */
    spFlashToolXml: string;
    /** mtkclient script line for the (unverified) macOS/Linux path. */
    mtkclientScript: string;
    /** Human checklist for the SP Flash Tool Download-Only route. */
    checklist: string[];
}
export declare class FlashPlanError extends Error {
}
export interface FlashPlanInput {
    manifest: FirmwareManifest;
    scatter: Scatter;
    imagePath: string;
    scatterPath: string;
    downloadAgentPath: string;
    /** Must be exactly the partition the manifest marks; anything else is refused. */
    partitionName?: string;
}
export declare function checkCompatibility(manifest: FirmwareManifest, scatter: Scatter): string[];
export declare function buildFlashPlan(input: FlashPlanInput): FlashPlan;
