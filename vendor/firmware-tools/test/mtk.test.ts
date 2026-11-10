// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { describe, expect, it } from 'vitest';
import { confirmedTail, HEAD_TAIL_BYTES, hex, identityGate, nextMtkProgress, parseEmmcCid, parseMtkLine, readWindowPlan, writePlan } from '../src/mtk.js';

describe('mtkclient plans', () => {
    it('formats hex and the two plan shapes', () => {
        expect(hex(0x5d00000)).toBe('0x5d00000');
        expect(() => hex(-1)).toThrow(RangeError);
        expect(readWindowPlan(0x5180000, 0x34800000, '/fw/device/window.img')).toEqual(['ro 0x5180000 0x34800000 /fw/device/window.img']);
        expect(HEAD_TAIL_BYTES).toBe(0x100000);
        expect(() => writePlan(0, 0x1000, 'i', { probe: 'p', head: 'h', tail: 't' })).toThrow(RangeError);
    });
});

describe('eMMC identity', () => {
    it('parses the eMMC id line and lowercases it', () => {
        expect(parseEmmcCid('m_emmc_cid = 1500AA0100A1B2C3D4E5F6012345ABCD')).toBe('1500aa0100a1b2c3d4e5f6012345abcd');
        expect(parseEmmcCid('m_emmc_fwver = 0000000000000000')).toBeNull();
    });
    it('identity gate: stage-2 progress before the id is fine, a read before it is not, a different id is wrong', () => {
        const cid = '1500aa0100a1b2c3d4e5f6012345abcd';
        let gate = identityGate(cid);
        expect(gate('Progress: |██████████| 100.0% Stage 2: (0x286BC/0x286BC), 250.0 KB/s')).toBeNull();
        expect(gate('m_emmc_cid = ' + cid.toUpperCase())).toBe('ok');
        expect(gate('Studio Pocket - player identity confirmed …2345abcd')).toBe('confirmed');
        expect(gate('Progress: |█████-----| 50.0% Read: (0x1000/0x400000), 2.5 MB/s')).toBeNull();
        gate = identityGate(cid);
        expect(gate('Main - Handling da commands ...')).toBe('unconfirmed');
        gate = identityGate(cid);
        expect(gate('m_emmc_cid = 0000000000000000000000000000beef')).toBe('wrong');
    });
    it('identity gate: the DA stage needs mtkclient\'s own confirmation after a matching id', () => {
        const cid = '1500aa0100a1b2c3d4e5f6012345abcd';
        let gate = identityGate(cid);
        expect(gate('m_emmc_cid = ' + cid)).toBe('ok');
        expect(gate('Studio Pocket - player identity confirmed …2345abcd')).toBe('confirmed');
        expect(gate('Main - Handling da commands ...')).toBeNull();
        expect(gate('Progress: |██--------| 15.0% Write: (0x7B00000/0x333FEC00), 1.87 MB/s')).toBeNull();
        gate = identityGate(cid);
        expect(gate('m_emmc_cid = ' + cid)).toBe('ok');
        expect(gate('Main - Handling da commands ...')).toBe('unchecked');
        gate = identityGate(cid);
        expect(gate('m_emmc_cid = ' + cid)).toBe('ok');
        expect(gate('Progress: |----------| 1.6% Read: (0xD00000/0x33400000), 2.5 MB/s')).toBe('unchecked');
        // An upper-case expectation confirms a lower-case id line.
        gate = identityGate(cid.toUpperCase());
        expect(gate('m_emmc_cid = ' + cid)).toBe('ok');
        expect(gate('Studio Pocket - player identity confirmed …2345abcd')).toBe('confirmed');
        expect(gate('Main - Handling da commands ...')).toBeNull();
        // A confirmation without an id line first still leaves the player unconfirmed.
        gate = identityGate(cid);
        expect(gate('Studio Pocket - player identity confirmed …2345abcd')).toBe('confirmed');
        expect(gate('Main - Handling da commands ...')).toBe('unconfirmed');
    });
    it('identity gate: a confirmation must carry the expected id\'s tail', () => {
        const cid = '1500aa0100a1b2c3d4e5f6012345abcd';
        let gate = identityGate(cid);
        expect(gate('m_emmc_cid = ' + cid)).toBe('ok');
        expect(gate('Main - Studio Pocket - player identity confirmed …2345abce')).toBe('wrong');
        gate = identityGate(cid);
        expect(gate('m_emmc_cid = ' + cid)).toBe('ok');
        expect(gate('Studio Pocket - player identity confirmed')).toBe('wrong');
        gate = identityGate(cid);
        expect(gate('m_emmc_cid = ' + cid)).toBe('ok');
        expect(gate('Studio Pocket - player identity confirmed …2345abcd00')).toBe('wrong');
        // A later confirmation naming another player is still wrong.
        gate = identityGate(cid);
        expect(gate('m_emmc_cid = ' + cid)).toBe('ok');
        expect(gate('Studio Pocket - player identity confirmed …2345abcd')).toBe('confirmed');
        expect(gate('Studio Pocket - player identity confirmed …2345abce')).toBe('wrong');
        // The tail is compared case-insensitively, and a mangled ellipsis still reads.
        gate = identityGate(cid.toUpperCase());
        expect(gate('m_emmc_cid = ' + cid)).toBe('ok');
        expect(gate('Studio Pocket - player identity confirmed �2345ABCD')).toBe('confirmed');
        expect(confirmedTail('Main - [LIB]: \x1b[31mStudio Pocket - player identity confirmed …2345abcd\x1b[0m')).toBe('2345abcd');
        expect(confirmedTail('Studio Pocket - player identity confirmed …4200')).toBeNull();
    });
    it('identity gate: the real tool\'s logger prefixes and colours its lines', () => {
        const cid = '1500aa0100a1b2c3d4e5f6012345abcd';
        let gate = identityGate(cid);
        expect(gate('m_emmc_cid = ' + cid)).toBe('ok');
        expect(gate('Main - Studio Pocket - player identity confirmed …2345abcd')).toBe('confirmed');
        expect(gate('Main - Handling da commands ...')).toBeNull();
        gate = identityGate(cid);
        expect(gate('m_emmc_cid = ' + cid)).toBe('ok');
        expect(gate('Main - [LIB]: \x1b[31mStudio Pocket - player identity confirmed …2345abcd\x1b[0m')).toBe('confirmed');
        gate = identityGate(cid);
        expect(gate('\x1b[33mMain - Handling da commands ...\x1b[0m')).toBe('unconfirmed');
        // The refusal lines decide nothing by themselves; the exit code carries them.
        gate = identityGate(cid);
        expect(gate('Main')).toBeNull();
        expect(gate('Main - [LIB]: \x1b[31mStudio Pocket - wrong player: expected …2345abcd, connected …0000beef; refusing to run the plan \x1b[0m')).toBeNull();
        expect(gate('Main - [LIB]: \x1b[31mStudio Pocket - could not confirm which player is connected; refusing to run the plan \x1b[0m')).toBeNull();
    });
    it('write plan starts with a 4 MiB probe read and can end with a full read-back', () => {
        const lines = writePlan(0x5d00000, 0x33400000, '../out/system.studiopocket.img', { probe: 'identity-probe.bin', head: 'verify-head.bin', tail: 'verify-tail.bin' });
        expect(lines[0]).toBe('ro 0x5d00000 0x400000 identity-probe.bin');
        expect(lines[1]).toMatch(/^wo 0x5d00000 /);
        expect(lines).toHaveLength(4);
        const full = writePlan(0x5d00000, 0x33400000, 'img', { probe: 'p', head: 'h', tail: 't', full: 'verify-full.img' }, 0x333fec00);
        expect(full[4]).toBe('ro 0x5d00000 0x333fec00 verify-full.img');
        expect(() => writePlan(0x5d00000, 0x33400000, 'img', { probe: 'p', head: 'h', tail: 't', full: 'f' })).toThrow(RangeError);
    });
});

