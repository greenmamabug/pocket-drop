// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';

export function readOnlyPlan(report, unitId, folder, daFile, count = 32) {
  const area = report?.layout?.android,
    length = 4 * 1024 ** 2;
  if (
    report?.state !== 'studiopocket' ||
    report.unitId !== unitId ||
    !/^[a-f0-9]{32}$/.test(unitId) ||
    !report?.layout?.trustedForWrite ||
    !Number.isSafeInteger(area?.start) ||
    area.start < 0 ||
    !Number.isSafeInteger(area.size) ||
    area.size < length ||
    !Number.isSafeInteger(area.start + area.size) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 32
  )
    throw new Error(
      'A complete player-specific backup with a measured layout is needed for this read-only test.',
    );
  const names = Array.from({ length: count }, (_, index) => `connection-read-${index}.bin`);
  return {
    id: 'connection-test',
    dir: folder,
    daFile,
    lines: names.map((name) => `ro 0x${area.start.toString(16)} 0x${length.toString(16)} ${name}`),
    files: names.map((name) => path.join(folder, name)),
    length,
  };
}

async function serialPorts() {
  try {
    return (await fs.readdir('/dev'))
      .filter((name) => /^cu\.usb(?:modem|serial)[\w-]*$/.test(name))
      .slice(0, 20);
  } catch {
    return [];
  }
}

export async function testPlayerConnection({
  platform,
  api,
  firmwareDir,
  unitId,
  folder,
  log,
  emit,
  count = 32,
}) {
  const report = await api.loadUpgradeReadReport(platform, firmwareDir, unitId);
  const daFile = await api.ensureDownloadAgent(platform, firmwareDir, log);
  const plan = readOnlyPlan(report, unitId, folder, daFile, count);
  const before = await serialPorts(),
    startedAt = Date.now(),
    lines = [];
  let completed = 0,
    firstReadAt = null;
  log('Read-only USB test: reads only. No firmware write commands and no new backup.');
  emit({
    label: 'Waiting for player — press the reset pinhole with the cable connected',
    percent: null,
    connectionPhase: 'waiting',
  });
  const result = await platform.runMtk(
    plan,
    (line) => {
      lines.push(String(line));
      if (lines.length > 100) lines.shift();
      log(line);
      const progress = api.parseMtkLine(line);
      if (!progress) return;
      if (progress.phase === 'read' && firstReadAt === null) firstReadAt = Date.now();
      if (progress.phase === 'done' && /Dumped offset/.test(line)) completed++;
      emit({
        label:
          progress.phase === 'waiting'
            ? 'Waiting for player — press the reset pinhole with the cable connected'
            : progress.phase === 'handshake'
              ? 'Player detected — starting read-only test'
              : `Testing USB connection — reads ${completed} of ${count}`,
        connectionPhase: progress.phase,
        missed: !!progress.missed,
        percent:
          progress.phase === 'read'
            ? Math.min(100, ((completed + (progress.percent ?? 0) / 100) / count) * 100)
            : null,
      });
    },
    { expectCid: unitId },
  );
  const after = await serialPorts();
  log('Serial ports before test: ' + (before.join(', ') || 'none'));
  log('Serial ports after test: ' + (after.join(', ') || 'none'));
  if (result.code !== 0 || completed !== count)
    throw new Error(
      'The read-only USB connection test did not finish. No firmware was written by this test. The earlier update is still incomplete.\n\n' +
        lines.slice(-25).join('\n') +
        '\nSerial ports after test: ' +
        (after.join(', ') || 'none'),
    );
  for (const file of plan.files) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== plan.length)
      throw new Error(
        'The read-only test received incomplete data. No firmware was written by this test; the earlier update remains incomplete.',
      );
  }
  return {
    passed: true,
    bytesRead: plan.length * count,
    elapsedMs: Date.now() - startedAt,
    transferMs: firstReadAt === null ? null : Date.now() - firstReadAt,
    completedReads: completed,
    before,
    after,
  };
}
