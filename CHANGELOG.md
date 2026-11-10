# 4.7.4 — read-only connection diagnostics

- Add a device-identity-checked USB diagnostic containing only read commands. It reads 128 MB to disposable Mac files without replacing the saved backup or prepared update. No write retry happens automatically.
- Keep interrupted-write recovery marked incomplete after a passing read test, and report temporary data verification separately from firmware verification.
- Preserve recent serial-port presence and raw tool errors for diagnosing repeated transport failures. No firmware transfer protocol or timeout was changed.

- Identify loss of the firmware USB serial connection before secondary Python cleanup errors and retain instructions to retry the saved image.
- Correct recovery review text: an interrupted player write remains incomplete until a full retry/readback succeeds; do not claim that nothing was written.

# 4.7.3 — stable, signed player-updater runtime

- Address the runtime-loading path identified in the Monterey process sample: dyld was spending nearly all sampled time mapping the bundled Python library, before USB communication.
- Include pinned mtkclient/Python and e2fsprogs runtime files inside the Mac app. Sign the native libraries/frameworks and seal their post-signing manifest into the outer app.
- Verify and reuse the same runtime path across separate updater operations instead of extracting/deleting fresh executable files for each attempt. Refuse missing, modified or redirected runtime files before execution.
- Keep the exact identity capability response, hardware-ID gate, signed APK checks, backup reuse, explicit WRITE confirmation and full readback verification.
- Test the actual signed app executable twice, asserting it selects the bundled runtime and retains the same runtime path. Publish corresponding GPL/LGPL sources alongside the app.
- This packaging change targets the loader behavior in the supplied macOS12.7.6 sample. The affected physical Mac still needs to confirm successful startup; this is not a timeout increase or a verified universal macOS fix.

# 4.7.2 — USB updater startup and existing backups

- Verify the actual USB updater capability inside the isolated helper before reading or preparing a player. Check update files also verifies native tool startup, without opening a device.
- Allow up to 90 seconds for cold startup on older Intel Macs; preserve the exact capability answer and successful-exit requirements.
- Surface raw pre-write probe failures and startup exceptions instead of incorrectly telling users to rebuild scripts. Retain Activity and Details logging from 4.7.1.
- Add Use existing backup: discover a complete player-specific backup and verify/reuse it through the existing firmware engine, skipping a fresh USB read. A missing, partial, linked or changed backup is refused. Actual-player identity, explicit WRITE confirmation and full readback checks remain required.
- Run the real updater preflight from both source and the packaged Intel app in Mac release CI. No physical Y2 or Monterey host was available to confirm the reported machine-specific USB failure.

# 4.7.1 — player update feedback and retained read errors

- Preserve the USB reader traceback, including the final error cause, when backup/preparation fails; retain the full operation log across launches.
- Save player-update failures in Recent Activity. Release the operation lock after failed reads so preparation can be retried.
- Show an illustrated reset-pinhole connection guide, acknowledge actual USB-reader detection, and close the guide automatically; allow it to continue in the background.
- Add a persistent View update progress entry, detailed timestamped logs and elapsed time. Keep phase text steady while backup percentages change.
- Keep the update header green while USB storage is intentionally unmounted; animate the player during preparation, with reduced-motion support.
- Publish Intel Mac builds only going forward. No player firmware engine or write-validation checks changed.
- The reported exit-1 failure cannot be diagnosed from “Traceback” alone; this patch retains the missing evidence rather than claiming a physical USB failure has been resolved.

# 4.7.0 — collection looks

- Add Icon, Picture, Chosen covers and Recent covers using Studio Pocket’s public v0.7.0 library format.
- Show live portrait/stack previews; fan cards on hover or keyboard focus while retaining circular collection avatars.
- Choose and reorder up to three member covers, optionally placing a collection picture on top. Prune cover choices when membership changes.
- Keep separate 16px fallback icons and 252×400 portrait artwork, lazily upgrading older circular pictures.
- Preserve and import collection appearance/images; compare all appearance settings for pending sync and verify copied artwork before metadata commit.
- Read bounded player-owned recent metadata for previews without rewriting listening history. Older players retain the icon fallback.

