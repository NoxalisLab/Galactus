#!/bin/bash
# Produce a notarized, stapled Galactus dmg. One command, from a clean tree to
# an artifact a stranger can double click.
#
#   export APPLE_SIGNING_IDENTITY="Developer ID Application: ... (TEAMID)"
#   export APPLE_KEYCHAIN_PROFILE=galactus-notary
#   scripts/macos-release.sh
#
# The two variables above are the whole configuration. Their values are yours:
# no credential is stored, echoed or written to a file by anything in this
# repository. The full list of accepted variables, and how to obtain each one,
# is in docs/RELEASE-SIGNING.md.
#
# What it does, in order:
#
#   1. refuses to start unless the identity really is a Developer ID
#      Application identity that this keychain can use, and unless one complete
#      set of notarization credentials is present. Failing here costs a second;
#      failing after the build costs the build.
#   2. stages the engine, the skills, the vault, the Python runtime and the
#      Rust tooling (prepare-engine.sh)
#   3. signs every staged Mach-O with the Developer ID identity, hardened and
#      timestamped (macos-sign-resources.sh), because Tauri signs the bundle
#      and not its contents
#   4. builds the app and the dmg, passing Galactus.entitlements through the
#      Tauri config merge so that tauri.conf.json itself stays untouched
#   5. notarizes both artifacts, staples both, and prints the Gatekeeper
#      verdict (macos-notarize.sh)
#
# Without a Developer ID identity, this is the wrong script: use
# scripts/build-app.sh, which produces the same app signed with the local
# identity. That build works, and it warns the person who downloads it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ENTITLEMENTS="$ROOT/app/src-tauri/Galactus.entitlements"

rule() { printf '%s\n' "======================================================================"; }

# ------------------------------------------------------------ preflight: id
IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  cat >&2 <<'EOF'
FAIL: APPLE_SIGNING_IDENTITY is not set.

A notarized build needs a Developer ID Application identity, for example

  export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"

Run `security find-identity -v -p codesigning` to see the exact string your
keychain holds. For a local build with no Apple account, use
scripts/build-app.sh instead.
EOF
  exit 1
fi

case "$IDENTITY" in
  "Developer ID Application:"*) : ;;
  *)
    echo "FAIL: APPLE_SIGNING_IDENTITY is not a Developer ID Application identity." >&2
    echo "      Only that kind of certificate can be notarized for distribution" >&2
    echo "      outside the Mac App Store." >&2
    exit 1
    ;;
esac

if ! security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
  echo "FAIL: this keychain has no usable code signing identity matching" >&2
  echo '      APPLE_SIGNING_IDENTITY. Run: security find-identity -v -p codesigning' >&2
  exit 1
fi

