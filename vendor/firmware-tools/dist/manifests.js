// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
import { parseManifest } from './manifest.js';
import stock321 from './manifests/y2-stock-3.2.1.json' with { type: 'json' };
import stock320fm from './manifests/y2-stock-3.2.0-fm.json' with { type: 'json' };
/** The stock builds Studio Pocket can identify: hashes and partition maps, checked by parseManifest. */
export function bundledManifests() {
    return [stock321, stock320fm].map((m) => parseManifest(JSON.stringify(m)));
}
export function bundledManifest(firmwareVersion) {
    const found = bundledManifests().find((m) => m.firmwareVersion === firmwareVersion);
    if (!found)
        throw new Error(`no bundled manifest for firmware ${firmwareVersion}`);
    return found;
}
//# sourceMappingURL=manifests.js.map