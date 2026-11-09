import type { SyncFs } from './fs.js';
import { type DeviceInfo } from './device.js';
import { type SyncPlan, type TransferRequest } from './plan.js';
import { type ApplyOptions, type ApplyResult } from './apply.js';
import type { DeviceMarker } from '@studio-pocket/library-format';
export declare const nodeSyncFs: SyncFs;
/** Node conveniences: the functions above bound to the Node file system, with plain paths. */
export declare const inspectDevice: (volume: string) => Promise<DeviceInfo>;
export declare const ensureDeviceMarker: (volume: string, createdBy: string) => Promise<DeviceMarker>;
export declare const writeAtomic: (file: string, data: string | Uint8Array) => Promise<void>;
export declare const planTransfer: (root: string, request: TransferRequest, options?: {
    verifyHashes?: boolean;
}) => Promise<SyncPlan>;
export declare const applySync: (plan: SyncPlan, options: ApplyOptions) => Promise<ApplyResult>;
