# Galactus Desktop v0.1.16

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

An afternoon of using the app for real, and everything it broke.

## The folder chooser opens

It answered "cancelled by the user" on a machine where nobody cancelled
anything. That is what a refused Apple Event looks like from the outside: a
hardened app, a process with no UI session of its own, and a panel that cannot
be presented. The button appeared dead, and each attempt to explain it made
matters worse, including one round spent reading the English wording of a French
error message.

The chooser is now a native panel, this process's own window. No Apple Event, no
Automation permission, nothing that can be refused on somebody else's behalf,
and it raises itself above the window that opened it. Its outcome travels as an
exit code rather than a localised sentence, so a cancel is a cancel in every
language.

## A workspace macOS is withholding is no longer erased

The Code view arrived with its three panels on one launch and with the folder
picker on the next, from the same install, and nothing explained the difference.
The restore probe answered yes or no, and every no erased the stored pointer: a
folder macOS was merely holding back, the Desktop before the app has been
granted it, was destroyed as thoroughly as one the user had deleted. A permission
is granted once; a workspace erased during the launch before that grant was gone
for good.

Three outcomes now, not two. And choosing a folder no longer stops halfway: the
git refresh, the file tree and the workspace services were awaited bare with the
repaint after them, so one of them throwing left the view asking for a folder it
had just been given.

## Reasoning, on your terms

**It can be turned off.** Thinking is why those models are worth running, and it
costs a minute of invisible tokens before the first word. On a long mechanical
task, a file of code with no decisions in it, that minute buys nothing and there
was no way to decline it.

**It follows what is being written.** The block sat at its top, so a model
thinking for five minutes filled it with lines nobody could see while the visible
ones stopped changing after two seconds.

**It stops flicking.** The first attempt at that followed the end but rebuilt the
whole thread on every token, so the block was a new element several times a
second: it started at its top and was pushed back to its bottom, endlessly.

**And it keeps its end, not its beginning.** The cap held the first 16000
characters, which froze a long thought on its opening lines forever.

## Teammates work at the same time

Every tool call was awaited in turn, delegations included. A turn that recruited
three teammates ran them one after another, each a whole model turn long, to
produce work that never interacted: three sequential threads presented as a team.
Consecutive delegations now overlap, while everything touching the workspace
stays strictly sequential, because two writes racing each other is a real bug and
a teammate on its own thread is not.

The tools now say so themselves. Recruiting gives nobody any work, and several
ask_agent calls in one message are what makes teammates run together. That
sentence was missing, so the parallel execution changed nothing until it existed.

## Also

The context window and the sampling are settings. Both were constants: every slot
got 8192 tokens, and temperature 0.6 went to every model with top_p and top_k not
sent at all. The window is bounded by what each model was trained on, and its KV
cost is now proportional, because raising it without teaching the memory ceiling
would admit a configuration the engine dies inside.

## Install

Download the dmg, drag it to Applications. The build is signed but not notarized,
so the first launch needs a right-click and Open.
