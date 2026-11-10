// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import { readFileSync } from 'node:fs';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { readCentralDirectory, type ZipEntry } from '../src/apk.js';

/**
 * Test-only APK bytes. The signed fixtures (test/fixtures/apk/signed-*.apk, see make-fixtures.sh)
 * are real APKs signed by apksigner and jarsigner; the builders here only alter them (one entry
 * replaced, added or removed, everything else byte-for-byte) or build structurally broken zips
 * around the real player manifest and certificate block.
 */
export const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/apk/${name}`, import.meta.url)));

/** SHA-256 of the certificate inside the committed CERT.RSA, the real player's release key (openssl pkcs7 -print_certs | x509 -outform DER | shasum -a 256). */
export const RELEASE_SIGNER = '62f22699150a30627f1ff9fcc2d0fdcf71a2a4e08e87d63c9f31da21b5024a1b';
/** SHA-256 of fixture key A's certificate (signed-apksigner.apk, signed-jarsigner.apk, signed-other-package.apk). */
export const SIGNER_A = '68e6bad93d21efb690f655441f78e1e7268d325f3a95f997ff23b3ec12e0954d';
/** SHA-256 of fixture key B's certificate (signed-other-key.apk). */
export const SIGNER_B = 'ba41b654ad31dd92f7693f50f5902799047014cb4b36acf9fbfe4ca0ae31e7f8';

export interface ZipFile { name: string; data: Uint8Array; deflate?: boolean }

/** A plain zip (no data descriptors, no zip64): local headers, central directory, end record. */
export function makeZip(files: ZipFile[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const f of files) {
        const name = Buffer.from(f.name, 'utf8');
        const body = f.deflate ? deflateRawSync(f.data) : Buffer.from(f.data);
        const method = f.deflate ? 8 : 0;
        const crc = crc32(f.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(f.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(f.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, name, body);
        centrals.push(central, name);
        offset += local.length + name.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, end]);
}

/**
 * The fixture manifest with its package string replaced in the (UTF-16) string pool. Same
 * length only, so no offsets move: 'com.example.launcherapp' is 23 characters like the original.
 */
export function manifestWithPackage(packageName: string): Uint8Array {
    const original = 'app.studiopocket.player';
    if (packageName.length !== original.length) throw new Error(`replacement package must be ${original.length} characters`);
    const bytes = Buffer.from(fixture('AndroidManifest.xml'));
    const needle = Buffer.concat([Buffer.from([original.length, 0]), Buffer.from(original, 'utf16le'), Buffer.from([0, 0])]);
    const at = bytes.indexOf(needle);
    if (at < 0) throw new Error('package string not found in the fixture manifest');
    Buffer.from(packageName, 'utf16le').copy(bytes, at + 2);
    return new Uint8Array(bytes);
}

export interface FakeApkOptions {
    /** classes.dex bytes. */
    dex?: Uint8Array;
    /** Store entries deflated (method 8) instead of stored. */
    deflate?: boolean;
}

/**
 * An APK-shaped zip that is not validly signed: the fixture manifest, classes.dex, and empty
 * MANIFEST.MF / CERT.SF beside the real player's CERT.RSA, which is the shape an outside review
 * used to get an unsigned APK accepted. For the structural tests (stored/deflated, the zip reader).
 */
export function makeFakeApk(options: FakeApkOptions = {}): Buffer {
    const deflate = options.deflate ?? false;
    const dex = options.dex ?? new Uint8Array(Array.from({ length: 150 * 1024 }, (_, i) => (i * 7) % 251));
    return makeZip([
        { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\r\n\r\n'), deflate },
        { name: 'AndroidManifest.xml', data: fixture('AndroidManifest.xml'), deflate },
        { name: 'classes.dex', data: dex, deflate },
        { name: 'META-INF/CERT.SF', data: Buffer.from('Signature-Version: 1.0\r\n\r\n'), deflate },
        { name: 'META-INF/CERT.RSA', data: fixture('CERT.RSA'), deflate },
    ]);
}

export interface ApkEdit {
    /** Entries whose bytes are replaced (stored deflated, like the rest). */
    replace?: Record<string, Uint8Array>;
    /** Entries appended at the end. */
    add?: ZipFile[];
    /** Entries left out. */
    remove?: string[];
}

/**
 * A signed fixture with one change: every entry not named in `edit` keeps its uncompressed bytes
 * exactly (META-INF included), and the zip is rewritten deflated in the original order.
 */
export function editApk(source: Uint8Array, edit: ApkEdit): Uint8Array {
    const files: ZipFile[] = [];
    for (const e of readCentralDirectory(source)) {
        if (edit.remove?.includes(e.name)) continue;
        files.push({ name: e.name, data: edit.replace?.[e.name] ?? inflated(source, e), deflate: true });
    }
    files.push(...(edit.add ?? []));
    return new Uint8Array(makeZip(files));
}

/** One entry of a zip, uncompressed. */
export function entryBytes(zip: Uint8Array, name: string): Uint8Array {
    const e = readCentralDirectory(zip).find((x) => x.name === name);
    if (!e) throw new Error(`${name} is not in the zip`);
    return inflated(zip, e);
}

function inflated(zip: Uint8Array, e: ZipEntry): Uint8Array {
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
    const raw = zip.subarray(start, start + e.compressedSize);
    return e.method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw.slice();
}

/** A DER node: constructed nodes (tag bit 0x20) keep their children, primitive ones their content. */
interface DerNode { tag: number; content: Uint8Array; children: DerNode[] | null }

function parseDer(b: Uint8Array, pos = 0, end = b.length): DerNode[] {
    const out: DerNode[] = [];
    while (pos < end) {
        const tag = b[pos++]!;
        let len = b[pos++]!;
        if (len & 0x80) {
            const n = len & 0x7f;
            if (n === 0 || n > 4) throw new Error('unsupported DER length');
            len = 0;
            for (let i = 0; i < n; i++) len = len * 256 + b[pos++]!;
        }
        const content = b.subarray(pos, pos + len);
        out.push({ tag, content, children: tag & 0x20 ? parseDer(b, pos, pos + len) : null });
        pos += len;
    }
    return out;
}

function encodeDer(node: DerNode): Uint8Array {
    const content = node.children ? Buffer.concat(node.children.map(encodeDer)) : Buffer.from(node.content);
    const n = content.length;
    const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
    return new Uint8Array(Buffer.concat([Buffer.from([node.tag, ...len]), content]));
}

/**
 * A PKCS#7 signature block with its first certificate's subjectPublicKeyInfo replaced by `spki`
 * and its first signer's signature by `signature`; issuer, serial and every OID stay as they were.
 */
export function withSignerKey(block: Uint8Array, spki: Uint8Array, signature: Uint8Array): Uint8Array {
    const [contentInfo] = parseDer(block);
    const signedData = contentInfo!.children![1]!.children![0]!;
    const certs = signedData.children!.find((c) => c.tag === 0xa0)!;
    const tbs = certs.children![0]!.children![0]!;
    const at = (tbs.children![0]!.tag === 0xa0 ? 1 : 0) + 5;
    tbs.children![at] = parseDer(spki)[0]!;
    const signerInfo = signedData.children!.at(-1)!.children![0]!;
    const sig = signerInfo.children!.at(-1)!;
    if (sig.tag !== 0x04) throw new Error('signer has no signature');
    sig.content = signature;
    return encodeDer(contentInfo!);
}

/**
 * A PKCS#7 signature block whose signerInfos SET holds its single SignerInfo twice; every enclosing
 * length (the SET, SignedData, the [0] explicit tag, the outer ContentInfo) is re-encoded.
 */
export function withTwoSigners(block: Uint8Array): Uint8Array {
    const [contentInfo] = parseDer(block);
    const signedData = contentInfo!.children![1]!.children![0]!;
    const signerInfos = signedData.children!.at(-1)!;
    if (signerInfos.tag !== 0x31 || signerInfos.children!.length !== 1) throw new Error('expected a block with one SignerInfo');
    signerInfos.children!.push(signerInfos.children![0]!);
    return encodeDer(contentInfo!);
}
