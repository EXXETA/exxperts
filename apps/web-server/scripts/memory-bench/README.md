# Memorize bench

Reproduces the Memorize (absorb consolidation) pipeline on a synthetic room memory of the field's size class, with scripted model replies. Numbers only; no provider needed. Not part of `npm run smokes`.

- `gen-memory.mjs <tokens> <rcEntries>`: deterministic L1b/current.md in the real layout (Chronos, Deep Memory subsections, Active Items, Recent Context entries with rc_metadata). `node gen-memory.mjs 66000 10 > synthetic-66k.md`.
- `measure.mts`: prompt sizes, required reply size against output caps and generation speeds, the prompt-window guard, the validator's verdict per reply shape (complete, cut, decorated headings, fenced, edited Chronos, budget-fit), and whether approval enforces the budget. Also dumps the proposal fixtures the gateway serves. Run from `apps/web-server`: `npx tsx scripts/memory-bench/measure.mts`.
- `memorize-gateway.mjs` + `start.sh` + `e2e.sh`: the real web server against a synthetic OpenAI-compatible gateway whose reply leg is chosen per run (`cut-at-max`, `decorated`, `faithful-fast`, `budgetfit-fast`, `budgetfit-80tps`, `drop-midstream`, `assess-drop`). `MAINT=maint-16k|maint-32k|maint-128k ./start.sh`, then `./e2e.sh <leg>`. Requests are logged to `gateway-requests.jsonl`.

Generated files (`synthetic-*.md`, `*-proposal.md`, `assessment.md`, `home/`, logs) are ignored.

## Fold quality bench

The bench above asks whether a Memorize run FITS. This one asks whether a fold is RIGHT: sessions are folded into a core memory one at a time, through the product's own fold layer (`buildFoldPrompt` → `parseFoldOps` → `validateFoldOps` → `applyFoldOps`), and the memory that comes out is scored against things the fixture planted on purpose.

- `fold-fixtures.mts`: the seeded fixture and the answer key. A small core memory in the v2 storage format (topics, entries with their `<!-- e: ... -->` metadata, one pinned must-keep practice, two open items) and eight sessions in the real Recent Context shape. Every planted thing carries a reference code (`CORE-03` for a core entry, `REF-F01` for what a session plants, `NOISE-02` for a line that must never become an entry), written inside the sentence, so a fold that keeps the point keeps the marker and the scorer can find the outcome. Standalone: `npx tsx scripts/memory-bench/fold-fixtures.mts [--sessions|--key] [--plain] [--seed N]`.
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

The first table is one row per session, in fold order: `ops` is how many operations were applied, then the applied counts per kind (`add`, `upd`, `sup`, `close`, `pin`: `pin` includes the entries the applier pinned because their text carries a must-keep marker), `drop` says whether the session was dropped, `calls` is 1 or 2 (a refused reply gets one retry with the refusals appended as a Retry Notice), `prompt` and `reply` are the largest estimated token counts of that session's calls, and `outcome` says applied, applied after one retry, or REFUSED with the first refusal.

The second table is one row per scoring category, with `passed/planted` and a verdict: `all right`, or one clause per miss naming the planted thing and what happened to it instead. The categories are the fold's promises: facts captured under the topic they belong to, reversals landing as the newer state with the older text gone, items closed, the must-keep line pinned and word for word, chatter dropped with a reason, a correction across two sessions resolving to the later state, a pin the user asked for honoured, noise excluded, and no marker carried by two entries. Nothing scores an operation SHAPE: a fact that reached the right topic by an `update` of the entry that already carried the subject scores exactly like one that arrived as an `add`, because the memory is the same either way.

The last line is the size story: entries and estimated memory tokens before and after, the prompt range per call, the largest reply, and the call count: the numbers the design's "no reply above ~4k tokens" promise is read off.

`exact` must score every category perfectly; anything less is a bug in the bench rather than a fold failure, and the run says so. `lazy` is there to be penalised visibly (it scores 1/33 on the default fixture: it keeps the must-keep line, which the applier pins on its own, and misses everything else). Each offline run also rehearses the refusal path once, with a reply that names an entry the memory does not hold, and reports that the retry cleared it.

Judgment is never an exit code. The bench exits non-zero only when the parser, the validator, the applier or the entry model throws or disagrees with the fixture; a model that folds badly is a table with low numbers in it.

## Recall bench

The fold bench asks whether one fold is right. This one asks what is left of a room after thirty of them, and whether the room can still ANSWER. A fixture's conversations are Remembered into a real room and Memorized through the product's own run, and then, per question, the bench reports three things in order: WHERE that question's evidence ended up (still in the core memory, pushed out to the archive, only in a conversation the room memorized, still waiting in Recent Context, or gone), whether the room's own `memory_recall` FINDS it, and whether the room's answer is right. Nothing is imitated: the room is scaffolded by the product's own scaffold call, a Remember is a real approved checkpoint write, a Memorize is a real absorb run and its approval, the budget is the room's own setting through the real settings writer, the retrieval is the room's own recall tool, and the ask is the real WebSocket turn against the real server. What a run scripts is only the MODEL.

