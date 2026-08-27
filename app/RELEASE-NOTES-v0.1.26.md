# Galactus Desktop v0.1.26

A native macOS app for the Galactus MoE engine: run certified open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

One fix, and it is the only thing in this release, because nothing else
matters while it is broken.

## Starting a model works again

Since 0.1.24, pressing Start on any model answered "cancelled" and loaded
nothing. Not one model, not one machine: all of them.

0.1.24 taught the app to honour a Stop pressed during the seconds before a
model appears, which it previously ignored entirely, and it does that by
comparing a counter that a stop moves. Starting a model also stops whatever
was running first, and that internal stop moved the same counter: the start
compared against a value it had already invalidated itself, decided it had
been cancelled, and reported exactly that.

The counter is now read after that internal stop, so the only thing that can
move it is a Stop you actually pressed. Stop during a long start still works.

If you are on 0.1.24 or 0.1.25, this is the update to take.
