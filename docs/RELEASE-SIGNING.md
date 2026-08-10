# Signing, notarization and distribution

How Galactus is signed, what the two build paths produce, and exactly what a
person who downloads each one experiences.

No credential appears in this repository. Everything below is read from an
environment variable or a GitHub secret that you set yourself, and no script
here ever writes one to disk, echoes one, or commits one.

## The two paths, in one table

|                                | `scripts/build-app.sh`            | `scripts/macos-release.sh`             |
| ------------------------------ | --------------------------------- | -------------------------------------- |
| Signing identity               | local self signed, or ad hoc      | Developer ID Application               |
| Hardened runtime on the app    | yes                               | yes                                    |
| Nested binaries                | ad hoc, unhardened                | Developer ID, hardened, timestamped    |
| Entitlements                   | none                              | `app/src-tauri/Galactus.entitlements`  |
| Notarized                      | no                                | yes                                    |
| Ticket stapled                 | no                                | app and dmg                            |
| `spctl --assess --type execute`| **rejected**                      | **accepted, Notarized Developer ID**   |
| What a stranger sees           | "cannot be verified", right click then Open | it opens |
| Needs an Apple Developer account | no                              | yes, 99 USD a year                     |
| Needs the network              | no                                | yes, for the timestamp and the notary  |

Both paths produce the same application. They differ only in who is prepared to
vouch for it.

## Without a Developer ID: what happens today, unchanged

`scripts/build-app.sh` behaves exactly as it always has. It looks for the local
identity `Galactus Local Signing`, created once by
`scripts/make-signing-identity.sh`, and falls back to an ad hoc signature if it
is absent. The point of the local identity is not distribution, it is that the
designated requirement stops being the cdhash of the binary, so macOS stops
asking for every permission again after every rebuild.

Two things are new, and neither changes what is produced:

1. Before building, the script states the distribution decision in a banner
   nobody can miss, instead of leaving it to the single grey Tauri line
   `Warn skipping app notarization, no APPLE_ID & APPLE_PASSWORD...` buried in
   several hundred lines of cargo output.
2. After building, it asks Gatekeeper the question that actually matters, with
   `spctl --assess --type execute`, prints the answer, and says plainly that
   the artifact must not be distributed. For this path the expected verdict is
   `rejected`, and that is not a failure of the build.

## With a Developer ID: one command

Set two variables, run one script:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_KEYCHAIN_PROFILE="galactus-notary"

scripts/macos-release.sh
```

That is the whole thing. `scripts/build-app.sh` also works: when it sees a
Developer ID identity in the environment it hands over to `macos-release.sh`
rather than quietly producing a half signed artifact.

The output ends with a printed Gatekeeper verdict, and the script exits non
zero if that verdict is anything other than
`accepted, source=Notarized Developer ID`.

### Getting the two values

**`APPLE_SIGNING_IDENTITY`.** In your Apple Developer account, create a
certificate of type *Developer ID Application*, download it, and open it so it
lands in your login keychain with its private key. Then:

```sh
security find-identity -v -p codesigning
```

Copy the quoted common name exactly, parentheses and all. It looks like
`Developer ID Application: Noxalis Lab (ABCDE12345)`. The ten characters in
parentheses are your team id, and they matter for more than bookkeeping: see
*library validation* below.

**`APPLE_KEYCHAIN_PROFILE`.** Store your notary credentials once, in the
keychain, so that no secret ever reaches a command line, an environment
variable or a log again:

```sh
xcrun notarytool store-credentials "galactus-notary" \
  --apple-id "you@example.com" \
  --team-id "ABCDE12345"
# it then prompts for an app specific password, interactively
```

The app specific password is generated at appleid.apple.com under *Sign-In and
Security*, *App-Specific Passwords*. It is not your Apple account password.

### The other two credential sets

`scripts/macos-notarize.sh` accepts three sets and uses the first complete one
it finds. The second and third exist because they are what the Tauri bundler
itself reads, so a machine configured for one is configured for both.

| Priority | Variables | Notes |
| --- | --- | --- |
| 1 | `APPLE_KEYCHAIN_PROFILE` | Recommended. Nothing secret in the environment. |
| 2 | `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` | App Store Connect API key. `APPLE_API_KEY` is the key id, `APPLE_API_KEY_PATH` the path to the `.p8` on this machine. |
| 3 | `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Apple ID plus an app specific password. |

Never commit a `.p8`. Keep it outside the repository, readable only by you
(`chmod 600`), and point `APPLE_API_KEY_PATH` at it.

## What the release path actually does

1. **Preflight.** Refuses to start unless `APPLE_SIGNING_IDENTITY` names a
   Developer ID Application identity that this keychain can use, and unless one
   complete credential set is present. Signing without notarizing is the worst
   of both worlds: a revocable certificate on a download Gatekeeper still
   refuses, so it is treated as an error rather than a warning.
2. **Stage.** `app/src-tauri/prepare-engine.sh`, unchanged: engine, skills,
   vault, standalone Python, Rust tooling.
