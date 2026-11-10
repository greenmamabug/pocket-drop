// Informational estimates only: the sync engine checks real free space before writes.
export function storagePreview(rows, device, { plannedBytes } = {}) {
  let bytes = 0,
    unknown = 0,
    estimated = false;
  for (const row of rows) {
    if (Number.isFinite(row.preparedBytes)) {
      bytes += row.preparedBytes;
    } else if (row.opusCount) {
      unknown++;
    } else {
      bytes += Math.max(0, row.transferBytes ?? row.size ?? 0);
      estimated = true;
    }
  }
  if (Number.isFinite(plannedBytes)) {
    bytes = Math.max(0, plannedBytes);
    unknown = 0;
    estimated = false;
  }
  return {
    bytes,
    unknown,
    estimated,
    remaining: device.connected && Number.isFinite(device.free) ? device.free - bytes : null,
    overCapacity: device.connected && bytes > device.free,
  };
}
