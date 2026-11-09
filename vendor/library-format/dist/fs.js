// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).
/** Pure-JS join for callers that only ever deal with forward slashes (device-relative paths). */
export function posixJoin(...parts) {
    return parts.filter((p) => p.length > 0).join('/').replace(/\/+/g, '/');
}
//# sourceMappingURL=fs.js.map