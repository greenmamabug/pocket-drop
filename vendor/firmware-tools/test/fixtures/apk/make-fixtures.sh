#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Ashworth Digital Ltd
# This file is part of Studio Pocket. It is licensed under GPL-3.0-only, or under a
# commercial licence from Ashworth Digital Ltd (see COPYING.commercial).

#
# Rebuilds the genuinely signed APK fixtures in this folder (APK v1 / JAR signature tests).
#
#   tiny.apk                     AndroidManifest.xml (the real player manifest: app.studiopocket.player,
#                                minSdk 19) + a placeholder classes.dex, deflated, unsigned
#   signed-apksigner.apk         tiny.apk signed v1-only by apksigner with key A
#   signed-jarsigner.apk         tiny.apk signed by jarsigner with key A (signed attributes in the PKCS#7)
#   signed-jarsigner-direct.apk  tiny.apk signed by jarsigner -directsign with key A (no signed attributes);
#                                only when the JDK's jarsigner has -directsign (see below)
#   signed-other-key.apk         tiny.apk signed v1-only by apksigner with key B
#   signed-other-package.apk     the manifest's package rewritten to app.studiopocket.playex, signed by
#                                apksigner with key A
#
# Keys A and B are throwaway RSA 2048 keys generated in a temp dir on every run and deleted
# afterwards; they are never committed. Re-running the script replaces every APK (new keys,
# so new signatures). Each output is checked with `apksigner verify --min-sdk-version 19 -v`.
#
# Finds a JDK (keytool, jarsigner) in $JAVA_HOME, ~/.gradle/jdks/*, then Android Studio's bundled
# JBR; apksigner in $ANDROID_HOME/build-tools/<highest>, else ~/Library/Android/sdk/build-tools/<highest>.
#
# Last generated with:
#   JDK:       OpenJDK 17.0.20.1+1 (Eclipse Adoptium, Gradle-provisioned, ~/.gradle/jdks)
#   apksigner: 0.9 (Android SDK build-tools 37.0.0)
#   zip:       Zip 3.0 (macOS /usr/bin/zip)
# Neither that JDK 17 nor Android Studio's JBR (OpenJDK 21.0.10) accepts `jarsigner -directsign`
# ("Illegal option"), so signed-jarsigner-direct.apk was not produced and is not committed.
#
# Usage: bash packages/firmware-tools/test/fixtures/apk/make-fixtures.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS="fixture-pass"

die() { echo "make-fixtures: $*" >&2; exit 1; }

has_jdk() { [[ -x "$1/bin/keytool" && -x "$1/bin/jarsigner" && -x "$1/bin/java" ]]; }

