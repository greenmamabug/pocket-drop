#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Ashworth Digital Ltd
# This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
# commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

# A stand-in for mtkclient's `mtk [--serialport DETECT] [--loader <da>] [--preloader <file>] script <plan>` used by the tests.
# FAKE_MTK_DEVICE names a file that plays the eMMC user area; every plan line is
#   ro <hex start> <hex len> <out>   copy that range of the device file into <out>
#   wo <hex start> <hex len> <img>   write <img> (whole file, must fit in <len>) at <start>
# Output mimics mtkclient's lines closely enough for parseMtkLine. FAKE_MTK_FAIL=<n> makes
# the n-th command fail the way the real tool failed on 2026-10-19 (data ack).
# FAKE_MTK_CID / FAKE_MTK_NO_CID set or drop the printed eMMC id; FAKE_MTK_SLOW=<s> sleeps before each command.
# STUDIO_POCKET_EXPECT_CID=<32 hex> plays the patched mtkclient's identity check (scripts/patch-mtkclient.py,
# Library/mtk_main.py): before the first command it confirms the printed id, or refuses the plan
# (exit 102 for another player, 103 when no id was printed).
# STUDIO_POCKET_PROBE=1 with no arguments plays the capability probe (patch 10, mtk.py): it prints
# "Studio Pocket - identity gate 1" and exits 0 before any argument is parsed.
# FAKE_MTK_UNPATCHED=1 plays an mtkclient built before patches 9 and 10: the probe gets the usage
# line and exit 2, and the identity check is skipped. FAKE_MTK_NO_CONFIRM=1 plays a tool that
# answers the probe but never prints the confirmation (patch 10 present, patch 9 broken).
# --loader <file> plays mtkclient's DA by path: it must exist ("Couldn't find loader", exit 1, as the
# real tool) and is announced as "Using custom loader: <file>". --preloader <file> likewise.
# FAKE_MTK_DRAM=1 plays an agent that asks for a DRAM configuration: "DRAM config needed for : ...",
# then, without --preloader, "Preloader needed due to dram config." and exit 1 (the bundles have no
# Loader/Preloader/ folder to look in); FAKE_MTK_DRAM=found plays a venv whose folder had a match ("Detected preloader: ...").
set -euo pipefail
if [ "${STUDIO_POCKET_PROBE:-}" = "1" ]; then
  if [ "${FAKE_MTK_UNPATCHED:-0}" = "1" ]; then echo "usage: mtk [-h] [--serialport [SERIALPORT]] command ..." >&2; exit 2; fi
  echo "Studio Pocket - identity gate 1"
  exit 0
fi
# FAKE_MTK_ARGV_FILE=<file> records the session's arguments there, one per line.
[ -z "${FAKE_MTK_ARGV_FILE:-}" ] || printf '%s\n' "$@" > "$FAKE_MTK_ARGV_FILE"
while [ $# -gt 0 ]; do
  case "$1" in
    --serialport) shift 2 ;;
    --loader) LOADER="$2"; shift 2 ;;
    --preloader) PRELOADER="$2"; shift 2 ;;
    script) PLAN="$2"; shift 2 ;;
    *) echo "fake-mtk: unexpected argument $1" >&2; exit 2 ;;
  esac
done
[ -n "${PLAN:-}" ] || { echo "fake-mtk: no script" >&2; exit 2; }
[ -n "${FAKE_MTK_DEVICE:-}" ] || { echo "fake-mtk: FAKE_MTK_DEVICE not set" >&2; exit 2; }
if [ -n "${LOADER:-}" ]; then
  [ -f "$LOADER" ] || { echo "Couldn't find loader $LOADER :("; exit 1; }
  echo "DAconfig - Using custom loader: $LOADER"
fi
if [ -n "${PRELOADER:-}" ]; then
  [ -f "$PRELOADER" ] || { echo "fake-mtk: no preloader $PRELOADER" >&2; exit 1; }
  echo "Main - Using preloader: $PRELOADER"
fi
echo "Preloader - Status: Waiting for PreLoader VCOM, please reconnect mobile/iot device to brom mode"
echo "DeviceClass - Detected 0xe8d:0x2000 device at: /dev/cu.fake"
echo "Port - Handshake successful."
echo "DALegacy - Uploading legacy da..."
printf 'Progress: |██████████| 100.0%% Stage 2: (0x286BC/0x286BC), 250.0 KB/s\r\n'
if [ "${FAKE_MTK_DRAM:-0}" != "0" ]; then
  echo "DALegacy - DRAM config needed for : 150100463732324d42"
  [ "$FAKE_MTK_DRAM" != "found" ] || echo "Detected preloader: /venv/mtkclient/Loader/Preloader/preloader_y2.bin"
  [ -n "${PRELOADER:-}" ] || [ "$FAKE_MTK_DRAM" = "found" ] || { echo "DALegacy - Preloader needed due to dram config."; exit 1; }
