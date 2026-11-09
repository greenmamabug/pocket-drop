# Pocket Drop 4 — verification report

Test date: November 6, 2026. Build host: Linux x86_64; Node 24.22.1. Target: Intel macOS 12+. Upstream revision: c7e6f377762d25faffa63f32d0df1a688256c9f0.

## Executed checks

- **12 Pocket Drop integration tests: PASS.** They run the real vendored Studio Pocket importer, planner, and applier against temporary, simulated player volumes. Assertions cover website ZIP/folder and Chrome ZIP/folder, local artwork bytes, chapter order and titles, supported 16×16 icons, unchanged originals, corrupt ZIPs, CRC failures, unsafe ZIP and metadata paths, source/device symlink rejection, unsupported audio, unlisted audio rejection, plain folders/rootless ZIP identity, fresh sync, no-op sync, same-size image and audio changes, explicit removal, index/state cleanup, preservation of unrelated playlists, re-sync after removal, wrong-player/path-traversal refusals, disconnect/recovery, duplicate consolidation, Inbox discovery/removal, device-only entries, local-only disconnected behavior, conflicting editions, and error translation.
- **57 upstream sync-engine tests: PASS.** Includes out-of-space refusal, interruption/cancellation and recovery, update staging, unrelated-playlist preservation, and a 60-playlist × 50-track scale check.
- **22 upstream library-format tests: PASS.** Includes validation, shared fixture compatibility, completeness and group/recent formats.
- **Browser interface checks: PASS.** Real renderer HTML/CSS/JS, injected test state, upstream fixture cover image, generated placeholders; selection and Sync IPC arguments, per-book removal IPC, Inbox/add actions, search, filters, all navigation pages, settings action, empty/disconnected state, disabled Sync, narrow 960px layout, and no renderer errors. Screenshot is explicitly a test view: sample titles, fixture artwork and simulated storage are not production library data.
- **Actual Electron desktop smoke test on Linux: PASS.** Starts the real main process using a test-only entry point and private temporary Downloads/userData paths. Checks actual automatic Inbox discovery and cover rendering, preload bridge, sandbox/context isolation/no Node in renderer, native Open Inbox API call with correct path, real folder copy without deleting source, persisted automatic-refresh preference, and Inbox relocation without moving/deleting originals. Native OS dialogs and opening Finder are stubbed in this Linux smoke test; the real APIs are wired but macOS interactions are not claimed as tested.
- **Runtime npm audit: PASS.** `npm audit --omit=dev` reported zero known runtime-package vulnerabilities at test time. This does not certify Electron/Chromium or operating-system support/security status.
- **Packaged application smoke check: PASS.** The app.asar produced for the Mac bundle was launched with the Linux Electron runtime using the same isolated desktop checks. This confirms packaged module resolution, assets, preload, and backend behavior, while the Darwin executable itself still requires a real Mac launch.
- **Mac packaging:** Electron Builder creates an Intel Darwin .app in a ZIP, with `LSMinimumSystemVersion=12.0.0`, `app.pocketdrop.desktop` bundle ID, custom icon.icns and bundled runtime dependencies. Mach-O x86_64 executable and the archive contents inspected; ZIP integrity checked. The app is **unsigned and unnotarized**.

Total automated code tests: **91 passing** (12 application integration + 57 sync-engine + 22 library-format), plus two passing interface/desktop check scripts. Tests and raw output accompany the source delivery.

## Not executed / remaining validation

- Actual launch on Intel macOS Monterey, Dock icon rendering, Gatekeeper approval, Finder folder opening and native dialogs.
- Physical Y2 mounting/discovery using macOS diskutil, actual USB free-space figures, transfers, removal, eject behavior, unplugging, power loss, and readback/playback under Studio Pocket v0.6.0.
- User-provided MYO downloads: none were attached. Tests use generated metadata representing the specified formats with real upstream audio fixtures. Actual archive variants need validation.
- Windows: device operations are intentionally disabled. No Windows installer is provided.
- Apple signing/notarization: no credentials available. First-launch OS approval may be necessary.
- Real 5.9 GB storage exhaustion: exercised by the upstream simulated free-space tests, not by filling a physical device. Mac USB protocol classification is based on diskutil's USB/external/writable volume fields and requires Y2 MAIN.

