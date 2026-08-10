#!/bin/bash
# Notarize, staple and then actually verify a Developer ID build of Galactus.
#
#   scripts/macos-notarize.sh <Galactus.app> [<Galactus.dmg>]
#
# The verification at the end is the point of this script. A build that says
# "signed" and a build that a stranger can double click are different things,
# and the only way to tell them apart is to ask Gatekeeper the same question it
# will be asked on the user's machine:
#
#   spctl --assess --type execute      is this app allowed to run
#   xcrun stapler validate             is the ticket on the disk image itself,
#                                      so it still works with no network
#   codesign --verify --deep --strict  is every nested signature intact
#
# All three are printed, none is assumed.
#
# CREDENTIALS. Nothing here is stored, echoed or written to a file. Exactly one
# of the following three sets is read from the environment, in this order:
#
#   1. APPLE_KEYCHAIN_PROFILE
#      The name of a profile created once, by you, with
#        xcrun notarytool store-credentials
#      This is the recommended local path: no secret ever reaches a command
#      line, an environment variable or a log.
#
#   2. APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH
#      App Store Connect API key. APPLE_API_KEY is the key id, APPLE_API_KEY_PATH
#      is the path to the .p8 file on this machine. Same trio the Tauri bundler
#      reads, so a build configured for one is configured for the other.
#
#   3. APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
#      Apple ID plus an app specific password (not the account password).
#
# Idempotent: an artifact that already carries a stapled ticket is not
# resubmitted, so this can be re-run after a partial failure.
set -euo pipefail

APP="${1:?usage: macos-notarize.sh <Galactus.app> [<Galactus.dmg>]}"
DMG="${2:-}"

[ -d "$APP" ] || { echo "FAIL: $APP is not an app bundle" >&2; exit 1; }
if [ -n "$DMG" ] && [ ! -f "$DMG" ]; then
  echo "FAIL: $DMG is not a file" >&2
  exit 1
fi

rule() { printf '%s\n' "----------------------------------------------------------------------"; }

# ------------------------------------------------------------ authentication
AUTH=()
AUTH_KIND=""
if [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  AUTH=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
  AUTH_KIND="keychain profile ($APPLE_KEYCHAIN_PROFILE)"
elif [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ]; then
  [ -f "$APPLE_API_KEY_PATH" ] || { echo "FAIL: APPLE_API_KEY_PATH does not point to a file" >&2; exit 1; }
  AUTH=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
  AUTH_KIND="App Store Connect API key"
elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  AUTH=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
  AUTH_KIND="Apple ID and app specific password"
else
  cat >&2 <<'EOF'
FAIL: no notarization credentials in the environment.

Set exactly one of these sets and re-run. The values are yours; this script
never writes them anywhere.

  APPLE_KEYCHAIN_PROFILE
  APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH
  APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID

See docs/RELEASE-SIGNING.md.
EOF
  exit 1
fi
echo "notarization credentials: $AUTH_KIND"

# ------------------------------------------------------------------ preflight
# Catch locally, in a second, what the notary service would tell us in five
# minutes: a nested binary that is ad hoc signed, unhardened or untimestamped.
echo
echo "preflight on the nested binaries of $(basename "$APP")"
problems=0
checked=0
while IFS= read -r -d '' f; do
  file -b "$f" 2>/dev/null | grep -q 'Mach-O' || continue
  checked=$((checked + 1))
  info="$(codesign -dvv "$f" 2>&1 || true)"
  rel="${f#"$APP"/}"
  case "$info" in
    *"Authority=Developer ID Application"*) : ;;
    *) echo "  NOT Developer ID signed: $rel"; problems=$((problems + 1)); continue ;;
  esac
  case "$info" in
    *"flags="*"runtime"*) : ;;
    *) echo "  hardened runtime missing: $rel"; problems=$((problems + 1)) ;;
  esac
  case "$info" in
    *"Timestamp="*) : ;;
    *) echo "  no secure timestamp: $rel"; problems=$((problems + 1)) ;;
  esac
done < <(find "$APP" -type f \( -perm -u+x -o -name '*.dylib' -o -name '*.so' \) -print0)

# get-task-allow is a debugging entitlement. Its presence is an automatic
# rejection, and it is easy to leak in from a stray entitlements file.
if codesign -d --entitlements - --xml "$APP" 2>/dev/null | grep -q 'get-task-allow'; then
  echo "  com.apple.security.get-task-allow is present on the app bundle"
  problems=$((problems + 1))
