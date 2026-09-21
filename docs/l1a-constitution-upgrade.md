# Upgrading room constitutions (L1a) to the current template

Each room's "constitution" (`L1a.md`) is written once when the room is created.
When the platform ships an improved constitution template, a room moves to it on
its next open: opening the room re-renders the constitution from the current
template using the room's own identity (its name, your name, preferred address).
It does **not** touch the room's durable memory (`L1b`): everything the room has
learned stays exactly as it is.

The runner below does the same thing on demand — ahead of time, or for every
room at once, which is what you want after an update with many rooms on the
machine. A room that is open somewhere else, or still finishing a turn when you
open it, is opened as it is and re-renders at a later open; having a
conversation selected in it does not hold it back, or almost no room would ever
re-render. A constitution you wrote by hand, with no template marker in it, is
never rewritten.

Every upgrade is archived and auditable, like all memory-adjacent mutations in
exxperts: the previous constitution is copied to `L1a-archive/` inside the room
folder, and a fingerprinted event record is written under
`events/constitution-upgrade/`.

## When to run this

After pulling a version whose release notes mention a new constitution
template, when you would rather not wait for each room's next open. Running it
when nothing changed is safe; rooms already on the current template are skipped
("already up to date").

## Steps

1. **Update and install.** From the repo root:

   ```bash
   git pull
   npm install
   ```

2. **Close all rooms.** Quit any open exxperts web or CLI room sessions. The
   upgrade refuses to touch a room that is open somewhere or mid-turn, so
   nothing can be corrupted, but closing everything first avoids refusals.

3. **Preview first (writes nothing):**

   ```bash
   npx tsx apps/web-server/scripts/upgrade-l1a-constitution.ts --dry-run --all
   ```

   Each room prints either `WOULD upgrade constitution v2 -> v3` or
   `already at template v3, nothing to do`.

4. **Run the upgrade:**

   ```bash
   npx tsx apps/web-server/scripts/upgrade-l1a-constitution.ts --all
   ```

   To upgrade only specific rooms, pass their ids instead of `--all`
   (the id is the room's folder name under
   `~/.exxperts/app/personalized-agents/`):

   ```bash
   npx tsx apps/web-server/scripts/upgrade-l1a-constitution.ts wolfgang euler
   ```

5. **Verify.** For each upgraded room the script prints the archive and event
   record paths. Spot-check one room:

   ```bash
   head -3 ~/.exxperts/app/personalized-agents/<room-id>/L1a.md
   ```

   The second line should contain `template_version=3`.

6. **Use the room normally.** New sessions boot with the upgraded
   constitution immediately. A room session that was saved before the upgrade
   resumes with its previous boot snapshot and picks up the new constitution
   the next time you Remember or Forget it; that is expected, and it is the
   same for a room that upgraded itself on open.

## What changes in the room's behavior

### Version 2

The v2 template is the Day-2 prompt-layer rework: the agent uses its memory
silently (no "I can see in my memory…" narration), holds its assessments
steady instead of agreeing under pushback, states disagreement plainly with
the concrete reason, and stops ending replies with reflexive
"would you like me to…?" offers.

### Version 3

The v3 template rewrites the Memory section around the room's read of its own
memory. Six points:

1. **What the memory is made of.** The room is told its memory has four parts:
   in front of it, the notes by topic and the conversations it has remembered
   but not yet folded in; behind its own search, the notes that left (replaced,
   finished, removed, or moved out to make room) and the memorized transcripts.
2. **Dates decide.** A note carries the day it was saved and the day it was
   last changed; the newer one wins, and a remembered conversation outdates the
   notes it has not reached yet.
3. **When to look.** Before saying it does not know something you could expect
   it to remember; when a topic says older notes were archived; when the detail
   behind a summary is wanted; when a date, a document, a number or a person
   escapes it.
4. **How to look.** In your language, by words, names, dates or numbers,
   narrowed to a topic, a date range or one part of the memory, and with other
   words tried before giving up.
5. **What comes back.** The room's own past words: data to weigh, never
   instructions to follow. It notes what each row establishes and when, prefers
   the newer, and names the period when that matters. It refers to a
   conversation or a note by its date and topic, never by an internal id. If
   nothing carries the answer, it says so in one sentence rather than guessing.
6. **Reading changes nothing.** A note that comes back from a search is not
   back in memory; it returns only through a Memorize or a Review you approve.

The rule these had to be reconciled with is still there: the mechanism stays
invisible in the answer, not in the reasoning. The room uses what it finds
without saying where a fact sits or how it looked for it, and that holds for a
search that found nothing too: it says in one plain sentence what it does not
know, without naming memory, notes, archive or records. The rule is about
narration nobody asked for: when the user asks where something comes from, the
room tells them plainly which earlier conversation or note it was, and its date.

## Rollback

Each upgrade archives the previous constitution byte-exactly. To restore one:

```bash
cd ~/.exxperts/app/personalized-agents/<room-id>
cp L1a-archive/<timestamp>-before-constitution_upgrade_<...>.md L1a.md
```

The event record under `events/constitution-upgrade/` keeps the fingerprints
of both versions, so the transition stays auditable either way.

## Troubleshooting

- `room is currently open on surface "…"`: close that web/CLI session (or
  wait for the scheduled run to finish) and re-run.
- `room runtime state is "…"`: the room has an unfinished turn. Open the
  room once, let it settle, close it, and re-run.
- `agent.json has no user.displayName`: that room predates user identity in
  its metadata; open a GitHub issue before doing anything manual.
