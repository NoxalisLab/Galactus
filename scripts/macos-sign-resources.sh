#!/bin/bash
# Sign every Mach-O binary staged under app/src-tauri, before Tauri seals the
# bundle around them.
#
# Why this step exists at all.
#
# The Tauri bundler signs the .app, and only the .app: it does not walk into
# Contents/Resources and it does not pass --deep. Everything prepare-engine.sh
# drops there (llama-server and its nine dylibs, the two Swift helpers, the
# standalone CPython, rust-analyzer) arrives ad hoc signed and without the
# hardened runtime, because that is all a local build ever needed.
#
# The notary service does not accept that. It rejects a submission in which any
# nested Mach-O is not signed with a Developer ID Application certificate, not
# hardened, or not secure timestamped, and the rejection arrives five minutes
# later as a JSON log rather than as a build error. Signing the loose binaries
# here, before the bundle is assembled, means the outer signature Tauri applies
# seals binaries that are already correct, and nothing has to be re-signed
# afterwards (which would break the outer seal and force a rebuild of the dmg).
#
# Only galactus-voice gets entitlements: it is the only nested binary that
# touches a resource the hardened runtime closes off. See Galactus.entitlements
# for the reasoning on every key, granted and refused.
#
# Usage: scripts/macos-sign-resources.sh "<signing-identity>"
#
# Requires network: --timestamp contacts Apple's timestamp authority. A build
# without it produces a signature the notary service refuses.
set -euo pipefail

IDENTITY="${1:?usage: macos-sign-resources.sh \"<signing-identity>\"}"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TAURI="$ROOT/app/src-tauri"
ENTITLEMENTS="$TAURI/Galactus.entitlements"

[ -f "$ENTITLEMENTS" ] || { echo "FAIL: missing $ENTITLEMENTS" >&2; exit 1; }

# The staged resource trees, in the order tauri.conf.json lists them. helpers/
# holds Swift sources, not binaries, so it is not here; the compiled helpers
# land in packaged/.
TREES=(engine packaged python rust-tooling)

is_macho() {
  file -b "$1" 2>/dev/null | grep -q 'Mach-O'
}

# Binaries that need an entitlement, matched on basename. Keep this list as
# short as the justification in Galactus.entitlements allows.
needs_entitlements() {
  case "$(basename "$1")" in
    galactus-voice) return 0 ;;
    *) return 1 ;;
  esac
}

echo "signing staged binaries with: $IDENTITY"

signed=0
entitled=0
for tree in "${TREES[@]}"; do
  dir="$TAURI/$tree"
  [ -d "$dir" ] || { echo "  [skip] $tree not staged"; continue; }
  while IFS= read -r -d '' f; do
    is_macho "$f" || continue
    if needs_entitlements "$f"; then
      codesign --force --timestamp --options runtime \
        --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$f"
      entitled=$((entitled + 1))
      note=" (+entitlements)"
    else
      codesign --force --timestamp --options runtime --sign "$IDENTITY" "$f"
      note=""
    fi
    codesign --verify --strict "$f"
    signed=$((signed + 1))
    echo "  ${f#"$TAURI"/}$note"
  done < <(find "$dir" -type f \( -perm -u+x -o -name '*.dylib' -o -name '*.so' \) -print0)
done

if [ "$signed" -eq 0 ]; then
  echo "FAIL: no Mach-O binary found under $TAURI/{$(IFS=,; echo "${TREES[*]}")}." >&2
  echo "      Run app/src-tauri/prepare-engine.sh first." >&2
  exit 1
fi

echo "$signed binaries signed, hardened and timestamped ($entitled with entitlements)"

# ------------------------------------------------------------------- smoke
# Turning on the hardened runtime turns on library validation, and library
# validation is the one thing in this script that can silently produce a bundle
# that builds, signs, notarizes and then refuses to start. A process may only
# load code whose team identifier matches its own, and the team identifier comes
# from the OU field of the signing certificate. A Developer ID Application
# certificate carries the team id, so llama-server and its nine dylibs all end
# up in the same team and the load succeeds. A certificate without an OU, such
# as the local development identity made by make-signing-identity.sh, produces
# no team id at all, and dyld refuses the load with
#
#   different Team IDs
#
# So do not take it on trust. Start the binaries, here, now, while the failure
# is still a build error instead of a support ticket.
echo
echo "smoke test: the hardened binaries have to actually start"

smoke_fail() {
  cat >&2 <<EOF

FAIL: $1 does not start once hardened.

If the reason above mentions team identifiers, the signing certificate has no
OU field and therefore grants no team id, so library validation refuses to let
the process load its own dylibs. A real "Developer ID Application" certificate
does carry one. A local self signed identity does not, which is why the local
build in scripts/build-app.sh signs the bundle and leaves these binaries ad hoc.

See docs/RELEASE-SIGNING.md, section "library validation".
EOF
  exit 1
}

if [ -x "$TAURI/engine/llama-server" ]; then
  if out="$("$TAURI/engine/llama-server" --version 2>&1)"; then
    echo "  engine/llama-server starts"
  else
    printf '%s\n' "$out" >&2
    smoke_fail "the inference engine"
  fi
fi

if [ -x "$TAURI/python/bin/python3" ]; then
  if out="$("$TAURI/python/bin/python3" -I -c 'import json,hashlib,struct,zipfile' 2>&1)"; then
    echo "  python/bin/python3 starts and imports its stdlib"
  else
    printf '%s\n' "$out" >&2
    smoke_fail "the bundled Python runtime"
  fi
fi

if [ -x "$TAURI/packaged/galactus-voice" ]; then
  # `check` reports availability and authorisation status. It does not open the
  # microphone, so it runs unattended, but it does exercise the entitled binary.
  if out="$("$TAURI/packaged/galactus-voice" check 2>&1)"; then
    echo "  packaged/galactus-voice starts with its entitlement"
  else
    printf '%s\n' "$out" >&2
    smoke_fail "the voice helper"
  fi
fi

if [ -x "$TAURI/rust-tooling/rust-analyzer" ]; then
  if out="$("$TAURI/rust-tooling/rust-analyzer" --version 2>&1)"; then
    echo "  rust-tooling/rust-analyzer starts"
  else
    printf '%s\n' "$out" >&2
    smoke_fail "rust-analyzer"
  fi
fi
