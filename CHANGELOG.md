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
