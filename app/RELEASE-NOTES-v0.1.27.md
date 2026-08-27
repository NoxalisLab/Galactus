# Galactus Desktop v0.1.27

A native macOS app for the Galactus MoE engine: run open-weight
Mixture-of-Experts models fully on-device, including models several times
larger than your RAM.

Designed and developed by Noxalis Lab.

This release is the answer to one report: a table of 414 translations applied
to a Word document, two hours of work, and nothing to show for it. Everything
below came out of reading that session's engine log and its transcript.

## The app is between 35 and 58 times faster at reading a prompt

Galactus ran its Mixture-of-Experts models through a Metal path that replays
the CPU algorithm bit for bit. That path is correct, it is verified, and it was
the single biggest thing standing between you and an answer. It cost almost
nothing during generation and almost everything before it, which is why no
benchmark had shown it.

Measured on the same model, the same prompt and the same batch, with the
parity path as the only difference:

| | prompt | generation |
|---|---|---|
| gpt-oss-120b, bit-exact | 61-68 tok/s | 29 tok/s |
| gpt-oss-120b, standard | **2286 tok/s** | **54 tok/s** |
| olmoe-1b-7b, bit-exact | 147 tok/s | 74-108 tok/s |
| olmoe-1b-7b, standard | **5567-8584 tok/s** | **187-225 tok/s** |

On the 120B that is a long conversation read in three seconds instead of two
minutes. Standard kernels are now the default.

The answers are as good either way. What the parity path buys is that they are
reproducible bit for bit, which matters when certifying kernels and not when
answering a question, so it becomes what it always was: a verification mode you
choose. Settings > Engine > Expert numerics still offers it, and the engine
badge always names the regime actually running.

## A finished job is no longer lost on the way back

A batch of edits could succeed completely and tell you nothing.

The report named all 414 rows, successes included: 37 000 characters, too large
for the model's context. It went to a scratch file; the model read that file
back; the re-read was too large in its own right and went to a *second* scratch
file with the same contents under a new name. Round and round, until the run
died on a limit, while the finished document sat on the desktop.

- A batch now reports counts for what worked and detail only for what did not.
  The same 414 rows report in 242 characters.
- Reading a spilled file back gives you a window with its byte range and the
  call that advances it, never another copy of the same file.
- The same tool call with the same arguments runs twice at most. The third time
  it is refused and the model is asked to report what it has, rather than spend
  another round trip discovering nothing.

## A translation table is allowed to differ from its document by a comma

91 of those 414 rows were refused, and every one of them carried "closest match
95%" with the exact difference spelled out: the tool knew where the sentence
was and wrote nothing.

A table never quotes its source document to the character. When one paragraph
is close enough and no other is, it is now replaced and reported as a near
match with its score, so you can review it. When several are equally close, no
guess is made: the row says so and asks to be narrowed.

## Smaller things from the same session

- The app no longer installs Python packages into your system Python without
  asking. The run began by doing exactly that, unattended, to read a
  spreadsheet the app already opens by itself.
- A wrong file path now names the one call that fixes it, instead of inviting
  five rounds of guessing a filename.
- Conversations keep their place in the engine, so a long thread is not re-read
  from the beginning when something else runs alongside it.
- Answers are shorter by default. A one-line question was drawing fifteen
  hundred tokens.
- Switching models no longer carries the previous model's context window.

## Under the hood

The Rust side was 10 673 lines in one file and is now 3 147, with the engine,
the memory planner, documents, settings, the install pipeline, the agent's
tools, the connectors, the library and conversations each in their own. No
behaviour changed with it; every line was accounted for against the previous
file.
