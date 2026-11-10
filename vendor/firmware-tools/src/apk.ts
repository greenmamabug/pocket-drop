// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

import type { FirmwarePlatform } from './platform.js';

/**
 * What the replacement APK is, read from its bytes before it is written into a system image:
 * the ZIP central directory; the binary AndroidManifest.xml (package, minSdkVersion, whether it
 * has a HOME launcher); and its v1 (JAR) signature, verified the way Android 4.4 and apksig's
 * V1SchemeVerifier do (entry digests in MANIFEST.MF, the .SF over MANIFEST.MF, the PKCS#7 RSA
 * signature over the .SF). Android 4.4 checks nothing but v1, so neither does this. Inflating,
 * hashing and RSA go through the platform, so this also runs in the desktop's webview.
 */
export const PLAYER_PACKAGE = 'app.studiopocket.player';
/** The API level of the player's Android (4.4). */
export const PLAYER_API = 19;

export interface ApkInspection {
    /** From the binary AndroidManifest.xml `package` attribute. */
    packageName: string | null;
    /** SHA-256 of the certificate of the APK's single v1 signer; null unless the APK has exactly one signature pair whose single SignerInfo verified. */
    signerSha256: string | null;
    /** True when the APK's only META-INF/*.SF + *.RSA pair, with one SignerInfo, verified against MANIFEST.MF. */
    v1Verified: boolean;
    /** `uses-sdk` minSdkVersion (1 when absent); null when the manifest could not be read or the value is not a number (both are problems). */
    minSdk: number | null;
    /** Some activity (or activity-alias) intent-filter has category android.intent.category.HOME. */
    homeLauncher: boolean;
    entries: string[];
    problems: string[];
}

