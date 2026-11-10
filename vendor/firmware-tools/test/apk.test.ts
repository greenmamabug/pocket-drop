// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    acceptApk, extractEntry, hasHomeLauncher, inspectApk, packageNameFromBinaryXml, parseJarManifest, parsePkcs7, PLAYER_PACKAGE, readAndroidManifest,
    readCentralDirectory, spkiFromCertificate, walkBinaryXml, type ApkInspection,
} from '../src/apk.js';
import { nodePlatform as p } from '../src/node.js';
import { editApk, entryBytes, fixture, makeFakeApk, makeZip, manifestWithPackage, RELEASE_SIGNER, SIGNER_A, SIGNER_B, withSignerKey, withTwoSigners } from './fake-apk.js';

const releaseApk = new URL('../../../apps/player/app/build/outputs/apk/release/app-release.apk', import.meta.url).pathname;
const NOT_SIGNED = 'not signed with a v1 (JAR) signature, which Android 4.4 requires';
const enc = new TextEncoder();
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const crlf = (lines: string[]): Uint8Array => enc.encode(lines.map((l) => `${l}\r\n`).join(''));

/** Every signed fixture by key A with the player package: apksigner's direct signature and jarsigner's signed attributes. */
const PLAYER_FIXTURES = ['signed-apksigner.apk', 'signed-jarsigner.apk'];