No actual user player was mounted or modified. The user's Enchanted Wood and Ralph Mouse copies were not accessed. This delivery is a functional, packaged hardware-validation candidate; it is not presented as a fully hardware-verified or signed production release.

## 4.0.1 checks

Re-ran all 12 application integration tests and the renderer/desktop checks after the interface update. The renderer check asserts Sync all sends every actionable row, Sync selected sends only checked rows, and the header storage bar reports 46% used for a simulated 5.9 GB device with 3.2 GB free. The 79 upstream tests passed in the preceding build; upstream runtime source is unchanged. Device display name is MYO Pocket; actual USB volume checks remain Y2 MAIN. Version 4.0.1 retains the unsigned, physical-Mac/Y2-unverified status.

## 4.0.2 ejection checks

Six additional mocked diskutil tests cover two separate player LUNs, two partitions of one disk, onboard-only storage, unrelated-device refusal, busy-volume refusal, and detecting falsely reported command success. UI checks exercise Eject IPC and disconnected disabling. macOS diskutil execution and actual player USB identity remain untested on hardware.

## 4.0.3 regression checks

Integration assertions verify that sync returns with both busy and scanning cleared, no extra device planning occurs after the verified transfer, and an unchanged background poll never enters a blocking scan. UI checks assert the card frame ratio, loading overlay, in-button 45% progress and animation state, removal menu wording, removal IPC, connected controls restored after busy state, and no repeated device name. Existing archive/removal/ejection suites are re-run. Hardware-specific diagnosis of the reported stall still requires the user’s Mac.

## 4.0.4 regression checks

23 application tests pass, including audio-read traps proving initial discovery, reopen and reconnect do not open audio files; a device-track-stat spy proving quick discovery does not walk track files; persistent cache reuse; draining a stopped scan; and separate-volume confirmation/cancellation. Previous 79 upstream tests passed with unchanged engine source. Renderer checks cover explicit selection buttons (no checkboxes), library-only overlay, active navigation/Eject during updating, normal progress and removal actions, and the connection/search header. Archive/audio validation is intentionally deferred to explicit sync rather than happening during browsing. Hardware ejection with missing identity information uses explicit user confirmation and remains unverified on a physical Mac/player.

## 4.0.5 checks

Re-ran all 23 application tests and browser checks. UI assertions check leftmost Status, a single Sync button, visible per-row removal invoking the correct ID, eject tooltip/no header arrow, a single Recent Activity heading/subtitle, refresh interval IPC, disconnected instructions, and controls remaining available outside the list update overlay. Actual Electron checks cover refresh-frequency persistence and Manual only, alongside existing file/thumbnail tests. The engine’s insufficient-space check remains unchanged; friendly wording now uses “Remove some audio”. Actual USB behavior remains subject to hardware confirmation.

Reproduced a false Needs attention result by adding the actual Chrome data/metadata.json layout to the test fixture; it failed before the detector fix and passes afterward for extracted and rootless ZIP layouts.

## 4.0.6 interface checks

23 application tests pass. Updated browser assertions cover both-direction title sorting, status and numeric-size sorting on both tabs, separate tab sort state, no Next sync column, no filenames/footnote, file-count wording, only non-installed items offering sync selection, one left-column red removal selector per On Pocket row, correct removal IPC, question-mark disconnected help, and Cancel below Sync. The previous fast metadata-only discovery, Chrome folder, source preservation and eject checks remain.

## 4.0.7 checks

All 23 application tests were re-run. Removal assertions check that measured stage progress starts at zero, advances, never decreases and reaches 100 after verification. Browser checks cover On Pocket-to-red-queue toggling, text-size control IPC and actual 22px title styling, red 50% button fill and spinning arrow, plus existing layout/selection/cancel behavior. Actual Electron checks verify text-size preference persistence. Visual review includes default narrow and wider layouts and removal-in-progress screenshots. Actual USB deletion speed varies; progress represents completed stages rather than estimated bytes.

