// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

// Tests download from a local HTTP server only: any other fetch fails before it leaves the machine.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(`tests may not fetch ${url.href}`);
    return realFetch(input, init);
}) as typeof fetch;
