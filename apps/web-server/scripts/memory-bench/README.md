# Memorize bench

Reproduces the Memorize (absorb consolidation) pipeline on a synthetic room memory of the field's size class, with scripted model replies. Numbers only; no provider needed. Not part of `npm run smokes`.

- `gen-memory.mjs <tokens> <rcEntries>`: deterministic L1b/current.md in the real layout (Chronos, Deep Memory subsections, Active Items, Recent Context entries with rc_metadata). `node gen-memory.mjs 66000 10 > synthetic-66k.md`.
- `measure.mts`: prompt sizes, required reply size against output caps and generation speeds, the prompt-window guard, the validator's verdict per reply shape (complete, cut, decorated headings, fenced, edited Chronos, budget-fit), and whether approval enforces the budget. Also dumps the proposal fixtures the gateway serves. Run from `apps/web-server`: `npx tsx scripts/memory-bench/measure.mts`.
- `memorize-gateway.mjs` + `start.sh` + `e2e.sh`: the real web server against a synthetic OpenAI-compatible gateway whose reply leg is chosen per run (`cut-at-max`, `decorated`, `faithful-fast`, `budgetfit-fast`, `budgetfit-80tps`, `drop-midstream`, `assess-drop`). `MAINT=maint-16k|maint-32k|maint-128k ./start.sh`, then `./e2e.sh <leg>`. Requests are logged to `gateway-requests.jsonl`.

Generated files (`synthetic-*.md`, `*-proposal.md`, `assessment.md`, `home/`, logs) are ignored.

## Fold quality bench

The bench above asks whether a Memorize run FITS. This one asks whether a fold is RIGHT: sessions are folded into a core memory one at a time, through the product's own fold layer (`buildFoldPrompt` → `parseFoldOps` → `validateFoldOps` → `applyFoldOps`), and the memory that comes out is scored against things the fixture planted on purpose.

- `fold-fixtures.mts`: the seeded fixture and the answer key. A small core memory in the v2 storage format (topics, entries with their `<!-- e: ... -->` metadata, one pinned must-keep practice, two open items) and eight sessions in the real Recent Context shape. Every planted thing carries a reference code — `CORE-03` for a core entry, `REF-F01` for what a session plants, `NOISE-02` for a line that must never become an entry — written inside the sentence, so a fold that keeps the point keeps the marker and the scorer can find the outcome. Standalone: `npx tsx scripts/memory-bench/fold-fixtures.mts [--sessions|--key] [--plain] [--seed N]`.
- `fold-models.mts`: the scripted models of the offline run, each a plain prompt-to-reply function. `exact` answers with the planted operations, `lazy` adds every line it sees as a new entry and never supersedes, closes, pins or drops, `decorated` answers like `exact` but buries the fence in prose under `### **Bold**` headings.
- `fold-bench.mts`: the loop, the scores and the tables.

### Running it

Offline, no provider, all three scripted variants (about a second):

```
cd apps/web-server && npx tsx scripts/memory-bench/fold-bench.mts
npx tsx scripts/memory-bench/fold-bench.mts --variant lazy --seed 7
npx tsx scripts/memory-bench/fold-bench.mts --variant exact --show-prompt
```

Against a real model, through the same isolated worker the product's maintenance calls use (no server needed; the provider must be signed in under AI setup):

```
FOLD_BENCH_MODEL=anthropic/claude-sonnet-5 npx tsx scripts/memory-bench/fold-bench.mts
```

A real-model run renders the sessions PLAIN: the markers stay, the `<!-- plant: ... -->` directives the scripted models read do not, so the model is answering the same session a room would give it.

### Reading the tables

The first table is one row per session, in fold order: `ops` is how many operations were applied, then the applied counts per kind (`add`, `upd`, `sup`, `close`, `pin` — `pin` includes the entries the applier pinned because their text carries a must-keep marker), `drop` says whether the session was dropped, `calls` is 1 or 2 (a refused reply gets one retry with the refusals appended as a Retry Notice), `prompt` and `reply` are the largest estimated token counts of that session's calls, and `outcome` says applied, applied after one retry, or REFUSED with the first refusal.

The second table is one row per scoring category, with `passed/planted` and a verdict: `all right`, or one clause per miss naming the planted thing and what happened to it instead. The categories are the fold's promises — facts captured under the topic they belong to, reversals landing as the newer state with the older text gone, items closed, the must-keep line pinned and word for word, chatter dropped with a reason, a correction across two sessions resolving to the later state, a pin the user asked for honoured, noise excluded, and no marker carried by two entries. Nothing scores an operation SHAPE: a fact that reached the right topic by an `update` of the entry that already carried the subject scores exactly like one that arrived as an `add`, because the memory is the same either way.

The last line is the size story: entries and estimated memory tokens before and after, the prompt range per call, the largest reply, and the call count — the numbers the design's "no reply above ~4k tokens" promise is read off.

`exact` must score every category perfectly; anything less is a bug in the bench rather than a fold failure, and the run says so. `lazy` is there to be penalised visibly (it scores 1/33 on the default fixture: it keeps the must-keep line, which the applier pins on its own, and misses everything else). Each offline run also rehearses the refusal path once, with a reply that names an entry the memory does not hold, and reports that the retry cleared it.

Judgment is never an exit code. The bench exits non-zero only when the parser, the validator, the applier or the entry model throws or disagrees with the fixture; a model that folds badly is a table with low numbers in it.
