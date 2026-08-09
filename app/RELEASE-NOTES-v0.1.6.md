# Galactus Desktop v0.1.6

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This release adds server mode, four editor features that close the gap with a
real IDE, and the fixes from a read-only audit that found two ways around the
permission gate.

## Server mode

The running model can now serve other apps and other machines.

The obvious way to do that would be to start llama-server on 0.0.0.0. It is
also the wrong way, and this build makes it concrete: the bundled binary
exposes no authentication option at all, and its CORS default is `*` with
credentials enabled. Binding it outside would publish an unauthenticated
endpoint, on a model that reads files and runs commands, to everyone on the
same network.

So the engine keeps binding to 127.0.0.1, always, and an authenticating relay
in front of it is the only thing that ever listens on an outside interface.
That ordering is the safety property rather than a detail: a mistake in the
relay fails closed, because the engine is not reachable from outside either
way.

The relay adds no dependency. It reads a request head, checks one bearer token
in constant time, and copies bytes both ways without buffering, because chat
completions stream as server-sent events and collecting a whole response first
would turn a live token stream into a pause followed by a wall of text. CORS
preflight is answered without a key, since a browser sends it without one by
design.

Listening without a key is refused in the relay itself, not in the interface:
it is the single rule the feature rests on and it belongs where it cannot be
bypassed. Binding anything other than 127.0.0.1 or 0.0.0.0 is refused too, so
the set of addresses that expose the machine stays enumerable. Keys carry 256
bits from /dev/urandom, are shown once, and are never written to disk: a key at
rest in a settings file is a key in every backup and every sync folder.

Server mode itself is not a second app. It is the same one with the assistant
surfaces removed: model, settings, measurements and API stay; chat, workspace,
memory and agent go.

Verified end to end against a real engine: no key gives 401, a wrong key gives
401, the right key reaches the model and returns 200, preflight answers 204
without a key, and the port is free again after closing.

## Four editor features

Inline edit on Cmd+K: select, describe the change, get a proposal in place.
`@file` and `@path#symbol` mentions in the composer, resolved into context
under a real token budget rather than a blind cut. rust-analyzer is finally
driven, after shipping unused inside the bundle for two releases. And an
integrated terminal on a real PTY, verified by hand in the running app with
stty reporting the grid actually drawn.

The adversarial pass that reviewed them paid for itself: it found, with a
reproduction, that the PTY master descriptor was not close-on-exec, so any
process the app forked could write a command into a terminal it did not own
and read back everything typed there.

## A model that cannot call tools no longer pretends

Some models emit no tool calls. The agent loop then reads no file and runs no
command while looking perfectly healthy. The capability is now measured, not
declared: one short request with a trivial tool goes out after warmup, and
the verdict decides whether the Code view and the autonomy selector stay
available. Declaring it in the registry would have been a guess: the same
weights answer differently depending on the chat template baked into the GGUF
and on whether the server was started with --jinja.

## Two ways around the permission gate, closed

Both found by a read-only audit and reproduced before being believed.

`run_command` spawns `/bin/zsh -lc`, a login shell, which sources `.zprofile`
and `.zlogin` and does not source `.zshrc`. The elevated-write list carried
`.zshrc` and not `.zlogin`, so the one startup file the app itself executes on
every shell tool was the only one a write could reach with no dialog. In
autonomous mode that was the whole chain.

"Always" on a file read stored the file's parent directory as the rule, and
reads matched by prefix, so clicking Always on `~/todo.txt` granted all of
`$HOME` recursively, for every session after it, with nothing in the dialog
saying so. Reads and lists now match exactly, like writes. Reading a
credential is elevated from now on, so it can never auto-approve: .ssh, .aws,
.gnupg, .netrc, .npmrc, .git-credentials, Keychains, any .env, and the app's
own settings file, which carries every connector's tokens.

Also fixed: a shell command whose grandchildren outlived it left the turn
hanging forever rather than timing out, with the orphan still running after
quit; and the preview frame was served under `default-src *`, which made it a
fourth way out to the network with no dialog and no URL shown.

## A rectilinear interface

Every corner radius is gone, all 137 of them. Panels carry four corner
brackets instead of a border, drawn in background gradients with nothing added
to the markup, and hover lengthens the arms rather than lighting an outline. A
coordinate grid sits behind the thread and the editor at the edge of
visibility, the way one is etched on a survey plate.

## Install

Download `Galactus_0.1.6_aarch64.dmg` and drag Galactus to Applications.
Signed with a local identity, not notarized, so the first launch goes through
right-click then Open. Apple Silicon only.

## Verification

612 frontend tests and 111 Rust tests pass. Thirty skills validate with no
unknown tool and no foreign tool name. The vault has no unresolved link.