fi
echo "DALegacy - Connected to stage2"
CID=""
[ "${FAKE_MTK_NO_CID:-0}" = "1" ] || CID="${FAKE_MTK_CID:-1500aa0100a1b2c3d4e5f6012345abcd}"
[ -z "$CID" ] || echo "m_emmc_cid = $CID"
if [ -n "${STUDIO_POCKET_EXPECT_CID:-}" ] && [ "${FAKE_MTK_UNPATCHED:-0}" != "1" ] && [ "${FAKE_MTK_NO_CONFIRM:-0}" != "1" ]; then
  expected="$(printf '%s' "$STUDIO_POCKET_EXPECT_CID" | tr 'A-F' 'a-f')"
  connected="$(printf '%s' "$CID" | tr 'A-F' 'a-f')"
  if [ -z "$connected" ]; then
    echo "Studio Pocket - could not confirm which player is connected; refusing to run the plan"
    exit 103
  elif [ "$connected" != "$expected" ]; then
    echo "Studio Pocket - wrong player: expected …${expected: -8}, connected …${connected: -8}; refusing to run the plan"
    exit 102
  fi
  echo "Studio Pocket - player identity confirmed …${connected: -8}"
fi
# Real mtkclient prints "Handling da commands" only outside script mode, so the fake does not
# by default; FAKE_MTK_LEGACY_LINE=1 prints it anyway (the gates treat it as a command start too).
[ "${FAKE_MTK_LEGACY_LINE:-0}" != "1" ] || echo "Main - Handling da commands ..."
n=0
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  n=$((n + 1))
  set -- $line
  cmd="$1"; start="$2"; len="$3"; file="$4"
  sleep "${FAKE_MTK_SLOW:-0}"
  if [ "${FAKE_MTK_FAIL:-0}" = "$n" ]; then
    echo "DaHandler - Writing offset $start with length $len"
    printf 'Progress: |██--------| 15.0%% Write: (0x7B00000/%s), 1.87 MB/s\r\n' "$len"
    echo "DALegacy - [LIB]: Data ack failed for sdmmc_write_data at offset 0x7b00000: got (nothing in 60 s)"
    echo "Failed to write $file to offset $start with length $len."
    exit 1
  fi
  case "$cmd" in
    ro)
      python3 - "$FAKE_MTK_DEVICE" "$start" "$len" "$file" <<'PY'
import sys
dev, start, length, out = sys.argv[1], int(sys.argv[2], 16), int(sys.argv[3], 16), sys.argv[4]
with open(dev, 'rb') as f, open(out, 'wb') as o:
    f.seek(start)
    remaining = length
    while remaining > 0:
        chunk = f.read(min(remaining, 1 << 24))
        if not chunk:
            chunk = b'\0' * min(remaining, 1 << 24)
        o.write(chunk)
        remaining -= len(chunk)
PY
      printf 'Progress: |█████-----| 50.0%% Read: (0x1000/%s), 2.5 MB/s\r' "$len"
      printf 'Progress: |██████████| 100.0%% Read: (%s/%s), 2.5 MB/s\n' "$len" "$len"
      echo "Dumped offset $start with length $len as $file."
      ;;
    wo)
      echo "DaHandler - Writing offset $start with length $len"
      python3 - "$FAKE_MTK_DEVICE" "$start" "$len" "$file" <<'PY'
import os, sys
dev, start, length, img = sys.argv[1], int(sys.argv[2], 16), int(sys.argv[3], 16), sys.argv[4]
size = os.path.getsize(img)
if size > length:
    print(f"fake-mtk: image {size} B larger than {length} B", file=sys.stderr); sys.exit(3)
with open(img, 'rb') as f, open(dev, 'r+b') as d:
    d.seek(start)
    while True:
        chunk = f.read(1 << 24)
        if not chunk:
            break
        d.write(chunk)
PY
      printf 'Progress: |██████████| 100.0%% Write: (%s/%s), 4.0 MB/s\n' "$len" "$len"
      echo "Wrote $file to offset $start with length $len."
      ;;
    *) echo "fake-mtk: unsupported command $cmd" >&2; exit 2 ;;
  esac
done < "$PLAN"
exit 0
