#!/bin/bash
# Produce and verify latest.json, the file the in-app updater reads.
#
# WHY A STATIC FILE AND NOT THE GITHUB API
#
# The GitHub releases endpoint was the other candidate and it cannot do the
# job. Three reasons, in order of how badly each one ends:
#
#  1. There is nowhere to put the signature. The updater refuses any archive
#     whose minisign signature does not verify against the public key in
#     tauri.conf.json, and api.github.com's release JSON has no field for it.
#     Without the signature there is no update; with a field invented on the
#     side there is no longer one document that says what the release is.
#  2. api.github.com is rate limited to 60 requests an hour per IP for an
#     anonymous client. Every Galactus install behind one office NAT shares
#     that budget, and the failure is a check that silently stops working for
#     a whole building. The release DOWNLOAD host is a CDN with no such limit.
#  3. The shapes do not match. Tauri v2 expects {version, notes, pub_date,
#     platforms{target{signature,url}}}. The API returns a different document
#     entirely, so something would have to translate, and that something would
#     be a server this project does not have and does not want.
#
# So: a static latest.json, uploaded as an asset of each release, read through
# the permanent redirect
#
#   https://github.com/NoxalisLab/Galactus/releases/latest/download/latest.json
#
# which always resolves to the asset of whichever release GitHub has flagged
# Latest. No server, no token, no rate limit, and the signature lives in the
# same document as the version it belongs to.
#
# WHAT THE UPDATER ACTUALLY DOWNLOADS
#
# Not the dmg. A dmg is an installer image and the macOS updater cannot apply
# one: it replaces the .app bundle in place from a tar.gz. `tauri build`
# produces Galactus.app.tar.gz and Galactus.app.tar.gz.sig beside the dmg
# because tauri.conf.json now sets bundle.createUpdaterArtifacts. A release
# therefore carries THREE assets: the dmg for a fresh install by hand, the
# tar.gz for the updater, and latest.json to point at it.
#
# Usage:
#   scripts/release-manifest.sh                 build and verify latest.json
#   scripts/release-manifest.sh --verify-remote also fetch the published one
#
# Exit code 1 on any fault, so it can gate a release.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$ROOT/app"
BUNDLE="$APP/src-tauri/target/release/bundle/macos"
CONF="$APP/src-tauri/tauri.conf.json"
REPO="NoxalisLab/Galactus"

VERIFY_REMOTE=0
for a in "$@"; do
  case "$a" in
    --verify-remote) VERIFY_REMOTE=1 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

fail() { echo "FAIL: $*" >&2; exit 1; }

# ------------------------------------------------------------------ inputs
VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$CONF")"
[ -n "$VERSION" ] || fail "no version in $CONF"
TAG="app-v$VERSION"
TARBALL="$BUNDLE/Galactus.app.tar.gz"
SIGFILE="$TARBALL.sig"
NOTES="$APP/RELEASE-NOTES-v$VERSION.md"
OUT="$BUNDLE/latest.json"

if [ ! -f "$TARBALL" ] || [ ! -f "$SIGFILE" ]; then
  echo "FAIL: no updater artifact for $VERSION" >&2
  echo "  expected: $TARBALL" >&2
  echo "  and:      $SIGFILE" >&2
  echo >&2
  echo "  These are produced by scripts/build-app.sh only when the signing key" >&2
  echo "  is in the environment. The bundler wants the KEY ITSELF, not a path" >&2
  echo "  to it, so this is a cat and not a filename:" >&2
  echo >&2
  echo "    export TAURI_SIGNING_PRIVATE_KEY=\"\$(cat \"\$HOME/.galactus/updater/galactus-updater.key\")\"" >&2
  echo "    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=" >&2
  echo "    scripts/build-app.sh" >&2
  exit 1
fi
[ -f "$NOTES" ] || fail "no release notes at $NOTES (the manifest must carry them)"

# ---------------------------------------------------------------- assemble
# The signature file is base64 already, on one line. It goes in verbatim: any
# reformatting here is a signature that no longer verifies, and the failure
# would only show up on a user's machine.
python3 - "$VERSION" "$TAG" "$SIGFILE" "$NOTES" "$OUT" "$REPO" <<'PY'
import datetime
import json
import sys

version, tag, sigfile, notesfile, out, repo = sys.argv[1:7]

signature = open(sigfile, encoding="utf-8").read().strip()
notes = open(notesfile, encoding="utf-8").read().strip()
url = f"https://github.com/{repo}/releases/download/{tag}/Galactus.app.tar.gz"
pub_date = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

