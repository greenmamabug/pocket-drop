// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const pending = new Map();

// Capture each caller's state now; serialize replacement, never truncate live data.
export function writeJson(file, value) {
  const destination = path.resolve(file),
    snapshot = JSON.stringify(value, null, 2);
  const job = (pending.get(destination) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const temporary = destination + '.' + randomUUID() + '.part';
      try {
        await fs.writeFile(temporary, snapshot, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, destination);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
  pending.set(destination, job);
  const clear = () => {
    if (pending.get(destination) === job) pending.delete(destination);
  };
  job.then(clear, clear);
  return job;
}
export async function flushJsonWrites() {
  await Promise.all([...pending.values()]);
}
