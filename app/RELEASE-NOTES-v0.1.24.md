# Galactus Desktop v0.1.24

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This one is a repair release. An audit of the whole app turned up a
feature that never worked, several things that failed quietly, and four
checks that were passing without checking anything.

## The preview pane in the Code view now opens

It never did. The panel looked for an element no template contained, so
the button toggled a flag and returned before anything happened, and
everything behind it (Mermaid diagrams, SVG, the pane's own styling) was
unreachable. The markup is restored, beside the editor rather than under
it.

## One click, one dialog

Five places built themselves after loading something, with nothing
claiming the slot in between: the engine log, the Obsidian constellation,
the install dialog, Push and Pull in the Code view, and deleting a run. A
second click during that gap opened a second copy, and in the install
dialog's case started a second download of the same model. The engine
log's close button was also wired after its own loading step, so it did
nothing while the log loaded.

## Nothing is lost quietly any more

A clip's soundtrack was written after the clip and its failure was
discarded, so a disk filling during a long generation left a video whose
sound existed nowhere, reported as a success. The sound is written first
and either failure is now an error you can read. The engine's own reason
for stopping was read before the threads collecting it had finished, so a
fast failure said "stopped without saying why" while the real line was
still in flight.

Stop pressed during a model start was ignored, and the model finished
loading. A download did not stop when you quit the app: it was told
through a flag nobody was left to read, so curl carried on filling the
disk. A scheduled job whose event could not be delivered was marked as
run and never ran. Closing a terminal sent the hangup and the kill on
consecutive lines, which gave an editor with unsaved work no chance to
save it.

## The app stops switching to vous when it fails

Galactus says tu everywhere until something goes wrong, and then said
vous: 28 strings, all of them on error surfaces, plus the label on your
own chat messages. The French check now catches that class of drift; it
could not see any of it before.

## Housekeeping

Requests arriving over the local API can no longer name a path outside
the gallery and the new api-inbox folder, and a refusal reads the same
whether or not the file is there. The relay bounds how long a client may
take to send a request and how many connections it will serve at once,
and stops forwarding your API key to an engine that has no use for it.
