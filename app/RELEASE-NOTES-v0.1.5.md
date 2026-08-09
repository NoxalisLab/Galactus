# Galactus Desktop v0.1.5

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM, and let them work on your files, shell and notes behind
a strict permission gate.

Designed and developed by Noxalis Lab.

This release fixes a defect that lost whole turns, and gives the activity
display a reason to exist.

## An oversized tool output no longer costs you the turn

A single `fetch_url` on a paper produced a request of 9536 tokens against an
8192 window. The server refused it and the answer never came. Three faults had
stacked up, and the truncation meant to prevent exactly this was one of them.

The cap on a tool result was a constant, 20000 characters. At the measured 3.0
bytes per token that is 6667 tokens, 81 percent of an 8192 window before the
system prompt is even counted, so the constant guaranteed the rejection it
existed to prevent. The allowance is now whatever is left of the live window
once the request so far and the room for the reply are subtracted.

The token estimate divided by 4.0 while the Rust side budgeted at 3.0. An
optimistic estimate is the expensive kind: it is what lets a request the caller
believed fitted come back as an error. Both sides now use the measured figure.

The rescue path was broken too. It sent up to 60000 characters in one
summarization call, 20000 tokens, so it failed precisely when it was needed and
no retry ever happened. It now folds: window-sized passes, then summaries of
summaries.

**What replaces truncation is retrieval, not a shorter cut.** An oversized
output goes to the scratch area whole, and what enters the conversation is the
passages that match the question, ranked by the same BM25, chunker and budget
discipline the knowledge base uses. On a 200 KB paper the first 8000 characters
are the title and the abstract while the paragraph that answers is on page
nine: same tokens spent, opposite answer. A unit test pins that exact case,
asserting both that the answering passage ranks first and that a head cut would
have missed it.

A `retrieve` tool lets the model query that file again with other terms, so
nothing is ever out of reach. Reads are confined to the scratch area in Rust.
Context recovery now escalates over two attempts, fold then trim in place,
before the error is ever your problem.

Verified end to end: the same request that returned a 400 now shows the fetch
completing, followed by three `retrieve` calls on the spilled file, and the
server log contains no context error at all.

## The activity display becomes a place

The pixel character had a 38 pixel strip above the composer, inside a bordered
box, and a grey label pinned to the far right. He now has a workshop to the
left of the input: a desk, a screen with code scrolling on it, a keyboard whose
keys light under his hands, a plant that sways. The screen lives even when he
is away, which is what stops the scene reading as paused whenever he wanders
off.

What he is doing is written in a bubble he carries above his head, with a tail
pointing at him, travelling with him as he walks. The eye no longer has to
shuttle between the character and the text describing him.

His walk had been a triangle wave at constant speed, mathematically clean and
exactly why it read as a machine sweeping a line. He now picks a destination,
varies his pace on each leg, stops for a variable while, glances around, and
occasionally hops. The head sways only when he is standing still, and that
contrast is what makes the stop legible.

The workshop is permanent. It used to exist only while a reply was generated,
which makes it a loading indicator in costume rather than a place.

## Stable local signing

Signed ad hoc, the app's designated requirement was the cdhash of its own
binary. Every rebuild therefore looked like a different application and macOS
asked for every permission again. `scripts/make-signing-identity.sh` creates a
stable local identity, and the requirement becomes the bundle identifier plus
the certificate, which does not move. This is a development convenience and
does not replace notarization.

`scripts/build-app.sh` is now the build entry point. It runs the engine
preparation step the Tauri build does not trigger, whose absence once shipped a
bundle with zero vault notes, applies the signing identity, clears the stale
dmg volumes that silently break bundling, and prints what actually ended up
inside the bundle.

## Install

Download `Galactus_0.1.5_aarch64.dmg` and drag Galactus to Applications. The
app is signed with a local identity and is not notarized, so the first launch
goes through right-click then Open. Apple Silicon only.

## Verification

199 frontend tests and 48 Rust tests pass. The thirty skills validate with no
unknown tool, no foreign tool name, no em dash and no frontmatter problem. The
vault has no unresolved link, no orphan note and no duplicate name.