3. **Sign the contents.** `scripts/macos-sign-resources.sh`. This is the step
   the naive approach misses. The Tauri bundler signs the `.app` and only the
   `.app`; it does not walk into `Contents/Resources` and it does not pass
   `--deep`. Everything `prepare-engine.sh` stages arrives ad hoc signed and
   unhardened, which is all a local build ever needed and is an automatic
   notarization rejection. Twenty two Mach-O files are re-signed with
   `--options runtime --timestamp` before the bundle is assembled, so the outer
   signature seals contents that are already correct.
4. **Smoke test.** The freshly hardened binaries are started, right there, to
   prove they still run. See *library validation*.
5. **Build.** `npm run tauri build`, with the entitlements path merged into the
   Tauri configuration on the command line. `tauri.conf.json` is not modified.
6. **Notarize and staple.** `scripts/macos-notarize.sh` submits the app and the
   dmg, waits, staples both. Stapling matters: without a stapled ticket, the
   first launch needs a working network connection to reach Apple.
7. **Verify, out loud.** See below.

## Verification, printed rather than assumed

`codesign --verify` answers "is this signature intact". It says nothing about
whether the app will open on somebody else's Mac. The release script therefore
prints six checks and fails on the two that decide shippability:

```
[1/6] codesign --verify --deep --strict
[2/6] signing authority, team identifier, hardened runtime flag, timestamp
[3/6] the entitlements actually embedded in the bundle
[4/6] xcrun stapler validate, on the app and on the dmg
[5/6] spctl --assess --type execute          must report Notarized Developer ID
[6/6] spctl --assess --type open --context context:primary-signature, on the dmg
```

Before submitting anything it also runs a local preflight over every nested
Mach-O, checking for a Developer ID authority, the hardened runtime flag and a
secure timestamp, and asserting that `com.apple.security.get-task-allow` is
absent. That turns a five minute round trip to Apple and a JSON rejection log
into an instant local failure with a file name.

## Entitlements

One file, `app/src-tauri/Galactus.entitlements`, with one key:

```xml
<key>com.apple.security.device.audio-input</key>
<true/>
```

**Why it is needed.** Galactus dictates locally.
`Resources/packaged/galactus-voice` opens `AVAudioEngine` on the built in
microphone and feeds `SFSpeechRecognizer`. Under the hardened runtime, a
process that calls `AVCaptureDevice` for `.audio` without this key is denied,
and the denial is silent from the user's point of view. The app carries the key
as well as the helper, because the app is the TCC responsible process: it is
Galactus that owns the microphone grant and whose Info.plist
`NSMicrophoneUsageDescription` is shown in the prompt.

**Why nothing else is granted.** The full reasoning for every key considered and
refused is in the header comment of the entitlements file itself, so it travels
with the thing it explains. In summary:

| Not granted | Because |
| --- | --- |
| `cs.allow-jit`, `cs.allow-unsigned-executable-memory` | Nothing JITs. WebKit runs JavaScript in its own out of process WebContent service with its own signature. Metal shaders are compiled by `MTLCompilerService` over XPC, not as executable pages in `llama-server`. |
| `cs.disable-library-validation` | Every nested Mach-O is signed by the same team before the bundle is sealed, so validation is satisfied rather than switched off. There is no `dlopen` anywhere in `src-tauri/src`. |
| `cs.disable-executable-page-protection`, `cs.allow-dyld-environment-variables` | No self modifying code, no injected loader environment. |
| `automation.apple-events` | The app spawns `osascript` for `choose folder` and `display notification`. Both are Standard Additions commands that osascript runs in its own process; no Apple event is sent to another application. |
| `app-sandbox` and the `network.*` / `files.*` families | Those keys only mean anything under the App Sandbox, which Developer ID distribution does not require and this build does not enable. Binding `127.0.0.1`, opening a pseudo terminal with `posix_openpt` and spawning `llama-server` are all unrestricted under the hardened runtime alone. |
| `get-task-allow` | A debugging entitlement. Its presence is an automatic notarization rejection, and the release script asserts it is absent. |

The PTY, the socket and the child process in the brief are, deliberately, not
in the granted column. None of them is restricted by the hardened runtime. The
hardened runtime restricts code loading, memory protection, and access to
privileged user resources. Of the things Galactus does, only the microphone is
in that list.

## Library validation

The one failure mode in this design that builds, signs, notarizes and then
refuses to start.

Turning on the hardened runtime turns on library validation. A process may only
load code whose team identifier matches its own, and the team identifier comes
from the OU field of the signing certificate. A Developer ID Application
certificate carries the team id, so `llama-server` and its nine dylibs all land
in the same team and load fine. This is how every notarized app that ships
native libraries works: on this machine, `Blender.app` and every dylib under
`Contents/Resources/lib` carry `Authority=Developer ID Application: Stichting
Blender Foundation (68UA947AUU)` and `flags=0x10000(runtime)`, which is exactly
the shape `macos-sign-resources.sh` produces.

