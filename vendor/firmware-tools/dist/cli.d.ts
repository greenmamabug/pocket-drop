#!/usr/bin/env node
import type { UnitInfo } from './units.js';
export declare function parseArgs(argv: string[]): {
    command: string;
    positional: string[];
    flags: Record<string, string>;
};
/** One line per player for `units`: id, firmware, first/last seen, whether Studio Pocket runs on it. */
export declare function formatUnits(units: UnitInfo[], current: string | null): string[];
