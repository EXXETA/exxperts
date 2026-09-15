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
  deleted; a note that leaves is archived with the reason it left, and
  the room can read its archive by itself when a question is about an
  older period (the chat shows a "Read archived notes" chip with what
  it looked for).

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
   first read lists what the room finds by itself ("Says the same twice",
   "Topics that look the same") and what looks stale or could be shorter.
   You choose a depth: wording only, or wording plus moving what is
   finished or stale to the archive; the room recommends one. The card
   shows each topic's before and after. Review never rewrites the memory
   as one block of text, so it completes on any model.

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
would leave the room over it, the lowest-ranked notes move to the
archive (pinned notes never; working-style notes last; the least
recently touched first), the card lists them, and you decide: keep,
raise the budget, or save as proposed. A room can be above its budget
in between, for instance after hand edits; it keeps working, reads in a
neutral colour everywhere, and the next Memorize or Review resolves it.

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
