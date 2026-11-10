export interface ManifestFile {
    sha256: string;
    sizeBytes: number;
    format?: string;
}
export interface ManifestPartition {
    index: number;
    name: string;
    file: string | null;
    physicalStart: string;
    size: string;
    region?: string;
    op: string;
    download: boolean;
    studioPocketTouches: boolean;
    note?: string;
}
export interface FirmwareManifest {
    device: string;
    firmwareVersion: string;
    source: {
        url: string;
        asset: string;
        sha256: string;
        sizeBytes: number;
        note?: string;
    };
    platform: {
        soc: string;
        mediatekProject: string;
        android: string;
        apiLevel: number;
        buildId: string;
        buildFingerprint: string;
        swVersion?: string;
        customBuildVersion?: string;
        fmRadio?: boolean;
    };
    files: Record<string, ManifestFile>;
    partitions: ManifestPartition[];
    linearAddressOffset: string;
    stockLauncher: {
        path: string;
        package: string;
        versionName: string;
        homeActivity: string;
        sizeBytes: number;
        sha256?: string;
    };
}
export declare class ManifestError extends Error {
}
/** Parses and sanity-checks a firmware manifest (src/manifests/*.json). */
export declare function parseManifest(text: string): FirmwareManifest;
/**
 * Structural invariants every manifest must satisfy. These are the rules the
 * installer relies on, so they are checked here rather than trusted.
 */
export declare function validateManifest(manifest: FirmwareManifest): void;
export declare function targetPartition(manifest: FirmwareManifest): ManifestPartition;
