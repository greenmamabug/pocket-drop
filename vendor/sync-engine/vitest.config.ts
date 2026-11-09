// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            '@studio-pocket/library-format/node': path.resolve(__dirname, '../library-format/src/node.ts'),
            '@studio-pocket/library-format': path.resolve(__dirname, '../library-format/src/index.ts'),
        },
    },
    test: {
        include: ['test/**/*.test.ts'],
        testTimeout: 120_000,
    },
});
