// SPDX-License-Identifier: GPL-3.0-only
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class PlayerRunner {
  run(input, progress) {
    if (this.child) throw new Error('A player operation is already running.');
    const child = fork(fileURLToPath(new URL('./player-worker.mjs', import.meta.url)), [], {
      execPath: process.execPath,
      execArgv: [],
      detached: process.platform !== 'win32',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child = child;
    this.writing = input.action === 'write';
    return new Promise((resolve, reject) => {
      let result,
        failure,
        stderr = '';
      child.stderr.on('data', (data) => {
        stderr = (stderr + data).slice(-4000);
      });
      child.on('message', (message) => {
        if (message.type === 'progress') {
          try {
            progress(message.event);
          } catch (error) {
            failure = error.message;
          }
        } else if (message.type === 'result') result = message.result;
        else if (message.type === 'error') failure = message.error;
      });
      child.on('error', (error) => {
        failure = error.message;
      });
      child.on('close', (code) => {
        this.child = null;
        this.writing = false;
        if (code === 0 && result && !failure) resolve(result);
        else
          reject(
            new Error(
              failure ||
                (this.cancelled
                  ? 'Player operation cancelled. Nothing was written.'
                  : 'Player update helper stopped unexpectedly. ' + stderr),
            ),
          );
      });
      this.cancelled = false;
      try {
        child.send(input, (error) => {
          if (error) failure = error.message;
        });
      } catch (error) {
        failure = error.message;
      }
    });
  }
  cancel() {
    if (this.writing)
      throw new Error(
        'The player write must finish verification before it can be closed. Do not unplug.',
      );
    this.cancelled = true;
    if (this.child) process.kill(-this.child.pid, 'SIGTERM');
  }
}
