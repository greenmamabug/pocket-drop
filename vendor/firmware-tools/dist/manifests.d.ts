import { type FirmwareManifest } from './manifest.js';
/** The stock builds Studio Pocket can identify: hashes and partition maps, checked by parseManifest. */
export declare function bundledManifests(): FirmwareManifest[];
export declare function bundledManifest(firmwareVersion: string): FirmwareManifest;
