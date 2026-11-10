// SPDX-License-Identifier: GPL-3.0-only
import { writeJson } from './atomic-json.mjs';

/** Commit independent patches in order; failed writes never alter live settings. */
export function createSettingsWriter(file, settings) {
  let pending = Promise.resolve();
  const update = (patch) => {
    const submitted = structuredClone(patch);
    const job = pending
      .catch(() => {})
      .then(async () => {
        const next = { ...settings, ...submitted };
        await writeJson(file, next);
        Object.assign(settings, next);
      });
    pending = job;
    return job;
  };
  update.flush = () => pending.catch(() => {});
  return update;
}
