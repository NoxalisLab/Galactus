#!/bin/bash
# Galactus, the launch smoke test: does the shipped bundle actually start?
#
# WHY THIS EXISTS. The repo has close to a thousand unit tests and every one of
# them runs against a pure module in a Node or cargo process. Not one of them
# would notice if Galactus.app failed to open. tauri-driver does not support
# macOS (WKWebView has no WebDriver implementation), so the usual end to end
# route is closed and the honest substitute is this: launch the real binary
# from the real bundle, watch it for a while, and take it down.
#
# WHAT IT ASSERTS, and why each one is a distinct check rather than one big
# "did it work":
#
#   1. the bundle exists and is signed          a broken bundle is a build bug
#   2. the process survives the startup window  the crash on launch case
#   3. nothing panicked on stderr               a Rust panic in setup()
#   4. the app support tree was seeded          proof setup() ran to the END,
#                                               not merely that a process lived
#   5. no crash report was written              catches a webview crash that
#                                               leaves the parent alive
#   6. it exits on a normal quit                a hung shutdown is a shipped bug
#
# CHECK 4 IS THE LOAD BEARING ONE. A process that starts and immediately sits
# in a broken state still satisfies "is alive". seed_bundled_skills() runs at
# the tail of the Tauri setup hook and copies the packaged skills into
# $HOME/Library/Application Support/Galactus/skills, so that directory being
# populated is evidence the setup hook completed.
#
# HOME IS SANDBOXED. The app is launched with HOME pointing at a throwaway
# directory, so the run cannot read or damage the real settings, conversations,
# learned skills or schedule, and every launch is a cold first launch. That is
# also what makes check 4 meaningful: the tree is empty before, populated after.
#
# REQUIREMENTS. A logged in macOS GUI session (this opens a real window for a
# few seconds). It does not need a model, a network, or any permission grant.
#
# Usage:
#   scripts/smoke-launch.sh                     the default bundle
#   scripts/smoke-launch.sh --app /path/to/Galactus.app
#   scripts/smoke-launch.sh --window 12         watch it longer
#   scripts/smoke-launch.sh --keep-sandbox      leave the sandbox HOME behind
#
# Exit code 0 when every check passes, 1 otherwise, with the failing check
# named on stderr so a CI log says what broke without being read in full.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

APP="${GALACTUS_APP:-$ROOT/app/src-tauri/target/release/bundle/macos/Galactus.app}"
# How long the app is watched before it is asked to quit. Eight seconds is
# past the Tauri setup hook, past the webview load and past the frontend's
# first round of commands on this hardware, with room to spare.
WINDOW="${GALACTUS_SMOKE_WINDOW:-8}"
# How long a normal quit may take before it counts as hung.
QUIT_DEADLINE=10
KEEP_SANDBOX=0

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --window) WINDOW="$2"; shift 2 ;;
    --keep-sandbox) KEEP_SANDBOX=1; shift ;;
    -h|--help) sed -n '1,50p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

FAILED=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; FAILED=1; }

BIN="$APP/Contents/MacOS/galactus-app"
SANDBOX=""
LOG=""
PID=""

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  fi
  if [ "$KEEP_SANDBOX" = "0" ] && [ -n "$SANDBOX" ] && [ -d "$SANDBOX" ]; then
    rm -rf "$SANDBOX"
  fi
}
trap cleanup EXIT INT TERM

echo "smoke launch: $APP"

# ------------------------------------------------------ 1. the bundle exists
if [ ! -x "$BIN" ]; then
  fail "bundle present ($BIN is missing or not executable; run scripts/build-app.sh)"
  echo
  echo "RESULT: FAILED"
  exit 1
fi
pass "bundle present"

if codesign --verify --strict "$APP" >/dev/null 2>&1; then
  pass "signature valid"
else
  fail "signature valid (codesign --verify --strict rejected the bundle)"
fi

# ------------------------------------------------------------ sandboxed HOME
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/galactus-smoke.XXXXXX")"
LOG="$SANDBOX/launch.log"
SUPPORT="$SANDBOX/Library/Application Support/Galactus"
mkdir -p "$SANDBOX/Library/Application Support"

