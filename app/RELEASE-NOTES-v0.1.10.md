# Galactus Desktop v0.1.10

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This release is what a closing audit found. Every feature was supposed to be
validated and working; three independent audits went looking, and what they
brought back is below, including the things nobody wants to write down.

## The split between two SSDs is now measured, not assumed

Installing a model on two drives splits every expert record between them. Both
are read in parallel, so a record is ready when the slower side finishes, and
the best share is the one that makes them finish together. That share was a
compile-time constant, 0.7157, the ratio of one pair of drives measured once
and frozen. It now comes from the drives in front of you.

Wiring it naively would have been a regression, and measuring said so before
any of it shipped. The app's bandwidth probe reads sequentially in one stream,
which is not how the engine reads: record-sized, sixteen in flight. Sequential
gave a ratio of 0.684, the engine shape gave 0.7395, and swept for real the
first runs this machine 12.7 percent SLOWER than the frozen constant while the
second runs it 10.2 percent faster. A number can be correct and still produce
the wrong decision, when it was taken in a shape its consumer does not use.

Packer and reader must agree on the cut of every record or the engine reads the
wrong bytes off one volume. The ratio travels with the pack, in a sidecar; the
environment variable is only a cross-check, and a disagreement refuses to start
with both values named. Packs written before this carry no sidecar and load
exactly as they did.

It also turned up a latent bug: the frozen GLM cut points could reach the
generic path, where the arithmetic gives 575 and the literal says 576, so a
non-GLM model with a 13,172,736 byte record was read one block off.

## What the audit found, stated plainly

**The sidebar announced v0.1.7 in the 0.1.9 build.** Hardcoded, on the one line
of the app that states its own version, on every screen. It now reads what the
binary declares.

**The engine inside the 0.1.9 bundle predated the split work.** An app able to
write a pack at a measured ratio, next to an engine that reads it at the frozen
one, silently, is the exact failure the sidecar exists to prevent. It did not
reach anyone, because the app side was not released either, but the build
script copied whatever engine happened to sit in the build directory and
nothing checked. It now refuses to build when any engine source is newer than
the binary.

**The committed patch no longer reproduced the certified engine.** It had
drifted 263 lines behind and contained nothing of the split mechanism, so
applying it to a clean upstream clone produced an engine that fails half the
checks above. For a project whose argument is that you can verify it yourself,
that is the worst kind of defect. Regenerated and verified by applying it in
reverse.

**A fresh clone could not configure.** A bare `tests/` rule in .gitignore hid
three C++ sources and a fixture that CMakeLists compiles, and a missing source
in `add_executable` is a hard CMake error, not a missing test.

**The README promised no update check.** That stopped being true the moment
0.1.9 shipped one, on by default. The paragraph now describes exactly the one
connection the app opens on its own, what it sends, and how to turn it off.

**Three tests could not fail.** Two guarding the grant escalation stayed green
under the exact defect they exist for: their assertions lived inside the agent
callback, which the driver wraps in a try/catch that turns a failed assertion
into an ordinary failed turn. One Rust test had a duplicated attribute and had
never run at all. All three were found by mutation, none by reading, which is
the third time that has happened here.

**The live relay test was skipped by default,** so the authenticate-then-forward
path, the whole reason the module exists, had never been executed by anyone. It
wanted a model on a fixed port; what it actually needs is a TCP peer that
answers. It runs on every test now.

## Everything else that landed

Server mode is chosen at launch rather than found in a settings row. Runs can be
scheduled with cron in the backend, with one late fire and nothing past six
hours. The agent can write its own skills, and nothing it writes is callable
before a human reads it. Updates check automatically in assistant mode only, and
never install while a run is working. All of that shipped in 0.1.9 and is
unchanged here.

## Install

Download `Galactus_0.1.10_aarch64.dmg` and drag Galactus to Applications.
Signed with a local identity, not notarized, so the first launch goes through
right-click then Open. Apple Silicon only. If you already run 0.1.9, the app
will offer this version to you.

## Verification

858 frontend tests plus 6 boot cases, 259 Rust tests, 5 native tests, and 69
mutations run against the new coverage with all 69 going red. Eight models
re-certified bit-exact today, zero divergence, plus the Metal parity probe at
286 of 286 cases identical.

## Known, not fixed here

Two points of the gpt-oss-120b curve are non-monotonic by 22 and 35 percent,
which is the signature of a measurement taken on a busy machine. The 128 GB tier
of qwen3-235b-a22b was attempted three times and never produced a timing line;
it is absent rather than estimated. `glm-5.2-744b` has a single measured point,
so the app clamps to it on every machine.

`certified_ppl` is not reproducible for four models: the certifier changed which
corpus file it picks and the field does not say which one it used. The
certifications themselves are green; the field is ambiguous.

Three properties survive being broken and are named in the code rather than
implied: the daylight saving guard in the cron search, the stop call when a run
parks, and whether the relay's secret comparison is constant time, which no
value assertion can establish.

Still no Developer ID certificate, so Gatekeeper refuses this build anywhere but
the machine that made it.
