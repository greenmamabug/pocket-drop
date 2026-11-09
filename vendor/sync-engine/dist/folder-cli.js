#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import { parseArgs } from 'node:util';
import { syncFolder, syncReportLines } from './folder-sync.js';
const USAGE = [
    'usage: studio-pocket-sync <folder> <volume> [--create]',
    '  <folder> holds playlist folders, or MYO Studio downloads (unzipped first: zip files are not opened), or is one download',
].join('\n');
let parsed;
try {
    parsed = parseArgs({ allowPositionals: true, options: { create: { type: 'boolean', default: false } } });
}
catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exit(2);
}
const { values, positionals } = parsed;
const [folder, volume] = positionals;
if (!folder || !volume) {
    console.error(USAGE);
    process.exit(2);
}
try {
    const result = await syncFolder({ folder, volume, create: values.create, generator: 'studio-pocket-sync' });
    const { notes: _notes, ...applied } = result;
    for (const line of syncReportLines(result))
        console.error(line);
    console.log(`synced ${folder} → ${volume}`, JSON.stringify(applied, null, 2));
}
catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
//# sourceMappingURL=folder-cli.js.map