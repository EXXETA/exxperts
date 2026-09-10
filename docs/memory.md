# Memory

> Audience: anyone wondering "does it remember me", and anyone who wants
> to understand what is stored, where, and who approves it.

## TL;DR

exxperts has two memory systems, one per surface:

| Surface | Memory | Where | Who writes it |
| --- | --- | --- | --- |
| **Persistent rooms (web)** | The room's L1b memory file, grown through Remember → Memorize → Review | `~/.exxperts/app/personalized-agents/<id>/` | Only you, through approval screens |
| **CLI (ExxCode)** | Context files + a fact store + session compaction | repo `AGENTS.md`, `~/.exxperts/app/memory.jsonl` | You directly, or the model with your approval |

The room memory engine is the product's core; the CLI layers are
conveniences for the coding workspace.

## Room memory: the L1b lifecycle

Each room boots from its own memory file with four sections:
**Chronos** (temporal spine), **Deep Memory** (consolidated
understanding), **Active Items** (live threads), and **Recent Context**
(a chronological buffer of per-session compressions).

Nothing enters or leaves this file without you:

1. **Remember**: at the end of a work session (the room shows a
   context meter so you know when it's worth doing), a compression
   worker proposes a Recent Context entry at your chosen density. You
   can add a steering note; anything you explicitly asked the agent to
   remember is marked **must-keep** and survives every compression
   budget. You review the proposal and approve or discard it. The
   default Remember button runs a fast path at standard density and
   shows you the proposal before saving; a room set to remember
   without preview saves warning-free proposals straight away and
   falls back to the preview for anything questionable.
   "Remember with options…" always opens the full preview. When a
   proposal had to be kept within what the next step accepts, the
   proposal screen says exactly what was shortened. Recent Context has
   a cap: Remember warns when one more save would fill it, and after
   that you Memorize before remembering again.
2. **Memorize**: once several remembered sessions accumulate, an
   assessment proposes what to merge into stable memory and what to
   forget. You can discuss it before approving the consolidated
   rewrite. Must-keep content carries through with its marker; later
   entries supersede earlier ones. The proposal states its effect on
   the room's memory budget (below), and an outcome that would leave
   the room over budget is never applied without your approval.
3. **Review**: a review of stable memory only (Deep Memory + Active
   Items) that tightens and reorganizes without growing it. Must-keep
   entries are only removed at your explicit direction, and any such
   removal is called out in the proposal, never silent. This is where
   the memory budget binds: the proposal names every drop and every
   compression before the candidate text, and a candidate that comes
   back over budget is drafted once more with the reasons; what still
   does not fit returns as a disclosed partial for you to decide on.
   The assessment that opens a Review has a **Reassess** button when
   it reads wrong: the model is asked again with the reasons, and
   nothing is saved. Before a Review removes material you can tick
   **save to Files**: the full text goes to the room's Files and a
   must-keep pointer to it stays in memory. Nothing is exported unless
   you choose it, and a failed save never touches memory.

Every approved change archives the previous memory file and writes an
event record with content fingerprints, so you can always see what
changed, when, and from what.

Rooms also have a per-room **Automatic memory maintenance** toggle
(default off). When on, Memorize and Review proposals apply
automatically only when they are structurally clean, carry no
must-keep removals, and do not leave the room over its memory budget;
anything else falls back to the manual review above, where the card
states the impact and you decide.

## The memory budget

Every room has a memory budget. It measures **Deep Memory plus Active
Items**, the stable memory a Review rewrites, in estimated tokens
(about four characters per token); Chronos and Recent Context are not
counted, because Recent Context is intake that Memorize clears and
Chronos is system-managed. The default is 20,000 tokens, adjustable in
the room's settings between 10,000 and 50,000 (`memoryBudgetTokens`).

The room card, the room's settings and the Memory page all show the
same number and the same verdict, over or under. An over-budget room
keeps working; the card badge says "memory over budget" and points you
to Review.

A room crosses its budget only through a proposal you approve. The
proposal names every drop and every compression first, the impact card
shows before and after, and the automatic path never applies an
outcome that leaves the room over. You can always approve an
over-budget outcome knowingly, and there is always a working way back
under: the next Review derives its pruning depth from how far over the
room is.

Every refusal along the way says what happened, that your memory is
unchanged, and what to do next. One refusal can meet you at the door:
a room whose memory and setup no longer fit the usable window of its
model refuses to start a conversation rather than failing on the first
reply. Memory is unchanged and nothing is sent to the model. The way
out is spelled out in the message: open Room settings, Session, and
choose **Forget** (it closes the session without using a model and
unlocks the room); then from Home open Maintain and run **Memorize**
if most of the room's memory is recent sessions, or **Review** if most
of it is long-term; or open the room again with a larger-context
model. A room that was close to its limit before 0.11.0 can meet this
refusal for the first time after updating: that is the new check
working, not new damage.

Memory entries carry the date they were saved ("saved on", never the
date the described events happened). Review reads that age as a prior:
older material is the first place it looks for tightening, but age
alone never deletes anything, unstamped material is never treated as
old, and a drop made partly for age says so next to its date.

If you tuned `memoryBudgetTokens` before 0.11.0, note that the number
was then read against the whole memory file; it now measures Deep
Memory and Active Items only, so the same number binds less tightly
than it did.

**What the workers are:** ephemeral, tool-less model processes with
locked models. They propose text; they cannot write files, browse, or
touch memory. Only the approval endpoint writes.

**What to say in chat:** just ask the agent to remember things in your
own words. There are no magic phrases: explicit remember-requests are
detected and protected regardless of phrasing.

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
