/**
 * Parser for the MediaTek "MTK_PLATFORM_CFG" scatter file (V1.1.x YAML-like format)
 * shipped inside the stock rom_y2.zip. Only the fields the installer needs are read.
 */
export interface ScatterGeneral {
    configVersion: string;
    platform: string;
    project: string;
    storage: string;
}
export interface ScatterPartition {
    index: number;
    name: string;
    fileName: string | null;
    isDownload: boolean;
    type: string;
    linearStart: number;
    physicalStart: number;
    size: number;
    region: string;
    operationType: string;
}
export interface Scatter {
    general: ScatterGeneral;
    partitions: ScatterPartition[];
}
export declare class ScatterError extends Error {
}
export declare function parseScatter(text: string): Scatter;
export declare function findPartition(scatter: Scatter, name: string): ScatterPartition | undefined;
