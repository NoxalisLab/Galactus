# Galactus Desktop v0.1.8

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This release does two things. It gives server mode something to do besides
serve, and it corrects a measurement that had been telling users the wrong
number.

## Unattended runs

Server mode hosted a model and stopped there. A machine serving a model with
nobody in front of it can now be given a task and left alone: a run has a name,
a policy, a turn budget and a wall clock, all fixed before the first token.
Start it, watch its transcript grow, answer it when it stops, cancel it. Runs
survive the window and the app.

Three properties hold, and each one is pinned by a test that fails when the
code is mutated.

Elevated requests are refused under every policy. There is no policy value that
unlocks them and no argument that overrides the rule, because the whole point of
a run is that nobody is there to be asked.

The budget is checked before a turn is spent, never after. A run that discovers
it is over budget having already taken the turn was not budgeted, it was
measured.

Blocking is an outcome rather than an error. A run that meets a decision only a
person can make stops cleanly, records what it is waiting for, and resumes where
it left off. That is also why a human can grant it: a stop nobody can act on
twice would not be a decision.

The run's agent never writes a standing rule. A rule written by a run nobody was
watching would outlive the run and pre-approve the same action in a later
attended session, in another project. A run's grant dies with the run.

## What an adversarial review found, and what was done about it

The first version of the run module was rejected. Three independent paths
reached a capability the run had never been granted: the gate consulted only the
cancel flag, so a run that had finished, been cancelled or run out of budget
still answered allow; `readonly limits` froze the binding and not the object, so
one assignment promoted a read_only run; and restore trusted its snapshot over
its transcript, so editing one field of a file on disk did the same thing
quietly while the audit record went on saying read_only.

The clock was three more bugs in one subtraction. Elapsed time was the gap
between two absolute timestamps, which charged a run for every hour the app
spent closed. The wall clock bounded how many turns could start and not how long
one could run, so a single looping turn never met it again. And restore spread
its transcript into a function call, so the run that had worked longest was
exactly the one that could not be brought back.

Two of the tests that were supposed to catch this kind of thing could not fail.
One filtered the states it tried through the very predicate it was testing, so
all four deletions from the terminal-state list passed. The other named a
handful of permission kinds per policy, so widening a policy to grant one more
passed. Both now state their table in full and check what each policy withholds
as well as what it grants.

The same review pass caught the grant path in the new view: grants were
consulted before the gate, which reads as a shortcut and is three holes at once,
because the gate is not only the policy but also the state check and the record.
A cancelled run went on being served, so did one past its wall clock, and
neither request reached the transcript. Grants are now consulted only after the
gate has answered block, so they overrule the policy and nothing else.

## The throughput curves were measuring the wrong path

Every model card shows an expected generation speed for the Mac it is running
on, interpolated from a measured curve. Those curves were measured with experts
recomputed on the CPU at a physical micro-batch of one.

That is the cross-check path. It exists to prove the Metal kernels bit for bit
against CPU truth, and the app does not take it: since the parity work landed,
Metal experts ARE the certified numerics, and what starts is Metal experts with
the planner's micro-batch, which is 512 once the cache holds every routed
expert. The two regimes are not close to each other.

`scripts/bench-curve.py` now mirrors what the app launches, argument for
argument, and records which regime each curve was taken in. It also refuses to
measure on a machine that is not idle, which it learned the hard way: a sweep
run beside a TypeScript build produced 1.3 prompt tokens per second on a tier
whose architectural twin measured 7.6, and nothing in the output said so.

Two curves may not be merged across regimes, so a model re-measured on the
shipped path loses its old points rather than keeping the ones no new run
happened to overwrite. The app interpolates in a straight line between points;
half a curve from each path would produce a number nobody could account for,
and the planner ceiling has moved since, so the old points no longer even sit
at the cache budgets the app now plans.

## A bench that was contaminating itself

Measuring the tiers of one model in a single sweep makes the later tiers slower
than they are. The same tier of the same model, in the same regime and the same
minute, read 1.8 generated tokens per second as the fifth tier of a sweep and
2.4 in a process of its own. A tier that has just held a forty gigabyte arena
leaves the memory system busy reclaiming it, and the next tier pays for that and
publishes it as a property of the model on a bigger machine.

There is now a pause between tiers, which is a mitigation and is labelled as
one in the code, and `--only-mac` measures a single tier into an existing curve,
which is the honest protocol for anything published.

Being plain about what that means for this release: every curve here except one
was taken by sweep, so its upper tiers read low. Re-measuring three tiers of one
model one at a time moved the two largest by a third and a fifth, and left the
third, which came early in the sweep with a small arena, where it was, one tenth
lower and inside the noise. So the error concentrates where the arenas are
largest and is not a flat offset that could be subtracted out. It runs in the
safe direction, since a machine that beats its estimate is not the failure mode
worth shipping against, but it is a known error and not a subtlety.

## One bench for every model

`lanceurs/banc/` held one launcher per model, each with that model's paths,
record size and layer count baked in. That is why the three most recently
certified models had no curve at all. There is now one bench that takes a model
id and reads the rest from the registry and from disk, and one launcher.

## Install

Download `Galactus_0.1.8_aarch64.dmg` and drag Galactus to Applications.
Signed with a local identity, not notarized, so the first launch goes through
right-click then Open. Apple Silicon only.

## Verification

722 frontend tests and 111 Rust tests pass. Ten models certified
bit-transparent, verified by a differential run rather than by declaration,
and nine of them re-measured on the shipped path.

## Known, not fixed here

`glm-5.2-744b` keeps its single point. Its pack does not live in the
repository, so the bench has nothing to read, and one point is not a curve: the
app clamps to it rather than interpolating.

The upper tiers of the eight models measured by sweep read low, by the amount
described above. They will be re-measured one tier per process.

No behaviour of the runs view has been verified by clicking through it. What was
run is the type checker, the build and the test suites.