# Crash reports are written under the REAL home, not the sandboxed one, so the
# before and after listing has to be taken there.
REPORTS="$HOME/Library/Logs/DiagnosticReports"
BEFORE_REPORTS="$SANDBOX/reports-before.txt"
ls "$REPORTS" 2>/dev/null | grep -i galactus > "$BEFORE_REPORTS" 2>/dev/null
true

# --------------------------------------------------------------- 2. it lives
# Launched through the bundle's own binary rather than `open`, so stdout and
# stderr come back here. `open` would detach the process and send the panic we
# are looking for to the unified log instead.
HOME="$SANDBOX" "$BIN" > "$LOG" 2>&1 &
PID=$!

# Poll rather than sleep once: a process that dies at second two should be
# reported as dead at second two, not blamed on the whole window.
DIED_AT=""
ELAPSED=0
while [ "$ELAPSED" -lt "$WINDOW" ]; do
  if ! kill -0 "$PID" 2>/dev/null; then
    DIED_AT="$ELAPSED"
    break
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [ -n "$DIED_AT" ]; then
  wait "$PID" 2>/dev/null
  EARLY_STATUS=$?
  fail "process survives the ${WINDOW}s startup window (it exited after ${DIED_AT}s, status $EARLY_STATUS)"
  PID=""
else
  pass "process survives the ${WINDOW}s startup window"
fi

# ---------------------------------------------------------- 3. nothing panicked
# `panicked at` is the Rust panic banner. The other two catch an abort and a
# failed unwrap that was printed rather than unwound.
if grep -qE "panicked at|fatal runtime error|RUST_BACKTRACE" "$LOG" 2>/dev/null; then
  fail "no panic in the log"
  echo "  ---- log ----" >&2
  sed 's/^/  /' "$LOG" >&2
  echo "  -------------" >&2
else
  pass "no panic in the log"
fi

# -------------------------------------------- 4. the setup hook ran to the end
SEEDED=0
if [ -d "$SUPPORT/skills" ]; then
  SEEDED="$(find "$SUPPORT/skills" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
fi
if [ "$SEEDED" -gt 0 ]; then
  pass "setup hook completed (seeded $SEEDED skills into a cold app support tree)"
else
  fail "setup hook completed (nothing was seeded into $SUPPORT/skills, so setup() did not finish)"
fi

# --------------------------------------------------------- 5. no crash report
sleep 1
AFTER_REPORTS="$SANDBOX/reports-after.txt"
ls "$REPORTS" 2>/dev/null | grep -i galactus > "$AFTER_REPORTS" 2>/dev/null
true
NEW_REPORTS="$(comm -13 "$BEFORE_REPORTS" "$AFTER_REPORTS" 2>/dev/null | tr -d ' ')"
if [ -z "$NEW_REPORTS" ]; then
  pass "no crash report written"
else
  fail "no crash report written (macOS logged: $NEW_REPORTS)"
fi

# ------------------------------------------------------ 6. it comes down clean
if [ -n "$PID" ]; then
  kill -TERM "$PID" 2>/dev/null
  WAITED=0
  while [ "$WAITED" -lt "$QUIT_DEADLINE" ] && kill -0 "$PID" 2>/dev/null; do
    sleep 1
    WAITED=$((WAITED + 1))
  done
  if kill -0 "$PID" 2>/dev/null; then
    fail "exits on a normal quit (still running ${QUIT_DEADLINE}s after SIGTERM)"
    kill -9 "$PID" 2>/dev/null
    wait "$PID" 2>/dev/null
  else
    wait "$PID" 2>/dev/null
    STATUS=$?
    # 143 is 128 + SIGTERM, which is what a process that took the signal and
    # went away looks like. A crash signal is a different thing entirely and
    # must not be waved through as "it exited".
    case "$STATUS" in
      132|134|138|139|133)
        fail "exits on a normal quit (died of a crash signal, status $STATUS)" ;;
      *)
        pass "exits on a normal quit in ${WAITED}s (status $STATUS)" ;;
    esac
  fi
  PID=""
fi

echo
if [ "$FAILED" = "0" ]; then
  echo "RESULT: PASSED"
  exit 0
fi
echo "RESULT: FAILED"
echo "log kept for this run only; rerun with --keep-sandbox to inspect $SANDBOX" >&2
exit 1
