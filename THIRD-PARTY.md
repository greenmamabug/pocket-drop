# Licensing and provenance

Pocket Drop is distributed under **GPL-3.0-only**, consistent with its use of Studio Pocket's GPL engine. See LICENSE. Complete application source and build instructions accompany the binary. Preserve this source archive with the app when redistributing it. Commercial relicensing rights to Studio Pocket are not granted by Pocket Drop.

## Studio Pocket

- Copyright (C) 2026 Ashworth Digital Ltd.
- Repository: https://github.com/MYO-Studio/studio-pocket
- Pinned revision: `c7e6f377762d25faffa63f32d0df1a688256c9f0` (retrieved 2026-11-06).
- Vendored packages: `packages/library-format`, `packages/sync-engine`.
- Upstream source is preserved in `vendor/`. Only the sync-engine workspace dependency specifier in package.json is adjusted from `workspace:*` to `*` for npm workspaces. Runtime source is unchanged.
- Licence: GPL-3.0-only, or a separate commercial licence from Ashworth Digital Ltd. COPYING.commercial is included where supplied upstream. This distribution uses the GPL option.
- Firmware code, flashing binaries and MediaTek tools are neither included nor invoked.

Pocket Drop's adapter adds safe ZIP access, Chrome archive metadata synthesis, artwork hash comparison, local discovery, USB-volume/identity checks, and a graphical UI. Planning, transfers, removal, state cleanup, and library index writes use the upstream engine.

## Other runtime dependencies

Electron 38.8.6 (MIT, with Chromium and other third-party notices), music-metadata 12.3.4 (MIT), yauzl 3.4.0 (MIT), plist 3.1.0 (MIT), and their locked transitive dependencies. Their licence files are retained in the packaged dependencies; Electron's LICENSE and LICENSES.chromium.html accompany the bundled framework. The macOS binary contains only runtime dependencies. The source package lockfile also lists developer tools and their dependency versions.

The 4.0.1 icon is adapted from artwork supplied by the user; no ownership claim over that supplied reference is made. The earlier vector icon remains in source for provenance. No copyrighted audiobook cover illustrations are bundled into the user's library. Automated test images are synthetic test fixtures or upstream fixtures; screenshots produced by test scripts are explicitly test views, not a representation of the user's collection.

Apple Silicon packaging uses apple-codesign/rcodesign 0.29.0 (MPL-2.0) as an external build tool, not a bundled runtime dependency. Its release URL/checksum are recorded in README. Signing entitlement templates are from @electron/osx-sign (MIT), already pinned in the developer dependency tree. No Apple Developer ID certificate is bundled or claimed.

The MYO Studio website button uses the white MYO Studio logo supplied by the user, obtained as the matching embedded PNG from https://www.myostudio.app on 2026-11-06. It is displayed on a green button linking to that website. No ownership of that mark is claimed. Pocket Drop interface credited to Lindsey Schultz; upstream engine attribution is retained.

## Opus conversion (4.1.0)

ogg-opus-decoder 1.6.16, opus-decoder 0.7.9 and @wasm-audio-decoders/common 9.0.6 by Ethan Halsall are MIT; bundled libopus is BSD. codec-parser 2.5.0 is LGPL-3.0-or-later; its unmodified JavaScript source, original copyright notices and LGPL licence remain in the unpacked runtime, allowing replacement. @eshaz/web-worker 1.2.2 is Apache-2.0; simple-yenc is MIT. Puff's zlib notice and the above licence texts are retained under assets/licenses and/or the packages. Dependency versions/integrity hashes are pinned in package-lock.json. No machine-learning speech enhancement is enabled. macOS /usr/bin/afconvert is invoked from the operating system, not redistributed. FFmpeg is used only as a Linux test encoder and is not included in the app.

## 7z archive support (4.3.0)

7-Zip 25.01 by Igor Pavlov is bundled as a separate command-line program (official macOS universal binary and Linux x64 binary). It is used only for listing, bounded metadata reads, and validated extraction. Licence: LGPL-2.1-or-later, portions BSD-2-Clause/BSD-3-Clause, and the included unRAR restriction; see assets/licenses/7zip-License.txt. Official binary URLs: https://www.7-zip.org/a/7z2501-mac.tar.xz and https://www.7-zip.org/a/7z2501-linux-x64.tar.xz. Corresponding source: https://www.7-zip.org/a/7z2501-src.tar.xz. The source release includes the original source archive and licence. No proprietary Studio Pocket Desktop code is used.

7-Zip upstream archive SHA-256: macOS `26aa75bc262bb10bf0805617b95569c3035c2c590a99f7db55c7e9607b2685e0`; Linux `4ca3b7c6f2f67866b92622818b58233dc70367be2f36b498eb0bdeaaa44b53f4`; corresponding source `ed087f83ee789c1ea5f39c464c55a5c9d4008deb0efe900814f2df262b82c36e`. The macOS universal executable is split into its unmodified architecture slices for native packaging. The reader can be replaced at Pocket Drop.app/Contents/Resources/tools/7zz; replacing it can invalidate an app signature.

The 4.3.1 Finder icon retains the user's supplied purple book/yellow arrow design; an image-editing pass cleaned its transparent perimeter. Explicit standard/Retina ICNS representations are generated by scripts/icons.mjs. Lossless PNG compression and a 512-pixel internal PNG reduce delivery size; the Finder ICNS retains its 1024-pixel representation.