# 4.6.1

- Size the final verification-space check against the actual prepared image plus a reserve; do not require another 6 GB after the backup/preparation has used disk space.

# 4.6.0 — guided player software updates

- Add a separate Settings wizard for updating existing Studio Pocket players to the official 0.7.0 pre-release.
- Preserve Stuart’s public GPL firmware engine, official APK signature/hash checks, per-player identity/layout checks and signing-key compatibility.
- Download architecture-specific Mac tools on demand; run image/USB work in an isolated process with phase progress and read/preparation cancellation.
- Save the backup and prepare first; require one-use typed WRITE confirmation, rehash the prepared image, and verify the full device readback before success.
- Retain interrupted-write recovery across app restarts, serialize helpers per backup folder, block concurrent sync/eject/quit, and prevent automatic app suspension.
- Document compatibility, backups, pre-release status and hardware testing limits. Inbox originals and existing audio sync remain separate.

# 4.5.0 — maintenance audit

- Centralize serialized atomic JSON writes for settings, activity, edits and index caches; flush pending writes at shutdown.
- Serialize catalog mutations so failed edits roll back before later edits take snapshots.
- Guard overlapping editor requests, drain late metric work at shutdown, and reject new work while closing.
- Await decoder termination and handle progress callback errors; make source/cache hashing cancellable.
- Reject unsafe numeric preview ranges before clamping; protect active preparation from close-to-background behavior.
- Reuse emitted library snapshots instead of rebuilding them for each main-process publication.
- Separate pure audio metadata calculations from file probing/background indexing and remove duplicated probing.
- Format first-party source/tests, add automated formatting/syntax checks to release CI, and document architecture and the audit.

# 4.4.6

- Remove Tags controls and tag text from library rows while preserving existing saved/source data.
- Show track length and original file size in the audio details editor. Use cached measurements immediately and fill missing lengths asynchronously without blocking editing.
- Persist prepared/synced durations by original source key, including converted Ogg/Opus and M4B tracks.
- Cancel editor extraction on close and clean up background work before quitting; preserve destroyed-window safeguards.
- Check temporary space against the selected extraction output, so thumbnail requests do not require disk space for the entire audiobook.

# 4.4.5

- Remove the collection dropdown and Prepare Audio button from the main library; move optional preparation to Settings. Sync still converts audio automatically.
- Include pending collection arrangements in normal Sync, with a collection-only Sync option when no audio is selected. Keep Sync Collections for copying all needed member audio.
- Show pending/synced collection arrangement status and explain ejecting/leaving USB-storage mode to load player changes.
- Keep controls and quit/eject protection active across the audio and collection stages; cancellation and partial-success messages preserve already completed audio transfers.
- Show Checking player folders during the initial device safety checks, and retain diagnostic logs and transfer progress.

# 4.4.4

- Batch archive track pictures into one extraction, avoiding repeated solid-7z decompression when details opens. Audio remains deferred until preview.
- Limit the editor's icon picker to 500 pictures, preserving assigned icons first, to avoid excessive option lists.
- Reuse measured durations in earlier versions' cached manifests so existing books do not need another audio read to show Length offline.

# 4.4.3

- Add a sortable Length column beside Size, using measured player/preparation durations and cached background discovery for unknown local audio.
- Duration discovery runs one item at a time, pauses for foreground work/editing, keeps originals, and adjusts totals for excluded tracks.
- Explain missing player library records in plain language and tell users to sync the affected item again; use this wording in completion details and Recent Activity.
- Verify resync repairs a missing manifest without deleting Inbox originals or saved listening position.
- Retain fast details, Save / Save and close, inline refresh, transfer debugging, progress and crash fixes from the previous release.

# 4.4.2