fi

if [ "$problems" -gt 0 ]; then
  echo
  echo "FAIL: $problems problem(s) across $checked binaries. The notary service" >&2
  echo "      would reject this submission. Did scripts/macos-sign-resources.sh run?" >&2
  exit 1
fi
echo "  $checked binaries: Developer ID, hardened, timestamped"

# ---------------------------------------------------------------- submission
submit() {
  local path="$1"
  local label
  label="$(basename "$path")"

  if xcrun stapler validate "$path" >/dev/null 2>&1; then
    echo "  $label already carries a stapled ticket, not resubmitting"
    return 0
  fi

  local payload="$path"
  local tmpdir=""
  if [ -d "$path" ]; then
    # notarytool takes a zip, a dmg or a pkg. An app bundle has to be zipped,
    # and ditto is the only archiver that preserves the signature.
    tmpdir="$(mktemp -d)"
    payload="$tmpdir/$label.zip"
    /usr/bin/ditto -c -k --keepParent --sequesterRsrc "$path" "$payload"
  fi

  echo "  submitting $label to the Apple notary service, waiting for the verdict"
  local out status id
  if ! out="$(xcrun notarytool submit "$payload" "${AUTH[@]}" --wait --output-format json 2>&1)"; then
    echo "FAIL: notarytool submit failed for $label" >&2
    printf '%s\n' "$out" >&2
    if [ -n "$tmpdir" ]; then rm -rf "$tmpdir"; fi
    return 1
  fi
  if [ -n "$tmpdir" ]; then rm -rf "$tmpdir"; fi

  status="$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("status",""))' 2>/dev/null || true)"
  id="$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("id",""))' 2>/dev/null || true)"

  if [ "$status" != "Accepted" ]; then
    echo "FAIL: notarization of $label came back \"$status\"" >&2
    printf '%s\n' "$out" >&2
    if [ -n "$id" ]; then
      echo "--- notary log $id ---" >&2
      xcrun notarytool log "$id" "${AUTH[@]}" >&2 || true
    fi
    return 1
  fi
  echo "  accepted (submission $id)"

  echo "  stapling the ticket into $label"
  xcrun stapler staple "$path"
}

echo
echo "notarization"
submit "$APP"
if [ -n "$DMG" ]; then submit "$DMG"; fi

# -------------------------------------------------------------- verification
echo
rule
echo "VERIFICATION, as Gatekeeper will see it on the user's machine"
rule

echo
echo "[1/6] codesign --verify --deep --strict"
codesign --verify --deep --strict --verbose=2 "$APP"

echo
echo "[2/6] signing authority and hardened runtime"
codesign -dvv "$APP" 2>&1 | grep -E '^(Authority|TeamIdentifier|CodeDirectory|Timestamp)' | sed 's/^/  /'

echo
echo "[3/6] entitlements actually embedded in the app"
if codesign -d --entitlements - --xml "$APP" 2>/dev/null | grep -q '<key>'; then
  codesign -d --entitlements - --xml "$APP" 2>/dev/null | sed 's/^/  /'
else
  echo "  none"
fi

echo
echo "[4/6] xcrun stapler validate"
xcrun stapler validate "$APP" | sed 's/^/  /'
if [ -n "$DMG" ]; then xcrun stapler validate "$DMG" | sed 's/^/  /'; fi

echo
echo "[5/6] spctl --assess --type execute"
assess="$(spctl --assess --type execute --verbose=4 "$APP" 2>&1 || true)"
printf '%s\n' "$assess" | sed 's/^/  /'
case "$assess" in
  *"source=Notarized Developer ID"*) ;;
  *)
    echo "FAIL: Gatekeeper did not report a notarized Developer ID source." >&2
    echo "      A user downloading this build would still be warned." >&2
    exit 1
    ;;
esac

echo
echo "[6/6] spctl on the disk image, as if it had just been downloaded"
if [ -n "$DMG" ]; then
  dmgassess="$(spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG" 2>&1 || true)"
  printf '%s\n' "$dmgassess" | sed 's/^/  /'
  case "$dmgassess" in
    *accepted*) ;;
    *) echo "FAIL: the disk image itself is not accepted by Gatekeeper." >&2; exit 1 ;;
  esac
else
  echo "  no dmg given, skipped"
fi

echo
rule
echo "NOTARIZED. This build opens with a double click on a machine that has"
echo "never seen it, with no right click, no warning and no network."
rule
