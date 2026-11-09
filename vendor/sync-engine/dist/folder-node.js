// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import { createReadStream } from 'node:fs';
import { open, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseFile, parseStream } from 'music-metadata';
import { sha256File } from '@studio-pocket/library-format/node';
export const nodeFolderDeps = {
    list: async (dir) => (await readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, path: path.join(dir, e.name), isDir: e.isDirectory() })),
    sha256: sha256File,
    size: async (file) => (await stat(file)).size,
    probe: async (file, mimeType) => {
        let meta;
        if (mimeType) {
            // parseFile picks its parser from the extension; with the type known, read the stream as that type.
            const stream = createReadStream(file);
            try {
                meta = await parseStream(stream, { mimeType, size: (await stat(file)).size }, { duration: true });
            }
            finally {
                stream.destroy();
            }
        }
        else {
            meta = await parseFile(file, { duration: true });
        }
        return { codec: meta.format.codec, durationSeconds: meta.format.duration };
    },
    read: async (file, maxBytes) => {
        const handle = await open(file, 'r');
        try {
            const buffer = Buffer.alloc(Math.min(maxBytes, (await handle.stat()).size));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return buffer.subarray(0, bytesRead);
        }
        finally {
            await handle.close();
        }
    },
};
//# sourceMappingURL=folder-node.js.map