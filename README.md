# Pocket Drop

An open-source Mac app for keeping an audio library on your computer and syncing it to Studio Pocket on an Innioasis Y2.

Pocket Drop by **Lindsey Schultz**, built with Studio Pocket's open-source sync engine by **Ashworth Digital Ltd**. Application code: **GPL-3.0-only**. Third-party components retain their licences; see [THIRD-PARTY.md](THIRD-PARTY.md).

## Download

Choose the app for Apple menu → About This Mac:

- **Intel Mac:** [Download Pocket Drop 4.4.0](https://github.com/greenmamabug/pocket-drop/releases/download/v4.4.0/Pocket-Drop-4.4.0-mac-x64.zip).
- **Apple Silicon (M-series):** [Download Pocket Drop 4.4.0](https://github.com/greenmamabug/pocket-drop/releases/download/v4.4.0/Pocket-Drop-4.4.0-mac-arm64.zip).
- [All releases and source downloads](https://github.com/greenmamabug/pocket-drop/releases).

Both require macOS Monterey 12 or later and contain the same app features. Quit the old app, unzip the download, and drag **Pocket Drop.app** into Applications. Replace the old app there; your Inbox and saved library edits are stored separately. Source ZIPs are optional for ordinary use.

The supplied icon is included as the Finder application icon with standard and Retina sizes. If Finder retains an older cached icon after replacement, relaunch Finder or sign out and back in. The ZIP file has its normal archive icon.

These builds have no Apple Developer ID signature or notarization. The Apple Silicon build uses verified ad-hoc integrity signatures. macOS may require approval through Open/Open Anyway on first launch; keep Gatekeeper enabled.

## Add and organize audio

Download MYO Studio audio from [www.myostudio.app](https://www.myostudio.app), choosing **Actions → Download → Full Archive**, and save it directly into **Downloads/Pocket Drop Inbox**. You don't need to unzip ZIP or 7z archives. Add Files copies archives from elsewhere into the Inbox and keeps their originals. Folders can be placed in the Inbox too, with audio in nested disc/track folders. Each top-level Inbox item is one audio item.

Track-list and card-detail files are optional. Complete MYO metadata supplies titles, order and icons. Other imports use complete, unique embedded disc/track tags or natural numeric folder/file order (2 before 10). If those clues do not describe the intended order, click an item's title to open **Audio details**:

- Drag tracks or use the arrows to reorder; rename tracks and the audio item.
- Assign an icon from the item's icon menu to any track, or import a track icon.
- Delete a track from the edited version, or Restore it. At least one track must remain.
- Listen with the audio preview and seek to check a track.
- Choose cover artwork, Fit the whole image or Fill the card proportions, and adjust vertical framing.
- Add comma-separated tags. Library search includes track titles and tags.

Click **Save changes** to retain these choices across Refresh and restarts. Edits are stored in the app's support folder; Inbox originals are kept. Audio item identity stays stable when you rename it, so a later sync updates the existing player item. For edited audio already on Pocket, choose **Sync changes** in All Audio. The On Pocket tab retains its removal controls.

For extracted folders only, **Move excluded originals to Trash** is a separate confirmation. It moves selected excluded source files to the system Trash. Finder's Trash can recover them until emptied. It does not rewrite archives or remove a player copy until you sync the edited version. To remove a complete original and its library entry, move its ZIP/7z/folder out of the Inbox in Finder.

## Collections

The Collections area arranges items into player-compatible groups. Create, rename, reorder or delete collections and order their members. Each audio item belongs to one player collection; tags can span multiple subjects. You can create up to 30 collections with names up to 40 characters.

Use **Import from Pocket** to bring existing groups into this app. Local membership takes precedence when merging imports. **Apply to Pocket** confirms the change and writes the open-source groups format atomically. It preserves other groups and listening history. Items assigned here move out of other player groups; missing audio stays listed locally and becomes visible on the player after its audio is synced. Group display depends on player software that supports groups. Collection deletion keeps audio in the library and on the player; apply collections to update the player's group list.

## Prepare and sync

Use **Prepare audio** or **Save & prepare audio** to convert/cache audio before plugging in Pocket. Preparation runs on the Mac; navigation, history and ejection remain available. Its progress shows the file/count and elapsed time. Estimates begin after completed conversions provide timing samples; long files can make an estimate need updating. Cancel preparation independently of a device transfer.

MP3 and AAC in M4A/M4B/AAC are supported. Opus is converted to AAC-LC on Sync or Prepare using a streaming WASM decoder and macOS afconvert (96 kb/s mono, 192 kb/s stereo). Prepared audio is cached and verified before reuse. Getting AAC directly avoids another lossy encoding step. Other recognized audio types receive an unsupported-format message instead of being silently skipped. Source audio, encryption, file-count, file-size and extraction protections still apply: up to 500 tracks per item in the player format, 20,000 archive entries, 4 GB per file and 12 GB per imported item.

Connect with a USB data cable and **turn on USB storage when prompted on your device**. The first onboard volume is Y2 MAIN. Create its library if prompted. Select audio and click Sync; review additions/updates, file counts and estimated space. Actual free space is checked before writing. Only onboard audio storage is supported by this version.

**Refresh** beside Audio Library works disconnected; use **All Audio** to see local items. Not on Pocket requires a connected player for comparison. Background discovery reads metadata and filenames, without decoding or hashing every book. Full comparisons run for explicitly requested preparation, duplicate comparison or syncing.

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

[TEST-RESULTS.md](TEST-RESULTS.md) records actual checks. Node tests use real audio fixtures and simulated player filesystems. Browser and real Linux Electron checks cover UI/IPC, preview seeking and native image processing. Those do not establish native macOS AAC encoding, USB ejection/rename, notifications, Gatekeeper or player hardware compatibility. The user has reported earlier Intel versions work on their Mac. User-provided large audiobook archives exceeded the chat attachment transfer limit and were not inspected.

[CHANGELOG.md](CHANGELOG.md) describes this release's features. Preserve the GPL licence, notices and corresponding source when redistributing. Studio Pocket Desktop's proprietary code is not included; the app uses its openly licensed engine and library format.
