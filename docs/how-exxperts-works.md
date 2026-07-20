# How exxperts works

> Read this after the [README](../README.md) to understand what the
> product actually is and how its pieces fit. For contributor setup and
> commands, see the [developer guide](developer.md).

## The product in one paragraph

exxperts is a local-first platform for **persistent AI colleagues**. You
create a *room* (a named agent with durable, human-governed memory)
and work with it over weeks, not sessions. The core of the product is
not chat; it is the **memory engine**: an approval-gated lifecycle
(checkpoint → Learn → Review Memory) that turns conversations into durable,
auditable memory the agent boots from next time. Chat orbits the memory
engine, not the other way around.

Everything runs on your machine: the web server binds to localhost
only, state lives under `~/.exxperts/`, and no memory changes without
your explicit approval.

## Lineage

exxperts is a hard fork of the open-source
[Pi](https://github.com/badlogic/pi-mono) coding agent (v0.70.5, MIT).
The fork lives in `runtime/` as `@exxeta/exxperts-*` workspace packages
and provides sessions, model providers, tools, and extensions. The
product layer (persistent rooms, the memory engine, the web app) is
built on top in `apps/` and `pi-package/`.

## Surfaces

| Surface | Command | What it is |
| --- | --- | --- |
| Web app | `exxperts web` | The primary product: persistent rooms with the full memory lifecycle. |
| CLI/TUI | `exxperts cli` | The coding workspace (ExxCode) with repo access; rooms are also reachable from the CLI. |

## Anatomy of a room: four prompt layers

A room's system prompt is assembled from four layers (in
`apps/web-server/src/persistent-agents.ts`), ordered deliberately:
primacy for identity, recency for runtime state.

| Layer | Content | Ownership | Updates |
| --- | --- | --- | --- |
| **L0**, platform kernel | Identity, privacy, style rules | Code | Auto-ships with every release |
| **L1a**, constitution | Per-agent charter and mode preset, versioned | Scaffolded at creation | Explicit migration path (see [`l1a-constitution-upgrade.md`](l1a-constitution-upgrade.md)) |
| **L1b**, durable memory | The agent's long-term memory file | **User-governed** | Only through approved memory workflows |
| **L2**, runtime envelope | Session metadata, workspace grants | Code | Auto-ships; read last |

L1b is the layer that grows. L0, L1a, and L2 are kept deliberately lean
so a fresh room starts with a small prompt and the memory budget belongs
to actual memory.

## L1b: the memory file

Each room owns one Markdown file (`L1b/current.md`) with four fixed
sections:

- **Chronos**: a concise temporal spine of the agent's history.
- **Deep Memory**: consolidated durable understanding.
- **Active Items**: unresolved live state worth carrying forward.
- **Recent Context**: a chronological intake buffer of per-session
  compressions (`RC-0001`, `RC-0002`, …), newest last.

## The memory lifecycle

Three workflows move material through that file. Each follows the same
contract: an isolated worker **proposes**, the human **approves**, the
system **writes**, never the worker.

### Checkpoint: end of a work session

Freezes the active thread and asks a compression worker to distill it
into a proposed Recent Context entry. The default Checkpoint button
runs a fast path at standard density that applies automatically when
the proposal is warning-free; "Checkpoint with options…" opens the
full flow, where you choose a density (compact/standard/rich) and can
add an optional steering note. Things
you explicitly asked the agent to remember are marked **must-keep** and
survive every compression budget. The worker prompt is measured against
the model's context window before the call; oversized transcripts are
reduced with declared elisions (never silently truncated) or refused
with guidance. On approval, the entry is appended, the thread closes at
a clean boundary, and the previous memory file is archived.

### Learn (absorb): consolidating the buffer

Once several Recent Context entries accumulate, Learn reads the chain
*in chronological order* (later entries supersede earlier ones) and
proposes a rewritten L1b: durable material merged into Deep Memory and
Active Items, the buffer cleared, must-keep content carried over with
its marker. The goal is stable memory that gets **denser, not merely
larger**. You see an assessment first, can discuss it, and approve the
final proposal.

