// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import plist from 'plist';
const run = promisify(execFile);
export const validVolumeUUID = (value) =>
  typeof value === 'string' && /^[0-9a-f-]{8,64}$/i.test(value);
export function validateOnboard(info, { volume, expectedUUID } = {}) {
  const mount = info.MountPoint;
  if (
    typeof mount !== 'string' ||
    path.dirname(mount) !== '/Volumes' ||
    mount !== path.join('/Volumes', info.VolumeName ?? '') ||
    (volume && mount !== volume) ||
    info.Internal !== false ||
    info.BusProtocol !== 'USB' ||
    info.WritableVolume === false ||
    !/^disk\d+(s\d+)*$/.test(info.DeviceIdentifier ?? '') ||
    !/^disk\d+$/.test(info.ParentWholeDisk ?? '')
  )
    throw new Error('MYO Pocket must be a mounted, writable external USB volume.');
  if (expectedUUID) {
    if (
      !validVolumeUUID(expectedUUID) ||
      info.VolumeUUID?.toUpperCase() !== expectedUUID.toUpperCase()
    )
      throw new Error('The connected drive does not match your saved MYO Pocket identity.');
  } else if (info.VolumeName !== 'Y2 MAIN')
    throw new Error('Connect the onboard volume named Y2 MAIN for the first connection.');
  return info;
}
export async function onboardInfo({
  volume = '/Volumes/Y2 MAIN',
  expectedUUID,
  command = run,
  platform = process.platform,
} = {}) {
  if (platform !== 'darwin')
    throw new Error('Device operations are enabled only on macOS in this release.');
  if (expectedUUID && !validVolumeUUID(expectedUUID))
    throw new Error('Invalid saved drive identity.');
  const target = expectedUUID ?? volume;
  const d = plist.parse(
    (
      await command('/usr/sbin/diskutil', ['info', '-plist', target], {
        timeout: 10000,
        maxBuffer: 1024 ** 2,
      })
    ).stdout,
  );
  return validateOnboard(d, { volume: expectedUUID ? undefined : volume, expectedUUID });
}
export function validDriveName(name) {
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9 _-]{0,10}$/.test(name) &&
    name === name.trim() &&
    name.toUpperCase() !== 'Y2 EXTERNAL'
  );
}
export async function renameOnboard({
  name,
  volume = '/Volumes/Y2 MAIN',
  expectedUUID,
  command = run,
  platform = process.platform,
  remember = async () => {},
  confirm = async () => false,
} = {}) {
  if (!validDriveName(name))
    throw new Error(
      'Use 1–11 letters, numbers, spaces, hyphens, or underscores. Y2 EXTERNAL is reserved for the SD card.',
    );
  const before = await onboardInfo({ volume, expectedUUID, command, platform });
  if (!validVolumeUUID(before.VolumeUUID))
    throw new Error('macOS did not provide a stable drive identity. The drive was not renamed.');
  if (name === before.VolumeName) return { cancelled: true };
  // Verify that the target name is unused before requesting the rename.
  let occupied;
  try {
    occupied = plist.parse(
      (
        await command('/usr/sbin/diskutil', ['info', '-plist', '/Volumes/' + name], {
          timeout: 10000,
          maxBuffer: 1024 ** 2,
        })
      ).stdout,
    );
  } catch {}
  if (occupied?.MountPoint)
    throw new Error('Another mounted volume already uses that name. Choose a different name.');
  if (!(await confirm(before, name))) return { cancelled: true };
  await remember(before.VolumeUUID);
  const current = await onboardInfo({ expectedUUID: before.VolumeUUID, command, platform });
  if (
    current.DeviceIdentifier !== before.DeviceIdentifier ||
    current.ParentWholeDisk !== before.ParentWholeDisk ||
    current.DeviceTreePath !== before.DeviceTreePath
  )
    throw new Error('The player changed before renaming. Reconnect it and try again.');
  await command('/usr/sbin/diskutil', ['renameVolume', current.DeviceIdentifier, name], {
    timeout: 30000,
    maxBuffer: 1024 ** 2,
  });
  const after = await onboardInfo({ expectedUUID: before.VolumeUUID, command, platform });
  if (
    after.VolumeName.toUpperCase() !== name.toUpperCase() ||
    after.DeviceIdentifier !== before.DeviceIdentifier
  )
    throw new Error(
      'Could not verify the new drive name. Check Finder, then reconnect MYO Pocket.',
    );
  return { volume: after.MountPoint, volumeUUID: after.VolumeUUID, name: after.VolumeName };
}