manifest = {
    "version": version,
    "notes": notes,
    "pub_date": pub_date,
    # aarch64 only, deliberately. Galactus is a Metal build and there is no
    # x86_64 bundle to point at; naming a target we do not ship would be a
    # promise the download breaks.
    "platforms": {
        "darwin-aarch64": {"signature": signature, "url": url},
    },
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY

# ------------------------------------------------------------------ verify
# The rules are not restated here. app/src/update.ts owns them, the app reads
# a manifest through them, and this script checks its own output with the SAME
# function, so the release cannot pass a check the app would fail.
echo "verifying the rules themselves"
( cd "$APP" && npm run --silent test:update >/dev/null ) || fail "app/tools/update suite is red"

echo "verifying $OUT against app/src/update.ts"
node --input-type=module -e '
import { readFileSync } from "node:fs";
const [file, wantVersion, wantTag] = process.argv.slice(1);
const { manifestProblems, platformEntry, parseManifest } =
  await import(process.argv[4]);
let raw;
try { raw = JSON.parse(readFileSync(file, "utf-8")); }
catch (e) { console.error("FAIL: not valid JSON:", e.message); process.exit(1); }
const problems = manifestProblems(raw);
if (problems.length) {
  for (const p of problems) console.error("FAIL:", p);
  process.exit(1);
}
const r = parseManifest(raw);
if (!r.ok) { console.error("FAIL: rejected after passing"); process.exit(1); }
const m = r.manifest;
if (m.version !== wantVersion) {
  console.error(`FAIL: manifest says ${m.version}, tauri.conf.json says ${wantVersion}`);
  process.exit(1);
}
const entry = platformEntry(m);
if (!entry.url.includes("/" + wantTag + "/")) {
  console.error(`FAIL: asset url does not point at ${wantTag}: ${entry.url}`);
  process.exit(1);
}
console.log("  version   " + m.version);
console.log("  pub_date  " + m.pub_date);
console.log("  url       " + entry.url);
console.log("  signature " + entry.signature.length + " base64 chars, "
  + entry.signature.slice(0, 12) + "..." + entry.signature.slice(-8));
console.log("  notes     " + m.notes.length + " chars, first line: "
  + m.notes.split("\n")[0]);
' "$OUT" "$VERSION" "$TAG" "$APP/tools/update/out/src/update.js"

# The signature in the document must be the one on disk, byte for byte. json
# encoding is the step that could have changed it.
python3 - "$OUT" "$SIGFILE" <<'PY'
import json
import sys

doc = json.load(open(sys.argv[1], encoding="utf-8"))
on_disk = open(sys.argv[2], encoding="utf-8").read().strip()
in_doc = doc["platforms"]["darwin-aarch64"]["signature"]
if in_doc != on_disk:
    print("FAIL: the signature in latest.json is not the one in the .sig file", file=sys.stderr)
    sys.exit(1)
print("  signature matches the .sig file byte for byte")
PY

echo "  tarball   $(du -h "$TARBALL" | cut -f1) at $TARBALL"
echo
echo "latest.json written to $OUT"
echo
DMG="$APP/src-tauri/target/release/bundle/dmg/Galactus_${VERSION}_aarch64.dmg"
echo "attach all four to the release:"
echo "  gh release upload $TAG \\"
echo "    \"$DMG\" \\"
echo "    \"$TARBALL\" \\"
echo "    \"$SIGFILE\" \\"
echo "    \"$OUT\" \\"
echo "    --repo $REPO --clobber"

# ------------------------------------------------------------ published one
if [ "$VERIFY_REMOTE" = "1" ]; then
  echo
  echo "fetching the published manifest"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  URL="https://github.com/$REPO/releases/latest/download/latest.json"
  curl -fsSL "$URL" -o "$TMP/latest.json" || fail "could not fetch $URL"
  node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const [file, mod] = process.argv.slice(1);
  const { manifestProblems, platformEntry } = await import(mod);
  const raw = JSON.parse(readFileSync(file, "utf-8"));
  const problems = manifestProblems(raw);
  if (problems.length) { for (const p of problems) console.error("FAIL:", p); process.exit(1); }
  console.log("  published version " + raw.version);
  console.log("  published url     " + platformEntry(raw).url);
  ' "$TMP/latest.json" "$APP/tools/update/out/src/update.js"
  ASSET="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["platforms"]["darwin-aarch64"]["url"])' "$TMP/latest.json")"
  code="$(curl -o /dev/null -s -w '%{http_code}' -L -I "$ASSET")"
  [ "$code" = "200" ] || fail "the asset the manifest points at answers $code"
  echo "  asset reachable, HTTP 200"
fi
