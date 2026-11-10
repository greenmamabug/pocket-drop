// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { describe, expect, it } from 'vitest';
import { buildDebugfsScript, SELINUX_CONTEXT } from '../src/patch.js';

describe('buildDebugfsScript', () => {
    it('matches the sequence proven on the stock image', () => {
        expect(buildDebugfsScript({ apkPath: '/tmp/StudioPocket.apk', contextPath: '/tmp/ctx.bin', removeOdex: false })).toEqual([
            'rm /priv-app/MyLauncher.apk',
            'cd /priv-app',
            'write "/tmp/StudioPocket.apk" StudioPocket.apk',
            'sif StudioPocket.apk mode 0100644',
            'sif StudioPocket.apk uid 0',
            'sif StudioPocket.apk gid 0',
            'ea_set -f "/tmp/ctx.bin" StudioPocket.apk security.selinux',
        ]);
    });

    it('also removes a stock odex when one exists', () => {
        const script = buildDebugfsScript({ apkPath: '/a.apk', contextPath: '/c', removeOdex: true });
        expect(script[1]).toBe('rm /priv-app/MyLauncher.odex');
    });

    it('upgrade mode replaces the installed APK and never touches the stock launcher', () => {
        expect(buildDebugfsScript({ apkPath: '/tmp/new.apk', contextPath: '/tmp/ctx.bin', removeOdex: true, mode: 'upgrade' })).toEqual([
            'rm /priv-app/StudioPocket.apk',
            'cd /priv-app',
            'write "/tmp/new.apk" StudioPocket.apk',
            'sif StudioPocket.apk mode 0100644',
            'sif StudioPocket.apk uid 0',
            'sif StudioPocket.apk gid 0',
            'ea_set -f "/tmp/ctx.bin" StudioPocket.apk security.selinux',
        ]);
    });

    it('uses the kernel-stored NUL-terminated system_file context', () => {
        expect(SELINUX_CONTEXT).toBe('u:object_r:system_file:s0\0');
        expect(Buffer.from(SELINUX_CONTEXT, 'latin1')).toHaveLength(26);
    });
});