# -------------------------------------------------- preflight: notary creds
have_creds=0
creds_kind=""
if [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  have_creds=1; creds_kind="keychain profile"
elif [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  have_creds=1; creds_kind="App Store Connect API key"
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  have_creds=1; creds_kind="Apple ID and app specific password"
fi

if [ "$have_creds" -eq 0 ]; then
  cat >&2 <<'EOF'
FAIL: a Developer ID identity is set but no notarization credentials are.

Signing without notarizing produces the worst of both: a certificate that can
be revoked, and a download that is still refused by Gatekeeper. Set one of

  APPLE_KEYCHAIN_PROFILE
  APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH
  APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID

and run again, or run scripts/build-app.sh for a local build.
See docs/RELEASE-SIGNING.md.
EOF
  exit 1
fi

[ -f "$ENTITLEMENTS" ] || { echo "FAIL: missing $ENTITLEMENTS" >&2; exit 1; }

# ------------------------------------------- preflight: updater signing key
# tauri.conf.json can ask the bundler to produce updater artifacts. When it
# does, the bundler needs the minisign private key, and it discovers that it is
# missing at the very end, after the whole release build. Catch it here, where
# it costs nothing.
UPDATER_ARTIFACTS=0
if grep -q '"createUpdaterArtifacts"[[:space:]]*:[[:space:]]*true' \
     "$ROOT/app/src-tauri/tauri.conf.json" 2>/dev/null; then
  UPDATER_ARTIFACTS=1
  if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
    cat >&2 <<'EOF'
FAIL: tauri.conf.json asks for updater artifacts, but TAURI_SIGNING_PRIVATE_KEY
      is not set. The bundler would compile the whole release and only then
      refuse to sign the update archive.

  export TAURI_SIGNING_PRIVATE_KEY="$(cat <path to your updater private key>)"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<its password, empty if none>"

The updater key is unrelated to the Apple certificate: it is a minisign key
pair whose public half is in tauri.conf.json under plugins.updater.pubkey.
EOF
    exit 1
  fi
fi

rule
echo "GALACTUS RELEASE BUILD"
echo "  identity      : $IDENTITY"
echo "  notarization  : yes, using the $creds_kind"
echo "  entitlements  : ${ENTITLEMENTS#"$ROOT"/}"
if [ "$UPDATER_ARTIFACTS" -eq 1 ]; then
  echo "  updater       : artifacts enabled, minisign key present"
fi
echo "  result        : a dmg that opens with a double click, no warning"
rule
echo

# ------------------------------------------------------- residual dmg volumes
# A dmg left mounted by an interrupted build makes the next bundling step fail
# silently. Same cleanup as scripts/build-app.sh.
for d in $(hdiutil info 2>/dev/null | grep -oE '/dev/disk[0-9]+' | sort -u); do
  if hdiutil info 2>/dev/null | grep -A5 "$d" | grep -qi galactus; then
    echo "detaching residual volume $d"
    hdiutil detach "$d" -force >/dev/null 2>&1 || true
  fi
done
rm -f "$ROOT/app/src-tauri/target/release/bundle/macos/rw."*.dmg 2>/dev/null || true
rm -f "$ROOT/app/src-tauri/target/release/bundle/dmg/rw."*.dmg 2>/dev/null || true

# ------------------------------------------------------------------- content
"$ROOT/app/src-tauri/prepare-engine.sh"

# ----------------------------------------------- sign what Tauri will not sign
echo
"$HERE/macos-sign-resources.sh" "$IDENTITY"

# --------------------------------------------------------------------- build
# tauri.conf.json is owned by another workstream, so the entitlements path is
# injected through the config merge that the Tauri CLI accepts on the command
# line rather than written into the file. A temporary file rather than an inline
# JSON string because the repository path can contain spaces and `npm run` puts
# forwarded arguments back through a shell.
CFGDIR="$(mktemp -d)"
trap 'rm -rf "$CFGDIR"' EXIT
CFG="$CFGDIR/release.conf.json"
printf '{"bundle":{"macOS":{"entitlements":"%s"}}}\n' "$ENTITLEMENTS" > "$CFG"

echo
echo "building with entitlements merged in from ${ENTITLEMENTS#"$ROOT"/}"
cd "$ROOT/app"
npm run tauri build -- --config "$CFG"

APP="$ROOT/app/src-tauri/target/release/bundle/macos/Galactus.app"
[ -d "$APP" ] || { echo "FAIL: no bundle produced" >&2; exit 1; }

shopt -s nullglob
DMGS=("$ROOT"/app/src-tauri/target/release/bundle/dmg/*.dmg)
shopt -u nullglob
if [ "${#DMGS[@]}" -ne 1 ]; then
  echo "FAIL: expected exactly one dmg under target/release/bundle/dmg, found ${#DMGS[@]}" >&2
  exit 1
fi
DMG="${DMGS[0]}"

# ------------------------------------------------------------- content check
echo
echo "bundle contents"
echo "  version : $(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString)"
echo "  skills  : $(ls "$APP/Contents/Resources/packaged/skills" | wc -l | tr -d ' ')"
echo "  notes   : $(find "$APP/Contents/Resources/packaged/vault" -name '*.md' | wc -l | tr -d ' ')"
echo "  engine  : $(strings "$APP/Contents/Resources/engine/libllama.0.dylib" | grep -c 'galactus_h4:') H4 markers"

# The Tauri bundler prefers APPLE_SIGNING_IDENTITY over the signingIdentity
# field in tauri.conf.json, which is still "-". That precedence is not
# documented anywhere we control, so it is checked rather than trusted.
actual="$(codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
case "${actual:-<none>}" in
  "Developer ID Application:"*) ;;
  *)
    echo >&2
    echo "FAIL: the bundle was signed by \"${actual:-nothing, it is ad hoc}\"," >&2
    echo "      not by the requested Developer ID identity. tauri.conf.json" >&2
    echo "      bundle.macOS.signingIdentity is winning over APPLE_SIGNING_IDENTITY." >&2
    echo "      See docs/RELEASE-SIGNING.md, section \"if the identity is ignored\"." >&2
    exit 1
    ;;
esac

# ----------------------------------------------------- notarize, staple, prove
echo
"$HERE/macos-notarize.sh" "$APP" "$DMG"

echo
echo "artifact: $DMG"
