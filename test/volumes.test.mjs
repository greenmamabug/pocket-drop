import test from 'node:test';
import assert from 'node:assert/strict';
import plist from 'plist';
import { renameOnboard, onboardInfo } from '../app/volumes.mjs';
import { ejectPocket } from '../app/eject.mjs';
const uuid = 'BABC1234-1234-1234-1234-123456789ABC';
function mock({ wrong = false, fail = false, collision = false } = {}) {
  let volume = {
    MountPoint: '/Volumes/Y2 MAIN',
    VolumeName: 'Y2 MAIN',
    VolumeUUID: uuid,
    Internal: false,
    BusProtocol: 'USB',
    WritableVolume: true,
    DeviceIdentifier: 'disk4s1',
    ParentWholeDisk: 'disk4',
    DeviceTreePath: 'IOService:/USB/player/IOSCSILogicalUnitNub@0/disk4',
  };
  const calls = [];
  return {
    calls,
    get currentVolume() {
      return volume;
    },
    command: async (bin, args) => {
      assert.equal(bin, '/usr/sbin/diskutil');
      calls.push(args);
      if (args[0] === 'info') {
        if (args[2] === '/Volumes/NEW POCKET' && collision)
          return {
            stdout: plist.build({
              ...volume,
              MountPoint: '/Volumes/NEW POCKET',
              VolumeName: 'NEW POCKET',
              VolumeUUID: 'DEAD1234',
            }),
          };
        if (
          args[2] !== uuid &&
          args[2] !== volume.MountPoint &&
          args[2] !== volume.DeviceIdentifier
        )
          throw new Error('not mounted');
        return { stdout: plist.build({ ...volume, ...(wrong ? { VolumeUUID: 'DEAD1234' } : {}) }) };
      }
      if (args[0] === 'renameVolume') {
        if (fail) throw new Error('busy');
        volume = { ...volume, VolumeName: args[2], MountPoint: '/Volumes/' + args[2] };
        return { stdout: '' };
      }
      throw new Error('unexpected command');
    },
  };
}
test('rename remembers UUID before mutating; reconnect resolves renamed drive by UUID', async () => {
  const m = mock();
  let saved = false;
  const result = await renameOnboard({
    ...m,
    name: 'NEW POCKET',
    platform: 'darwin',
    confirm: async () => true,
    remember: async (id) => {
      assert.equal(id, uuid);
      assert.equal(m.calls.filter((c) => c[0] === 'renameVolume').length, 0);
      saved = true;
    },
  });
  assert.ok(saved);
  assert.equal(result.volume, '/Volumes/NEW POCKET');
  assert.deepEqual(
    m.calls.find((c) => c[0] === 'renameVolume'),
    ['renameVolume', 'disk4s1', 'NEW POCKET'],
  );
  assert.equal(
    (await onboardInfo({ ...m, expectedUUID: uuid, platform: 'darwin' })).VolumeName,
    'NEW POCKET',
  );
});
test('rename cancellation does not remember or rename', async () => {
  const m = mock();
  assert.ok(
    (
      await renameOnboard({
        ...m,
        name: 'NEW POCKET',
        platform: 'darwin',
        confirm: async () => false,
        remember: () => assert.fail(),
      })
    ).cancelled,
  );
  assert.ok(!m.calls.some((c) => c[0] === 'renameVolume'));
});
test('unsafe names never invoke diskutil', async () => {
  for (const name of [
    '',
    '../drive',
    'Y2 EXTERNAL',
    'A'.repeat(12),
    ' x',
    'x ',
    'name;rm',
    '-rf',
  ]) {
    const m = mock();
    await assert.rejects(renameOnboard({ ...m, name, platform: 'darwin' }));
    assert.equal(m.calls.length, 0);
  }
});
test('identity mismatch refuses renamed drive and eject', async () => {
  const m = mock({ wrong: true });
  await assert.rejects(onboardInfo({ ...m, expectedUUID: uuid, platform: 'darwin' }), /identity/);
  await assert.rejects(ejectPocket({ ...m, mainUUID: uuid, platform: 'darwin' }), /identity/);
  assert.ok(!m.calls.some((c) => ['renameVolume', 'eject'].includes(c[0])));
});
test('existing mounted name is refused without renaming', async () => {
  const m = mock({ collision: true });
  await assert.rejects(
    renameOnboard({ ...m, name: 'NEW POCKET', platform: 'darwin', confirm: async () => true }),
    /already uses/,
  );
  assert.ok(!m.calls.some((c) => c[0] === 'renameVolume'));
});
test('rename command failure does not falsely report success; saved UUID still finds original', async () => {
  const m = mock({ fail: true });
  let saved;
  await assert.rejects(
    renameOnboard({
      ...m,
      name: 'NEW POCKET',
      platform: 'darwin',
      confirm: async () => true,
      remember: async (id) => (saved = id),
    }),
    /busy/,
  );
  assert.equal(
    (await onboardInfo({ ...m, expectedUUID: saved, platform: 'darwin' })).VolumeName,
    'Y2 MAIN',
  );
});
test('renamed onboard storage ejects with its external SD card and reports current names', async () => {
  const mounted = new Map([
    [
      '/Volumes/NEW POCKET',
      {
        Internal: false,
        BusProtocol: 'USB',
        VolumeName: 'NEW POCKET',
        MountPoint: '/Volumes/NEW POCKET',
        VolumeUUID: uuid,
        DeviceIdentifier: 'disk4s1',
        ParentWholeDisk: 'disk4',
        DeviceTreePath: 'IOService:/USB/player/IOSCSILogicalUnitNub@0/disk4',
      },
    ],
    [
      '/Volumes/Y2 EXTERNAL',
      {
        Internal: false,
        BusProtocol: 'USB',
        VolumeName: 'Y2 EXTERNAL',
        MountPoint: '/Volumes/Y2 EXTERNAL',
        DeviceIdentifier: 'disk5s1',
        ParentWholeDisk: 'disk5',
        DeviceTreePath: 'IOService:/USB/player/IOSCSILogicalUnitNub@1/disk5',
      },
    ],
  ]);
  const ejected = [];
  const command = async (bin, args) => {
    if (args[0] === 'info') {
      const info = mounted.get(args[2]);
      if (!info) throw new Error('not mounted');
      return { stdout: plist.build(info) };
    }
    assert.equal(args[0], 'eject');
    ejected.push(args[1]);
    for (const [p, d] of mounted) if (d.ParentWholeDisk === args[1]) mounted.delete(p);
    return { stdout: '' };
  };
  assert.deepEqual(
    (
      await ejectPocket({
        command,
        platform: 'darwin',
        mainVolume: '/Volumes/NEW POCKET',
        mainUUID: uuid,
      })
    ).volumes,
    ['NEW POCKET', 'Y2 EXTERNAL'],
  );
  assert.deepEqual(ejected, ['disk5', 'disk4']);
});
