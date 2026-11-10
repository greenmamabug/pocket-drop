// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { playerWriteFailure } from '../app/player-failure.mjs';
test('lost serial transport during firmware writing is reported before Python cleanup errors', () => {
  const message = playerWriteFailure(
    [
      'Progress: 2.1% Write',
      "termios.error: (6, 'Device not configured')",
      '[PYI:ERROR] Failed to execute script due to unhandled exception',
      'ValueError: underlying buffer has been detached',
    ],
    'the read-backs are missing: the session did not complete',
  );
  assert.match(message, /USB serial connection.*became unavailable/);
  assert.match(message, /update is incomplete/);
  assert.match(message, /Review update to retry/);
  assert.match(message, /do not make a new backup/);
  assert.doesNotMatch(message, /Nothing was written|underlying buffer/);
});
test('a generic verification mismatch is not incorrectly diagnosed as a lost USB connection', () => {
  const message = playerWriteFailure(
    ['Handshake failed, retrying', 'Handshake successful', 'Write: 100%'],
    'the whole image differs',
  );
  assert.match(message, /did not finish verification/);
  assert.doesNotMatch(message, /connection.*became unavailable/);
});
