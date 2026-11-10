import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundTasks, performEject } from '../app/background.mjs';
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const events = [];
  return {
    events,
    device: { volume: '/Volumes/Y2 MAIN', resolveVolume: async () => events.push('resolve') },
    deviceState: { connected: true },
    rows: [
      { local: true, onDevice: true, status: 'current' },
      { local: false, onDevice: true },
    ],
    busy: false,
    publish() {
      events.push('publish');
    },
    stopScan: async () => events.push('drain-scan'),
    log: async () => events.push('log'),
  };
}
test('pause drains active discovery and prevents overlapping/new polling', async () => {
  const b = new BackgroundTasks();
  let finish,
    active = 0;
  const task = b.run(async () => {
    active++;
    await new Promise((resolve) => (finish = resolve));
    active--;
  });
  await tick();
  await b.run(() => assert.fail('overlapping poll'));
  let paused = false;
  const pause = b.pause().then(() => (paused = true));
  await tick();
  assert.equal(paused, false);
  finish();
  await Promise.all([task, pause]);
  assert.equal(active, 0);
  await b.run(() => assert.fail('poll while paused'));
  b.resume();
  let called = false;
  await b.run(() => (called = true));
  assert.ok(called);
});
test('background callback rejection is caught and the next poll still works', async () => {
  const errors = [];
  const b = new BackgroundTasks((error) => errors.push(error.message));
  await b.run(() => {
    throw new Error('volume disappeared');
  });
  await b.run(() => Promise.reject(new Error('native info failed')));
  assert.deepEqual(errors, ['volume disappeared', 'native info failed']);
  let ok = false;
  await b.run(() => (ok = true));
  assert.ok(ok);
});
test('eject drains monitoring before disk action; publishes disconnected without immediate device re-scan', async () => {
  const library = fixture();
  let resume = 0;
  const result = await performEject({
    library,
    pause: async () => library.events.push('pause'),
    resume: () => resume++,
    eject: async () => {
      assert.ok(library.busy);
      assert.deepEqual(library.events.slice(-3), ['pause', 'drain-scan', 'resolve']);
      return { volumes: ['Y2 MAIN', 'Y2 EXTERNAL'] };
    },
  });
  assert.equal(result.volumes.length, 2);
  assert.equal(library.busy, false);
  assert.equal(library.deviceState.connected, false);
  assert.deepEqual(
    library.rows.map((r) => r.onDevice),
    [false],
  );
  assert.equal(resume, 1);
  assert.equal(library.progress.percent, 100);
  assert.ok(!library.events.includes('log'), 'routine success must not enter Recent Activity');
});
test('failed and cancelled eject restore controls and monitoring without claiming success', async () => {
  for (const failed of [false, true]) {
    const library = fixture();
    let resumed = false;
    const op = performEject({
      library,
      pause: async () => {},
      resume: () => (resumed = true),
      eject: async () => {
        if (failed) throw new Error('disk busy');
        return { cancelled: true };
      },
    });
    if (failed) await assert.rejects(op, /disk busy/);
    else await op;
    assert.equal(library.busy, false);
    assert.equal(resumed, true);
    assert.equal(library.deviceState.connected, true);
    assert.notEqual(library.progress?.percent, 100);
  }
});