find_jdk() {
    local candidate
    if [[ -n "${JAVA_HOME:-}" ]] && has_jdk "$JAVA_HOME"; then echo "$JAVA_HOME"; return; fi
    shopt -s nullglob
    for candidate in "$HOME"/.gradle/jdks/* "$HOME"/.gradle/jdks/*/* "$HOME"/.gradle/jdks/*/*/Contents/Home "$HOME"/.gradle/jdks/*/Contents/Home; do
        if has_jdk "$candidate"; then shopt -u nullglob; echo "$candidate"; return; fi
    done
    shopt -u nullglob
    candidate="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
    if has_jdk "$candidate"; then echo "$candidate"; return; fi
    return 1
}

highest_build_tools() {
    local dir="$1/build-tools"
    [[ -d "$dir" ]] || return 1
    local version
    version="$(ls "$dir" | grep -E '^[0-9]+(\.[0-9]+)*$' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"
    [[ -n "$version" && -x "$dir/$version/apksigner" ]] || return 1
    echo "$dir/$version/apksigner"
}

find_apksigner() {
    if [[ -n "${ANDROID_HOME:-}" ]] && highest_build_tools "$ANDROID_HOME"; then return; fi
    highest_build_tools "$HOME/Library/Android/sdk"
}

JAVA_HOME="$(find_jdk)" || die "no JDK with keytool and jarsigner (set JAVA_HOME)"
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"
APKSIGNER="$(find_apksigner)" || die "apksigner not found (set ANDROID_HOME)"
command -v zip >/dev/null || die "zip is required"
command -v python3 >/dev/null || die "python3 is required"

echo "JDK:       $JAVA_HOME ($("$JAVA_HOME/bin/java" -version 2>&1 | head -1))"
echo "apksigner: $APKSIGNER ($("$APKSIGNER" --version))"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- keys ---------------------------------------------------------------------------------
for key in a b; do
    "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$WORK/key-$key.p12" -storetype PKCS12 \
        -storepass "$PASS" -keypass "$PASS" -alias "key-$key" -keyalg RSA -keysize 2048 \
        -validity 10000 -dname "CN=Studio Pocket fixture key $(echo "$key" | tr a-z A-Z)" >/dev/null 2>&1
done

# --- unsigned APKs --------------------------------------------------------------------------
# Same entry order and timestamps on every run, deflated like a Gradle-built APK.
make_apk() { # <manifest> <out>
    local stage="$WORK/stage-$(basename "$2" .apk)"
    mkdir -p "$stage"
    cp "$1" "$stage/AndroidManifest.xml"
    # A placeholder dex: the header magic and zero padding (nothing here parses it).
    printf 'dex\n035\0' > "$stage/classes.dex"
    head -c 104 /dev/zero >> "$stage/classes.dex"
    touch -t 200801010000 "$stage/AndroidManifest.xml" "$stage/classes.dex"
    rm -f "$2"
    (cd "$stage" && zip -q -X -9 "$2" AndroidManifest.xml classes.dex)
}

make_apk "$HERE/AndroidManifest.xml" "$HERE/tiny.apk"

# The other-package manifest: the string-pool entry that is exactly "app.studiopocket.player"
# (UTF-16LE, u16 length 23 before it, u16 NUL after) becomes the same-length "app.studiopocket.playex".
# Fully qualified component names (app.studiopocket.player.MainActivity, ...) are left alone.
python3 -I - "$HERE/AndroidManifest.xml" "$WORK/AndroidManifest-other.xml" <<'PY'
import struct, sys
src, dst = sys.argv[1], sys.argv[2]
old, new = 'app.studiopocket.player', 'app.studiopocket.playex'
assert len(old) == len(new)
data = open(src, 'rb').read()
entry = lambda s: struct.pack('<H', len(s)) + s.encode('utf-16le') + b'\0\0'
if data.count(entry(old)) != 1:
    sys.exit('expected exactly one "%s" string-pool entry' % old)
out = data.replace(entry(old), entry(new))
assert len(out) == len(data)
open(dst, 'wb').write(out)
PY
make_apk "$WORK/AndroidManifest-other.xml" "$WORK/other-package.apk"

# --- signing --------------------------------------------------------------------------------
apksign() { # <key> <in> <out>
    rm -f "$3"
    "$APKSIGNER" sign --ks "$WORK/key-$1.p12" --ks-pass "pass:$PASS" --ks-key-alias "key-$1" --key-pass "pass:$PASS" \
        --v1-signing-enabled true --v2-signing-enabled false --v3-signing-enabled false --v4-signing-enabled false \
        --min-sdk-version 19 --out "$3" "$2"
    rm -f "$3.idsig"
}

jarsign() { # <out> [extra jarsigner flags...]
    local out="$1"; shift
    rm -f "$out"
    "$JAVA_HOME/bin/jarsigner" -keystore "$WORK/key-a.p12" -storetype PKCS12 -storepass "$PASS" -keypass "$PASS" \
        "$@" -signedjar "$out" "$HERE/tiny.apk" key-a >/dev/null
}

OUTPUTS=(signed-apksigner.apk signed-jarsigner.apk signed-other-key.apk signed-other-package.apk)
apksign a "$HERE/tiny.apk" "$HERE/signed-apksigner.apk"
apksign b "$HERE/tiny.apk" "$HERE/signed-other-key.apk"
apksign a "$WORK/other-package.apk" "$HERE/signed-other-package.apk"
jarsign "$HERE/signed-jarsigner.apk"
# Only a jarsigner that lists -directsign makes that fixture; otherwise it is skipped (any existing
# copy is left as it is).
JARSIGNER_HELP="$("$JAVA_HOME/bin/jarsigner" -help 2>&1 || true)"
if [[ "$JARSIGNER_HELP" == *-directsign* ]]; then
    jarsign "$HERE/signed-jarsigner-direct.apk" -directsign
    OUTPUTS+=(signed-jarsigner-direct.apk)
else
    echo "make-fixtures: this jarsigner has no -directsign; signed-jarsigner-direct.apk not rebuilt" >&2
fi

# --- checks ---------------------------------------------------------------------------------
for apk in tiny.apk "${OUTPUTS[@]}"; do
    size=$(wc -c < "$HERE/$apk" | tr -d ' ')
    (( size < 20480 )) || die "$apk is $size bytes (expected under 20 KB)"
done
for apk in "${OUTPUTS[@]}"; do
    echo "== $apk"
    "$APKSIGNER" verify --min-sdk-version 19 -v "$HERE/$apk"
done
echo "make-fixtures: wrote tiny.apk ${OUTPUTS[*]}"