- `recall-fixtures.mts`: the seeded fixture. Thirty dated conversations and sixty questions per language, in German and English (the two halves share one layout and differ in language, world and content), fifty across five abilities: extraction (the answer sits in one conversation), multi-session (it takes two), temporal (an order or an interval), knowledge-update (a later conversation replaced the value), and abstention (nothing was ever said, and the right answer is to say so), and ten more whose answer was SAID and never NOTED: ordinary extraction and multi-session questions whose evidence stands in a conversation and in no Recent Context entry, so no fold ever made a note of it. Every planted fact sits inside a sentence that carries a reference code, `REC-E07` and its like, so that a note which keeps the point keeps the marker and the bench can say where that point went. Each question also carries three ways of asking for the same evidence: the literal words, a paraphrase, and a respelling (umlauts written out, another date or number form). A question resting on SEVERAL sentences (a temporal one, a multi-session one) quotes every one of them in its literal and its variant: the demotion ranking can leave one sentence in the core and put the other in the archive, and a literal that quotes only the first can never reach the second, so each sentence whose wording the hand-written literal does not already carry (nearly all of its words, the way the engine reads carrying) is appended to it whole, without its reference code, and to the variant respelled the way the language's variant rule respells, the sentence the hand-written literal quotes a fragment of included, because a query holding one sentence whole and the other as a fragment hands back the whole one's note and the transcript that said it before the fragment's note. The paraphrase stays a paraphrase. The bar for such a question is every retrieved sentence within as many results as it has sentences, and the literal and variant question lines under the retrieval table count how many made it. Standalone: `npx tsx scripts/memory-bench/recall-fixtures.mts`.
- `recall-engine.mts`: the machinery every run shares: the temp home, the room, the Remember and Memorize pairs (scripted and real), the ingest loop, the locator, the retrieval probe, the answer scorer, the tables, the scripted room gateway, the server, one turn, and the isolated worker every real model call goes through.
- `recall-bench.mts`: the run, the tables and the exit code. `scripts/recall-bench-smoke.ts` pins the machinery offline.

### The fact that was said and never noted

Four places were not enough. A question's evidence used to be in the core, in the archive, still waiting in Recent Context, or gone, and a fifth, `conversation`, is the fact the room was TOLD and never wrote down: no note carries it, in the core or the archive, and the transcript of the conversation a Memorize folded still says it word for word. The fixture plants those on purpose (`noted: false`, ten questions a language), the locator looks there last, and the mechanical "a planted marker is nowhere" check reads `gone` only when the transcript has lost it too: a folded conversation is searchable, so a planted marker that vanishes from one is the indexing failing rather than the fold. Those rows are retrieval's alone: nothing about them is in front of the room, so a `none` in a conversation row is the whole answer lost, and they are counted beside the archive's in the question lines under the retrieval table.

`--sources notes,archive,conversations` restricts what a recall may read, in the tool's own words, and the restriction goes everywhere at once: the bench's own retrieval probes, the code control, and the scripted room's first leg, which calls `memory_recall` with the question's literal query and those sources. The default passes nothing, which is what a room does.

The ranks themselves are read off the TOOL'S OWN row list where it has one (`details.rows`, every matched row in score order) rather than off the envelope it rendered: an envelope holds what fitted, so a rank read there is a rank among the results that were printed. The old `[MEMORY ARCHIVE …]` envelope is still parsed, so the same run reads either side of that change.

### The conversation the fold dropped, and the claim audit

A Memorize does one of two things with a conversation: it FOLDS it, taking notes, or it DROPS it, judging that nothing in it outlives the sitting. Both are memorized, both leave Recent Context, and the product indexes the transcript of both, a dropped one with the origin `from a conversation on 2026-07-14 (no notes taken)`. An origin names the day and never the Recent Context id, which stays in the row's details for the tools; where a room memorized two or more conversations of one day, each of them adds its time, as in `from a conversation on 2026-07-14 at 14:30 UTC`. So the locator keeps a sixth place, `dropped`, printed as `conversation (no notes)`: a fact said in a conversation the fold took no notes from, where the transcript is all the room has. It is searched after `conversation` and before a marker is called `gone`, it is a place recall has to answer for like the archive and a folded conversation, and it has its own column in the forgetting table and its own rows in the retrieval table. It is kept apart from `conversation` because the two are indexed on different grounds, and a table that merged them could not say which of the two a search stopped reaching.

The fixture plants one such fact per language. The last sitting of the full fixture, the quarter close, plants nothing the Remember writes down, so the scripted fold drops it whole; one sentence in it names a binder (`the Tollgate file`, `die Schleusen-Akte`), never noted, and one extraction question asks for it with a literal, a paraphrase and a variant query. The plant goes into the LAST sitting of a run and only when that sitting notes nothing, which is true of the thirtieth sitting and of no other: at any smaller size nothing is planted and nothing is asked, and at the full size the plant's marker is numbered after every other class and its question comes last of all, so every earlier sitting, marker, question id and query is byte for byte what it was. `--key` lists the question in a block of its own, `no notes taken`, after the planted pairs. Seeing the place in a run therefore takes all thirty sittings: `--sessions 30 --per-ability 1` is the smallest run that prints it.

Under every table sits an assumption: the search index holds the conversations the room memorized, each under the conversation it was. The CLAIM AUDIT checks it. After the last Memorize the ingest reads the room's corpus afresh and counts three things, printed as `claims: N memorized, N unindexed, N misassigned`:

- `memorized`: the conversations whose final outcome was folded or dropped. A conversation a fold refused is still waiting in Recent Context and is not counted; one refused by an early Memorize and folded by a later one is.
- `unindexed`: memorized conversations with no conversation document at all. No question can reach them by searching.
- `misassigned`: conversations the index holds under the wrong name, either a document whose conversation was never memorized, or one whose Recent Context id is not the id that conversation was Remembered under. That is a fold that took another conversation's transcript. It counts conversations, not chunks.

Both defect counts are zero on a sound pipeline, and neither is a finding about a model: in the recall bench a non-zero count is a mechanical failure, printed in full, and the run exits non-zero at the end. There is no flag for it. The numbers are in the results file under each run's `summary.claims`.

