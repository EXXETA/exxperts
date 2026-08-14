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
   "Remember with options…" always opens the full preview.
2. **Memorize**: once several remembered sessions accumulate, an
   assessment proposes what to merge into stable memory and what to
   forget. You can discuss it before approving the consolidated
   rewrite. Must-keep content carries through with its marker; later
   entries supersede earlier ones.
3. **Review**: a review of stable memory only (Deep Memory + Active
   Items) that tightens and reorganizes without growing it. Must-keep
   entries are only removed at your explicit direction, and any such
   removal is called out in the proposal, never silent.

Every approved change archives the previous memory file and writes an
event record with content fingerprints, so you can always see what
changed, when, and from what.

Rooms also have a per-room **Automatic memory maintenance** toggle
(default off). When on, Memorize and Review proposals apply
automatically only when they are structurally clean and carry no
must-keep removals; anything else falls back to the manual review
above.

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