## 4.0.8 Apple Silicon packaging

A native Darwin ARM64 app is built with Electron 38.8.6 and the unchanged application engine/UI features. Linux cross-signing applies ad-hoc code signatures, with no Developer ID/notarization claim. ARM64 architecture and ad-hoc code-directory page hashes, entitlement special slots, and sealed resources are checked independently. The default rcodesign verifier's absent-CMS warning is expected for ad-hoc signatures, and is not represented as a passed CMS/certificate verification. ZIP integrity and executable permissions are checked. The packaged JavaScript is smoke-tested under Linux Electron, and the Settings architecture label is tested with ARM64 state. Neither the Darwin ARM64 executable nor real Apple Silicon USB/ejection behavior has been launched/tested in this environment. Native macOS codesign/spctl checks remain pending. Intel 4.0.7 remains available unchanged.

## 4.0.9 interface, preferences and drive naming

30 application tests pass. Added mocked diskutil tests cover rename confirmation/cancellation, UUID persistence before the mutation, discovery after renamed reconnect, mismatched identities, invalid/reserved names, mounted-name collisions, rename command failure without false success, and ejecting both storage volumes after an onboard rename. Existing transfer/source preservation, fast metadata discovery and dual-volume ejection tests remain. UI checks cover the labelled green MYO Studio link, removal of Add Folder, Refresh placement, independent app/library font settings, adjustable title width, rename form IPC, and On Pocket hiding the live Sync button while showing disabled Remove from Pocket. Narrow-window checks include the largest font settings. Actual Electron checks verify file and folder import copy/source preservation, fixed website URL, preference persistence and invalid text-size rejection.

Both native archives share application code. ARM64 ad-hoc signature hashes/resource seals and ZIP roundtrip checks are performed for delivery. macOS diskutil rename, actual renamed-player reconnect/ejection, native Gatekeeper behavior, and physical Apple Silicon launch remain untested here. No notarization claim is made.

## 4.1.0 Opus conversion

Production Ogg Opus streaming decoding is checked with real synthetic mono/stereo Opus fixtures, exact sample counts/durations, packet checksum/truncation rejection, cancellation, cached AAC reuse and corrupted-cache regeneration. A 16-file website fixture converts with titles/artwork/order intact and syncs through the unmodified engine into a verified simulated player. Chrome ZIP and plain folder conversion preserve their originals. Linux integration uses FFmpeg as an injected AAC encoder; it does not test macOS afconvert. Actual Electron smoke checks run the production decoder worker, including packaged resources. Full source/file/thumbnail/settings checks and the interface regression suite remain. Neither of the two uploaded Big Sky Mountain ZIPs could be transferred for inspection because each exceeded this session's 32 MiB transfer limit; compatibility with those particular archives is not claimed as tested. Native macOS encoding/playback, renamed-drive operations, and hardware launch remain pending.

4.1.0 test count: 36 integration tests passed. Converted AAC samples are decoded again by the Linux test tool and checked for signal amplitude as well as duration, to catch PCM endian/format errors. The production CAF writer uses float32 little-endian PCM with CAF flags 3; it streams one Ogg page at a time in a worker instead of loading an entire book into memory. The production decoder worker also passed an actual Electron run from the packaged app resources. The macOS encoder command itself remains unexecuted in this Linux environment.

A cache-clearing/resync regression test uses AAC encodes with different metadata hashes to confirm that an unchanged Opus original can be re-encoded and synced again; the existing source fingerprint guard remains active.

## 4.1.1 eject investigation and automatic opening

The user reported one complete app shutdown after Eject, followed by a successful retry. No native crash report was available; the cause remains unconfirmed. New tests cover draining active polling before eject, preventing overlapping/paused polls, catching rejected background callbacks, disconnected publication without immediate post-eject scanning, and restoring monitoring/controls after failed or cancelled eject. UI checks cover the eject animation, stopping at Disconnected, the visible USB reminder, and the automatic-opening setting IPC. Actual Electron checks call the eject IPC on Linux, confirm the supported-platform error is returned, controls recover, the app window remains alive, and a diagnostic event is saved. Physical macOS shutdown reproduction and login-item behavior remain untested.