A certificate **without** an OU, such as the local development identity from
`make-signing-identity.sh`, grants no team id at all, and dyld refuses:

```
Library not loaded: @rpath/libllama-server-impl.dylib
Reason: ... mapping process and mapped file (non-platform) have different Team IDs
```

That is why the local build path signs the bundle and deliberately leaves the
nested binaries ad hoc, and why `macos-sign-resources.sh` must not be pointed at
a local identity.

Because this cannot be verified on a machine that has no Developer ID
certificate, it is verified at build time instead: after signing,
`macos-sign-resources.sh` starts `llama-server`, the bundled Python, the voice
helper and rust-analyzer, and aborts the release with the explanation above if
any of them fails to launch. The failure arrives before the notary submission,
not after the release.

If it ever does fail with a legitimate Developer ID certificate, the diagnostic
order is: confirm every nested binary reports the same `TeamIdentifier`
(`codesign -dvv`), then look for a third party binary signed by somebody else.
`com.apple.security.cs.disable-library-validation` would paper over it and is
the wrong answer; sign the offending binary with your own identity instead.

## If the identity is ignored

`app/src-tauri/tauri.conf.json` sets `bundle.macOS.signingIdentity` to `"-"`,
which means ad hoc. The Tauri bundler prefers the `APPLE_SIGNING_IDENTITY`
environment variable over that field, which is why the local build has always
worked, and it is verified rather than trusted: `macos-release.sh` reads the
authority back out of the finished bundle with `codesign -dvv` and aborts if it
is not a Developer ID authority.

If a future Tauri version reverses that precedence, the fix is one line in
`app/src-tauri/tauri.conf.json`:

```diff
     "macOS": {
-      "signingIdentity": "-",
       "hardenedRuntime": true
     }
```

Removing the field entirely, rather than setting it to a Developer ID string,
keeps the identity out of the repository and leaves the environment variable in
charge for both paths.

## Two different signatures, do not confuse them

There are two independent signing systems in this project and they share
nothing but the word.

| | Apple code signature | Updater signature |
| --- | --- | --- |
| Key | Developer ID Application certificate, in the keychain | minisign key pair |
| Public half lives in | Apple's certificate chain | `tauri.conf.json`, `plugins.updater.pubkey` |
| Set through | `APPLE_SIGNING_IDENTITY` | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` |
| Answers | may this code run on a Mac | is this update really from us |
| Verified by | Gatekeeper, at every launch | the in-app updater, before applying |

If `bundle.createUpdaterArtifacts` is true in `tauri.conf.json`, the bundler
needs the updater private key and will otherwise fail at the very end of the
build. `macos-release.sh` checks for it in its preflight, so the failure costs a
second rather than a full release compile.

## In CI

`.github/workflows/release-dmg.yml` runs this same script on a self hosted
macOS arm64 runner. It does not run on a GitHub hosted runner, for two reasons
that are not going away: the patched llama.cpp engine is not in the repository
and would need a full Metal build first, and the Developer ID private key
belongs on one machine rather than in an ephemeral VM as a base64 secret.

Repository configuration, all set by you:

| Kind | Name | Purpose |
| --- | --- | --- |
| Variable | `GALACTUS_BUILD_RUNNER` | Runner label set. Defaults to `self-hosted`. |
| Variable | `GALACTUS_ENGINE_BIN` | Absolute path on the runner to the built llama.cpp `bin` directory. |
| Secret | `APPLE_SIGNING_IDENTITY` | The Developer ID identity string. |
| Variable | `APPLE_KEYCHAIN_PROFILE` | notarytool profile name on the runner. Recommended. |
| Secret | `APPLE_API_KEY`, `APPLE_API_ISSUER` | Alternative: App Store Connect key. |
| Variable | `APPLE_API_KEY_PATH` | Path to the `.p8` on the runner. |
| Secret | `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Alternative: Apple ID and app specific password. |
| Secret | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater key, only if `createUpdaterArtifacts` is on. |

The identity string is held as a secret rather than a variable only so that the
team id inside it is masked in logs.

## Troubleshooting

**`no identity found`.** The certificate is in the keychain but not trusted for
code signing, or its private key is missing. `security find-identity -v -p
codesigning` lists only usable identities; if yours is not there, re-import the
`.p12` including the key.

**Notarization returns `Invalid`.** The script prints the notary log
automatically. The two recurring causes are a nested binary that was not
hardened, which the preflight now catches first, and a missing secure
timestamp, which means the machine could not reach Apple's timestamp authority
while signing.

**The app opens for you but not for a tester.** You have a local Gatekeeper
assessment cached. `spctl --assess --type execute` is the honest question, and
the release script already answers it. If it says `rejected`, the artifact is
not shippable no matter what `codesign --verify` said.

**The first launch on a fresh machine hangs, then works.** The ticket was not
stapled and the machine went to ask Apple. `xcrun stapler validate` on both the
app and the dmg is part of the printed verification for exactly this reason.
