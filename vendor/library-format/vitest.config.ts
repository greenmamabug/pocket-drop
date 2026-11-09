// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        testTimeout: 120_000,
    },
});
