# Galactus Desktop v0.1.9

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

Server mode stops being a place where a model is hosted and becomes a place
where work happens without anyone sitting there. And the machinery a released
application is supposed to have, and did not, now exists.

## The mode is chosen at launch

Server mode decides which half of the app exists: picking it removes the chat,
the workspace, the memory and the agent. It could only be reached through one
row of the settings page, in the network section, which is to say it could not
be reached at all. Someone who starts Galactus to serve a model to their editor
had to open the assistant first and find a setting they had no reason to know
about.

It is now asked at launch, as two doors drawn at the same weight. The answer is
remembered, and a settings row asks again at every start for anyone who
alternates.

## Scheduled work, with its clock in the backend

A run could be declared and started by hand, once. That is a task launcher.
Cron now lives in the Rust process: five-field expressions with lists, ranges
and steps, the shorter forms a human actually types, job definitions and runtime
state persisted to two separate files so a restart loses nothing.

Catch-up is one late fire, and only while it is still worth having. A job whose
slot passed under six hours ago runs once, for the most recent slot. Past six
hours nothing runs: a digest scheduled for 03:00 and delivered at 16:00 is not
late, it is wrong. The decision never depends on how many slots were missed, so
four hundred missed overnight produce exactly one run.

Idle cost is nothing, and that is measured rather than asserted. With no active
job the scheduler parks with no timeout at all. One daily job costs two wakeups
an hour; ten daily jobs also cost two, because the horizon is a single minimum.
Those two exist for the one thing a computed deadline cannot survive, a wall
clock that moves underneath it.

Closing the window in server mode hides it and a menu bar item appears, so the
webview stays alive to run the agent. Quitting really does stop scheduled work,
and the menu says so rather than letting anyone find out.

## An autonomous run stops for nobody

Under the autonomous policy, two requests could still stop a run: `git push`
and `git pull`, which the attended gate shows every time so the user sees the
branch and the count. Nobody sees anything in a run, so that stop was not a
safety feature, it was the run failing to be what it claims to be. The
declaration form answers both in advance, which is where the decision belongs in
an automated system: made once, by someone who knows what the run is for.

It answers that one question and reaches nothing else. Elevated is refused
before it is consulted, a kind outside the policy is refused before that, and
under `read_only` it changes nothing.

## The agent writes its own skills, and a human reads them first

A task that took five or more tool calls can become a reusable procedure the
agent wrote itself. The bar is eleven named refusals rather than a score, and
the default answer is no: the catalogue is pasted into the system prompt of
every request, so a line too many is a permanent tax on every conversation.

What makes it trustworthy is not the content filter, it is grounding. Every
command in a written skill has to appear in the transcript, checked per command
rather than against the union, so three real commands cannot be sewn into a
fourth that never ran. A model summarising its own work adds the step it wishes
it had taken, and that is exactly the one nobody verified.

Nothing the agent writes is callable before a human reads it, whatever its
origin. Watching steps go by one at a time is not the same act as reading the
generalisation distilled from them. Off by default.

## Updates

There was no update mechanism at all. There is one now: a signed manifest, a
check that runs automatically in assistant mode only, and an installation that
is always manual.

Never automatic on a server. An offer displayed on a screen nobody watches can
only get an accidental answer. And neither the download nor the restart happens
while a run is working: replacing the bundle under a working agent ends the run
with no way back, which is worse than refusing.

## What a released application is supposed to have

There was no CI. Every build and every test ran by hand on one machine. There is
now a pipeline on push and on pull request, and building it found two things
that were already broken: `npm test` fails on a clean checkout because a
generated directory is gitignored, and `cargo test --offline` fails on a cold
cache.

There were no end-to-end tests. Every one of the 858 frontend tests and 251 Rust
tests was a unit test on a pure module, which is how it could be true at the same
time that the test count was high and that nothing had ever run. There is now a
launch test that starts the real bundle and asserts it survives, writes no
panic, completes its setup hook and exits cleanly; integration tests that hit a
real filesystem; and a DOM harness for the views. Building it found a `.gitignore`
rule that swallowed the Rust integration tests, whose absence looked exactly
like a passing build.

The app was signed with a local identity and not notarized. The notarization
path now exists, and building it turned up the reason it would have been
rejected: the bundler signs the app and leaves its 22 nested binaries ad hoc and
unhardened. They are signed before bundling now. One entitlement is granted, the
microphone, and every other one is refused with its reason written down.

## Install

Download `Galactus_0.1.9_aarch64.dmg` and drag Galactus to Applications.
Signed with a local identity, not notarized, so the first launch goes through
right-click then Open. Apple Silicon only.

## Verification

858 frontend tests, 251 Rust tests, 30 mutations run against the new
end-to-end coverage and all 30 went red as they should.

## Known, not fixed here

No Developer ID certificate, so this build is still refused by Gatekeeper on any
machine but the one that built it. The chain is ready and waits on an Apple
developer account.

No workflow has ever run, no notarization has been submitted, and no real update
has been installed. Those three only prove themselves in production.

The upper tiers of the throughput curves were measured by sweep and read low.
`glm-5.2-744b` keeps a single point, its pack not being in the repository.
