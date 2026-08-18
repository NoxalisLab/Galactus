# Galactus Desktop v0.1.17

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This one is about the Code view. It could read a repository; now it can work in
one.

## A repository, without leaving the app

Getting a project onto the machine meant a terminal. The empty workspace screen
now clones one, and opens it when it lands.

The address is checked before it becomes a process: https and ssh forms only,
nothing starting with a dash, no whitespace. That refuses the two shapes that
turn a clone into something else, an option smuggled in as a URL and the ext::
transport, which runs a command. Shallow by default, because someone opening a
project to read it does not need ten years of history, and the dialog says how
to get the rest. Prompting is disabled outright: a packaged app has no terminal
to answer a password prompt on, so a private repository without a working key
would hang forever on a question nobody can see.

## A terminal on another machine

A list of machines you work on, and a real shell on one of them, as another tab
in the terminal that is already there.

Three things it deliberately does not do. It never stores or types a password:
authentication is whatever your own ssh already does, keys and ~/.ssh/config
included, because a password in a settings file is a password in a settings
file. It never runs a command the interface supplied: the app names a saved
machine and the backend builds the command line. And it never weakens host key
checking, which a test asserts by name, because an unknown host prompt is the
one moment ssh protects you from talking to the wrong machine.

## Files, from the tree

Create, rename, and delete, on a right-click. The explorer was a viewer.

Nothing is ever unlinked. Delete moves to the Trash, or to a folder inside the
workspace when it lives on another volume and a move across the two cannot work,
so a mistake made at speed in a file tree is a drag back rather than a lost
afternoon. Create refuses to land on a file that is already there, rename
refuses a collision but still allows README.md to readme.md, and an open tab
follows its file to the new name.

## The gutter says what you changed

Green where lines were added, blue where they changed, a red wedge where
something was removed, measured against the version git holds. The Changes tab
answers "what did I touch"; this answers "what did I touch here, in the function
I am reading".

Large rewrites are reported as one block rather than mapped exactly. A precise
diff of five thousand changed lines tells you nothing you cannot see, and
freezing the editor to draw it would be a poor trade.

## Two editors, side by side

Cmd+\ sends the open file to the other side, and the same key sends it back.
Cmd+Alt+arrow moves between them.

A file is never open on both sides at once, and that is a decision. Two views
over one document need their states kept in step on every keystroke, and getting
that subtly wrong means a save writing the wrong text, which is the one failure
an editor may not have. Asking for a file already open on the other side takes
you there instead. The layout survives a relaunch.

## Search takes a pattern

The project search was literal only. It now reads a regular expression when you
ask it to, on an engine written for this, in about four hundred lines, with no
dependency added.

It cannot hang. It is a state-set simulation rather than a backtracker, so every
character of a line advances every live state exactly once, whatever the
pattern. The textbook disaster, (a+)+$ against a long run of a's, finishes in
microseconds; a test pins it. Backreferences and lookaround are refused by name
rather than misread, and the pattern is compiled before a single file is read,
so a typo is an answer you get immediately instead of after thirty seconds of
walking a tree.

## Fixed

**Dense models are no longer treated as broken installs.** Installing one ran a
bandwidth probe that reads gigabytes off both disks to answer a question a model
with no experts never asks. Serving one demanded a proof about expert records it
makes no claim about. And the command line listed one as not installed beside a
complete download.

**Three commands could freeze the window.** The knowledge base's statistics
waited on a lock held for the whole of an index rebuild, to paint a file count.
Rebuilding and changing folders ran on the wrong thread.

**One slow connector no longer stops all of them.** Every MCP server shared a
single lock, held across a call that waits up to a minute. Each has its own now,
and quitting kills them by pid rather than queueing behind those locks, because
an app that will not quit is worse than a stray process.

**Memory scoped to a workspace no longer leaks into the global file.** With no
folder open it fell back to the file every project reads, which is exactly the
leak the setting exists to prevent.

Also: a model swap announced itself in the main thread even when the message
came from a teammate's, so the notice and any failure appeared where nobody was
looking; a failed conversation export returned silently after the button had
been pressed; the relay panel could leave a button pressed and the panel showing
the old state; and YAML, TOML, shell and the .env family are coloured.

## Install

Download the dmg, drag it to Applications. The build is signed but not
notarized, so the first launch needs a right-click and Open.