The audit exists because of what the first real run on LongMemEval showed. A room hands its Recent Context ids out again once a Memorize has emptied the section, so the index has to tell two uses of `RC-0001` apart, and it did so by time. The bench stamped every conversation of a day at 09:00:00 and the Memorize at 09:01:00, so the conversation remembered after a fold carried an EARLIER stamp than the fold, ties were everywhere, and folds were handed other conversations' transcripts: about a third of what the rooms had memorized was in the index. The product now writes the conversation's name into the fold record and, for older records without one, takes the oldest unclaimed Remember. The bench for its part stamps STRICTLY INCREASING: a Remember at the later of its session's own clock (the date at 09:00Z) and one minute after the previous stamp, a Memorize one minute after the last Remember it folds, the next Remember one minute after that. A day holds a few dozen stamps at most, so no saved-on day moves. With no ties left, the fallback rule is exercised on a clean clock and an audit that reads zero reads zero because of the pipeline and not by luck.

### The back history, and why the budget floor forces it

The point of the bench is forgetting BY BUDGET: the note that left the core because a newer one needed the room. Thirty conversations fold into one or two thousand tokens of notes, and the product refuses a memory budget below ten thousand (two orders of magnitude apart), so no budget a room may legally hold can ever be crossed by the fixture's own material. What crosses it is the room's BACK HISTORY: the notes a room already in use is holding when the fixture's first conversation arrives. The bench seeds one, sizes it from the run rather than from a constant, and spreads its dates evenly from thirty days before the first conversation to the day of the last, because the demotion ranking leaves the least recently touched note first among notes worth the same, and a back history dated all on one old day would simply be shed first every time and the forgetting curve would come out flat. Its notes are written a little smaller than the fixture's own, for the same reason the other way round: the ranking takes a larger note before a smaller one worth the same, so a filler note two or three times the size of a planted line would be shed first however old the planted line, and the back history would shelter the fixture instead of competing with it. That is why a back-history note is SEVEN words (`BACK_HISTORY_NOTE_WORDS`), smaller than every planted line, and stays so: under the score, size decides among old unused notes, and a filler larger than the planted lines would leave first every time, so nothing planted would ever be archived and the archive location would not exist at all. A run with only ONE fold is the case no size can fix: a Memorize puts what it has just saved last, so its own notes are safe inside it and there is no later fold to take them. `--fold-every` is how a short run gets a second one.

### The open items

Two extraction questions per language (the two lowest-numbered whose plant nothing later replaces or rewrites) are planted as OPEN ITEMS rather than facts: their RC directive reads `kind=item`, the scripted fold adds them to Active Items with status open, and the question carries `openItem: true`. The room's budget never moves an open item out, so these are the markers a run counts to see that protection hold; their wording, their questions and their ids are the same as before, only the kind of note the fold saves them as has changed. The fixture's self-check refuses a build where the count, the directive or the later history disagrees.

### Duplicates and conflicts

Memory has one test for "do these two notes say one thing", and since 0.13 it has two answers: a duplicate (the same words, the same values) and a conflict (the same words, another date, number or negation). The fold refuses the first as a repeat and tells the second to supersede the older note; the Review lists the second apart, as notes that disagree. The fixture plants both on purpose, per language, as five PAIRS of sentences said in two conversations three or more sittings apart, each pair authored into the world's own story:

| shape | what the pair is | what the run expects |
| --- | --- | --- |
| duplicate | the same sentence, word for word, in two conversations | one note carries it, the second add is refused as a repeat and left out, nothing is superseded |
| conflict-long | nine normalised words, eight shared: the shape the twin test calls alike (Jaccard 0.80 exactly) | the newer wording is a note, the older is an archive row that reads `superseded`, never `duplicate`, and the row carries a reason naming both values |
| conflict-short | under the twin test's six-word floor, three or more plain words around one date group | the same |
| moved-event | a dated event whose date moved ("Sprint 12 review is on 20 May", then 10 June) | the same |
| decoy | two events under one topic with a different number AND a different date ("Sprint 14 review is on 3 July", "Sprint 15 review is on 17 July") | both stay, and no pair in the final core names either |

The members of a pair carry their reference code in square brackets (`[REC-E62]`) rather than in parentheses. The code is the bench's scaffolding and not part of the sentence, and the product's classifier reads a bracketed id as the system's own mark and drops it, where it would read a code in parentheses as a value (a code has digits in it, the way a ticket number does) and call every pair a conflict. Every other planted sentence keeps its parentheses, and every marker of the fixture as it was keeps its number: the pairs are numbered after the noted and the said-not-noted markers, and they are planted as the last turn of their sittings, so the abilities' questions, ids, evidence and queries are byte for byte what they were (`--key` from the fixture before and after the pairs differs only by the `--- conflicts` block). The smallest run that holds all five pairs whole is thirteen sittings; the smoke's eight-sitting runs hold the duplicate and the two conflicts and say `n/a` for the rest.

Each pair asks one question: a knowledge-update question on the newer member of a conflict (the older value is the trap), an extraction question on the duplicate's first member and on the decoy's second. They carry a `shape`, and they are counted APART from the ability tables: the forgetting table, the retrieval tables, the interleave table and the ask line leave them out, because what they measure is not whether the room can find a note but what the memory made of the pair, and a table that mixed the two would say something untrue about both. In the results file their rows carry `shape`, and the summary carries a `conflicts` block.

