# Player software updates

Pocket Drop's **Settings → Player software** wizard updates an existing Studio
Pocket installation. It uses the public GPL firmware engine from
Studio Pocket **v0.7.0**, commit `06f11b08ff4a10c9ab4d38ea4000869090298174`.
Pocket Drop 4.7.2 adds a bounded startup-probe report and a 90-second cold-start allowance; identity and write checks are retained. The supported player release is pinned deliberately. Checking for a newer Pocket
Drop app is a separate feature; this wizard does not silently choose a new player
release or change the base Y2 firmware.

## Using the wizard

1. Choose a backup folder on the Mac. If you already have the firmware folder from
   the original Studio Pocket installation, use it to retain that player's original
   restore copy. A fresh folder can save the current Studio Pocket system, but
   cannot reconstruct the stock software it replaced.
2. Choose **Check update files** to download/verify the update files and start the USB tool without opening a player. Pocket Drop checks fixed release SHA-256 hashes and
   verifies the APK's Android signature against Stuart's committed release
   certificate. The MediaTek agent is downloaded separately from its pinned
   upstream source, checked and cached by the upstream engine. First use needs
   roughly 24 MB of downloads and at least 6 GB free for image work.
3. Eject both player volumes, power the Y2 off and leave its data cable connected.
   Start **Back up & prepare update**. Press the reset pinhole when the app says it
   is waiting. Reading and preparing may take several minutes. Nothing is written
   to the player in this stage. If a complete read is already saved, choose **Use existing backup** instead: its size/hash and signer compatibility are verified locally, and a new full USB read is skipped. Later player-software changes are not included in an older backup.
4. Review the prepared player identity and checklist, type **WRITE**, then click
   **Update player**. Press the reset pinhole again when prompted. Do not unplug
   or shut the Mac down. The image is rehashed, the actual connected player must
   match the prepared player's hardware ID, and only the measured system
   partition is written. The full image is read back and compared before success
   is shown. Allow roughly 10–15 minutes for writing plus verification.
5. After verified completion, unplug and turn on the player. Keep the backup
   folder. The wizard can be closed/reopened while an operation continues; app
   quit, syncing and eject are blocked during the operation. Read/preparation can
   be cancelled; writing must finish verification.

## Compatibility and limits

v0.7.0 is an upstream **pre-release** with limited physical hardware testing.
The engine recognizes stock **3.2.0 with FM Radio** and **3.2.1**, and refuses
unknown firmware/layouts. This wizard does not install onto a stock player.
The already installed player must have the same signing key as the official
release. A player installed with a different development key requires Stuart's
restore/reinstall procedure; Pocket Drop does not bypass that check.

Audio sync and Inbox files are separate from the system update. This does not
add support for external-SD audio or change the base firmware to Y2 3.2.4.

## Interrupted updates

A recovery journal is atomically saved and flushed before handing the write to the engine. If a write
fails or its verification is incomplete, Pocket Drop retains that marker and
the prepared image. **Review update to retry** rehashes and checks the same image
and player identity, then requires a new WRITE confirmation. Do this before
using a possibly half-written player. Do not delete the backup folder or start
a new read over the pending update. A per-folder process lock prevents competing
helpers from operating on the same backup while an earlier helper is still
running. A write already started can finish in its helper after an unexpected
desktop-process exit; the next launch conservatively requires re-verification
by retrying the prepared update.

If the app's settings/journal were lost, select the existing per-player backup
folder. **Review saved update** can recover its prepared official image directly
without rereading a possibly half-written player.

If retrying fails, use [Stuart's recovery guide](https://github.com/MYO-Studio/studio-pocket/blob/v0.7.0/docs/recovery/y2-recovery.md)
and the original per-player backup. The GUI does not perform a stock restore.

## Maintainer boundaries

- `player-release`: fixed release provenance, bounded downloads, streamed hash
  verification and cache reuse. Native tool archives are freshly extracted from
  the hash-checked originals for each device operation.
- `player-task` / `player-worker` / `player-runner`: isolated process, native tool
  execution and the vendor firmware engine. No shell, arbitrary download URL,
  unchecked signer or agent override is exposed through IPC.
- `player-tool-check`: no-device native startup preflight and actual probe-failure details, retaining the upstream pre-write identity gate.
- `player-updater`: exclusive operation state, durable pending-write marker,
  one-use confirmation token, retry state and close/sleep protection.
- `player-ipc` / `ui/player-update`: native folder selection and guided UI.

Tests cover download failure/cache recovery, review integrity, confirmation reuse,
pending writes across restarts, busy/mounted-device refusals and failure cleanup.
Release CI verifies the actual official APK and each Mac's native tool capability
probe without opening USB ports. Electron checks exercise the real helper process;
browser tests cover confirmation and progress behavior. No physical Y2 has been
flashed during these automated tests. Hardware install/retry/unplug behavior
still needs verification with a disposable test player and its original backup.

A failed capability probe previously discarded non-Studio-Pocket output, so a crashed or slow tool could be reported as missing identity-check support. 4.7.2 preflights in the real helper and retains the tool's stderr. The same exact capability answer and successful exit are required; absence, failure, and timeout all stop the operation. The binary is still the pinned official upstream archive. This change is not a confirmed fix for every Monterey-specific startup/USB failure.
