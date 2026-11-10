#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
set -eu
PD_SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
PD_APP='/Applications/Pocket Drop.app'
if [ ! -x "$PD_APP/Contents/MacOS/Pocket Drop" ]; then
  echo 'Install Pocket Drop 4.7.4 in Applications first.'
  exit 1
fi
exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 "$PD_APP/Contents/MacOS/Pocket Drop" "$PD_SCRIPT_DIR/terminal-player-recovery.mjs" "$@"