### Review Memory (structural review): tightening stable memory

Reviews only Deep Memory and Active Items (Chronos and Recent Context
are withheld from the worker and grafted back byte-exact). It improves
signal density and coherence; claims keep their sources, and
**must-keep** entries can only be removed on your explicit direction;
any such removal is named in the proposal's warnings, never silent.

### Safety rails

- Workers are ephemeral, **tool-less**, isolated model sessions with
  locked models; they cannot touch files or the network.
- Every proposal is `writesMemory: false`; only the approval endpoint
  writes, after fingerprint checks detect any staleness between
  proposal and approval.
- Every write archives the prior L1b (copy-on-write) and records an
  event with SHA-256 fingerprints, so history is reconstructable.

See [`memory.md`](memory.md) for the user-facing walkthrough.

## Models and AI profiles

A global **AI profile** (Claude, ChatGPT Plus/Pro, or a local
OpenAI-compatible gateway) maps each LLM process to an allowed model:
rooms pick from the profile's room-model list, checkpoint workers
inherit the room's model, and Learn/Review Memory use the profile's
maintenance model. The mapping is asserted at call time, so a room
cannot silently run on an off-profile model. Setup is described in
[`provider-setup.md`](provider-setup.md).

## Tools and the workspace

Rooms get tools through a per-room policy rather than a global grant:

- **Workspace grants**: a room can be granted bounded access to a
  chosen folder; workspace tools operate inside that grant.
- **`fetch_url`**: HTTP fetching with SSRF defenses (private-range and
  redirect protection).
- **Web search**: via a local SearXNG instance ([`web-search.md`](web-search.md)).
- **Artifacts**: documents/outputs produced into the app state,
  viewable in a sandboxed artifacts viewer; delegated tasks a room runs
  live in the room's Artifacts panel, with a click-to-watch run view.
- **`read_skill`**: rooms read the skills enabled for them through this
  tool; skills are the sanctioned way to give rooms new instructions
  (extensions never load in rooms). The library lists skills from the
  exxperts store and from the cross-tool `~/.agents/skills` directory
  shared with other agent tools (read-only on our side); wherever a
  skill lives, a room only uses it after you review and enable it
  there, and an edited skill must be re-reviewed.
- **Consult**: a room can ask another room a question via @-mention in
  chat; the consulted room answers read-only from its own memory and
  context.
- **MCP**: external MCP connectors ([`mcp.md`](mcp.md)).
- **Schedules**: recurring background prompts with preflight checks
  and run history.

Tool permissions are an advisory gate (checked and explained per call),
not an OS sandbox; the security boundary is the localhost-only server
and your approval gates, not process isolation.

## Security posture

- The web server binds to `127.0.0.1` only (no LAN exposure),
  validates Host/Origin headers against DNS rebinding, and requires a
  client auth token on API and WebSocket requests (see `SECURITY.md`).
- Durable memory has no silent write path: every mutation goes through
  the proposal/approval workflow and a server-side fingerprint check.
  Warning-free proposals from an action you triggered can apply
  automatically; anything questionable always comes back for a manual
  approval screen.
- State directories are created with restrictive modes under
  `~/.exxperts/`.

## Where state lives

| Path | Purpose |
| --- | --- |
| `~/.exxperts/app/personalized-agents/<id>/` | Each room: L1b memory, archives, event records, threads |
| `~/.exxperts/app/conversations/` | Web conversation history |
| `~/.exxperts/app/persistent-room-schedules/`, `background-runs/` | Schedules and their run history |
| `~/.exxperts/app/usage.jsonl` | Token/cost usage log |
| `~/.exxperts/app/web-search.json`, `searxng/` | Web-search configuration |
| `~/.exxperts/agent/` | Embedded runtime state: provider auth, model registry, CLI sessions |
