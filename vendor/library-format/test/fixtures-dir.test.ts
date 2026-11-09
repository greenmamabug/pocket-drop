// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixturesDir } from '../src/node.js';

describe('fixturesDir', () => {
    it('finds the shared library fixture', () => {
        expect(existsSync(path.join(fixturesDir(), 'library', 'STUDIOPOCKET'))).toBe(true);
    });
});