/** Lines as the real tool printed them on 2026-10-19 (readback and write logs, \r split). */
describe('mtkclient log lines', () => {
    const cases: [string, ReturnType<typeof parseMtkLine>][] = [
        ['Preloader - Status: Waiting for PreLoader VCOM, please reconnect mobile/iot device to brom mode', { phase: 'waiting', percent: null }],
        ['Preloader - [LIB]: \x1b[31mStatus: Handshake failed, retrying...\x1b[0m', { phase: 'waiting', percent: null, missed: true }],
        ['..........', null],
        ['DeviceClass - Detected 0xe8d:0x2000 device at: /dev/cu.usbmodem1100', { phase: 'handshake', percent: null, detail: '/dev/cu.usbmodem1100' }],
        ['Port - Handshake successful.', { phase: 'handshake', percent: null }],
        ['Preloader - Detected regular mode !', { phase: 'handshake', percent: null }],
        ['DALegacy - Uploading legacy stage 1 from MTK_AllInOne_DA_mt6590.bin', { phase: 'da', percent: null }],
        ['Progress: |██████████| 100.0% Stage 2: (0x286BC/0x286BC), 254.32 KB/s', { phase: 'da', percent: 100, detail: 'Stage 2' }],
        ['Done |----------| 2.5% Stage 2: (0x1000/0x286BC),0.00 MB/s', { phase: 'da', percent: 3, detail: 'Stage 2' }],
        ['DALegacy - Connected to stage2', { phase: 'da', percent: 100 }],
        ['Progress: |----------| 1.6% Read: (0xD00000/0x33400000), 2.5 MB/s 04m:58s left', { phase: 'read', percent: 2 }],
        ['Progress: |██████████| 100.0% Read: (0x33400000/0x33400000), 2.5 MB/s', { phase: 'read', percent: 100 }],
        ['Dumped offset 0x5180000 with length 0x33400000 as /x/android.img.', { phase: 'done', percent: 100, detail: 'Dumped offset 0x5180000 with length 0x33400000 as /x/android.img.' }],
        ['DaHandler - Writing offset 0x5d00000 with length 0x33400000', { phase: 'write', percent: 0 }],
        ['Progress: |██--------| 15.0% Write: (0x7B00000/0x333FEC00), 1.87 MB/s 02m:27s left', { phase: 'write', percent: 15 }],
        ['Wrote /x/system.stock.img to offset 0x5d00000 with length 0x33400000.', { phase: 'done', percent: 100, detail: 'Wrote /x/system.stock.img to offset 0x5d00000 with length 0x33400000.' }],
        ['DALegacy - [LIB]: \x1b[31mData ack failed for sdmmc_write_data\x1b[0m', { phase: 'error', percent: null, detail: 'Data ack failed for sdmmc_write_data' }],
        ['Failed to write /x/system.stock.img to offset 0x5d00000 with length 0x33400000.', { phase: 'error', percent: null, detail: 'Failed to write /x/system.stock.img to offset 0x5d00000 with length 0x33400000.' }],
        ['Preloader - [LIB]: \x1b[31mSync error. Please power off the device and retry.\x1b[0m', { phase: 'error', percent: null, detail: 'Sync error. Please power off the device and retry.' }],
        ['DaHandler - [LIB]: \x1b[31mFailed to upload da.\x1b[0m', { phase: 'error', percent: null, detail: 'Failed to upload da.' }],
        ['Traceback (most recent call last):', { phase: 'error', percent: null, detail: 'Traceback (most recent call last):' }],
        ['mtk: error: unrecognized arguments: --serialport DETECT', { phase: 'error', percent: null, detail: 'mtk: error: unrecognized arguments: --serialport DETECT' }],
        ['DALegacy - m_emmc_ua_size = 0x1d2000000', null],
        ['LegacyExt - [LIB]: \x1b[33mLegacy Read is normal.\x1b[0m', null],
    ];
    it.each(cases)('%s', (line, expected) => {
        expect(parseMtkLine(line)).toEqual(expected);
    });
});

describe('mtkclient progress shown to the user', () => {
    const waiting = { phase: 'waiting' as const, percent: null };
    const missed = { phase: 'waiting' as const, percent: null, missed: true as const };
    const handshake = { phase: 'handshake' as const, percent: null };
    it('keeps a miss through the hint lines that follow it, until the player is seen again', () => {
        expect(nextMtkProgress(null, waiting)).toEqual(waiting);
        expect(nextMtkProgress(waiting, missed)).toEqual(missed);
        expect(nextMtkProgress(missed, waiting)).toEqual(missed);
        expect(nextMtkProgress(missed, handshake)).toEqual(handshake);
        expect(nextMtkProgress(handshake, waiting)).toEqual(waiting);
    });
});
