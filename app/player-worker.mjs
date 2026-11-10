// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs/promises';
import path from 'node:path';
import { executePlayerTask } from './player-task.mjs';

let started = false;
process.on('message', async (input) => {
  if (started) return;
  started = true;
  let lock,
    owned = false,
    last = 0,
    lastLine = 0,
    lastLabel = '';
  const send = (message) => {
    try {
      if (process.connected) process.send(message, () => {});
    } catch {}
  };
  try {
    if (input.firmwareDir) {
      await fs.mkdir(input.firmwareDir, { recursive: true, mode: 0o700 });
      lock = path.join(input.firmwareDir, '.pocket-drop-update.lock');
      try {
        const prior = JSON.parse(await fs.readFile(lock, 'utf8'));
        if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0)
          throw new Error('Invalid player update lock.');
        try {
          process.kill(prior.pid, 0);
          throw new Error('A player update is already running. Wait for it to finish.');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
        await fs.rm(lock);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
      owned = true;
    }
    const result = await executePlayerTask(input, (event) => {
      const now = Date.now();
      if (event.line) {
        if (now - lastLine >= 1000 || !/Progress:|%/.test(event.line)) {
          send({ type: 'progress', event });
          lastLine = now;
        }
      } else if (event.label !== lastLabel || now - last >= 180 || event.percent === 100) {
        send({ type: 'progress', event });
        last = now;
        lastLabel = event.label;
      }
    });
    send({ type: 'result', result });
  } catch (error) {
    send({ type: 'error', error: error.message });
  } finally {
    if (owned) await fs.rm(lock, { force: true }).catch(() => {});
    if (process.connected) process.disconnect();
  }
});
