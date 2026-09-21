# Memory

> Audience: anyone wondering "does it remember me", and anyone who wants
> to understand what is stored, where, and who approves it.

## TL;DR

exxperts has two memory systems, one per surface:

| Surface | Memory | Where | Who writes it |
| --- | --- | --- | --- |
| **Persistent rooms (web)** | The room's notes, grown through Remember → Memorize → Review | `~/.exxperts/app/personalized-agents/<id>/` | Only you, through approval screens |
| **CLI (ExxCode)** | Context files + a fact store + session compaction | repo `AGENTS.md`, `~/.exxperts/app/memory.jsonl` | You directly, or the model with your approval |

The room memory engine is the product's core; the CLI layers are
conveniences for the coding workspace.

## Room memory: notes, topics, archive

A room remembers in **notes**, grouped by **topic**, plus a list of
**open items** (the loops it is still carrying). Every note carries the
day it was saved, whether you pinned it, and the conversation it came
from. The notes and open items are what the room reads on every turn.
Beside them sit two more things:

- **Waiting conversations**: the conversations you have remembered but
  not yet memorized, kept in recent memory as short summaries.
- **The archive**: notes that left the room's memory. Nothing is
  deleted; a note that leaves is archived with the reason it left.

The room can **search what it has written down and what it was told**,
by itself, when a question is about something that is no longer in
front of it: the notes in its memory, the notes in its archive, and the
conversations it has memorized, transcript and all. So a detail that
was said once and never made it into a note is still answerable: the
conversation kept it. That holds for every conversation you have
memorized, including the ones a Memorize took no notes from. A Memorize
decides what is worth keeping in front of the room every turn, not what
stays findable, so a row the room recalls from such a conversation says
**(no notes taken)**: the transcript is all memory kept of it. A
conversation you have remembered but not yet memorized is still in the
room's recent memory, so it is already in view and needs no search; one
you never remembered is not searched at all. The chat shows a chip with
what the room looked for.

The search takes words, names, dates or numbers rather than a literal
text, in German or English, and the two spellings meet: **Überweisung**
finds **Ueberweisung**, **1.6.2026** finds **2026-06-01**, and
**55.000** finds **55,000**. It can be narrowed to one topic, to a date
range, and to the parts of the memory it may read: the notes, the
archive, the conversations, or any of them together. It is read-only:
reading a note back does not put it back in memory, which only a
Memorize or a Review you approve does.

The search works in any language written with spaces between words. It
folds case and accents for all of them, and digits, ISO dates and the
beginnings of words match everywhere. Word forms, month names written as
words, spelling variants such as **ü** and **ue**, and the filler words
it ignores exist for German and English so far. Languages written
without spaces are handled poorly. Only German and English were measured.

The room is told, every turn, which tools of its own it has and what
each one is for, and its own instructions tell it to look things up
before it says it does not know. A topic whose notes have moved to the
archive carries one line where the room reads its memory (how many
there are, which months they span, and which tool reads them), so the
room can see there is more and knows how to get at it. What a search
brings back is the room's own past words, weighed rather than obeyed,
with the day each was saved beside it: dates decide, and the newer one
wins. When neither the notes nor a search carry what you asked for, the
room says so in one sentence instead of guessing.

Nothing enters or leaves memory without you:

1. **Remember**: at the end of a conversation (the room shows a context
   meter so you know when it is worth doing), a worker proposes a short
   summary of what happened. You can add a steering note; anything you
   explicitly asked the room to remember is carried through and becomes
   a pinned note when it is memorized. The default Remember button shows
   you the proposal before saving; a room set to remember without the
   preview saves clean proposals straight away and shows you anything
   questionable. "Remember with options…" always opens the full preview.
   Remember warns when the list of waiting conversations is nearly full
   and asks you to Memorize before remembering more.
2. **Memorize**: turns the waiting conversations into lasting notes, one
   conversation at a time. A first read says what the conversations hold
   and what needs your call; **Discuss first** lets you answer before
   anything runs. The card fills in as each conversation is read, with
   what it added or changed; you can edit a note on the card and keep
   any note the room should not let go. A conversation whose reading
   fails stays waiting for next time, with the reason beside it. When
   the memory is over its budget, the card shows which notes would move
   to the archive; **Keep** marks one that must stay, and you can raise
   the budget from the card so that everything fits.
