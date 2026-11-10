# Maintenance audit — 4.5.0

This audit fixes reproducible faults and improves maintainability. It is not a
proof that software or USB hardware can never fail.

## Findings addressed

| Finding | Change | Evidence |
| --- | --- | --- |
| Settings/history/cache files could be truncated or overwritten by overlapping writes | Shared serialized, atomic JSON replacement; flush on quit | Ordered writes, injected rename failure, recovery and temporary-file cleanup tests |
| A failed catalog edit could leak into the next queued successful snapshot | Serialize mutations and settings patches as well as persistence; rollback before the next mutation | Concurrent failing/succeeding edit test checks disk and memory |
| Concurrent detail requests could create competing sessions | Enforce one opening request at the workspace and editor boundaries | Overlapping-open regression checks one active session |
| Late metric jobs could continue past shutdown cleanup | Track and drain jobs; reject new work during shutdown | Gated late-job and closed-workspace tests |
| Decoder progress callback failures could escape into the main process | Convert callback errors into rejected work and await worker termination | Actual worker callback-failure regression |
| Cancellation could wait for a complete source/cache hash | Check cancellation while streaming hashes | Cancellation test proves the encoder is never launched |
| Oversized numeric media ranges were accepted after clamping | Validate integer range bounds before clamping | Actual HTTP-style preview range tests |
| Close-to-background could hide the app during active preparation | Share an explicit close/quit policy | Preparation/connection-mode regression |
| Main-process publishing rebuilt the same state snapshot twice | Send the snapshot already emitted by the library | Browser/native desktop regressions |
| Dense source and duplicated metadata probing obscured behavior | Format first-party code; isolate pure metadata and shared probing; add automated checks | Formatter/lint/syntax checks and full functional regressions |

## Verification boundaries

Node tests use real audio and temporary simulated player volumes, including failure
injection, cancelled operations, missing manifests, large files and unchanged
originals. Browser tests cover the actual renderer with controlled state. Electron
tests exercise native IPC, previews, dialogs and shutdown with isolated data. Mac
CI verifies native encoding/editor behavior and both package architectures.

Physical Y2 mount/eject, long USB transfers, firmware-specific collection display,
Finder icon caches and older Mac performance still need hardware checks. Apple
Developer ID signing/notarization remains separate from ad-hoc integrity signing.

## Follow-up priorities

- Profile metadata enumeration, preparation and readback separately on the user's
  Mac/Y2; retain identity checks and verified completion.
- Exercise unplug/power-loss recovery on physical hardware with disposable copies.
- Before a major UI redesign, split the large renderer panels into independent
  components with explicit editor/selection state ownership.
- Keep extending failure-injection coverage when new field reports provide an
  exact operation, phase and diagnostic log.

## Results

104 Node/integration tests pass, including 12 new hardening regressions. Both
browser checks and both real Linux Electron desktop checks pass. Formatting,
undefined-name linting and syntax checks pass. Runtime dependency audit reports
zero known vulnerabilities at test time. Obsolete overlay, checkbox-selection
and collection-filter styles have been removed. Native Mac package/encoder/editor
checks are repeated by release CI.