## 4.1.2 checks

41 integration tests pass, including filtering historical routine eject successes while preserving imports/transfers/errors. The successful-eject test confirms no Recent Activity log is emitted. UI checks assert hiding the right action during eject, the inline icon animation and green color, the new USB reminder, friendly-name form IPC, visible Refresh label, padded/visible arrow SVGs, and the active conversion wording. Actual Electron checks exercise the friendly-name form, persisted settings and invalid names, alongside the existing surviving eject-error IPC and production Opus worker checks. Narrow-window/large-font screenshots and eject/conversion screenshots are reviewed. Physical Mac validation limits from 4.1.1 remain.

## 4.2.0 checks

47 integration tests pass. Added tests cover shared file/folder import copy and source preservation, preflight failure without partial batch writes, collision refusal, symlink/Inbox-ancestor rejection, known/unknown Opus storage previews and actual planned sizes, accurate result counts, and a pre-device-write preparation failure that releases controls and identifies the problem item. Existing engine, background, converter, cached-resync and ejection tests remain. UI checks exercise Not on Pocket filtering/sorting, counted buttons, storage estimates, completion details/dismissal, drop indication/import, absence of rejected bulk-selection controls, and narrow/large-font layouts. Actual Electron tests use a real OS-backed file in a DOM drop to import a valid ZIP, verify identical source/destination bytes and immediate discovery, and refuse generic import-path IPC and synthetic unbacked Files. Native Mac verification and the previous intermittent crash diagnosis remain pending.

4.2.0 follow-up checks: Not on Pocket is disabled while disconnected so unknown device contents are not labelled as missing. The user declined an additional connection-check button; tests assert it is absent. Conversion tests verify decode/encode timing propagation through Library and archive preparation, and that a cached-copy write error does not trigger re-encoding. Existing PCM bytes/quality settings are retained after the candidate packing benchmark showed no measured improvement on this host. The user's later Finder report described inaccessible stale icons that disappeared, not browsable mounted volumes. Native eject logic is unchanged.


## 4.3.0 flexible audio import

52 automated tests pass, including nested CD/file numeric ordering, complete/partial/duplicate embedded track tags, malformed and incomplete optional metadata, archive/extracted-folder identity parity, every-file checksum verification after a simulated player sync, unchanged originals, 7z copy-to-Inbox, initial and explicit forced refresh with no device connected, and 7z link/encryption/corruption rejection. Existing ZIP checksum/path protections, Opus conversion, original preservation, device ejection and engine integration remain covered. The renderer regression check passes. Native Mac extraction/launch requires hardware confirmation; this Linux environment cannot run macOS executables. The exact uploaded Henry and Beezus archive exceeded the attachment-transfer tool's 32 MiB limit and was not inspected.

The fresh native Electron desktop smoke test could not run on this resumed host: there is no running X server or Xvfb executable (the old X99 socket is stale). A headless-platform attempt also closed before creating a test window. Browser renderer checks and the Node/engine integration suite passed; those do not establish a fresh full Electron launch result.


## 4.3.1 Finder icon

Decoded all 11 ICNS representations and verified each PNG size and alpha channel: standard 16/32/64/128/256/512/1024 pixels, plus Retina ic11/ic12/ic13/ic14 at 32/64/256/512 pixels. Packaging assigns PocketDrop.icns in the Mac bundle's Info.plist. The full-resolution Finder icon is separate from the 512-pixel in-app image. No library/import/sync runtime behavior changes in this release. Finder rendering and its icon cache cannot be exercised on this Linux host.


## 4.4.0 editor and collections

