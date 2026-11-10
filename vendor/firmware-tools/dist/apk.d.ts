import type { FirmwarePlatform } from './platform.js';
/**
 * What the replacement APK is, read from its bytes before it is written into a system image:
 * the ZIP central directory; the binary AndroidManifest.xml (package, minSdkVersion, whether it
 * has a HOME launcher); and its v1 (JAR) signature, verified the way Android 4.4 and apksig's
 * V1SchemeVerifier do (entry digests in MANIFEST.MF, the .SF over MANIFEST.MF, the PKCS#7 RSA
 * signature over the .SF). Android 4.4 checks nothing but v1, so neither does this. Inflating,
 * hashing and RSA go through the platform, so this also runs in the desktop's webview.
 */
export declare const PLAYER_PACKAGE = "app.studiopocket.player";
/** The API level of the player's Android (4.4). */
export declare const PLAYER_API = 19;
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
/** The central directory, found from the end-of-central-directory record. Throws with the problem. */
export declare function readCentralDirectory(bytes: Uint8Array): ZipEntry[];
/** One entry's uncompressed bytes (stored or deflated only). Throws with the problem. */
export declare function extractEntry(p: FirmwarePlatform, bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array>;
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
export declare function parsePkcs7(der: Uint8Array): {
    certificates: Uint8Array[];
    signer: Pkcs7Signer | null;
    signerCount: number;
};
/** The SubjectPublicKeyInfo DER of an X.509 certificate. Throws when the certificate is malformed. */
export declare function spkiFromCertificate(der: Uint8Array): Uint8Array;
/**
 * Verifies a PKCS#7 block's first signer over the .SF bytes: with signed attributes, their
 * messageDigest must be the .SF's digest and the RSA signature covers the attributes re-tagged
 * as a SET; without, the signature covers the .SF itself. The certificate's key must be
 * rsaEncryption. Returns the signer's certificate DER,
 * or null when anything does not verify (never throws).
 */
export declare function verifyPkcs7Signature(p: FirmwarePlatform, sf: Uint8Array, block: Uint8Array): Promise<Uint8Array | null>;
export interface JarManifestSection {
    name: string;
    attrs: Map<string, string>;
    bytes: Uint8Array;
}
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
export declare function parseJarManifest(input: Uint8Array | string): JarManifest;
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
export declare function walkBinaryXml(bytes: Uint8Array): {
    elements: BinaryXmlElement[];
} | null;
/**
 * What the installer needs from a compiled AndroidManifest.xml: the `manifest` element's
 * `package`; `uses-sdk` minSdkVersion (1 when absent, as Android defaults it; null when it is
 * not a number); and whether some activity's intent-filter carries category android.intent.category.HOME.
 */
export declare function readAndroidManifest(bytes: Uint8Array): {
    packageName: string | null;
    minSdk: number | null;
    homeLauncher: boolean;
};
/** Some `activity` or `activity-alias` has an intent-filter with category android.intent.category.HOME. */
export declare function hasHomeLauncher(elements: BinaryXmlElement[]): boolean;
/** The `package` attribute of the `manifest` element of a compiled AndroidManifest.xml; null when absent or not binary XML. */
export declare function packageNameFromBinaryXml(bytes: Uint8Array): string | null;
/** Inspects an APK's bytes. Never throws: whatever could not be read or verified is in `problems`. */
export declare function inspectApk(p: FirmwarePlatform, bytes: Uint8Array): Promise<ApkInspection>;
/** Reads a whole APK through the platform (in 1 MiB reads, the desktop bridge's limit) and inspects it. */
export declare function inspectApkFile(p: FirmwarePlatform, file: string): Promise<ApkInspection>;
/**
 * Whether an inspected APK may be written into a player as Studio Pocket: no problems, a verified
 * v1 signature (all Android 4.4 checks), the player's package, an API level the player runs,
 * and a HOME activity to start. The refusal text is what the installer and the patcher show.
 */
export declare function acceptApk(i: ApkInspection): {
    ok: true;
    packageName: string;
    signerSha256: string;
} | {
    ok: false;
    refusal: string;
};