describe('APK inspection', () => {
    it('extracts the package name from the committed manifest fixture', () => {
        expect(PLAYER_PACKAGE).toBe('app.studiopocket.player');
        expect(packageNameFromBinaryXml(fixture('AndroidManifest.xml'))).toBe('app.studiopocket.player');
        expect(packageNameFromBinaryXml(manifestWithPackage('com.example.launcherapp'))).toBe('com.example.launcherapp');
    });

    it('reads a UTF-8 string pool too, and returns null for anything that is not binary XML', () => {
        expect(packageNameFromBinaryXml(utf8Manifest('app.studiopocket.player'))).toBe('app.studiopocket.player');
        expect(packageNameFromBinaryXml(enc.encode('<manifest package="x"/>'))).toBeNull();
        expect(packageNameFromBinaryXml(fixture('AndroidManifest.xml').subarray(0, 300))).toBeNull();
        expect(packageNameFromBinaryXml(new Uint8Array(0))).toBeNull();
        expect(walkBinaryXml(enc.encode('<manifest/>'))).toBeNull();
    });

    it('parses the PKCS#7 block of the real player (CERT.RSA): certificate, signer, and its public key', async () => {
        const block = parsePkcs7(fixture('CERT.RSA'));
        expect(block.certificates).toHaveLength(1);
        expect(sha256(block.certificates[0]!)).toBe(RELEASE_SIGNER);
        expect(block.signer).toMatchObject({ digestOid: '2.16.840.1.101.3.4.2.1', signatureOid: '1.2.840.113549.1.1.1', signedAttrs: null });
        expect(block.signer!.signature).toHaveLength(256);
        expect(block.signer!.issuerSerial[0]).toBe(0x30);
        const spki = spkiFromCertificate(block.certificates[0]!);
        expect(spki[0]).toBe(0x30);
        // AlgorithmIdentifier rsaEncryption (1.2.840.113549.1.1.1) opens the key
        expect(Buffer.from(spki.subarray(4, 19)).toString('hex')).toContain('06092a864886f70d010101');
        expect(() => parsePkcs7(fixture('CERT.RSA').subarray(0, 40))).toThrow();
        expect(() => parsePkcs7(fixture('AndroidManifest.xml'))).toThrow();
        expect(() => spkiFromCertificate(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]))).toThrow();
    });

    it('reads the central directory and extracts stored and deflated entries', async () => {
        for (const deflate of [false, true]) {
            const zip = new Uint8Array(makeFakeApk({ deflate }));
            const entries = readCentralDirectory(zip);
            expect(entries.map((e) => e.name)).toEqual(['META-INF/MANIFEST.MF', 'AndroidManifest.xml', 'classes.dex', 'META-INF/CERT.SF', 'META-INF/CERT.RSA']);
            const manifest = entries.find((e) => e.name === 'AndroidManifest.xml')!;
            expect(manifest).toMatchObject({ size: 4724, method: deflate ? 8 : 0 });
            expect(await extractEntry(p, zip, manifest)).toEqual(fixture('AndroidManifest.xml'));
        }
        expect(() => readCentralDirectory(new Uint8Array(100))).toThrow(/not a zip/);
        const zip64 = new Uint8Array(makeZip([{ name: 'a', data: new Uint8Array(4) }]));
        new DataView(zip64.buffer).setUint32(zip64.length - 6, 0xffffffff, true);
        expect(() => readCentralDirectory(zip64)).toThrow('zip64 archives are not supported');
        expect((await inspectApk(p, zip64)).problems).toEqual(['zip64 archives are not supported']);
    });

    it('refuses an unsigned APK, a non-zip, and zips that are not Android packages', async () => {
        const unsigned = await inspectApk(p, fixture('tiny.apk'));
        expect(unsigned).toMatchObject({ v1Verified: false, signerSha256: null, packageName: PLAYER_PACKAGE, minSdk: 19, homeLauncher: true, problems: [NOT_SIGNED] });
        expect(acceptApk(unsigned)).toEqual({ ok: false, refusal: `the APK is not a valid Android package: ${NOT_SIGNED}` });

        const garbage = await inspectApk(p, new Uint8Array(Array.from({ length: 4096 }, (_, i) => i % 256)));
        expect(garbage).toMatchObject({ packageName: null, signerSha256: null, v1Verified: false, minSdk: null, homeLauncher: false, entries: [] });
        expect(garbage.problems).toEqual(['not a zip archive (no end of central directory record)']);
        expect(acceptApk(garbage)).toEqual({ ok: false, refusal: 'the APK is not a valid Android package: not a zip archive (no end of central directory record)' });

        const empty = await inspectApk(p, new Uint8Array(makeZip([{ name: 'META-INF/MANIFEST.MF', data: new Uint8Array(1) }])));
        expect(empty.problems).toEqual(['AndroidManifest.xml is missing', 'classes.dex is missing', 'META-INF/MANIFEST.MF could not be parsed', NOT_SIGNED]);
        expect(acceptApk(empty)).toEqual({ ok: false, refusal: `the APK is not a valid Android package: AndroidManifest.xml is missing; classes.dex is missing; META-INF/MANIFEST.MF could not be parsed; ${NOT_SIGNED}` });

        const badManifest = makeZip([
            { name: 'AndroidManifest.xml', data: enc.encode('<manifest/>') },
            { name: 'classes.dex', data: new Uint8Array(8) },
        ]);
        expect((await inspectApk(p, new Uint8Array(badManifest))).problems).toEqual(['AndroidManifest.xml names no package', NOT_SIGNED]);
    });

    it('never throws: unsupported methods and encrypted entries are problems, each reported once', async () => {
        const zip = fixture('signed-apksigner.apk');
        const at = centralEntryOffset(zip, 'AndroidManifest.xml');
        const methodPatched = zip.slice();
        new DataView(methodPatched.buffer).setUint16(at + 10, 12, true);
        expect((await inspectApk(p, methodPatched)).problems).toEqual(['AndroidManifest.xml uses compression method 12, which is not supported']);
        const encrypted = zip.slice();
        new DataView(encrypted.buffer).setUint16(at + 8, 1, true);
        const report: ApkInspection = await inspectApk(p, encrypted);
        expect(report.problems).toEqual(['AndroidManifest.xml is encrypted']);
    });
});

