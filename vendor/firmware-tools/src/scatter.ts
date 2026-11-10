// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Ashworth Digital Ltd
// This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
// commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

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

export class ScatterError extends Error {}

const hex = (value: string | undefined, field: string): number => {
    if (value === undefined || !/^0x[0-9a-fA-F]+$/.test(value)) throw new ScatterError(`${field}: expected hex, got ${value}`);
    return Number.parseInt(value, 16);
};

export function parseScatter(text: string): Scatter {
    const lines = text.split(/\r?\n/);
    const general: Record<string, string> = {};
    const partitions: ScatterPartition[] = [];
    let current: Record<string, string> | null = null;
    let inGeneral = false;

    const flush = () => {
        if (!current) return;
        const index = current.partition_index?.match(/^SYS(\d+)$/)?.[1];
        if (index === undefined) throw new ScatterError(`bad partition_index ${current.partition_index}`);
        const name = current.partition_name;
        if (!name) throw new ScatterError('partition without partition_name');
        partitions.push({
            index: Number(index),
            name,
            fileName: current.file_name && current.file_name !== 'NONE' ? current.file_name : null,
            isDownload: current.is_download === 'true',
            type: current.type ?? '',
            linearStart: hex(current.linear_start_addr, `${name}.linear_start_addr`),
            physicalStart: hex(current.physical_start_addr, `${name}.physical_start_addr`),
            size: hex(current.partition_size, `${name}.partition_size`),
            region: current.region ?? '',
            operationType: current.operation_type ?? '',
        });
        current = null;
    };

    for (const raw of lines) {
        const line = raw.replace(/#.*$/, '').trimEnd();
        if (!line.trim()) continue;
        if (/^- general:/.test(line)) { inGeneral = true; continue; }
        const partitionStart = line.match(/^- partition_index:\s*(\S+)/);
        if (partitionStart) {
            flush();
            inGeneral = false;
            current = { partition_index: partitionStart[1] ?? '' };
            continue;
        }
        const kv = line.match(/^\s*-?\s*([A-Za-z_]+):\s*(.*)$/);
        if (!kv) continue;
        const [, key, value] = kv;
        if (!key) continue;
        if (current) current[key] = (value ?? '').trim();
        else if (inGeneral) general[key] = (value ?? '').trim();
    }
    flush();

    for (const field of ['config_version', 'platform', 'project', 'storage']) {
        if (!general[field]) throw new ScatterError(`general.${field} missing`);
    }
    if (!partitions.length) throw new ScatterError('no partitions found');
    return {
        general: {
            configVersion: general.config_version ?? '',
            platform: general.platform ?? '',
            project: general.project ?? '',
            storage: general.storage ?? '',
        },
        partitions,
    };
}

export function findPartition(scatter: Scatter, name: string): ScatterPartition | undefined {
    return scatter.partitions.find((p) => p.name === name);
}
