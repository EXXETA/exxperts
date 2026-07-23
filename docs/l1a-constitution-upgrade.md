# Upgrading room constitutions (L1a) to the current template

Each room's "constitution" (`L1a.md`) is written once when the room is created.
When the platform ships an improved constitution template, existing rooms keep
their old one until you run the upgrade below. The upgrade re-renders the
constitution from the current template using the room's own identity (its name,
your name, preferred address). It does **not** touch the room's durable memory
(`L1b`): everything the room has learned stays exactly as it is.

Every upgrade is archived and auditable, like all memory-adjacent mutations in
exxperts: the previous constitution is copied to `L1a-archive/` inside the room
folder, and a fingerprinted event record is written under
`events/constitution-upgrade/`.

## When to run this

After pulling a version whose release notes mention a new constitution
template. Running it when nothing changed is safe; rooms already on the
current template are skipped ("already up to date").

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

   Each room prints either `WOULD upgrade constitution v1 -> v2` or
   `already at template v2, nothing to do`.

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

   The second line should contain `template_version=2`.

6. **Use the room normally.** New sessions boot with the upgraded
   constitution immediately. A room session that was saved before the upgrade
   resumes with its previous boot snapshot and picks up the new constitution
   at its next checkpoint; that is expected.

## What changes in the room's behavior

The v2 template is the Day-2 prompt-layer rework: the agent uses its memory
silently (no "I can see in my memory…" narration), holds its assessments
steady instead of agreeing under pushback, states disagreement plainly with
the concrete reason, and stops ending replies with reflexive
"would you like me to…?" offers.

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
