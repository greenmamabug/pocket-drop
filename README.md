# Pocket Drop

An open-source Mac app for keeping an audio library on your computer and syncing it to Studio Pocket on an Innioasis Y2.

Pocket Drop by **Lindsey Schultz**, built with Studio Pocket's open-source sync engine by **Ashworth Digital Ltd**. Application code: **GPL-3.0-only**. Third-party components retain their licences; see [THIRD-PARTY.md](THIRD-PARTY.md).

## Download

Choose the app for Apple menu → About This Mac:

- **Intel Mac:** [Download Pocket Drop 4.8.1](https://github.com/greenmamabug/pocket-drop/releases/download/v4.8.1/Pocket-Drop-4.8.1-mac-x64.zip).
- **Apple Silicon (M-series, previous release):** [Download Pocket Drop 4.7.0](https://github.com/greenmamabug/pocket-drop/releases/download/v4.7.0/Pocket-Drop-4.7.0-mac-arm64.zip).
- [All releases and source downloads](https://github.com/greenmamabug/pocket-drop/releases).

These require macOS Monterey 12 or later. New releases currently target Intel Macs. Quit the old app, unzip the download, and drag **Pocket Drop.app** into Applications. Replace the old app there; your Inbox and saved library edits are stored separately. Source ZIPs are optional for ordinary use.

The supplied icon is included as the Finder application icon with standard and Retina sizes. If Finder retains an older cached icon after replacement, relaunch Finder or sign out and back in. The ZIP file has its normal archive icon.

These builds have no Apple Developer ID signature or notarization. The Apple Silicon build uses verified ad-hoc integrity signatures. macOS may require approval through Open/Open Anyway on first launch; keep Gatekeeper enabled.

## Add and organize audio

Download MYO Studio audio from [www.myostudio.app](https://www.myostudio.app), choosing **Actions → Download → Full Archive**, and save it directly into **Downloads/Pocket Drop Inbox**. You don't need to unzip ZIP or 7z archives. Add Files copies archives from elsewhere into the Inbox and keeps their originals. Folders can be placed in the Inbox too, with audio in nested disc/track folders. Each top-level Inbox item is one audio item.

The numbered archive layout is recognized directly, in ZIPs, 7z archives or extracted folders:

```text
audio_files/          numbered audio files (1, 2, 10...)
images/1.png          icon for audio file 1
images/2.png          icon for audio file 2
images/cover_image.png  the card cover in the library and on Pocket
card.txt              ignored
tracks.txt            ignored
```

Numbered audio order takes precedence over embedded track-number tags in this layout. Leading zeros are allowed (01 matches 1.png). Titles use embedded titles or audio filenames. Larger numbered PNG icons are converted into 16-pixel player icons in temporary storage; the originals stay unchanged. Ambiguous or missing icon numbers can be reviewed in Audio details. Nested archive wrappers are supported. Metadata discovery is refreshed on upgrade so an older cached interpretation does not hide the new layout.

Track-list and card-detail files are optional. Complete MYO metadata supplies titles, order and icons. Other imports use complete, unique embedded disc/track tags or natural numeric folder/file order (2 before 10). If those clues do not describe the intended order, click an item's title to open **Audio details**:

- Drag tracks or use the arrows to reorder; rename tracks and the audio item.
- Assign an icon from the item's icon menu to any track, or import a track icon.
- Delete a track from the edited version, or Restore it. At least one track must remain.
- Listen with the audio preview and seek to check a track.
- Choose cover artwork, Fit the whole image or Fill the card proportions, and adjust vertical framing.
- View each track’s measured length and original file size. Missing lengths fill in without blocking the editor.

Click **Save and close** to retain these choices across Refresh and restarts. Edits are stored in the app's support folder; Inbox originals are kept. Audio item identity stays stable when you rename it, so a later sync updates the existing player item. For edited audio already on Pocket, choose **Sync changes** in All Audio. The On Pocket tab retains its removal controls.

For extracted folders only, **Move excluded originals to Trash** is a separate confirmation. It moves selected excluded source files to the system Trash. Finder's Trash can recover them until emptied. It does not rewrite archives or remove a player copy until you sync the edited version. To remove a complete original and its library entry, move its ZIP/7z/folder out of the Inbox in Finder.

## Collections

The Collections area arranges items into player-compatible groups. Create, rename, reorder or delete collections and order their members. Each audio item belongs to one player collection. You can create up to 30 collections with names up to 40 characters.

Choose **Icon**, **Picture**, **Cover trio**, or **Recent covers** in the collection editor. Cover trio lets you select and order up to three member covers; Recent covers follows the player's listening order, then collection order. A collection picture can take the top position in either stack. Live previews use local library artwork and the last connected Pocket's recent list; hover or focus a collection to fan its cards out. Your circular collection picture stays in Pocket Drop, while the player receives a separate portrait picture at 252×400. Older circular pictures gain a portrait version when requested. Sync verifies copied artwork before publishing the new collection metadata.

The new looks require Studio Pocket **0.7.0+** on the Y2; older players keep the icon view. Use Settings → Player software for the existing-installation update wizard. Reading new collections from Pocket preserves their appearance settings and imports their available pictures. Local collections take precedence during merging. Moving an item out of a collection removes it from that collection's chosen covers as well.

Use **Read from Pocket** to bring existing groups into this app. Local membership takes precedence when merging imports. **Sync Collections** confirms the change and writes the open-source groups format atomically. It preserves other groups and listening history. Items assigned here move out of other player groups; missing or edited member audio is synced before the collection arrangement. Choose a custom collection picture, displayed in a circular frame. Group display depends on player software that supports groups. Collection deletion keeps audio in the library and on the player; sync collections to update the player's group list.

## Prepare and sync

In Settings, use **Prepare audio** (shown only for items needing conversion) to convert/cache audio before plugging in Pocket. Preparation runs on the Mac; navigation, history and ejection remain available. Its progress shows the file/count and elapsed time. Estimates begin after completed conversions provide timing samples; long files can make an estimate need updating. Cancel preparation independently of a device transfer.

MP3 and AAC in M4A/M4B/AAC are supported. Ogg Vorbis and Ogg Opus (including .ogg files) are converted to AAC-LC on Sync or Prepare using a streaming WASM decoder and macOS afconvert (96 kb/s mono, 192 kb/s stereo). Prepared audio is cached and verified before reuse. Getting AAC directly avoids another lossy encoding step. Other recognized audio types receive an unsupported-format message instead of being silently skipped. Source audio, encryption, file-count, file-size and extraction protections still apply: up to 500 tracks per item in the player format, 20,000 archive entries, 4 GB per file and 12 GB per imported item.

Connect with a USB data cable and **turn on USB storage when prompted on your device**. The first onboard volume is Y2 MAIN. Create its library if prompted. Select audio and click Sync; review additions/updates, file counts and estimated space. Actual free space is checked before writing. Only onboard audio storage is supported by this version.

**Refresh** beside Audio Library works disconnected; use **All Audio** to see local items. Not on Pocket requires a connected player for comparison. Background discovery reads metadata and filenames, without decoding or hashing every book. Likely matching imports are compared quietly in the background, cached by source fingerprint, and paused for foreground operations. Other full comparisons run only for explicitly requested preparation or syncing.

On Pocket, choose items for removal and use the red removal action. Original files stay in the Inbox. **Undo removal** can restore the most recent local removal to the same player, provided originals and saved edits are unchanged.

Use **Eject** beside the player name before unplugging. It ejects onboard storage and a mounted Y2 external volume without force; separate USB disks require a confirmation identifying both. Storage can rename the onboard Finder drive using its stable UUID; clicking the player name edits only its friendly app name.

## Other controls

- Compare duplicates hashes audio to distinguish identical audio, different ordering and other editions. Choosing a preferred import hides other copies; restore hidden imports in Settings. All Inbox copies are kept.
- Error details explain the problem, suggest a next step, list affected filenames and tuck technical details behind an expander.
- Settings controls library/app text size, title-column width, update frequency, opening at device connection, conversion cache and optional background completion notifications.
- Check for updates uses this public GitHub repository, shows release notes and selects the correct Mac architecture. Downloads open in your browser; installing is manual.
- Audio, edits and local diagnostic logs stay on your computer or player. Update checks request public GitHub release metadata. Nothing uploads your audio automatically.

## Build from source

Node 22 or later, npm, Python 3 and the supplied source are required:

```sh
npm ci
npm test
npm start
```

The engine/library-format source is vendored at its recorded upstream revision, with original copyright and licence notices. Their runtime TypeScript source is unchanged; see THIRD-PARTY.md.

Intel Mac packaging:

```sh
npm run dist:mac:intel
```

For the supplied Apple Silicon Linux cross-build, set `POCKET_DROP_CODESIGN_TOOL` to apple-codesign/rcodesign 0.29.0, then run `npm run dist:mac:apple-silicon`. The script signs the ARM64 app ad hoc and verifies architecture, page hashes, entitlement/resource seals. Tool release: https://github.com/indygreg/apple-platform-rs/releases/tag/apple-codesign%2F0.29.0. This external build tool is not bundled into the app. macOS signing/notarization and real hardware checks remain separate.

`node scripts/icons.mjs` generates the icon set. `scripts/after-pack.cjs` assigns PocketDrop.icns in Info.plist before signing. Native 7-Zip readers and their corresponding source archive are under assets/tools, with upstream URLs/checksums in THIRD-PARTY.md.

Additional checks:

```sh
node scripts/ui-check.mjs
node scripts/studio-ui-check.mjs
node scripts/desktop-check.mjs
node scripts/studio-desktop-check.mjs
```

Browser checks need Playwright's Chromium. Linux native Electron checks need an X server (for example Xvfb). Desktop test entry points use isolated temporary data and are excluded from packaged apps.

## Validation and limits

[TEST-RESULTS.md](TEST-RESULTS.md) records actual checks. Node tests use real audio fixtures and simulated player filesystems. Browser and real Linux Electron checks cover UI/IPC, preview seeking and native image processing. Mac CI additionally checks native AAC encoding and the editor. These tests do not establish USB ejection/rename, notifications, Gatekeeper or player hardware compatibility. The user has reported earlier Intel versions work on their Mac. User-provided large audiobook archives exceeded the chat attachment transfer limit and were not inspected.

[CHANGELOG.md](CHANGELOG.md) describes this release's features. Preserve the GPL licence, notices and corresponding source when redistributing. Studio Pocket Desktop's proprietary code is not included; the app uses its openly licensed engine and library format.

## Audio length

Length beside Size shows measured audio duration and can be sorted. Existing Pocket manifests and prepared audio provide durations immediately. Unknown local items are measured one at a time in the background and cached by source fingerprint; the library and editor do not wait for this. A dash means the length is not available yet. Foreground transfers, preparation and editing pause this discovery. Excluded tracks are removed from the displayed total. Refresh does not reread unchanged audio.

If an existing book’s library record (manifest.json) is missing on Pocket, keep its original in the Inbox and sync that book again. Pocket Drop regenerates the record and verifies the copy; this does not require the optional tracks.txt or card.txt download files. Diagnostics and transfer progress from the previous stability update are retained.

## Syncing collection changes

The main Audio Library has no collection dropdown or Prepare Audio button. Sync handles needed audio conversion automatically; optional offline preparation is in Settings.

Normal **Sync** now includes pending collection changes, and is available for collection-only changes even when no audio is selected. It copies the selected audio and the collection arrangement. **Sync Collections** on the Collections page additionally copies any missing member audio. Creating or editing a collection saves it locally until you click one of these Sync buttons. Pending/synced status is displayed on that page.

After syncing, eject Pocket and leave USB-storage mode so the player can reload its library. The inspected open-source player hides empty collections and collections with no available member audio. Audio/collection sync does not change player software.

## Player software

Firmware installation and updating are not included in Pocket Drop. Audio-library syncing is separate from player software. Existing backup folders and saved images are left untouched.

## Track details

The editor has no Tags controls. Each track shows its measured length and original file size under the filename. Sizes are available without extracting audio; previously measured lengths appear immediately. Other lengths fill in asynchronously while editing remains available. Closing details cancels archive extraction for its metrics. Prepared/synced audio retains durations by original track key so reordering and reopening do not require another probe. Saving keeps any pre-existing tag data; removing the UI does not delete original metadata.

## Maintainer guide

See [Architecture](docs/ARCHITECTURE.md) for module boundaries and invariants, and
[Maintenance audit](docs/AUDIT.md) for fixes, regression evidence and remaining
hardware validation. Run `npm run check`, `npm test`, `npm run test:ui` and
`npm run test:desktop` as described there. `npm run format` keeps first-party
code consistent. Vendored upstream code is excluded from formatting.


## Track icon picker and Yoto account

Choose a track’s **Choose icon** button to browse its existing icons as pictures, or **Find icon…** to search standard Yoto icons and Yotoicons.com. Selected icons are normalized to 16×16 PNGs and saved locally with your edits. These two public catalogues work without an account.

Settings includes optional Yoto account setup for personal icons. Register your own public client in Yoto’s developer dashboard with `http://127.0.0.1:8787/callback` as its redirect URL; no client secret is required. Sign-in uses the browser, PKCE and state validation. Tokens are encrypted with the operating system credential store and are never sent to the icon community site. Real account authorization requires your registered client; automated tests use a simulated account service.

Collection **Cover trio** previews label the first/front, second/left and third/right covers. Hover or focus the editor preview to fan the cards out. The collection page shows a Cover trio already fanned. The player needs Studio Pocket 0.7.0 or later to display these collection looks; older versions use the collection icon.