- Long duplicate comparisons continue through metadata-only automatic refresh and still pause for device operations.
- Reuse the connection probe and cache unchanged device manifests by the library index checksum; manual Refresh bypasses this cache.
- Report cancellation immediately and cancel archive extraction during transfers/offline preparation.
- Update the desktop smoke test for “Pocket disconnected”.

# 4.4.1

- Guard destroyed Electron windows during quit, activation, notifications and IPC; handle startup failures.
- Convert Ogg Vorbis and Ogg Opus to verified AAC using a streaming worker and native macOS encoder; keep originals.
- Reduce per-chunk USB metadata checks and publish source checking/copy/verification progress with cancellation.
- Restore cached Inbox rows immediately; reuse unchanged metadata and keep the index after failed transfers.
- Open audio details from names/metadata; extract only requested preview files. Add title edit pencils and persistent opening indicators.
- Save keeps details open; Save and close returns to the library. Refresh spins inline, announces importing, and has no overlay.
- Circular collection pictures, one collection per audio item, and Sync Collections copies missing member audio and arrangement.
- Automatic cached duplicate comparisons run only for likely matching imports and pause for foreground work.
- Recognize loose-folder cover aliases/largest artwork and numbered track icons, including local disc scopes.
- Regenerate Finder icons with Apple's standard/Retina tools and version-specific bundle resource names.
- Show measured total audio duration from player manifests; add a friendly-name pencil and “Your audio. Your player.” tagline.

# Pocket Drop changes

## 4.4.0

Numbered archives now import audio_files/ in numeric order, pair images/1.png and images/2.png with the matching files, use images/cover_image.png as both library and player cover, and ignore card.txt/tracks.txt. Larger numbered icons are normalized to 16-pixel PNGs without modifying originals.

1. Audio details lists tracks, supports drag or arrow reordering, renaming, reversible deletion from the edited version, and reassignment of original or imported track icons.
2. Audio previews provide play/pause, seeking, and volume controls through a private, range-capable local media protocol.
3. Audio item titles can be edited without changing Inbox names or playlist identity on Pocket.
4. Cover selection includes Fit/Fill framing in the card's 54 × 85.6 proportions and vertical crop positioning.
5. Prepare audio works while Pocket is disconnected, caches converted audio, and leaves device operations available.
6. Conversion progress includes current file/count, elapsed time, and estimates based on completed conversions. No encoding estimate is inferred from decoder percentages alone.
7. Names, order, exclusions, icon choices, covers, tags and duplicate preferences persist outside the Inbox. Changed sources require a fresh review.
8. Undo removal restores a recent removal to the same Pocket when originals and edits are unchanged.
9. Duplicate comparison hashes audio bytes, distinguishes different editions/order/metadata, and lets a preferred import hide other copies without deleting them.
10. Collections has creation, naming, membership, order, deletion, importing from Pocket, and applying groups to the player. Tags provide additional computer-side organization.
11. Library search includes track names and tags; Audio details has track search, and the library can be filtered by collection.
12. Import/preparation/sync errors include an explanation, next step, affected filenames, and expandable technical details.
13. Sync shows a compact review of additions/updates, file counts, estimated space and current available space. The engine still checks actual capacity before writing.
14. Optional background completion notifications cover preparation, syncing and removal, including work that needs attention.
15. Settings checks public GitHub releases, displays release notes, and opens the correct Intel or Apple Silicon download. Open Downloads opens the release page.

Track deletion keeps Inbox originals. A separate confirmed action moves excluded original files in extracted folders to the system Trash; it does not rewrite ZIP/7z archives. Use Finder's Trash to recover those files. Existing player groups that are not managed here and listening history are preserved when applying collections. A playlist can belong to one player group, with up to 30 groups of 40-character titles; older player software may ignore groups.

## 4.3.1

The supplied purple book/yellow arrow artwork is the Finder app icon, with standard and Retina representations and an app-specific resource name.

## 4.3.0

ZIP/7z and nested audio folders work without required track-list or card-detail files. Complete metadata retains its order; other imports use complete unique disc/track tags or natural numeric path order. Inbox refresh works disconnected in All Audio.
