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