export interface ZipEntry {
    name: string;
    /** Offset of the entry's local file header. */
    offset: number;
    compressedSize: number;
    size: number;
    method: number;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const utf8 = new TextDecoder('utf-8');

/** The central directory, found from the end-of-central-directory record. Throws with the problem. */
export function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
    const v = view(bytes);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
        if (v.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip archive (no end of central directory record)');
    const count = v.getUint16(eocd + 10, true);
    const cdSize = v.getUint32(eocd + 12, true);
    const cdOffset = v.getUint32(eocd + 16, true);
    const zip64Locator = eocd >= 20 && v.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIG;
    if (zip64Locator || count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported');
    if (v.getUint16(eocd + 4, true) !== 0 || v.getUint16(eocd + 6, true) !== 0) throw new Error('multi-disk zip archives are not supported');
    if (cdOffset + cdSize > eocd) throw new Error('the zip central directory lies outside the file');

    const entries: ZipEntry[] = [];
    const seen = new Set<string>();
    let pos = cdOffset;
    for (let n = 0; n < count; n++) {
        if (pos + 46 > eocd || v.getUint32(pos, true) !== CENTRAL_SIG) throw new Error('the zip central directory is damaged');
        const flags = v.getUint16(pos + 8, true);
        const nameLen = v.getUint16(pos + 28, true);
        const extraLen = v.getUint16(pos + 30, true);
        const commentLen = v.getUint16(pos + 32, true);
        const name = utf8.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
        if (flags & 0x1) throw new Error(`${name} is encrypted`);
        // Android's ZipFile throws on a repeated name (the 2013 "master key" fix), so such an archive never
        // installs; a lookup by name here must never have two entries to choose from either.
        if (seen.has(name)) throw new Error(`duplicate zip entry ${name}; Android refuses the archive`);
        seen.add(name);
        // Sizes come from here, so entries with data descriptors (flag bit 3) need nothing more.
        entries.push({
            name,
            offset: v.getUint32(pos + 42, true),
            compressedSize: v.getUint32(pos + 20, true),
            size: v.getUint32(pos + 24, true),
            method: v.getUint16(pos + 10, true),
        });
        pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/** One entry's uncompressed bytes (stored or deflated only). Throws with the problem. */
export async function extractEntry(p: FirmwarePlatform, bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
    if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name} uses compression method ${entry.method}, which is not supported`);
    const v = view(bytes);
    if (entry.offset + 30 > bytes.length || v.getUint32(entry.offset, true) !== LOCAL_SIG) throw new Error(`${entry.name}: local header not found`);
    const start = entry.offset + 30 + v.getUint16(entry.offset + 26, true) + v.getUint16(entry.offset + 28, true);
    if (start + entry.compressedSize > bytes.length) throw new Error(`${entry.name} runs past the end of the file`);
    const raw = bytes.subarray(start, start + entry.compressedSize);
    const data = entry.method === 0 ? raw : await p.inflateRaw(raw).catch(() => { throw new Error(`${entry.name} could not be decompressed`); });
    if (data.length !== entry.size) throw new Error(`${entry.name} is ${data.length} B, the zip says ${entry.size} B`);
    return data;
}

interface Tlv { tag: number; start: number; contentStart: number; end: number }

/** One DER tag-length-value at `pos`, bounded by `limit`; null when it does not fit. */
function readTlv(der: Uint8Array, pos: number, limit: number): Tlv | null {
    if (pos + 2 > limit) return null;
    const tag = der[pos]!;
    let len = der[pos + 1]!;
    let contentStart = pos + 2;
    if (len & 0x80) {
        const octets = len & 0x7f;
        if (octets === 0 || octets > 4 || contentStart + octets > limit) return null; // indefinite length is not DER
        len = 0;
        for (let i = 0; i < octets; i++) len = len * 256 + der[contentStart + i]!;
        contentStart += octets;
    }
    const end = contentStart + len;
    return end > limit ? null : { tag, start: pos, contentStart, end };
}

/** The TLV at `pos` with tag `tag`; throws naming `what` otherwise. */
function needTlv(der: Uint8Array, pos: number, limit: number, tag: number, what: string): Tlv {
    const t = readTlv(der, pos, limit);
    if (!t || t.tag !== tag) throw new Error(`${what} is malformed`);
    return t;
}

/** Every TLV inside a constructed one; throws when they do not fill it exactly. */
function childrenOf(der: Uint8Array, parent: Tlv, what: string): Tlv[] {
    const out: Tlv[] = [];
    let pos = parent.contentStart;
    while (pos < parent.end) {
        const t = readTlv(der, pos, parent.end);
        if (!t) throw new Error(`${what} is malformed`);
        out.push(t);
        pos = t.end;
    }
    return out;
}

const bytesOf = (der: Uint8Array, t: Tlv): Uint8Array => der.subarray(t.start, t.end);

function oidOf(der: Uint8Array, t: Tlv | undefined, what: string): string {
    if (!t || t.tag !== 0x06 || t.end === t.contentStart) throw new Error(`${what} is malformed`);
    const arcs: number[] = [];
    let value = 0;
    for (let i = t.contentStart; i < t.end; i++) {
        value = value * 128 + (der[i]! & 0x7f);
        if (der[i]! & 0x80) continue;
        if (arcs.length === 0) arcs.push(value < 40 ? 0 : value < 80 ? 1 : 2, value < 80 ? value % 40 : value - 80);
        else arcs.push(value);
        value = 0;
    }
    return arcs.join('.');
}

/** The OID of an AlgorithmIdentifier SEQUENCE { algorithm OID, parameters ANY OPTIONAL }. */
const algorithmOf = (der: Uint8Array, t: Tlv | undefined, what: string): string => {
    if (!t || t.tag !== 0x30) throw new Error(`${what} is malformed`);
    return oidOf(der, childrenOf(der, t, what)[0], what);
};

const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_RSA = '1.2.840.113549.1.1.1';
const HASH_BY_DIGEST_OID: Record<string, 'sha1' | 'sha256'> = { '1.3.14.3.2.26': 'sha1', '2.16.840.1.101.3.4.2.1': 'sha256' };
const HASH_BY_SIGNATURE_OID: Record<string, 'sha1' | 'sha256'> = { '1.2.840.113549.1.1.5': 'sha1', '1.2.840.113549.1.1.11': 'sha256' };

export interface Pkcs7Signer {
    /** DER of the SignerInfo's sid (issuerAndSerialNumber SEQUENCE). */
    issuerSerial: Uint8Array;
    digestOid: string;
    /** DER of the `[0] IMPLICIT` signed attributes, tag byte included; null for a direct signature. */
    signedAttrs: Uint8Array | null;
    signatureOid: string;
    signature: Uint8Array;
}

/**
 * A PKCS#7 SignedData block (META-INF/*.RSA): ContentInfo { signedData OID, [0] SignedData {
 * version, digestAlgorithms, contentInfo, [0] certificates, [1] crls OPTIONAL, signerInfos } },
 * with the first SignerInfo { version, sid, digestAlgorithm, [0] signedAttrs OPTIONAL,
 * signatureAlgorithm, signature } and the number of SignerInfos. Throws when the block does not have that shape.
 */
export function parsePkcs7(der: Uint8Array): { certificates: Uint8Array[]; signer: Pkcs7Signer | null; signerCount: number } {
    const what = 'the PKCS#7 signature block';
    const outer = needTlv(der, 0, der.length, 0x30, what);
    const [oid, explicit] = childrenOf(der, outer, what);
    if (oidOf(der, oid, what) !== OID_SIGNED_DATA || !explicit || explicit.tag !== 0xa0) throw new Error(`${what} is not PKCS#7 SignedData`);
    const signedData = needTlv(der, explicit.contentStart, explicit.end, 0x30, what);
    const items = childrenOf(der, signedData, what);
    let i = 0;
    if (items[i++]?.tag !== 0x02 || items[i++]?.tag !== 0x31 || items[i++]?.tag !== 0x30) throw new Error(`${what} is malformed`);
    const certificates: Uint8Array[] = [];
    if (items[i]?.tag === 0xa0) {
        for (const c of childrenOf(der, items[i]!, what)) if (c.tag === 0x30) certificates.push(bytesOf(der, c));
        i++;
    }
    if (items[i]?.tag === 0xa1) i++;
    const signerInfos = items[i];
    if (!signerInfos || signerInfos.tag !== 0x31) throw new Error(`${what} has no signerInfos`);
    const signers = childrenOf(der, signerInfos, what);
    const signerCount = signers.length;
    const first = signers[0];
    if (!first) return { certificates, signer: null, signerCount };
    if (first.tag !== 0x30) throw new Error(`${what} is malformed`);
    const f = childrenOf(der, first, what);
    let j = 0;
    if (f[j++]?.tag !== 0x02) throw new Error(`${what} is malformed`);
    const sid = f[j++];
    if (!sid) throw new Error(`${what} is malformed`);
    const digestOid = algorithmOf(der, f[j++], what);
    const signedAttrs = f[j]?.tag === 0xa0 ? bytesOf(der, f[j++]!) : null;
    const signatureOid = algorithmOf(der, f[j++], what);
    const signature = f[j];
    if (!signature || signature.tag !== 0x04) throw new Error(`${what} is malformed`);
    return { certificates, signer: { issuerSerial: bytesOf(der, sid), digestOid, signedAttrs, signatureOid, signature: der.subarray(signature.contentStart, signature.end) }, signerCount };
}

/** TBSCertificate { [0] version OPTIONAL, serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo, … } of an X.509 certificate. */
function certificateFields(der: Uint8Array): { serial: Uint8Array; issuer: Uint8Array; spki: Uint8Array } {
    const what = 'the signing certificate';
    const cert = needTlv(der, 0, der.length, 0x30, what);
    const tbs = childrenOf(der, cert, what)[0];
    if (!tbs || tbs.tag !== 0x30) throw new Error(`${what} is malformed`);
    const f = childrenOf(der, tbs, what);
    const i = f[0]?.tag === 0xa0 ? 1 : 0;
    const [serial, , issuer, , , spki] = f.slice(i);
    if (serial?.tag !== 0x02 || issuer?.tag !== 0x30 || spki?.tag !== 0x30) throw new Error(`${what} is malformed`);
    return { serial: bytesOf(der, serial), issuer: bytesOf(der, issuer), spki: bytesOf(der, spki) };
}

/** The SubjectPublicKeyInfo DER of an X.509 certificate. Throws when the certificate is malformed. */
export function spkiFromCertificate(der: Uint8Array): Uint8Array {
    return certificateFields(der).spki;
}

/** The algorithm OID of a SubjectPublicKeyInfo { AlgorithmIdentifier, BIT STRING }. */
function keyAlgorithmOf(spki: Uint8Array): string {
    const what = 'the public key';
    return algorithmOf(spki, childrenOf(spki, needTlv(spki, 0, spki.length, 0x30, what), what)[0], what);
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The certificate the SignerInfo names by issuer and serial number (DER compared), if any. */
function signerCertificate(certificates: Uint8Array[], issuerSerial: Uint8Array): Uint8Array | null {
    const sid = needTlv(issuerSerial, 0, issuerSerial.length, 0x30, 'the signer id');
    const [issuer, serial] = childrenOf(issuerSerial, sid, 'the signer id');
    if (issuer?.tag !== 0x30 || serial?.tag !== 0x02) return null;
    for (const cert of certificates) {
        const c = certificateFields(cert);
        if (sameBytes(c.issuer, bytesOf(issuerSerial, issuer)) && sameBytes(c.serial, bytesOf(issuerSerial, serial))) return cert;
    }
    return null;
}

/** The messageDigest attribute's OCTET STRING among the signed attributes, if present. */
function messageDigestOf(signedAttrs: Uint8Array): Uint8Array | null {
    const what = 'the signed attributes';
    const set = needTlv(signedAttrs, 0, signedAttrs.length, 0xa0, what);
    for (const attr of childrenOf(signedAttrs, set, what)) {
        const [oid, values] = childrenOf(signedAttrs, attr, what);
        if (oidOf(signedAttrs, oid, what) !== OID_MESSAGE_DIGEST || values?.tag !== 0x31) continue;
        const value = childrenOf(signedAttrs, values, what)[0];
        return value?.tag === 0x04 ? signedAttrs.subarray(value.contentStart, value.end) : null;
    }
    return null;
}

/**
 * Verifies a PKCS#7 block's first signer over the .SF bytes: with signed attributes, their
 * messageDigest must be the .SF's digest and the RSA signature covers the attributes re-tagged
 * as a SET; without, the signature covers the .SF itself. The certificate's key must be
 * rsaEncryption. Returns the signer's certificate DER,
 * or null when anything does not verify (never throws).
 */
export async function verifyPkcs7Signature(p: FirmwarePlatform, sf: Uint8Array, block: Uint8Array): Promise<Uint8Array | null> {
    try {
        const { certificates, signer } = parsePkcs7(block);
        if (!signer) return null;
        const cert = signerCertificate(certificates, signer.issuerSerial);
        if (!cert) return null;
        const digestHash = HASH_BY_DIGEST_OID[signer.digestOid];
        const signatureHash = HASH_BY_SIGNATURE_OID[signer.signatureOid] ?? (signer.signatureOid === OID_RSA ? digestHash : undefined);
        if (!digestHash || !signatureHash) return null;
        let signed = sf;
        if (signer.signedAttrs) {
            const expected = messageDigestOf(signer.signedAttrs);
            if (!expected || !sameBytes(expected, await p.digestBytes(digestHash, sf))) return null;
            signed = signer.signedAttrs.slice();
            signed[0] = 0x31;
        }
        // RSASSA-PKCS1-v1_5 only: a certificate with any other key type (EC, DSA, RSA-PSS) does not verify, as on Android 4.4.
        const spki = spkiFromCertificate(cert);
        if (keyAlgorithmOf(spki) !== OID_RSA) return null;
        return (await p.verifyRsaPkcs1(spki, signatureHash, signed, signer.signature)) ? cert : null;
    } catch {
        return null;
    }
}

export interface JarManifestSection { name: string; attrs: Map<string, string>; bytes: Uint8Array }
export interface JarManifest {
    main: Map<string, string>;
    /** The main section as written, through its terminating blank line. */
    mainBytes: Uint8Array;
    /** The `Name:` sections, each with its bytes as written from the `Name:` line through its terminating blank line. */
    sections: JarManifestSection[];
}

/**
 * A JAR manifest (MANIFEST.MF or a .SF): sections separated by blank lines, lines ending in
 * CRLF, LF or CR, continuation lines starting with one space. The main section comes first;
 * later sections without a `Name` are ignored. Throws on a line that is not `Key: value`.
 */
export function parseJarManifest(input: Uint8Array | string): JarManifest {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const sections: { attrs: Map<string, string>; start: number; end: number }[] = [];
    let current: { attrs: Map<string, Uint8Array[]>; start: number } | null = null;
    let lastKey: string | null = null;
    const close = (end: number): void => {
        if (!current) return;
        const attrs = new Map<string, string>();
        for (const [k, parts] of current.attrs) attrs.set(k, utf8.decode(concatBytes(parts)));
        sections.push({ attrs, start: current.start, end });
        current = null;
        lastKey = null;
    };
    let pos = 0;
    while (pos < bytes.length) {
        let eol = pos;
        while (eol < bytes.length && bytes[eol] !== 0x0a && bytes[eol] !== 0x0d) eol++;
        const next = eol >= bytes.length ? eol : bytes[eol] === 0x0d && bytes[eol + 1] === 0x0a ? eol + 2 : eol + 1;
        const line = bytes.subarray(pos, eol);
        if (line.length === 0) {
            close(next);
        } else if (line[0] === 0x20) {
            if (!current || lastKey === null) throw new Error('a manifest continuation line follows nothing');
            current.attrs.get(lastKey)!.push(line.subarray(1));
        } else {
            const colon = line.indexOf(0x3a);
            if (colon <= 0 || line[colon + 1] !== 0x20) throw new Error('a manifest line is not "Key: value"');
            current ??= { attrs: new Map(), start: pos };
            lastKey = utf8.decode(line.subarray(0, colon));
            current.attrs.set(lastKey, [line.subarray(colon + 2)]);
        }
        pos = next;
    }
    close(bytes.length);
    const [main, ...rest] = sections;
    return {
        main: main?.attrs ?? new Map(),
        mainBytes: main ? bytes.subarray(main.start, main.end) : new Uint8Array(0),
        sections: rest.flatMap((s) => {
            const name = attribute(s.attrs, 'Name');
            return name === undefined ? [] : [{ name, attrs: s.attrs, bytes: bytes.subarray(s.start, s.end) }];
        }),
    };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let at = 0;
    for (const x of parts) { out.set(x, at); at += x.length; }
    return out;
}

/** A manifest attribute by name; attribute names are case-insensitive. */
function attribute(attrs: Map<string, string>, name: string): string | undefined {
    for (const [k, v] of attrs) if (k.toLowerCase() === name.toLowerCase()) return v;
    return undefined;
}

function base64Bytes(text: string): Uint8Array | null {
    try {
        const binary = atob(text.trim());
        return Uint8Array.from(binary, (c) => c.charCodeAt(0));
    } catch {
        return null;
    }
}

/**
 * Checks `SHA-256<suffix>` / `SHA1<suffix>` attributes against `data`: null when neither is
 * present, true when every one present matches.
 */
async function digestsMatch(p: FirmwarePlatform, attrs: Map<string, string>, suffix: string, data: Uint8Array): Promise<boolean | null> {
    let seen = false;
    for (const [algorithm, hash] of [['SHA-256', 'sha256'], ['SHA1', 'sha1']] as const) {
        const value = attribute(attrs, `${algorithm}${suffix}`);
        if (value === undefined) continue;
        seen = true;
        const expected = base64Bytes(value);
        if (!expected || !sameBytes(expected, await p.digestBytes(hash, data))) return false;
    }
    return seen ? true : null;
}

/**
 * Whether a .SF signs this MANIFEST.MF: it names every entry the APK must sign (Android 4.4
 * leaves an entry no .SF names unsigned), and either its whole-manifest digest matches or
 * (Android's fallback) the main-attributes digest, when present, and every named section's
 * digest (at least one) match the manifest's sections as written.
 */
async function signatureFileMatches(p: FirmwarePlatform, sfBytes: Uint8Array, manifestBytes: Uint8Array, manifest: JarManifest, required: string[]): Promise<boolean> {
    const sf = parseJarManifest(sfBytes);
    const named = new Set(sf.sections.map((s) => s.name));
    if (required.some((name) => !named.has(name))) return false;
    if ((await digestsMatch(p, sf.main, '-Digest-Manifest', manifestBytes)) === true) return true;
    if ((await digestsMatch(p, sf.main, '-Digest-Manifest-Main-Attributes', manifest.mainBytes)) === false || sf.sections.length === 0) return false;
    for (const s of sf.sections) {
        const m = manifest.sections.find((x) => x.name === s.name);
        if (!m || (await digestsMatch(p, s.attrs, '-Digest', m.bytes)) !== true) return false;
    }
    return true;
}

const RES_STRING_POOL = 0x0001;
const RES_XML = 0x0003;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_END_ELEMENT = 0x0103;
const RES_XML_RESOURCE_MAP = 0x0180;
const UTF8_FLAG = 1 << 8;
const TYPE_STRING = 0x03;
const TYPE_FIRST_INT = 0x10;
const TYPE_LAST_INT = 0x1f;
const NO_ENTRY = 0xffffffff;
const ATTR_NAME = 0x01010003;
const ATTR_MIN_SDK_VERSION = 0x0101020c;
const CATEGORY_HOME = 'android.intent.category.HOME';

/** Strings of a ResStringPool chunk at `chunk` (UTF-8 or UTF-16). */
function readStringPool(bytes: Uint8Array, chunk: number): (index: number) => string | null {
    const v = view(bytes);
    const headerSize = v.getUint16(chunk + 2, true);
    const count = v.getUint32(chunk + 8, true);
    const isUtf8 = (v.getUint32(chunk + 16, true) & UTF8_FLAG) !== 0;
    const stringsStart = chunk + v.getUint32(chunk + 20, true);
    return (index) => {
        if (index >= count) return null;
        let at = stringsStart + v.getUint32(chunk + headerSize + index * 4, true);
        if (isUtf8) {
            // utf16 length (skipped), then utf8 byte length; each 1 byte, or 2 with the high bit set
            at += bytes[at]! & 0x80 ? 2 : 1;
            let len = bytes[at]!;
            if (len & 0x80) { len = ((len & 0x7f) << 8) | bytes[at + 1]!; at += 2; } else at += 1;
            if (at + len > bytes.length) return null;
            return utf8.decode(bytes.subarray(at, at + len));
        }
        let len = v.getUint16(at, true);
        if (len & 0x8000) { len = ((len & 0x7fff) << 16) | v.getUint16(at + 2, true); at += 4; } else at += 2;
        if (at + len * 2 > bytes.length) return null;
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint16(at + i * 2, true));
        return s;
    };
}

export interface BinaryXmlAttribute {
    name: string;
    /** Android resource id of the attribute name (from the resource map), 0 when it has none. */
    resId: number;
    /** A string (raw or TYPE_STRING), an integer (TYPE_INT_*), or null for any other type. */
    value: string | number | null;
}
export interface BinaryXmlElement {
    name: string;
    /** Index of the enclosing element in `elements`, -1 at the root. */
    parent: number;
    attrs: BinaryXmlAttribute[];
}

/**
 * Every element of a compiled (binary) XML document, in document order: the string pool, the
 * resource map, and each START_ELEMENT with its attributes. Null when the bytes are not
 * binary XML or are damaged.
 */
export function walkBinaryXml(bytes: Uint8Array): { elements: BinaryXmlElement[] } | null {
    try {
        const v = view(bytes);
        if (v.getUint16(0, true) !== RES_XML) return null;
        let pos = v.getUint16(2, true);
        const end = Math.min(bytes.length, v.getUint32(4, true));
        let str: ((index: number) => string | null) | null = null;
        let resourceIds: number[] = [];
        const elements: BinaryXmlElement[] = [];
        const open: number[] = [];
        while (pos + 8 <= end) {
            const type = v.getUint16(pos, true);
            const headerSize = v.getUint16(pos + 2, true);
            const size = v.getUint32(pos + 4, true);
            if (size < 8 || pos + size > end) return null;
            if (type === RES_STRING_POOL && !str) str = readStringPool(bytes, pos);
            if (type === RES_XML_RESOURCE_MAP) {
                resourceIds = [];
                for (let at = pos + headerSize; at + 4 <= pos + size; at += 4) resourceIds.push(v.getUint32(at, true));
            }
            if (type === RES_XML_START_ELEMENT) {
                if (!str) return null;
                const ext = pos + headerSize;
                const attrStart = v.getUint16(ext + 8, true);
                const attrSize = v.getUint16(ext + 10, true);
                const attrCount = v.getUint16(ext + 12, true);
                const attrs: BinaryXmlAttribute[] = [];
                for (let i = 0; i < attrCount; i++) {
                    const a = ext + attrStart + i * attrSize;
                    const nameIndex = v.getUint32(a + 4, true);
                    const raw = v.getUint32(a + 8, true);
                    const dataType = bytes[a + 15]!;
                    const data = v.getUint32(a + 16, true);
                    const value = raw !== NO_ENTRY ? str(raw)
                        : dataType === TYPE_STRING ? str(data)
                        : dataType >= TYPE_FIRST_INT && dataType <= TYPE_LAST_INT ? data | 0
                        : null;
                    attrs.push({ name: str(nameIndex) ?? '', resId: resourceIds[nameIndex] ?? 0, value });
                }
                elements.push({ name: str(v.getUint32(ext + 4, true)) ?? '', parent: open.at(-1) ?? -1, attrs });
                open.push(elements.length - 1);
            }
            if (type === RES_XML_END_ELEMENT) open.pop();
            pos += size;
        }
        return { elements };
    } catch {
        return null;
    }
}

/**
 * What the installer needs from a compiled AndroidManifest.xml: the `manifest` element's
 * `package`; `uses-sdk` minSdkVersion (1 when absent, as Android defaults it; null when it is
 * not a number); and whether some activity's intent-filter carries category android.intent.category.HOME.
 */
export function readAndroidManifest(bytes: Uint8Array): { packageName: string | null; minSdk: number | null; homeLauncher: boolean } {
    const doc = walkBinaryXml(bytes);
    if (!doc) return { packageName: null, minSdk: null, homeLauncher: false };
    const { elements } = doc;
    const pkg = elements.find((e) => e.name === 'manifest')?.attrs.find((a) => a.name === 'package')?.value;
    let minSdk: number | null = 1;
    const declared = elements.find((e) => e.name === 'uses-sdk')?.attrs.find((a) => a.resId === ATTR_MIN_SDK_VERSION)?.value;
    if (typeof declared === 'number') minSdk = declared;
    else if (typeof declared === 'string') minSdk = /^\d+$/.test(declared) ? Number(declared) : null;
    else if (declared === null) minSdk = null;
    return { packageName: typeof pkg === 'string' ? pkg : null, minSdk, homeLauncher: hasHomeLauncher(elements) };
}

/** Some `activity` or `activity-alias` has an intent-filter with category android.intent.category.HOME. */
export function hasHomeLauncher(elements: BinaryXmlElement[]): boolean {
    return elements.some((e) => {
        if (e.name !== 'category' || !e.attrs.some((a) => a.resId === ATTR_NAME && a.value === CATEGORY_HOME)) return false;
        const filter = elements[e.parent];
        if (filter?.name !== 'intent-filter') return false;
        const owner = elements[filter.parent]?.name;
        return owner === 'activity' || owner === 'activity-alias';
    });
}

/** The `package` attribute of the `manifest` element of a compiled AndroidManifest.xml; null when absent or not binary XML. */
export function packageNameFromBinaryXml(bytes: Uint8Array): string | null {
    return readAndroidManifest(bytes).packageName;
}

const SIGNATURE_FILE = /^META-INF\/[^/]+\.SF$/i;
const NOT_SIGNED = 'not signed with a v1 (JAR) signature, which Android 4.4 requires';
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Inspects an APK's bytes. Never throws: whatever could not be read or verified is in `problems`. */
export async function inspectApk(p: FirmwarePlatform, bytes: Uint8Array): Promise<ApkInspection> {
    const report: ApkInspection = { packageName: null, signerSha256: null, v1Verified: false, minSdk: null, homeLauncher: false, entries: [], problems: [] };
    const problem = (text: string): void => { if (!report.problems.includes(text)) report.problems.push(text); };
    let entries: ZipEntry[];
    try {
        entries = readCentralDirectory(bytes);
    } catch (e) {
        problem(message(e));
        return report;
    }
    report.entries = entries.map((e) => e.name);
    const find = (name: string): ZipEntry | undefined => entries.find((e) => e.name === name);
    const read = async (entry: ZipEntry): Promise<Uint8Array | null> => {
        try {
            return await extractEntry(p, bytes, entry);
        } catch (e) {
            problem(message(e));
            return null;
        }
    };

    // 1. The binary AndroidManifest.xml.
    const androidManifest = find('AndroidManifest.xml');
    if (!androidManifest) problem('AndroidManifest.xml is missing');
    if (!find('classes.dex')) problem('classes.dex is missing');
    if (androidManifest) {
        const data = await read(androidManifest);
        if (data) {
            const facts = readAndroidManifest(data);
            report.packageName = facts.packageName;
            if (!facts.packageName) problem('AndroidManifest.xml names no package');
            else {
                report.minSdk = facts.minSdk;
                report.homeLauncher = facts.homeLauncher;
                if (facts.minSdk === null) problem('AndroidManifest.xml has a minSdkVersion that is not a number');
            }
        }
    }

    // 2. Every entry outside META-INF/ against its MANIFEST.MF digest.
    const required = entries.filter((e) => !e.name.endsWith('/') && !e.name.startsWith('META-INF/'));
    const manifestEntry = find('META-INF/MANIFEST.MF');
    const manifestBytes = manifestEntry ? await read(manifestEntry) : null;
    let manifest: JarManifest | null = null;
    if (manifestBytes) {
        try {
            manifest = parseJarManifest(manifestBytes);
        } catch {
            problem('META-INF/MANIFEST.MF could not be parsed');
        }
    }
    if (manifest) {
        for (const entry of required) {
            const section = manifest.sections.find((s) => s.name === entry.name);
            if (!section) { problem(`${entry.name} is not covered by MANIFEST.MF`); continue; }
            const data = await read(entry);
            if (data && (await digestsMatch(p, section.attrs, '-Digest', data)) !== true) problem(`${entry.name} does not match its MANIFEST.MF digest`);
        }
    }

    // 3. The signature pairs: each META-INF/<name>.SF with a <name>.RSA, .DSA or .EC block. Exactly one is
    // accepted, an RSA one: the .SF against MANIFEST.MF, a block with one SignerInfo, its signature over the .SF.
    // More pairs are still checked so their own problems appear, but then nothing counts as verified.
    // A .SF with more than one block is refused: Android 4.4's JarVerifier verifies every block and keys the
    // chain by the .SF name, so the last one processed wins and the app cannot know which signer Android uses.
    // Every block is counted, whatever the case of its name (readCentralDirectory has already refused exact
    // duplicates), so a block that differs only by case is one too many rather than the same one.
    // An entry MANIFEST.MF does not cover is already a problem; the .SF must name every one it does.
    const requiredNames = manifest ? required.map((e) => e.name).filter((name) => manifest.sections.some((s) => s.name === name)) : [];
    const pairs = entries.filter((e) => SIGNATURE_FILE.test(e.name)).map((sfEntry) => {
        const base = sfEntry.name.slice(0, -'.SF'.length);
        const upperBase = base.toUpperCase();
        const extensionOf = (e: ZipEntry): string | null =>
            (e.name.length > base.length && e.name.slice(0, base.length).toUpperCase() === upperBase ? e.name.slice(base.length).toUpperCase() : null);
        const blocks = entries.filter((e) => ['.RSA', '.DSA', '.EC'].includes(extensionOf(e) ?? ''));
        const rsa = blocks.find((e) => extensionOf(e) === '.RSA');
        return { sfEntry, base, rsa, blockCount: blocks.length };
    }).filter((pair) => pair.blockCount > 0);
    if (pairs.length > 1) {
        const names = pairs.map((pair) => pair.base.slice('META-INF/'.length)).sort();
        problem(`the APK has ${pairs.length} v1 signers (${names.join(', ')}); exactly one is required`);
    }
    let rsaPairs = 0;
    for (const { sfEntry, base, rsa: block, blockCount } of pairs) {
        if (blockCount !== 1) {
            problem(`${base} has ${blockCount} signature blocks; exactly one is required`);
            if (block) rsaPairs++;
            continue;
        }
        if (!block) {
            problem(`${base} is signed with DSA/EC; only RSA signatures are accepted`);
            continue;
        }
        rsaPairs++;
        const sf = await read(sfEntry);
        if (!sf) continue;
        const sfOk = manifestBytes && manifest ? await signatureFileMatches(p, sf, manifestBytes, manifest, requiredNames).catch(() => false) : false;
        if (!sfOk) { problem(`${sfEntry.name} does not match MANIFEST.MF`); continue; }
        const der = await read(block);
        if (!der) continue;
        let signerCount: number | null = null;
        try {
            signerCount = parsePkcs7(der).signerCount;
        } catch {
            // A malformed block does not verify below.
        }
        if (signerCount !== null && signerCount !== 1) { problem(`${block.name} has ${signerCount} signers; exactly one is required`); continue; }
        const certificate = await verifyPkcs7Signature(p, sf, der);
        if (!certificate) { problem(`${block.name} signature does not verify`); continue; }
        if (pairs.length !== 1) continue;
        report.v1Verified = true;
        report.signerSha256 = await p.sha256Bytes(certificate);
    }
    if (rsaPairs === 0) problem(NOT_SIGNED);
    return report;
}

/** Reads a whole APK through the platform (in 1 MiB reads, the desktop bridge's limit) and inspects it. */
export async function inspectApkFile(p: FirmwarePlatform, file: string): Promise<ApkInspection> {
    const size = (await p.stat(file)).size;
    const bytes = new Uint8Array(size);
    const CHUNK = 1024 * 1024;
    let offset = 0;
    while (offset < size) {
        const part = await p.readBytes(file, offset, Math.min(CHUNK, size - offset));
        if (part.length === 0) break;
        bytes.set(part, offset);
        offset += part.length;
    }
    return inspectApk(p, bytes.subarray(0, offset));
}

/**
 * Whether an inspected APK may be written into a player as Studio Pocket: no problems, a verified
 * v1 signature (all Android 4.4 checks), the player's package, an API level the player runs,
 * and a HOME activity to start. The refusal text is what the installer and the patcher show.
 */
export function acceptApk(i: ApkInspection): { ok: true; packageName: string; signerSha256: string } | { ok: false; refusal: string } {
    if (i.problems.length) return { ok: false, refusal: `the APK is not a valid Android package: ${i.problems.join('; ')}` };
    if (!i.v1Verified || !i.signerSha256) return { ok: false, refusal: 'the APK is not signed with a verified v1 (JAR) signature, which Android 4.4 requires' };
    if (i.packageName !== PLAYER_PACKAGE) return { ok: false, refusal: `the APK is ${i.packageName}, not the Studio Pocket player (${PLAYER_PACKAGE})` };
    if (i.minSdk !== null && i.minSdk > PLAYER_API) return { ok: false, refusal: `the APK needs Android API ${i.minSdk}; the player runs API ${PLAYER_API}` };
    if (!i.homeLauncher) return { ok: false, refusal: 'the APK has no HOME launcher activity, so the player would start with no launcher' };
    return { ok: true, packageName: i.packageName, signerSha256: i.signerSha256 };
}
