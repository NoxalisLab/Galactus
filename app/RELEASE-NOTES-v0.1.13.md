# Galactus Desktop v0.1.13

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

Every model in the catalogue can now be installed from the app. One of them
never could.

## GLM-5.2 could not be obtained from the app at all

Eleven catalogue entries carry a download block. GLM-5.2 carried none, so its
card drew no button: the largest model on offer, 744 billion parameters, was
advertised and then could only be fetched by hand. Anyone who deleted it had no
way back.

The six shards now resolve to their published source, and the entry behaves like
every other one: download, profile, plan, pack.

Underneath that was a worse fault, invisible until somebody other than its
author installed the model. The entry carried two absolute paths from the
machine it was first packed on, one of them inside a developer checkout, and
those paths shipped verbatim to every user. They are consulted before the
standard pack store, so on any other Mac the lookup went straight to a location
that does not exist there. That is what made this model manual-only, everywhere.
Both fields are gone.

Two tests now read the shipped registry on every run: every entry must be
downloadable, and none may carry an absolute path or a home-directory
expansion. Both fail against the entry as it was.

## Also in 0.1.12, if you skipped it

An upgraded install kept the catalogue it was born with. The refresh that copies
the registry out of the app bundle only ran when no Galactus folder was
configured yet, which meant it never ran for anyone who had launched an earlier
build. Two newly certified models were invisible to them. Fixed in 0.1.12 and
carried here.

## Install

Download the dmg, drag it to Applications. The build is signed but not notarized,
so the first launch needs a right-click and Open.