The scripted fold answers a refusal the way the refusal asks. A Retry Notice that refuses `op N (add)` as a repeat (the sentence says the note `already says` it) has that add left out of the second reply and the rest answered as before; a reply whose every operation was a repeat drops the session. Any other refusal is answered as before, so a fixture the memory genuinely disagrees with still fails twice and is reported as mechanical. The adds left out are counted (`twinsRefused`, on every Memorize outcome and every ingest step).

After the `supersedes:` line the run prints the conflicts block:

```
conflicts: 3 found, 3 superseded with a reason, 0 left as both, 1 repeats refused as twins
  duplicate       ok    one note carries the sentence, the second add was refused as a repeat and left out (REC-E63 reads archive, found by wording)
  conflict-long   ok    REC-E65 in the core, REC-E62 superseded as m-0944-v1: "1 July (saved 21 Apr) replaces 1 June (saved 23 Apr); the newer date decides"
  ...
  3 of 5 right
```

`found` is the rows the room's own Memorize records (`events/absorb/*.json`, `run.archived`) say were superseded with a reason, plus the pairs the product's own predicate still finds disagreeing in the final core; `superseded with a reason` is the first of those and `left as both` the second; `repeats refused as twins` is the ingest's count. The pair search leaves the back history's filler notes out: each carries its own reference number, which is a value, and every twenty-fourth of them repeats the words of another, so the product rightly lists those as disagreeing, and left in they would fill the predicate's ceiling of thirty pairs before any planted note was reached. Then one line per pair, `ok` or `FAIL` with the detail read off the room's files (the archive by the planted line's code first and its words second, the core by the locator, the records for the reason), `n/a` for a pair the size holds only half of, and, when the room was asked, how many of the pairs' own questions it got right. A newer wording the budget moved out AFTER the supersede reads "in the archive by budget" and is still ok: that is the ordinary forgetting of a long run, not the conflict's doing. A `FAIL` is printed in full on every run and is an exit code only under `--gate-conflicts` or `--gate-before`.

```
npx tsx scripts/memory-bench/recall-bench.mts --language both --sessions 13 --per-ability 2 --fold-every 3 --gate-conflicts
```

### The room asked between the folds

A room that is only asked at the end has never been used, and the demotion ranking now reads use: a note the room looked up is worth keeping. `--interleave` asks the room after EVERY Memorize, through its own recall with the question's literal query, every question whose evidence has been ingested by then, and asks it again at every later fold, because that is what repeated real use looks like: the same things are asked about more than once, and the hits add up in the room's use sidecar the way they would over weeks. Abstention questions plant nothing and are not asked. A probe records, per marker, whether it ever came back from the NOTES: that is "asked while in core", the room looked it up while the budget could still have taken it. After the probes the sidecar is written out (the product coalesces its writes on a timer the next fold would outrun), so the next Memorize's ranking sees the counts. On a product without the sidecar the probes record nothing and the run says so; that run is the "before" of the gate. The run header says `interleaved`, every result row carries `askedWhileInCore`, the summary carries an `interleave` block (null when the run did not interleave), and the bench prints the product's score constants, or `score constants: none (fixed sort)` on a product that ranks by date alone.

The forgetting table an interleaved run prints:

| line | what it counts |
| --- | --- |
| asked (evidence of a question) | distinct markers cited by the questions that were asked at least once |
| asked while in core | markers a probe returned from the core notes at least once |
| still in core | of those, the ones still in the core at the end |
| then archived by budget | of those, the ones the budget moved out afterwards: the archive's own `budget` reason, never a supersede |
| then gone | of those, the ones no part of the room's memory carries any more |
| open items planted | the markers the fixture planted as open items |
| still in core | how many of them the budget left alone |
| moved out by budget | rows the room's own Memorize records (`events/absorb/*.json`, `run.archived`) say left by budget |
| with a reason | how many of those rows say why in a sentence |

`--gate-before <results.json>` holds the run against an interleaved run of the product BEFORE the ranking read use, per language: (a) the asked-then-demoted markers (then archived by budget + then gone) are at most half of what they were before, (b) every open item is still in the core, (d) every row moved out by budget says why. (c), the order of the score's own terms, is the ranking smoke's. Without `--gate-before` the numbers are only printed; with it a failed gate is a clear line and a non-zero exit, the one place a judgment number is an exit code. The gated run also prints the median answer tokens before and after.

```
npx tsx scripts/memory-bench/recall-bench.mts --interleave --language de --out results/recall-de-interleave-after.json
npx tsx scripts/memory-bench/recall-bench.mts --interleave --language de --gate-before results/recall-de-interleave-before.json
```

The before file comes from the same bench files run on a checkout of the product before the sidecar and the score; the three bench files import the sidecar on demand and read the score constants only if they exist, so they run unchanged on either side.

### The question without a hint

Every other question is worded from its planted sentence, so the room never has to DECIDE to search: the words of the question already match the note or the transcript, and an archived fact sits under a topic whose pointer line says older notes exist. The sixth class takes both hints away. Six questions per language, hand-written in the world's own story like the said-not-noted ones, each resting on one sentence said in passing at the end of a sitting that notes other things: the fold keeps the conversation, the Remember never wrote the sentence down, so it sits in a folded transcript (`conversation`) and nothing in the window points at it. The question asks in everyday words: the plant says the crew "sits in the Marlow room on the second floor", the question asks which door to knock on to join the people doing the cutover. Beyond the named person or thing itself (each seed names its `entity`) the question shares no content word with the planted sentence or with the turn that led to it, and the fixture's self-check refuses a build where it does; the smoke checks the same with every word of four letters or more, function words included. The literal, paraphrase and variant queries are the usual ones, so the retrieval probe still says whether a search, once made, finds the sentence. They are scored like extraction, taken whole rather than per ability at every size that holds their sittings (two of the six sit inside the first eight), and placed so that nothing before them moves: the plants are one more exchange at the end of their sittings and numbered after every other class, the dropped conversation's included, the questions come after every other id, and `--key` lists them in a block of their own, `no hint`, so the key before and after differs by that block alone. They enter no ability table and no retrieval table and are not asked between the folds of an interleaved run, where a probe with their literal query would be the hint. They are counted in a last column of the forgetting table, `no hint`, after `all`, in a line under it (`no hint: 6 question(s) in conversation · recall finds literal 6/6, paraphrase 6/6, variant 6/6 · 4/6 right`), in the summary's `noHint` block, and under `--gate-before` in a line beside the gate (`no hint right before/after (de): 2/6 before, 4/6 after`). That score is the row a change to the room's instructions can move, which is what it is for; it is reported and never a gate by itself.

### How an abstention is scored

An abstention is right when the room invents nothing AND says it does not know, and the first half is the gate. Inventing is read as before: a trap spelling of the question, its `trapPattern` still matching once every fact the fixture plants or accepts is taken out of the answer, or a hedge in front of either. A hedge in front of any number is a guess as well, whatever the question asked for ("I don't know, but it is probably 4,750 or so" is wrong on every abstention question): a question's own trap is shaped for its own subject and would let an amount, a count or a date through. A number with no hedge before it is left to the question's own trap, so a date the room states or a known budget it quotes costs nothing. Saying so used to mean carrying one of a fixed list of phrases, and the real runs showed what that costs: eleven of twenty honest abstentions were called wrong for their wording alone ("Nothing in memory gives a headcount", "No deputy has been named yet", "Dazu liegt nichts vor", "ist nirgends notiert") while the LongMemEval judge accepted all twenty. So the list is now evidence and not the gate: an answer says it does not know when it carries a phrase of the list or a plain negation (no, not, nothing, never, nowhere, don't, doesn't, isn't, nicht, nichts, nirgends, kein, keine, keinem) in what is left of it once the fixture's own facts are removed, read as whole tokens in the scorer's spelling, where an apostrophe splits a word and "don't" is "don" followed by "t". A negation is no licence to guess: "never written down, but I believe it was the Radisson" and "nothing was agreed, about 140 EUR a month" fail on the invention exactly as they did. The smoke holds the eleven rejected answers against their own questions, word for word, and both result files of that run re-score to ten of ten.

### The answers that name the mechanism

The room is told to use what it remembers the way a colleague does and to keep the mechanism out of what it says, on a hit and on a miss alike. A run with `--ask` counts the answers that do not: `narratesMechanism` matches, as whole words side by side and in both languages, the wordings that say where a fact sits or that it was looked for ("in my memory", "in memory", "in my notes", "in the archive", "on record", "let me check", "in meiner Erinnerung", "in den Notizen", "im Archiv", "festgehalten" and the like; `NARRATION_PHRASES` is the list). The count is printed under the score (`narrates: 3 of 60 answers name the mechanism`) and carried in the summary as `narrates: { answers, narrating }`, over every answer of the run, the planted pairs' and the no-hint ones included. It is a wording count and errs on the generous side ("on record" is also how a careful colleague talks), so it is read as a trend between two runs of the same fixture and is never a gate.

The room is also told to name a conversation or a note by its date and what it was about, never by an id a person cannot read. The same run counts the answers that do not: `citesInternalId` matches a conversation's `RC-0004` or a note's `m-0031` as a whole token with three or four digits, so "(RC-0003)" and "m-0031." count and "ARC-0004", "form-0031" and "RC-00045" do not; `RC` is read in either case and `m-` in lowercase only, which is how the product writes it. The count is printed under the narrates line (`internal ids: 2 of 60 answers cite an internal id`) and carried in the summary as `internalIds: { answers, citing }`, over every answer of the run. It is a count read between two runs of the same fixture and is never a gate.

### The scripted ceiling

Offline, the room's model is a gateway on a random port whose first leg calls `memory_recall` with the question's literal query and whose second leg quotes back, verbatim, the lines carrying the question's evidence (from the tool's results when the search returned them, out of the archive or out of a conversation, from the memory in its own system prompt when the core still holds them), and answers "I don't know" when neither reached it. That is a room that reads perfectly and invents nothing, so what it scores is the accuracy the MEMORY allows. It is a ceiling, not a score: two abilities ask for more than quoting. A multi-session question needs two archived notes and one turn makes one recall call; a temporal interval is arithmetic over the quoted lines, which a quoting model never does. A real model is expected to beat that ceiling on the same room, and the run prints it so that nobody reads the scripted number as a wiring failure.

### Running it

Offline, no server, no provider, no network, no port; the whole run lives in a temp HOME that goes with it:

```
cd apps/web-server && npx tsx scripts/memory-bench/recall-bench.mts
npx tsx scripts/memory-bench/recall-bench.mts --language de --sessions 6 --per-ability 1 --fold-every 3
npx tsx scripts/memory-bench/recall-bench.mts --out /tmp/recall.json --keep-home --show-memory
npx tsx scripts/memory-bench/recall-bench.mts --sources notes,archive
```

With the room ASKED, still offline, by the scripted room model, and with the real Remember and Memorize driven against that same gateway rather than a provider: the one free run in which the notes reach memory in a model's own words, without their reference codes:

```
npx tsx scripts/memory-bench/recall-bench.mts --ask
npx tsx scripts/memory-bench/recall-bench.mts --ask --real-ingest
```

Against a real model. `RECALL_BENCH_MODEL` picks it, the machine's signed-in provider records are copied into the temp home read-only and no key is ever printed, and `--dry-run` prices the work and stops before anything is spawned. `--scripted-ingest` keeps the room the free one and lets the model answer only:

```
RECALL_BENCH_MODEL=anthropic/claude-sonnet-5 npx tsx scripts/memory-bench/recall-bench.mts --ask --dry-run
RECALL_BENCH_MODEL=anthropic/claude-sonnet-5 npx tsx scripts/memory-bench/recall-bench.mts --ask --limit 10
RECALL_BENCH_MODEL=anthropic/claude-sonnet-5 npx tsx scripts/memory-bench/recall-bench.mts --ask --scripted-ingest
```

The two baselines either side of a room's memory. `--baseline none` is the floor: the same questions on a second room in the same home that nothing was ever remembered into, so whatever it scores is what the questions give away by themselves, and every point above it is a point the memory earned. `--baseline transcript` is the ceiling: every conversation rendered plain in one prompt with the question after it, no memory and no retrieval: the answer a room would give if a context window were free, printed with the size that says it is not.

```
RECALL_BENCH_MODEL=anthropic/claude-sonnet-5 npx tsx scripts/memory-bench/recall-bench.mts --ask --baseline none
npx tsx scripts/memory-bench/recall-bench.mts --baseline transcript
```

A second opinion on the answers, with `--judge provider/model`. The scorer is containment (a gold spelling occurs in the answer or it does not), which is free, deterministic, and wrong whenever the room says the right thing in words the fixture did not foresee. The judge is a model asked LongMemEval's own question, on LongMemEval's own templates (see below), through the same isolated worker every other real call goes through. It is printed BESIDE the exact score and never instead of it, per ability, with a column for the questions the two disagree about, which is the only reason to pay for one. Under the scripted gateway `--judge` says it needs a real model and skips, because a quoting room and a judge would only ever agree with themselves.

```
RECALL_BENCH_MODEL=anthropic/claude-sonnet-5 npx tsx scripts/memory-bench/recall-bench.mts --ask --judge anthropic/claude-sonnet-5
```

`RECALL_BENCH_DUMP=1` prints what the memory refused, in its own words.

### Reading the tables

The ingest table comes first, one row per Memorize in fold order: how many conversations that run folded, how many it refused, the operations applied, and the room's own size afterwards: notes in core, rows in the archive, how many of those left BY BUDGET, and the core's token count against the budget. It is the only place the forgetting is watched as it happens.

The first of the three result tables is one row per question: its ability, where its evidence sits now, the rank its evidence came back at for each of the three queries, and whether the room answered right. A rank cell reads a position, `none` when the search came back without it, or `n/a` when the question has no evidence a search has to reach (nothing in the archive and nothing left in a conversation alone), so nothing was asked of recall, the cell belongs in no denominator, and a bench that wrote `none` there would report retrieval as failing at questions the core answers without it.

The second is the forgetting table: accuracy per ability × location, with the totals down each edge. `no evidence` is its own column and never folded into `gone`: a question the fixture planted nothing for is an abstention whose right answer is "I don't know", and a marker that was planted and is nowhere is the fold losing something. `conversation` is its own column too, between `archive` and `recent`: a fact the room was told and never wrote down is neither forgotten nor in front of it. `conversation (no notes)` follows it, for a fact said in a conversation the fold dropped; its column is wider than the others and the location column of the other two tables widens only in a run that has such a row, so a run without one prints the tables it always printed. The columns are always all of them: a column of zeros is the finding that nothing was forgotten that way.

The third is the retrieval table, one row per evidence MARKER rather than per question, split by where that marker sits and by which of the three queries asked for it: how many came back at rank 1, how many came back at all, how many came back with nothing. Under it is the code control (a search for the marker's own reference code), which is not one of the three queries and never enters a result row. It is there so a table full of `none` can be read at all: it separates a search that cannot find what it holds from a question whose words the archived note never carried. A note a real fold rewrote in its own words has no code left to search for and is reported as reworded instead, with no control applied to it. Then three lines say the same three queries as QUESTIONS: how many of the questions recall was actually asked about the query answered, and how many of those at rank 1.

The last line is the size story: conversations, notes in core off a back history of a stated size, rows in the archive by reason in the archive's own words, how many of the fixture's own planted notes are among them, how many conversation documents are searchable and how many planted facts live only in them, the memory against its budget, and what asking cost in answer tokens.

### The LongMemEval adapter

The fixture above has one weakness that no amount of care removes: we wrote the questions and we wrote the answer key. `longmemeval-adapter.mts` runs the same room against somebody else's benchmark. LongMemEval publishes 500 instances, each a question and a haystack of chat sessions one of which holds the answer, and a judge script that scores a hypothesis file. One instance becomes one room here: its sessions are sorted into the order they were said in (the haystack is not stored chronologically, and every dating, every demotion and every temporal question depends on it), Remembered and Memorized through the product's own pipeline, and then the room is asked the question in a fresh conversation, on the date the instance says it is.

The data is DOWNLOADED BY HAND into `data/`, which is gitignored along with `results/`, and is never committed: `longmemeval_oracle.json` is the small one, whose haystack is the evidence sessions only, and `longmemeval_s_cleaned.json` is the benchmark proper, around fifty sessions and a hundred thousand tokens an instance. The oracle file is the PIPELINE CHECK and not a score (a room handed only the sessions that hold the answer is not the room the benchmark is about), and it is what the offline run below uses because it is small.

```
npx tsx scripts/memory-bench/longmemeval-adapter.mts --oracle --sample 5 --seed 1 --scripted
RECALL_BENCH_MODEL=anthropic/claude-sonnet-5 npx tsx scripts/memory-bench/longmemeval-adapter.mts --sample 50 --seed 1 --dry-run
RECALL_BENCH_MODEL=anthropic/claude-sonnet-5 npx tsx scripts/memory-bench/longmemeval-adapter.mts --sample 50 --seed 1 --judge anthropic/claude-sonnet-5
```

`--scripted` drives the whole pipeline against the engine's scripted gateway with no provider at all, which is what the offline check and the smoke use. Its hypotheses are JUNK and the run says so: the scripted model answers by quoting lines that carry the recall fixture's reference codes, LongMemEval's conversations carry none, so the folds keep little and the room says it does not know to everything. What that run proves is that the pipeline runs end to end and that the files come out in the shape the judge reads. `--sample N --seed S` takes a sample stratified across the six question types, as evenly as the pools allow, deterministically (a flat sample of a benchmark a third of which is one type says nothing about the types it missed), and the abstention instances stay in the pool of their own type, because that is what they are. `--ids` and `--type` select by hand instead. The two baselines are the same two as above, with the transcript one refusing, in a line that says so, when the whole haystack does not fit the model's context window as the registry reports it. `--dry-run` prints the estimate and stops before anything is built, which is the number to read before deciding a spend.

What comes out is `results/longmemeval-<model>-<date>.jsonl`, where the date is the LOCAL one of the machine the run was started on rather than the UTC one, so an evening run is filed under the evening it was started; one `{"question_id", "hypothesis"}` line per instance and NOTHING else in those lines, which is exactly what upstream's `evaluate_qa.py` reads with one `json.loads` per line. Everything our own tools want (per-instance usage, session counts, memory size, recall calls, timings and the run header) is in a `.meta.json` sidecar, so the hypothesis file stays a file anyone can score with the published script and compare against published numbers. The mapping itself (an instance into conversations, a stratified sample, one hypothesis line) lives in `longmemeval-map.mts`, a module with no side effects at all, so a smoke can import it without running a benchmark to reach one function.

A run of fifty instances is about five hours of calls, and it is written down as it goes. The hypothesis file gets its line the moment an instance is answered, and the `.meta.json` is written on every way out: the normal end, an error that breaks the pipeline (written before the error goes on up, with `partial: true`), and an interrupt (Ctrl-C writes it, stops the server and leaves with 130). A run that dies at the thirtieth instance has thirty answers on disk.

The one failure a run carries on past is a provider that says no: the worker turn ends on "error" or "aborted" (the subscription's usage window has closed for the rest of the hour, or a 5xx that clears in a minute). Every worker call the bench makes (the checkpoint and the fold of an ingest, the transcript baseline, the judge) is waited out on one schedule, 1, 5, 15, 30 and 60 minutes between attempts, six attempts in all, one printed line per wait (`provider error on checkpoint compression worker (...): waiting 5 min before attempt 3 of 6`); the ask, which goes through the room's own turn, is waited out the same way, each attempt in a conversation of its own. Only when the schedule is used up does the instance FAIL: its meta row carries `hypothesis: null` and a `failure` sentence naming the step, the worker and the provider's message, it has NO line in the hypothesis file (the judge file holds answers only), and the run goes on to the next instance. The failures are listed and counted in the `summary:` line, and the run exits 0 when at least one instance was answered; 1 only when every instance failed or the pipeline broke on something waiting cannot fix. The worker itself still makes one attempt per call, on purpose: the waiting belongs to the bench.

Three details of the waiting. A turn the provider ended still ends the way every turn ends, with no text in it, so the ask reads the turn's own stop reason: a turn that stopped on "error" or "aborted", or came back with nothing to say, is a failed attempt and never an empty hypothesis. A fold that gives up inside a Memorize ends that Memorize unapproved and marks the instance failed at the ingest, because the product's run would turn the fold into a conversation left waiting and carry on, and a room missing the conversations of a provider's bad hours must not be scored as if it had been told them; the time spent waiting inside a fold is added to the Memorize's own time limit, so an hour's wait does not read as a run that hung. And the schedule is budgeted per instance: once it has run out inside an instance, every later provider failure of that instance gives up at its first attempt, and the next instance gets the whole schedule again.

A call that HANGS is the other shape a provider's bad hour takes: the request is never answered, and the worker's own limit is what ends it (a fold's limit is the product's, eight minutes; the checkpoint, which the product runs without one, gets the same limit in the bench, because a call that never comes back would otherwise hold a run of hours forever). A stopped call reads as "aborted" and is waited out like a refusal. The wall time every failed attempt took, hung or refused, counts toward the Memorize's own settle limit along with the waits, and a Memorize that reaches that limit while the provider was being waited out is the provider's failure (the instance is marked, the run goes on), not the pipeline's. Two more smoke hooks: `RECALL_BENCH_WORKER_TIMEOUT_MS` shrinks the worker limit, `RECALL_BENCH_SETTLE_TIMEOUT_MS` the Memorize limit, and `RECALL_BENCH_SCRIPTED_FAIL="<marker>:<times|all>:hang"` makes the gateway hold the matching requests open instead of answering 500.

Under each instance's ingest summary the adapter prints the claim audit described above, `claims: N memorized, N unindexed, N misassigned`; the instance's row in the `.meta.json` carries it as `claims`, the meta carries the sum, and the final summary prints the sum once. A non-zero count does not fail the instance, whose answer is still measured, but the summary then says `CLAIM AUDIT FAILED`, names the instances, and the run exits 1.

`--resume` carries on into an existing hypothesis file: the instances its lines name are skipped, the rest are appended, and the meta says `resumedFrom`. `--resume <file>` names the file and stands in for `--out`. Without it an existing `--out` is refused with a sentence naming `--resume`, because a file silently overwritten and a sample silently resumed are both files nobody can trust. The dry run prints the sample's question ids in order (`sample: ...`), and with `--resume` how many of them are already answered. The judge of a resumed run reads the whole hypothesis file, the earlier run's lines included, so one `--judge` at the end of the last resume scores the full sample. Two hooks exist for the smoke and nothing else: `RECALL_BENCH_RETRY_SCHEDULE_MS="10,10,10,10,10"` replaces the schedule with milliseconds, and `RECALL_BENCH_SCRIPTED_FAIL="<marker>:<times|all>"` makes the scripted gateway answer every completion whose request carries the marker with an HTTP 500, that many times or always, which the runtime turns into exactly the worker error the real failure had.

`longmemeval-judge.mts` is that judge script's prompt half, ported. Its six templates are the upstream strings character for character, trailing spaces and all, because a judge prompt that differs by a character is a different judge and its numbers are not comparable with anybody's; the label is upstream's whole rule, that the reply lowercased contains "yes". The port is what `--judge` uses in both benches, and it is why a run can be judged with no Python environment at all. `--judge` on the adapter writes a second `.judged.jsonl` carrying `autoeval_label` and leaves the plain file untouched, and prints accuracy per question type with an added row for the abstention instances.

Judgment is never an exit code. Both benches exit non-zero only on a MECHANICAL failure: a fold the scripted model could not answer, a marker the fixture says it planted that no part of the room's memory carries although no fold archived it, a parser or an applier throwing, the scorer disagreeing with its own hand-written cases. A room that retrieves badly, forgets early or answers wrong is a table with low numbers in it, which is the whole point of the table.

## Published results

LongMemEval-S (`longmemeval_s_cleaned.json`), a fixed sample of 50 questions (`--sample 50 --seed 1`), each history about 48 conversations and 115,000 tokens. Claude Sonnet 5 answers, folds and judges, on LongMemEval's own templates. Both runs were started on 2026-09-20; the room run lost one question to the provider, and a `--resume` on 2026-09-21 answered it.

| run | commit | correct of 50 | tokens per question | building the memory |
| --- | --- | --- | --- | --- |
| room memory | 3f943bf0 | 43 | about 33,000 | about 1.15M tokens per history, once |
| full history in the prompt (`--baseline transcript`), the control | 9a568ed9 | 41 | about 168,000 | nothing |

By question type, room memory first and the control second: single-session-user 9/9 and 9/9, single-session-assistant 9/9 and 9/9, temporal-reasoning 8/8 and 7/8, multi-session 7/8 and 6/8, knowledge-update 6/8 and 6/8, single-session-preference 4/8 and 4/8. 43 against 41 correct on 50 questions, which at this sample size is a tie: a difference under about 7 questions is within chance. The sample was also the one used during development, so a fresh sample (another `--seed`) is the clean confirmation. The reading of the numbers, their costs and their limits is in [docs/memory.md](../../../../docs/memory.md#how-well-it-works-measured).

To run both again, from `apps/web-server`, on the commit of the row. `--data` names your own copy of the S file and can be left out when the file sits in `scripts/memory-bench/data/`:

```
RECALL_BENCH_MODEL=anthropic/claude-sonnet-5 npx tsx scripts/memory-bench/longmemeval-adapter.mts --data <path to longmemeval_s_cleaned.json> --sample 50 --seed 1 --judge anthropic/claude-sonnet-5
RECALL_BENCH_MODEL=anthropic/claude-sonnet-5 npx tsx scripts/memory-bench/longmemeval-adapter.mts --data <path to longmemeval_s_cleaned.json> --sample 50 --seed 1 --baseline transcript --judge anthropic/claude-sonnet-5
```

One thing the first command does not carry. `RECALL_BENCH_MODEL` picks the model that answers, and the Memorize of a room runs on the model its AI profile names. The room row was measured with Memorize on Claude Sonnet 5, set by a local edit of the Claude profile's `absorb` and `structuralReview` models in `src/persistent-agent-ai-profiles.ts` that is not committed; the profile as committed runs Memorize on Opus 5, which costs more per conversation and was not measured.

What each costs: add `--dry-run` to either command and it prints the estimate in prompt tokens and stops before anything is built. For the room run the estimate counts the room's whole memory budget on every ingest call, so it is an upper bound. The published room run was estimated at 61,395k prompt tokens in total, about 1,228k per instance: 2,382 Remember calls, 363 Memorize runs at a fold every 7 conversations, and 50 questions at 2 calls each. The control was estimated at 6,224k prompt tokens: 50 calls carrying 6,124k tokens of transcript, about 124k per instance. What the published runs used is in the table: about 33,000 tokens per question and about 1.15M tokens per history to build the memory for the room run, about 168,000 tokens per question for the control. A stopped run carries on with `--resume`.

The `claims: N memorized, N unindexed, N misassigned` line under each instance of the room run is the claim audit: how many conversations the room memorized, how many of them the search index does not hold, and how many it holds under another conversation's name, and a run in which either of the last two is not zero says `CLAIM AUDIT FAILED` and exits 1. In the published room run every claims line reads 0 unindexed and 0 misassigned, for all 50 rooms, the question filled by the resume included.

Results files and the downloaded dataset are never committed: `results/` and `data/` are gitignored, and the numbers above are copied from the runs' own records by hand.
