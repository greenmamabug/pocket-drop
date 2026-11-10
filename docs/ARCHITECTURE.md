# Pocket Drop architecture

Pocket Drop is an Electron GUI around the GPL Studio Pocket engine. The application
adapts inputs and manages user intent; the vendored engine defines the player
format and stages transfers. Vendor code is kept separate and is not reformatted.

## Boundaries

| Layer | Responsibility | Modules |
| --- | --- | --- |
| Desktop host | Trusted IPC sender checks, native dialogs, monitoring, shutdown | `main`, `studio-ipc`, `window-lifecycle`, `background` |
| Operations | Coordinate selected audio, collections, edits, preparation | `workspace`, `library` |
| Sources | Validate paths, inspect/extract ZIP/7z/folders, convert when needed | `archive`, `seven-zip`, `convert-audio`, `opus-worker` |
| Device | Pin volume identity, reject links, stage/copy/verify, write groups | `device`, `volumes`, `eject` |
| Player software | Pinned release verification, isolated upstream firmware engine, confirmation and recovery journal | `player-release`, `player-task`, `player-worker`, `player-runner`, `player-updater`, `player-ipc` |
| Persistence | Serialize mutations and atomically replace JSON | `catalog`, `settings-store`, `atomic-json` |
| Metadata | Pure calculations separate from actual file probing | `audio-metadata`, `collection-state`, `audio-probe` |
| Background | Quiet duration/duplicate discovery, cancellation, cache reuse | `duration-index`, workspace duplicate scheduler |
| Renderer | Display state, collect intent, preserve editor drafts | `ui/app.js`, `ui/studio.js` |

Imports flow from orchestration to adapters. Pure metadata calculations do not
import archive extraction or background schedulers. Renderer code has no Node
access; the preload exposes IPC and OS-backed drag/drop paths.

## Invariants

- Inbox originals are read-only during preparation/sync. Explicit original-to-Trash
  is a separately confirmed action.
- A volume identity is pinned before device mutations and checked around writes.
- Transfer completion follows readback verification. A collection-write failure
  after audio finishes is reported as partial success.
- Background duration/duplicate work does not own the global device busy flag and
  yields to explicit work. Editor extraction is cancelled on close.
- User edit mutations run sequentially and roll back on failed persistence. JSON
  replacements use unique same-directory temporary files and serialized renames.
- Quit blocks on transfers/preparation; passive jobs are cancelled/drained and
  pending persistence is flushed. New IPC work is rejected during shutdown.
- A cached duration/conversion is associated with a source fingerprint. Edit
  revisions determine which prepared variant is current.

## Development and review

`npm run check` checks consistent formatting, undefined names and first-party JavaScript syntax. Development tools require Node 22.13 or newer; installed Mac apps include their own runtime.
`npm test` builds the vendored libraries and runs real filesystem/codec integration
tests. `npm run test:ui` runs browser checks with Playwright Chromium installed.
`npm run test:desktop` needs an available display on Linux; Mac release CI runs
native editor and encoder checks.

Add regression tests for observed failure modes. Prefer a small boundary adapter
or pure helper over another UI-specific copy of persistence or metadata logic.
Avoid replacing the staged-transfer engine or removing integrity checks to improve
benchmark numbers. Profile real USB hardware separately from simulated filesystems.