3. **Review**: tidies the notes you already have, topic by topic. Its
   first read lists what the room finds by itself: notes that say the
   same thing twice, notes that disagree with each other (the same words
   with another date, number or negation), and topics that look the
   same; and what looks stale or could be shorter. You choose a depth:
   wording only, or wording plus moving what is finished or stale to the
   archive; the room recommends one. The card shows each topic's before
   and after. Review never rewrites the memory as one block of text, so
   it completes on any model.

A Memorize whose conversation changes a value the memory already holds
is told to replace the note rather than add a second one (a number that
opens a note, such as a ticket or invoice number, is its name and never
counts as a changed value), and the card
says which value replaced which and why: "1 July (saved 14 Sep)
replaces 1 June (saved 2 Jun); the newer date decides".

Every save archives the previous memory file and writes an event record
with content fingerprints. **History** shows every change with "What
changed": the notes a save added, updated, moved or archived, an updated
note with its old text struck above the new. Any Memorize or Review save
can be **undone** while it is the latest change, from the saved screen
or from History: Undo puts the previous memory back byte for byte, takes
back the archive rows that save added, and lowers a budget that save
raised.

### Editing memory by hand

Room settings → **Memory** shows the room's notes by topic with a search
box. You can add, edit, move, pin and delete notes by hand; deleting
sends a note to the archive, where you can **Restore** it or **Delete
for good**. Editing stays open while the room is open in a chat; only a
running answer blocks it. Every hand edit is recorded in History like
any other change.

The **Memory** tab is the cross-room view: how full each room's memory
is, its topics, its full memory as the room reads it, the growth graph
save by save (click a point to read the memory as it was then), the
waiting conversations and the memorized ones, which open as they were
stored.

### Saving without a second look

Two per-room toggles, off by default, under "Saving without a second
look": **Remember: save without the preview** and **Memorize: save a
clean update without the card**. A clean update is one with nothing for
you to weigh. An update that archives notes, crosses the memory budget
or leaves a conversation unfinished always waits for you, and you can
always see what changed afterwards in History.

## The memory budget

Every room has a memory budget. It measures the notes and open items
the room reads on every turn, in estimated tokens (about four
characters per token); waiting conversations do not count. The default
is 20,000 tokens, adjustable in Room settings between 10,000 and
80,000 (`memoryBudgetTokens`). Tokens appear only next to that slider;
everywhere else the room says how full its memory is.

The budget is enforced when memory is saved: when a Memorize or Review
would leave the room over it, the notes worth the least move to the
archive, the card lists them, and you decide: keep, raise the budget,
or save as proposed. Pinned notes never move, and neither do open
items; a room with more open items than its budget can hold says so on
the card ("N open items are kept; close them to free room") rather
than moving one out. Among the rest, what a note is worth comes from
four things: what kind of note it is (a working-style note is worth the
most, a fact less, an event or a closed item the least), whether the
room ever looked it up, how recently it was touched, and how much room
it takes, so that between two notes worth the same the larger one
leaves first. Use counts a lot: a fact the room has recalled about
three times ranks with a working-style note it never recalled, and
about seven recalls lift it past. A room migrated from an older
memory starts with one saved day for every note, so there, among
notes of one kind the room has not looked up, size is what orders
them until they are touched
again. Every note the card proposes to move says why in one sentence,
in the terms that decided it: "not touched since 2 Mar, never
recalled". A room can be above its budget in between,
for instance after hand edits; it keeps working, reads in a neutral
colour everywhere, and the next Memorize or Review resolves it.

One refusal can meet you at the door: a room whose memory and setup no
longer fit the usable window of its model refuses to start a
conversation rather than failing on the first reply. Memory is
unchanged and nothing is sent to the model. The way out is spelled out
in the message: open Room settings, Session, and choose **Forget** (it
closes the session without using a model and unlocks the room); then
from Home open Maintain and run **Memorize** if the room has waiting
conversations, or **Review** to tidy its notes; or open the room again
with a larger-context model.

**Upgrading from 0.11.2:** a room keeps everything it has. Its notes
migrate on the first save, the old "(saved …)" stamps become dates,
working-style notes are filed as practices, and the memory budget starts
at the room's size, so the first Memorize never moves anything to the
archive by surprise. Room settings says so under the slider; lower the
budget whenever you want. The memory file stays readable by 0.11.2 if
you go back.

