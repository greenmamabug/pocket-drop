// SPDX-License-Identifier: GPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverFromTerminal } from '../scripts/terminal-player-recovery.mjs';

const fixture = () => {
  const calls = [];
  const updater = {
    journal: { pendingWrite: true, completed: false },
    state: {
      token: 'review-token',
      summary: { unitId: 'a'.repeat(32), checklist: ['System only'] },
    },
    async connectionTest() {
      calls.push('read');
      return { passed: true };
    },
    async review() {
      calls.push('review');
    },
    async write(confirmation, token) {
      assert.equal(confirmation, 'WRITE');
      assert.equal(token, 'review-token');
      calls.push('write');
      this.state.phase = 'complete';
      this.state.pendingWrite = false;
    },
  };
  return { updater, calls };
};
const options = { ask: async () => 'WRITE', print: () => {} };
test('Terminal recovery stops before review, confirmation or writing if the read-only connection fails', async () => {
  const { updater, calls } = fixture();
  updater.connectionTest = async () => {
    calls.push('read');
    throw new Error('USB lost');
  };
  await assert.rejects(
    recoverFromTerminal(updater, { ...options, ask: () => assert.fail('no write prompt') }),
    /USB lost/,
  );
  assert.deepEqual(calls, ['read']);
  assert.equal(updater.journal.pendingWrite, true);
});
test('Terminal recovery requires an interrupted update, a passing read, review and exact typed confirmation', async () => {
  const { updater, calls } = fixture();
  updater.journal.pendingWrite = false;
  await assert.rejects(recoverFromTerminal(updater, options), /No interrupted update/);
  assert.deepEqual(calls, []);
  updater.journal.pendingWrite = true;
  const stopped = await recoverFromTerminal(updater, { ...options, ask: async () => 'write' });
  assert.equal(stopped.aborted, true);
  assert.deepEqual(calls, ['read', 'review']);
  assert.equal(updater.journal.pendingWrite, true);
});
test('Terminal recovery only reports success after the existing write and verification flow completes', async () => {
  const { updater, calls } = fixture();
  const result = await recoverFromTerminal(updater, options);
  assert.equal(result.verified, true);
  assert.deepEqual(calls, ['read', 'review', 'write']);
  updater.state.phase = 'resume';
  updater.write = async () => {
    updater.state.pendingWrite = true;
  };
  await assert.rejects(recoverFromTerminal(updater, options), /not fully verified/);
});

test('a non-passing read result or failed saved-image review cannot reach writing', async () => {
  const { updater, calls } = fixture();
  updater.connectionTest = async () => ({ passed: false });
  await assert.rejects(recoverFromTerminal(updater, options), /did not pass/);
  assert.deepEqual(calls, []);
  updater.connectionTest = async () => ({ passed: true });
  updater.review = async () => {
    throw new Error('saved image changed');
  };
  await assert.rejects(recoverFromTerminal(updater, options), /saved image changed/);
  assert.deepEqual(calls, []);
});

test('reopening another updater before confirmation prevents the Terminal write', async () => {
  const { updater, calls } = fixture();
  await assert.rejects(
    recoverFromTerminal(updater, {
      ...options,
      assertExclusive: async () => {
        throw new Error('another updater is open');
      },
    }),
    /another updater is open/,
  );
  assert.deepEqual(calls, ['read', 'review']);
});
