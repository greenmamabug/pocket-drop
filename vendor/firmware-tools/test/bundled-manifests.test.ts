// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { describe, expect, it } from 'vitest';
import { bundledManifest, bundledManifests } from '../src/index.js';

describe('bundled firmware manifests', () => {
    it('ships the two known stock builds, parsed and validated', () => {
        expect(bundledManifests().map((m) => m.firmwareVersion).sort()).toEqual(['3.2.0-fm', '3.2.1']);
    });

    it('looks a build up by version and refuses an unknown one', () => {
        expect(bundledManifest('3.2.1').firmwareVersion).toBe('3.2.1');
        expect(() => bundledManifest('9.9.9')).toThrow(/no bundled manifest for firmware 9\.9\.9/);
    });
});