**What the workers are:** ephemeral, tool-less model processes with
locked models. They propose short lists of changes; they cannot write
files, browse, or touch memory. Only the approval endpoint writes, and
no reply the workers give is larger than a few thousand tokens, so
Memorize and Review complete on a company gateway with a 16k output
cap.

**What to say in chat:** just ask the room to remember things in your
own words. There are no magic phrases: explicit remember-requests are
detected and protected regardless of phrasing. To make the room forget
something, open Room settings → Memory and delete or edit the note;
there is no chat-side forget yet.

## How well it works, measured

A room answers as well as a model that has the whole history in view,
with about a fifth of the tokens per question.

That was measured on LongMemEval-S, a public benchmark of long chat
histories, on a fixed sample of 50 questions (seed 1). Every question
comes with a history of its own, about 48 conversations and 115,000
tokens. For the room, the conversations are Remembered and Memorized
in the order they were said, and the question is asked in a fresh
conversation. For the comparison, the whole history is pasted into the
prompt with the question after it, and there is no memory at all.
Claude Sonnet 5 answers, runs Memorize and judges, on the benchmark's
own judging templates.

| | Room memory | Full history in the prompt |
| --- | --- | --- |
| Correct of 50 | 43 | 41 |
| Tokens per question | about 33,000 | about 168,000 |
| Tokens to build the memory, once per history | about 1.15M | none |
| Cost per question | about 6 cents | about 42 cents |
| Cost to build the memory, once per history | about 3.23 dollars, about 7 cents per conversation | nothing |

43 against 41 correct on 50 questions, which at this sample size is a
tie. The two cost rows are in dollars at API prices; someone on a
subscription pays no per-token price.

By type of question, room memory first and the full history second:

- a fact the user said once: 9 of 9 and 9 of 9
- a fact the assistant said once: 9 of 9 and 9 of 9
- temporal reasoning: 8 of 8 and 7 of 8
- across many sessions: 7 of 8 and 6 of 8
- knowledge updates: 6 of 8 and 6 of 8
- personal preferences: 4 of 8 and 4 of 8

**A projection, not a measurement.** Each history was asked one
question. Multiplying that one question, the two approaches cost the
same after about 9 questions to one history. This assumes that every
question costs the same and that nothing is cached between questions;
questions asked minutes apart would make the full-history side cheaper.

The limits of this result:

- It is 50 questions. A difference under about 7 questions is within
  chance.
- The sample was also the one used during development, so a fresh
  sample is the clean confirmation.
- The same model answers and judges.
- The benchmark is personal chat with a scripted user who Remembers
  everything, not project work.
- It was measured with Memorize on Claude Sonnet 5. The Claude
  profile's default runs Memorize on Opus 5, which costs more per
  conversation and was not measured.
- Personal preferences are weak with and without memory, because a
  Memorize is tuned for how work is done, not for personal taste.

A history that outgrows the model's window cannot be pasted in at all.

How to run it again is in the bench's own
[README](../apps/web-server/scripts/memory-bench/README.md#published-results).

## CLI memory (ExxCode)

The coding workspace has three lighter layers:

### Context files

`AGENTS.md` in a repo root is auto-loaded into the session when you run
the CLI from that repo. Use it for project conventions, personal
defaults, and anything you keep re-typing. This is the
highest-leverage, zero-config personalisation for coding sessions.

### Fact store

A long-term fact store at `~/.exxperts/app/memory.jsonl` (append-only
JSONL, mode 0600), wired in by the `memory` extension:

- the model can propose facts with `memory_note`; you Approve / Edit /
  Decline;
- `/remember <text>` saves directly, `/memories` browses, `/forget`
  deletes;
- stored facts are injected into the prompt under "Known facts about
  this user".

### Compaction

When a CLI session approaches the model's context window, the runtime
compacts older messages into a structured summary and keeps recent
messages verbatim. Compaction is lossy for the model but the full
transcript stays on disk. (Persistent rooms don't rely on compaction;
Remember is their deliberate, human-approved
equivalent.)

## Privacy

- All memory is local, per-user, under `~/.exxperts/` with restrictive
  file modes. Nothing is synced anywhere.
- Memory content is sent to your configured model provider as part of
  prompts; choose your AI profile accordingly for sensitive material.
- The room workers apply restraint to sensitive personal categories
  (health, conflicts, finances, identity, third-party details): they
  propose such material for durable memory only when it's clearly
  load-bearing or you explicitly asked to remember it.