describe('v1 verification', () => {
    for (const name of PLAYER_FIXTURES) {
        it(`accepts ${name}`, async () => {
            const report = await inspectApk(p, fixture(name));
            expect(report).toMatchObject({ packageName: PLAYER_PACKAGE, signerSha256: SIGNER_A, v1Verified: true, minSdk: 19, homeLauncher: true, problems: [] });
            expect(acceptApk(report)).toEqual({ ok: true, packageName: PLAYER_PACKAGE, signerSha256: SIGNER_A });
            // apksigner signs the .SF directly; jarsigner signs attributes carrying its digest: both paths are exercised.
            const signer = parsePkcs7(entryBytes(fixture(name), 'META-INF/KEY-A.RSA')).signer!;
            expect(signer.signedAttrs === null).toBe(name === 'signed-apksigner.apk');
        });
    }

    it('accepts signed-other-key.apk under its own signer', async () => {
        const report = await inspectApk(p, fixture('signed-other-key.apk'));
        expect(report).toMatchObject({ v1Verified: true, signerSha256: SIGNER_B, problems: [] });
        expect(acceptApk(report)).toEqual({ ok: true, packageName: PLAYER_PACKAGE, signerSha256: SIGNER_B });
    });

    // signed-apksigner.apk and signed-other-key.apk share a byte-identical MANIFEST.MF, so adding KEY-B's
    // .SF and .RSA to the first gives a genuine two-signer APK: `apksigner verify --min-sdk-version 19 -v`
    // on exactly this composition reported "Number of signers: 2" (2026-11-04, build-tools 37.0.0).
    it('refuses an APK with two v1 signers (composed from the two apksigner fixtures; apksigner verify reports "Number of signers: 2")', async () => {
        const other = fixture('signed-other-key.apk');
        const two = editApk(fixture('signed-apksigner.apk'), { add: [
            { name: 'META-INF/KEY-B.SF', data: entryBytes(other, 'META-INF/KEY-B.SF'), deflate: true },
            { name: 'META-INF/KEY-B.RSA', data: entryBytes(other, 'META-INF/KEY-B.RSA'), deflate: true },
        ] });
        const report = await inspectApk(p, two);
        expect(report).toMatchObject({ v1Verified: false, signerSha256: null });
        expect(report.problems).toContain('the APK has 2 v1 signers (KEY-A, KEY-B); exactly one is required');
        expect(acceptApk(report).ok).toBe(false);
    });

    it('refuses a PKCS#7 block with two SignerInfos', async () => {
        const apk = fixture('signed-apksigner.apk');
        const block = withTwoSigners(entryBytes(apk, 'META-INF/KEY-A.RSA'));
        expect(parsePkcs7(block).signerCount).toBe(2);
        const report = await inspectApk(p, editApk(apk, { replace: { 'META-INF/KEY-A.RSA': block } }));
        expect(report).toMatchObject({ v1Verified: false, signerSha256: null });
        expect(report.problems).toContain('META-INF/KEY-A.RSA has 2 signers; exactly one is required');
    });

    // Android 4.4's JarVerifier verifies every block and keys the chain by the .SF name, so the last block
    // processed wins: the app cannot know which signer Android would use.
    it('refuses one .SF with both an .RSA and a .DSA block (two signature blocks)', async () => {
        const apk = fixture('signed-apksigner.apk');
        const report = await inspectApk(p, editApk(apk, { add: [{ name: 'META-INF/KEY-A.DSA', data: new Uint8Array([0x30, 0x00]), deflate: true }] }));
        expect(report).toMatchObject({ v1Verified: false, signerSha256: null });
        expect(report.problems).toContain('META-INF/KEY-A has 2 signature blocks; exactly one is required');
        expect(acceptApk(report).ok).toBe(false);
    });

    it('refuses one .SF with an .RSA, a .DSA and an .ec block (extension matched case-insensitively)', async () => {
        const apk = fixture('signed-apksigner.apk');
        const report = await inspectApk(p, editApk(apk, { add: [
            { name: 'META-INF/KEY-A.DSA', data: new Uint8Array([0x30, 0x00]), deflate: true },
            { name: 'META-INF/KEY-A.ec', data: new Uint8Array([0x30, 0x00]), deflate: true },
        ] }));
        expect(report).toMatchObject({ v1Verified: false, signerSha256: null });
        expect(report.problems).toContain('META-INF/KEY-A has 3 signature blocks; exactly one is required');
    });

    // Android's ZipFile refuses an archive with two entries of one name (the 2013 "master key" fix), and
    // apksigner reports "Duplicate entry: META-INF/KEY-A.RSA" on exactly this composition. The verifier
    // used to look up the first entry of a name and so saw one signer where Android sees a broken archive.
    it('refuses duplicate zip entry names: a second META-INF/KEY-A.RSA, and a second classes.dex', async () => {
        const apk = fixture('signed-apksigner.apk');
        const twoBlocks = editApk(apk, { add: [{ name: 'META-INF/KEY-A.RSA', data: entryBytes(apk, 'META-INF/KEY-A.RSA'), deflate: true }] });
        expect(() => readCentralDirectory(twoBlocks)).toThrow('duplicate zip entry META-INF/KEY-A.RSA; Android refuses the archive');
        const report = await inspectApk(p, twoBlocks);
        expect(report).toMatchObject({ v1Verified: false, signerSha256: null });
        expect(report.problems).toEqual(['duplicate zip entry META-INF/KEY-A.RSA; Android refuses the archive']);
        expect(acceptApk(report).ok).toBe(false);

        const twoDex = editApk(apk, { add: [{ name: 'classes.dex', data: new Uint8Array(112).fill(0x42), deflate: true }] });
        expect((await inspectApk(p, twoDex)).problems).toEqual(['duplicate zip entry classes.dex; Android refuses the archive']);
    });

    // Every block of a .SF is counted, whatever the case of its extension, and every .SF is a signer, whatever
    // the case of its name: a block or a signature file that differs only by case is one too many.
    it('refuses signature entries that differ only by case: META-INF/key-a.rsa beside KEY-A.RSA, and a key-a.SF pair', async () => {
        const apk = fixture('signed-apksigner.apk');
        const caseBlock = await inspectApk(p, editApk(apk, { add: [{ name: 'META-INF/key-a.rsa', data: entryBytes(apk, 'META-INF/KEY-A.RSA'), deflate: true }] }));
        expect(caseBlock).toMatchObject({ v1Verified: false, signerSha256: null });
        expect(caseBlock.problems).toContain('META-INF/KEY-A has 2 signature blocks; exactly one is required');

        const casePair = await inspectApk(p, editApk(apk, { add: [
            { name: 'META-INF/key-a.SF', data: entryBytes(apk, 'META-INF/KEY-A.SF'), deflate: true },
            { name: 'META-INF/key-a.RSA', data: entryBytes(apk, 'META-INF/KEY-A.RSA'), deflate: true },
        ] }));
        expect(casePair).toMatchObject({ v1Verified: false, signerSha256: null });
        expect(casePair.problems).toContain('the APK has 2 v1 signers (KEY-A, key-a); exactly one is required');
        expect(acceptApk(casePair).ok).toBe(false);
    });

    it('parsePkcs7 reports the signer count of the real player block', () => {
        expect(parsePkcs7(fixture('CERT.RSA')).signerCount).toBe(1);
    });

    it.skipIf(!existsSync(releaseApk))('accepts the real release APK when it is built', async () => {
        const report = await inspectApk(p, new Uint8Array(readFileSync(releaseApk)));
        expect(report.problems).toEqual([]);
        expect(report).toMatchObject({ packageName: PLAYER_PACKAGE, v1Verified: true, signerSha256: RELEASE_SIGNER, minSdk: 19, homeLauncher: true });
        expect(report.entries).toEqual(expect.arrayContaining(['AndroidManifest.xml', 'classes.dex', 'META-INF/MANIFEST.MF', 'META-INF/CERT.SF', 'META-INF/CERT.RSA']));
        expect(acceptApk(report)).toEqual({ ok: true, packageName: PLAYER_PACKAGE, signerSha256: RELEASE_SIGNER });
    });

    it('refuses the other-package fixture', async () => {
        const report = await inspectApk(p, fixture('signed-other-package.apk'));
        expect(report).toMatchObject({ packageName: 'app.studiopocket.playex', v1Verified: true, signerSha256: SIGNER_A, problems: [] });
        expect(acceptApk(report)).toEqual({ ok: false, refusal: 'the APK is app.studiopocket.playex, not the Studio Pocket player (app.studiopocket.player)' });
    });

    for (const name of PLAYER_FIXTURES) {
        it(`refuses a tampered classes.dex (${name})`, async () => {
            const report = await inspectApk(p, editApk(fixture(name), { replace: { 'classes.dex': new Uint8Array(112).fill(0x42) } }));
            expect(report.problems).toEqual(['classes.dex does not match its MANIFEST.MF digest']);
            expect(acceptApk(report)).toEqual({ ok: false, refusal: 'the APK is not a valid Android package: classes.dex does not match its MANIFEST.MF digest' });
        });

        it(`refuses an entry MANIFEST.MF does not cover (${name})`, async () => {
            const report = await inspectApk(p, editApk(fixture(name), { add: [{ name: 'assets/extra.bin', data: new Uint8Array([1, 2, 3]) }] }));
            expect(report.problems).toEqual(['assets/extra.bin is not covered by MANIFEST.MF']);
        });

        it(`refuses a swapped signature block (${name})`, async () => {
            const report = await inspectApk(p, editApk(fixture(name), { replace: { 'META-INF/KEY-A.RSA': fixture('CERT.RSA') } }));
            expect(report).toMatchObject({ v1Verified: false, signerSha256: null, problems: ['META-INF/KEY-A.RSA signature does not verify'] });
        });

        it(`refuses a .SF edited after signing (${name})`, async () => {
            const sf = new TextDecoder().decode(entryBytes(fixture(name), 'META-INF/KEY-A.SF'));
            const edited = enc.encode(sf.replace('Signature-Version: 1.0\r\n', 'Signature-Version: 1.0\r\nX-Note: edited\r\n'));
            const report = await inspectApk(p, editApk(fixture(name), { replace: { 'META-INF/KEY-A.SF': edited } }));
            expect(report.problems).toEqual(['META-INF/KEY-A.RSA signature does not verify']);
        });

        it(`refuses an APK without a .SF (${name})`, async () => {
            const report = await inspectApk(p, editApk(fixture(name), { remove: ['META-INF/KEY-A.SF'] }));
            expect(report).toMatchObject({ v1Verified: false, signerSha256: null, problems: [NOT_SIGNED] });
        });

        it(`refuses a DSA/EC signature block (${name})`, async () => {
            const zip = fixture(name);
            const report = await inspectApk(p, editApk(zip, { remove: ['META-INF/KEY-A.RSA'], add: [{ name: 'META-INF/KEY-A.DSA', data: entryBytes(zip, 'META-INF/KEY-A.RSA') }] }));
            expect(report.problems).toEqual(['META-INF/KEY-A is signed with DSA/EC; only RSA signatures are accepted', NOT_SIGNED]);
        });

        it(`refuses an entry added together with its MANIFEST.MF section, which the .SF does not name (${name})`, async () => {
            const zip = fixture(name);
            const extra = new Uint8Array([1, 2, 3]);
            const manifest = concat(entryBytes(zip, 'META-INF/MANIFEST.MF'), crlf([`Name: assets/extra.bin`, `SHA-256-Digest: ${b64(extra)}`, '']));
            const report = await inspectApk(p, editApk(zip, { replace: { 'META-INF/MANIFEST.MF': manifest }, add: [{ name: 'assets/extra.bin', data: extra }] }));
            expect(report.problems).toEqual(['META-INF/KEY-A.SF does not match MANIFEST.MF']);
        });

        it(`verifies when only the per-section .SF digests match (${name})`, async () => {
            // A section for a file that is not in the APK changes the whole-file digest; Android ignores the section.
            const zip = fixture(name);
            const manifest = concat(entryBytes(zip, 'META-INF/MANIFEST.MF'), crlf(['Name: not/in/the/apk.txt', `SHA-256-Digest: ${b64(new Uint8Array(1))}`, '']));
            const report = await inspectApk(p, editApk(zip, { replace: { 'META-INF/MANIFEST.MF': manifest } }));
            expect(report).toMatchObject({ v1Verified: true, signerSha256: SIGNER_A, problems: [] });
        });
    }

    it('refuses an EC certificate in a .RSA block, even on a platform whose verifier would take it', async () => {
        // apksigner's block signs the .SF directly with signature OID rsaEncryption; swap in an EC key
        // and an ECDSA signature over the same .SF, keeping issuer, serial and every OID.
        const zip = fixture('signed-apksigner.apk');
        const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const ecSpki = new Uint8Array(ec.publicKey.export({ format: 'der', type: 'spki' }));
        const sf = entryBytes(zip, 'META-INF/KEY-A.SF');
        const block = withSignerKey(entryBytes(zip, 'META-INF/KEY-A.RSA'), ecSpki, new Uint8Array(sign('sha256', sf, ec.privateKey)));
        // The rewrite keeps the rest of the block: the original key and signature still verify after a round trip.
        const original = entryBytes(zip, 'META-INF/KEY-A.RSA');
        const parsed = parsePkcs7(original);
        expect(withSignerKey(original, spkiFromCertificate(parsed.certificates[0]!), parsed.signer!.signature)).toEqual(original);
        expect(spkiFromCertificate(parsePkcs7(block).certificates[0]!)).toEqual(ecSpki);

        const ecApk = editApk(zip, { replace: { 'META-INF/KEY-A.RSA': block } });
        const refused = { v1Verified: false, signerSha256: null, problems: ['META-INF/KEY-A.RSA signature does not verify'] };
        expect(await inspectApk(p, ecApk)).toMatchObject(refused);
        // A verifier that takes any key type (node:crypto's default) must not change the outcome.
        const permissive = { ...p, verifyRsaPkcs1: async (spki: Uint8Array, hash: 'sha1' | 'sha256', data: Uint8Array, signature: Uint8Array) =>
            verify(hash, data, createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' }), signature) };
        expect(await permissive.verifyRsaPkcs1(ecSpki, 'sha256', sf, parsePkcs7(block).signer!.signature)).toBe(true);
        expect(await inspectApk(permissive, ecApk)).toMatchObject(refused);
    });

    it('refuses a changed main section when the per-section path is taken', async () => {
        // apksigner's .SF has no main-attributes digest, so an extra main attribute still verifies per section;
        // jarsigner's has one (SHA-256-Digest-Manifest-Main-Attributes), which Android checks.
        const addToMain = (zip: Uint8Array): Uint8Array => {
            const mf = new TextDecoder().decode(entryBytes(zip, 'META-INF/MANIFEST.MF'));
            return editApk(zip, { replace: { 'META-INF/MANIFEST.MF': enc.encode(mf.replace('Manifest-Version: 1.0\r\n', 'Manifest-Version: 1.0\r\nX-Note: added\r\n')) } });
        };
        expect((await inspectApk(p, addToMain(fixture('signed-apksigner.apk')))).problems).toEqual([]);
        expect((await inspectApk(p, addToMain(fixture('signed-jarsigner.apk')))).problems).toEqual(['META-INF/KEY-A.SF does not match MANIFEST.MF']);
    });

    it("refuses the reviewer's APK-shaped zip", async () => {
        const report = await inspectApk(p, new Uint8Array(makeFakeApk({ dex: new Uint8Array([1, 2, 3]) })));
        expect(report.v1Verified).toBe(false);
        expect(report.signerSha256).toBeNull();
        expect(report.problems).toEqual([
            'AndroidManifest.xml is not covered by MANIFEST.MF',
            'classes.dex is not covered by MANIFEST.MF',
            'META-INF/CERT.SF does not match MANIFEST.MF',
        ]);
        expect(acceptApk(report).ok).toBe(false);
    });

    it('parses CRLF and LF manifests: sections, continuation lines, and section bytes through the blank line', () => {
        for (const eol of ['\r\n', '\n']) {
            const text = ['Manifest-Version: 1.0', 'Created-By: x', '', 'Name: a/very/long/path/that/wraps/onto/the/next/line/because/jar/manifests/are/wr', ' apped.bin', 'SHA-256-Digest: AAAA', '', 'Name: b.txt', 'SHA1-Digest: BBBB', ''].join(eol) + eol;
            const parsed = parseJarManifest(enc.encode(text));
            expect(parsed.main.get('Manifest-Version')).toBe('1.0');
            expect(parsed.main.get('Created-By')).toBe('x');
            expect(parsed.sections.map((s) => s.name)).toEqual(['a/very/long/path/that/wraps/onto/the/next/line/because/jar/manifests/are/wrapped.bin', 'b.txt']);
            expect(parsed.sections[0]!.attrs.get('SHA-256-Digest')).toBe('AAAA');
            expect(parsed.sections[1]!.attrs.get('SHA1-Digest')).toBe('BBBB');
            expect(new TextDecoder().decode(parsed.sections[1]!.bytes)).toBe(['Name: b.txt', 'SHA1-Digest: BBBB', '', ''].join(eol));
            expect(new TextDecoder().decode(parsed.sections[0]!.bytes)).toBe(text.slice(text.indexOf('Name: a/'), text.indexOf('Name: b.txt')));
            expect(new TextDecoder().decode(parsed.mainBytes)).toBe(['Manifest-Version: 1.0', 'Created-By: x', '', ''].join(eol));
        }
        // the string form decodes the same way
        expect(parseJarManifest('Manifest-Version: 1.0\r\n\r\nName: c\r\nSHA-256-Digest: C\r\n\r\n').sections[0]!.name).toBe('c');
    });

    it('reads a final line that has no line ending, as an attribute of the last section through the end of the bytes', () => {
        const text = 'Manifest-Version: 1.0\r\n\r\nName: c\r\nSHA-256-Digest: C';
        const parsed = parseJarManifest(text);
        expect(parsed.sections).toHaveLength(1);
        expect(parsed.sections[0]!.attrs.get('SHA-256-Digest')).toBe('C');
        expect(new TextDecoder().decode(parsed.sections[0]!.bytes)).toBe('Name: c\r\nSHA-256-Digest: C');
        expect(new TextDecoder().decode(parsed.mainBytes)).toBe('Manifest-Version: 1.0\r\n\r\n');
        // A main section alone, and a continuation as the unterminated last line.
        expect(parseJarManifest('Manifest-Version: 1.0').main.get('Manifest-Version')).toBe('1.0');
        expect(parseJarManifest('Manifest-Version: 1.0\n\nName: lo\n ng').sections[0]!.name).toBe('long');
    });

    it('reads minSdk and HOME from the binary manifest and from rewritten copies', () => {
        const manifest = fixture('AndroidManifest.xml');
        expect(readAndroidManifest(manifest)).toEqual({ packageName: PLAYER_PACKAGE, minSdk: 19, homeLauncher: true });
        const elements = walkBinaryXml(manifest)!.elements;
        expect(elements[0]!.name).toBe('manifest');
        expect(elements.some((e) => e.name === 'intent-filter')).toBe(true);
        const usesSdk = elements.find((e) => e.name === 'uses-sdk')!;
        expect(usesSdk.attrs.find((a) => a.resId === 0x0101020c)?.value).toBe(19);

        // uses-sdk: minSdkVersion then targetSdkVersion (attributes sorted by resource id), both TYPE_INT_DEC 19.
        const ints = indexesOf(manifest, [8, 0, 0, 0x10, 19, 0, 0, 0]);
        expect(ints).toHaveLength(2);
        const min21 = manifest.slice(); min21[ints[0]! + 4] = 21;
        expect(readAndroidManifest(min21)).toMatchObject({ minSdk: 21, homeLauncher: true });
        const target21 = manifest.slice(); target21[ints[1]! + 4] = 21;
        expect(readAndroidManifest(target21)).toMatchObject({ minSdk: 19 });

        const home = indexesOf(manifest, [...Buffer.from('android.intent.category.HOME', 'utf16le')]);
        expect(home).toHaveLength(1);
        const noHome = manifest.slice();
        noHome.set(Buffer.from('X', 'utf16le'), home[0]! + 'android.intent.category.'.length * 2);
        expect(readAndroidManifest(noHome)).toEqual({ packageName: PLAYER_PACKAGE, minSdk: 19, homeLauncher: false });

        // no uses-sdk element: Android's default of 1
        expect(readAndroidManifest(utf8Manifest('app.studiopocket.player'))).toEqual({ packageName: PLAYER_PACKAGE, minSdk: 1, homeLauncher: false });
    });

    it('counts a HOME intent-filter only inside an activity or activity-alias', () => {
        // The fixture's HOME filter sits in an activity.
        const elements = walkBinaryXml(fixture('AndroidManifest.xml'))!.elements;
        const filter = elements.findIndex((e) => e.name === 'intent-filter');
        expect(elements[elements[filter]!.parent]!.name).toBe('activity');
        expect(hasHomeLauncher(elements)).toBe(true);

        const ATTR_NAME = 0x01010003;
        const tree = (owner: string, category = 'android.intent.category.HOME') => [
            { name: 'manifest', parent: -1, attrs: [] },
            { name: 'application', parent: 0, attrs: [] },
            { name: owner, parent: 1, attrs: [] },
            { name: 'intent-filter', parent: 2, attrs: [] },
            { name: 'category', parent: 3, attrs: [{ name: 'name', resId: ATTR_NAME, value: category }] },
        ];
        expect(hasHomeLauncher(tree('activity'))).toBe(true);
        expect(hasHomeLauncher(tree('activity-alias'))).toBe(true);
        expect(hasHomeLauncher(tree('receiver'))).toBe(false);
        expect(hasHomeLauncher(tree('service'))).toBe(false);
        expect(hasHomeLauncher(tree('activity', 'android.intent.category.LAUNCHER'))).toBe(false);
        // An intent-filter straight under application (or at the root) is no activity's.
        expect(hasHomeLauncher(tree('activity').filter((_, i) => i !== 2).map((e, i) => (i >= 2 ? { ...e, parent: e.parent - 1 } : e)))).toBe(false);
        expect(hasHomeLauncher([
            { name: 'intent-filter', parent: -1, attrs: [] },
            { name: 'category', parent: 0, attrs: [{ name: 'name', resId: ATTR_NAME, value: 'android.intent.category.HOME' }] },
        ])).toBe(false);
    });

    it('acceptApk refuses minSdk 21 and a missing HOME category, after the signature and the package', () => {
        const good: ApkInspection = { packageName: PLAYER_PACKAGE, signerSha256: SIGNER_A, v1Verified: true, minSdk: 19, homeLauncher: true, entries: [], problems: [] };
        expect(acceptApk(good)).toEqual({ ok: true, packageName: PLAYER_PACKAGE, signerSha256: SIGNER_A });
        expect(acceptApk({ ...good, minSdk: 21 })).toEqual({ ok: false, refusal: 'the APK needs Android API 21; the player runs API 19' });
        expect(acceptApk({ ...good, homeLauncher: false })).toEqual({ ok: false, refusal: 'the APK has no HOME launcher activity, so the player would start with no launcher' });
        expect(acceptApk({ ...good, minSdk: 21, homeLauncher: false, packageName: 'x.y' })).toEqual({ ok: false, refusal: 'the APK is x.y, not the Studio Pocket player (app.studiopocket.player)' });
        expect(acceptApk({ ...good, v1Verified: false, packageName: 'x.y' })).toEqual({ ok: false, refusal: 'the APK is not signed with a verified v1 (JAR) signature, which Android 4.4 requires' });
        expect(acceptApk({ ...good, signerSha256: null })).toEqual({ ok: false, refusal: 'the APK is not signed with a verified v1 (JAR) signature, which Android 4.4 requires' });
        expect(acceptApk({ ...good, v1Verified: false, problems: ['p1', 'p2'] })).toEqual({ ok: false, refusal: 'the APK is not a valid Android package: p1; p2' });
    });
});

const b64 = (data: Uint8Array): string => createHash('sha256').update(data).digest('base64');
const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

function indexesOf(haystack: Uint8Array, needle: number[]): number[] {
    const found: number[] = [];
    for (let i = 0; i + needle.length <= haystack.length; i++) if (needle.every((b, j) => haystack[i + j] === b)) found.push(i);
    return found;
}

/** Offset of a named entry's central directory header. */
function centralEntryOffset(zip: Uint8Array, name: string): number {
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let pos = v.getUint32(zip.length - 6, true);
    for (;;) {
        const nameLen = v.getUint16(pos + 28, true);
        if (new TextDecoder().decode(zip.subarray(pos + 46, pos + 46 + nameLen)) === name) return pos;
        pos += 46 + nameLen + v.getUint16(pos + 30, true) + v.getUint16(pos + 32, true);
    }
}

/** A one-element binary XML document with a UTF-8 string pool: <manifest package="…"/>. */
function utf8Manifest(pkg: string): Uint8Array {
    const strings = ['manifest', 'package', pkg];
    const enc = new TextEncoder();
    const data: number[] = [];
    const offsets: number[] = [];
    for (const s of strings) {
        offsets.push(data.length);
        const b = enc.encode(s);
        data.push(s.length, b.length, ...b, 0);
    }
    while (data.length % 4) data.push(0);
    const poolHeader = 28;
    const poolSize = poolHeader + offsets.length * 4 + data.length;
    const elemSize = 36 + 20;
    const total = 8 + poolSize + elemSize;
    const out = new Uint8Array(total);
    const v = new DataView(out.buffer);
    v.setUint16(0, 0x0003, true); v.setUint16(2, 8, true); v.setUint32(4, total, true);
    let o = 8;
    v.setUint16(o, 0x0001, true); v.setUint16(o + 2, poolHeader, true); v.setUint32(o + 4, poolSize, true);
    v.setUint32(o + 8, strings.length, true); v.setUint32(o + 12, 0, true); v.setUint32(o + 16, 1 << 8, true);
    v.setUint32(o + 20, poolHeader + offsets.length * 4, true); v.setUint32(o + 24, 0, true);
    offsets.forEach((off, i) => v.setUint32(o + poolHeader + i * 4, off, true));
    out.set(data, o + poolHeader + offsets.length * 4);
    o += poolSize;
    v.setUint16(o, 0x0102, true); v.setUint16(o + 2, 16, true); v.setUint32(o + 4, elemSize, true);
    v.setUint32(o + 8, 1, true); v.setUint32(o + 12, 0xffffffff, true);
    v.setUint32(o + 16, 0xffffffff, true); v.setUint32(o + 20, 0, true);
    v.setUint16(o + 24, 20, true); v.setUint16(o + 26, 20, true); v.setUint16(o + 28, 1, true);
    const a = o + 36;
    v.setUint32(a, 0xffffffff, true); v.setUint32(a + 4, 1, true); v.setUint32(a + 8, 2, true);
    v.setUint16(a + 12, 8, true); out[a + 15] = 0x03; v.setUint32(a + 16, 2, true);
    return out;
}