New tests cover persistent reorder/rename/icon reassignment, stable player identity through title edits, resync no-op, original preservation, excluded unsupported/Opus tracks avoiding conversion, rejection of all-excluded or invalid-icon edits, player-group preservation and single-membership validation, group write locking and player identity, offline preparation, removal undo identity/source checks, local audio range requests and parent-link replacement, duplicate byte comparisons and hidden-copy persistence, and bounded architecture-aware GitHub release checks. Browser checks exercise actual drag-to-reorder, deletion/restoration payloads, icon reassignment, search, collection membership/order, preparation controls, duplicates, notifications and update UI. Real Linux Electron checks exercise the production sandbox/preload, editor IPC, playable media and range seeking, native cover selection/crop, persistence, collections, and both cancelled and confirmed original-to-Trash flows (the confirmed test uses an isolated test Trash). A user-local Debian Xvfb runtime was used to restore native Electron testing on this resumed host. Public GitHub repository: greenmamabug/pocket-drop. macOS hardware validation remains separate.

Final 4.4.0 verification: 62 Node tests passed. Original renderer and new editor/collections renderer suites passed, including drag-to-reorder and 960px layout. Original and new real Electron desktop suites passed on the local X100 test display, including production audio protocol/range requests, native cover processing, persistence, and confirmed/cancelled original-file Trash actions. Conversion estimates use completed encode timing samples; cached files do not create false encoding samples. Existing extraction/path protections and device-side transfer tests remain included. Mac-specific USB, AAC encoder, notifications and Finder behavior still require Mac hardware validation.

Numbered-layout follow-up: the full suite passed 66 tests, including extracted folders, wrapped and rootless 7z files, ZIPs, leading-zero numeric audio/icon pairing, ignored card.txt/tracks.txt contents, cover_image.png copying and hash verification on a simulated player, larger numbered PNG normalization with unchanged originals and temporary cleanup, numbered Opus conversion with its icon retained, and nested-disc fallback ordering. The real Electron suite also opened and prepared the four-item numbered layout through the production native-image adapter, preserving its larger original icon. The metadata discovery cache moved to version 4 to invalidate older interpretations of this layout. Changes to a previously synced source mark its edited version ready for update while retaining its player identity.

## 4.4.1 stability, Ogg and library performance

75 application tests pass on Linux, including streaming Vorbis/Opus Ogg conversion to verified AAC, corrupt-file failure without device writes followed by successful retry, persisted duplicate checks, collection audio/picture sync, deferred single-track archive preview, artwork aliases/disc-local icons, refresh state completion/failure, and the destroyed-window quit regression. A 64 MiB copy test verifies event-loop responsiveness, bounded USB marker reads and hash-verification progress. Existing interruption/recovery, out-of-space, source preservation, and both-volume eject tests pass. Browser and real Electron editor checks pass. Native macOS conversion/editor/signature checks run in release CI. Runtime dependency audit reports zero known vulnerabilities. Physical USB transfer, Finder icon rendering/cache behavior and player hardware playback remain hardware validation.

## 4.4.2 refresh and cancellation follow-up

78 application tests pass. New regression tests verify that an automatic metadata refresh does not abort a long duplicate comparison, device operations do pause it, unchanged device manifests are reused by index checksum, manual refresh rereads them, and each refresh inspects the device only once. The current desktop smoke test and editor check pass on Linux. Mac release CI repeats native encoder/editor and signature verification for the final version.

## 4.4.3 book length and incomplete-player warning

82 application tests pass, including measured folder/ZIP lengths, persistence, excluded-track totals, foreground pause behavior, source preservation, and resync of a missing manifest while preserving another book and listening position. Browser checks verify Length display/sorting, Save versus Save and close, persistent opening indicators, and no horizontal overflow at 960px with large text. The actual Electron editor/collection checks pass. Existing crash/large-copy/Ogg/eject regression tests remain passing. Diagnostics and transfer progress are retained; an apparent pause ending is not treated as proof of a completed transfer.

## 4.4.4 archive picture performance and old duration-cache reuse

84 application tests pass. Additional tests verify concurrent solid-7z picture requests share one extraction, audio is not extracted for those pictures, temporary pictures are removed on close, source bytes remain unchanged, and an old cached manifest supplies Length offline before and after refresh without audio probing. Native Electron editor and browser checks pass. Existing diagnostic logs, transfer stage progress, Save / Save and close and persistent opening indications are retained.
