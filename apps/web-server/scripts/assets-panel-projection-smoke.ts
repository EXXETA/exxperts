import { assetDisplayTitle, assetTemplateShortName, projectAssetRows, rowShelfFileName, windowAssetRows, type AssetLedgerRowInput } from "../../web-ui/src/assets-panel.js";
import { resolveIterateSourceFromLedger, type TaskLedgerRecord } from "../src/persistent-room-task-ledger.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const NOW = new Date("2026-07-18T15:00:00.000Z");
// Sublines render LOCAL wall-clock time — compute the expected strings with
// the same Date APIs so the smoke passes in any timezone.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function expectedShortTime(iso: string): string {
	const when = new Date(iso);
	const sameDay = when.getFullYear() === NOW.getFullYear() && when.getMonth() === NOW.getMonth() && when.getDate() === NOW.getDate();
	if (sameDay) return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
	return `${MONTHS[when.getMonth()]} ${when.getDate()}`;
}
const artifact = (name: string) => ({ relativePath: name, bytes: 10, extension: name.slice(name.lastIndexOf(".")) });

function row(partial: Partial<AssetLedgerRowInput> & { taskId: string; outcome: AssetLedgerRowInput["outcome"]; startedAt: string }): AssetLedgerRowInput {
	return { templateId: "deck", title: `Task ${partial.taskId}`, ...partial } as AssetLedgerRowInput;
}

try {
	// Template short names: family before the first dash.
	assert(assetTemplateShortName("diagram-svg") === "diagram", "diagram-svg should shorten to diagram");
	assert(assetTemplateShortName("deck") === "deck", "deck should stay deck");

	// Subline precedence (row grammar, files-management slice): in conversation
	// > aborted > orphaned > error > ready > plain date. "in workspace" is GONE
	// (snapshot destinations are not file state), and resting room-made rows
	// show only their date.
	const base = { startedAt: "2026-07-18T13:41:00.000Z", endedAt: "2026-07-18T13:41:00.000Z", artifacts: [artifact("tasks/t/x.html")] };
	const projected = projectAssetRows(
		[
			row({ taskId: "tsk-conv", outcome: "ok", ...base, exports: [{ relativePath: "x", savedTo: "y", at: "z" }] }),
			row({ taskId: "tsk-ws", outcome: "ok", ...base, exports: [{ relativePath: "x", savedTo: "y", at: "z" }] }),
			row({ taskId: "tsk-stop", outcome: "aborted", ...base }),
			row({ taskId: "tsk-orphan", outcome: "orphaned", startedAt: "2026-07-15T09:00:00.000Z", endedAt: "2026-07-15T09:05:00.000Z", artifacts: [artifact("tasks/t/y.svg")] }),
			row({ taskId: "tsk-fail", outcome: "error", ...base, artifacts: [] }),
			// viewedAt: these fixtures pin the SEEN plain row (the unread state has
			// its own block below).
			row({ taskId: "tsk-plain", outcome: "ok", ...base, viewedAt: "2026-07-18T14:00:00.000Z" }),
			row({ taskId: "tsk-old", outcome: "ok", startedAt: "2026-07-15T10:00:00.000Z", endedAt: "2026-07-15T10:00:00.000Z", artifacts: [artifact("tasks/t/z.html")], viewedAt: "2026-07-15T11:00:00.000Z" }),
		],
		{ liveTask: null, threadTaskIds: new Set(["tsk-conv"]), now: NOW },
	);
	const byId = new Map(projected.map((r) => [r.taskId, r]));
	assert(byId.get("tsk-conv")?.subline === `in conversation · ${expectedShortTime("2026-07-18T13:41:00.000Z")}`, `in-conversation wins and carries the time, got ${byId.get("tsk-conv")?.subline}`);
	assert(byId.get("tsk-conv")?.inConversation === true, "in-conversation flag should be set");
	assert(byId.get("tsk-ws")?.subline === `created · ${expectedShortTime("2026-07-18T13:41:00.000Z")}`, `exports no longer produce a subline ("in workspace" retired; export still implies seen), got ${byId.get("tsk-ws")?.subline}`);
	assert(byId.get("tsk-stop")?.subline === "stopped", `aborted subline, got ${byId.get("tsk-stop")?.subline}`);
	assert(byId.get("tsk-orphan")?.subline === `${expectedShortTime("2026-07-15T09:05:00.000Z")} · past session`, `orphan subline dated, got ${byId.get("tsk-orphan")?.subline}`);
	assert(byId.get("tsk-orphan")?.orphan === true, "orphan flag should be set");
	assert(byId.get("tsk-fail")?.subline === "didn't finish", `error subline, got ${byId.get("tsk-fail")?.subline}`);
	assert(byId.get("tsk-plain")?.subline === `created · ${expectedShortTime("2026-07-18T13:41:00.000Z")}`, `resting room-made rows read verb + moment, got ${byId.get("tsk-plain")?.subline}`);
	assert(byId.get("tsk-old")?.subline === `created · ${expectedShortTime("2026-07-15T10:00:00.000Z")}`, `other-day resting rows read verb + date, got ${byId.get("tsk-old")?.subline}`);
	assert(byId.get("tsk-plain")?.iconLabel === "HTML" && byId.get("tsk-orphan")?.iconLabel === "SVG", "icon labels carry the full extension up to 4 chars (HTML, not a truncated HTM)");

	// Ordering: newest-first by startedAt.
	const idsInOrder = projected.map((r) => r.taskId);
	assert(idsInOrder.indexOf("tsk-old") > idsInOrder.indexOf("tsk-plain"), "older rows must sort after newer rows");

	// Live task leads and shadows its own ledger row; a foreign running row is a
	// surviving background delegation (option 4) — shown running, never orphan.
	const withLive = projectAssetRows(
		[
			row({ taskId: "tsk-live", outcome: "running", startedAt: "2026-07-18T14:59:00.000Z" }),
			row({ taskId: "tsk-survivor", outcome: "running", startedAt: "2026-07-18T09:00:00.000Z" }),
		],
		{ liveTask: { taskId: "tsk-live", title: "Q3 deck", templateId: "deck" }, threadTaskIds: new Set(), now: NOW },
	);
	assert(withLive[0].taskId === "tsk-live" && withLive[0].running && withLive[0].subline === "working…", "live task must lead with working…");
	assert(withLive.filter((r) => r.taskId === "tsk-live").length === 1, "live task must not duplicate its ledger row");
	const survivor = withLive.find((r) => r.taskId === "tsk-survivor");
	assert(survivor?.running === true && !survivor.orphan && survivor.subline === "working…", "a running ledger row that is not the live task still shows running (option 4: workers outlive connections)");
	assert(survivor?.unread === false, "running rows never carry the unread dot");

	// Display titles name the thing, not the instruction: prettified primary
	// artifact filename; rows without files keep the task title.
	assert(assetDisplayTitle("Create a polished…", [artifact("tasks/t/kimi3-vs-gpt56_benchmarks.html")]) === "kimi3 vs gpt56 benchmarks", "artifact filename prettifies into the title");
	assert(assetDisplayTitle("Create a polished…", []) === "Create a polished…", "no artifacts → task title stands");
	assert(assetDisplayTitle("Create a polished…", [artifact("tasks/t/v2.1-deck.final.html")]) === "v2.1 deck.final", "only the last extension drops");
	assert(byId.get("tsk-plain")?.title === "x", "projected rows carry the prettified artifact name");
	assert(byId.get("tsk-fail")?.title === "Task tsk-fail", "artifact-less rows keep the task title");
	const runningTitle = projectAssetRows([], { liveTask: { taskId: "tsk-l", title: "Create a deck", templateId: "deck" }, threadTaskIds: new Set(), now: NOW });
	assert(runningTitle[0].title === "Create a deck", "the live running row keeps the task title (no file yet)");

	// Origin line (room-scoped history, 2026-07-18): rows born in another
	// conversation carry the viewer disclosure; the rail subline never does.
	const originRows = projectAssetRows(
		[
			row({ taskId: "tsk-here", outcome: "ok", conversationId: "conv-live", ...base }),
			row({ taskId: "tsk-earlier", outcome: "ok", conversationId: "conv-old", startedAt: "2026-07-12T10:00:00.000Z", endedAt: "2026-07-12T10:00:00.000Z", artifacts: [artifact("tasks/t/p.html")], viewedAt: "2026-07-12T11:00:00.000Z" }),
			row({ taskId: "tsk-unknown", outcome: "ok", ...base }),
		],
		{ liveTask: null, threadTaskIds: new Set(), liveConversationId: "conv-live", now: NOW },
	);
	const originById = new Map(originRows.map((r) => [r.taskId, r]));
	assert(originById.get("tsk-here")?.originLine === "", "live-conversation rows carry no origin line");
	assert(originById.get("tsk-earlier")?.originLine === `From an earlier thread · ${expectedShortTime("2026-07-12T10:00:00.000Z")}`, `earlier-thread rows disclose origin, got ${originById.get("tsk-earlier")?.originLine}`);
	assert(originById.get("tsk-earlier")?.subline === `created · ${expectedShortTime("2026-07-12T10:00:00.000Z")}`, "the rail subline reads verb + moment; the thread-origin disclosure stays viewer-only");
	assert(originById.get("tsk-unknown")?.originLine === "", "rows without a recorded conversation make no origin claim");
	const noLiveConv = projectAssetRows(
		[row({ taskId: "tsk-earlier", outcome: "ok", conversationId: "conv-old", ...base })],
		{ liveTask: null, threadTaskIds: new Set(), now: NOW },
	);
	assert(noLiveConv[0].originLine === "", "no live conversation known → no origin claim");

	// Status grammar (2026-07-18): green unread dot = done, has files, never
	// opened, never acted on — subline leads with "ready". Decays on viewedAt;
	// attach/export imply seen, so their sublines stand with no dot. Errors
	// carry the steady danger dot beside the shipped subline.
	const grammarRows = projectAssetRows(
		[
			row({ taskId: "tsk-fresh", outcome: "ok", ...base }),
			row({ taskId: "tsk-seen", outcome: "ok", ...base, viewedAt: "2026-07-18T14:00:00.000Z" }),
			row({ taskId: "tsk-acted", outcome: "ok", ...base, exports: [{ relativePath: "x", savedTo: "y", at: "z" }] }),
			row({ taskId: "tsk-broken", outcome: "error", ...base, artifacts: [] }),
		],
		{ liveTask: null, threadTaskIds: new Set(), now: NOW },
	);
	const grammarById = new Map(grammarRows.map((r) => [r.taskId, r]));
	assert(grammarById.get("tsk-fresh")?.unread === true, "a never-opened done row is unread");
	assert(grammarById.get("tsk-fresh")?.subline === `ready · ${expectedShortTime("2026-07-18T13:41:00.000Z")}`, `unread subline leads with ready, got ${grammarById.get("tsk-fresh")?.subline}`);
	assert(grammarById.get("tsk-seen")?.unread === false, "viewedAt decays the unread state");
	assert(grammarById.get("tsk-seen")?.subline === `created · ${expectedShortTime("2026-07-18T13:41:00.000Z")}`, "a seen row rests on created + its moment");
	assert(grammarById.get("tsk-acted")?.unread === false && grammarById.get("tsk-acted")?.subline === `created · ${expectedShortTime("2026-07-18T13:41:00.000Z")}`, "export implies seen; the row rests on created + its moment (no workspace subline)");
	assert(grammarById.get("tsk-broken")?.failed === true && grammarById.get("tsk-broken")?.subline === "didn't finish", "error rows carry the failed flag beside the shipped subline");
	assert(grammarById.get("tsk-fresh")?.failed === false, "ok rows never carry the failed flag");

	// Windowing: 3 resting + show-all.
	const many = projectAssetRows(
		["a", "b", "c", "d", "e"].map((id, i) => row({ taskId: `tsk-${id}`, outcome: "ok", startedAt: `2026-07-18T0${i}:00:00.000Z`, artifacts: [artifact("tasks/t/x.html")] })),
		{ liveTask: null, threadTaskIds: new Set(), now: NOW },
	);
	const resting = windowAssetRows(many, false);
	assert(resting.visible.length === 3 && resting.hiddenCount === 2, "resting window is 3 + hidden count");
	assert(resting.visible[0].taskId === "tsk-e", "resting window keeps the newest");
	const expanded = windowAssetRows(many, true);
	assert(expanded.visible.length === 5 && expanded.hiddenCount === 0, "show-all reveals everything");

	// Iterate-source ledger fallback (server side): ok+artifacts only.
	const ledger = (partial: Partial<TaskLedgerRecord> & { taskId: string; outcome: TaskLedgerRecord["outcome"] }): TaskLedgerRecord =>
		({ schemaVersion: 1, roomId: "r", conversationId: "c", templateId: "deck", templateVersion: 1, title: "t", startedAt: "2026-07-18T10:00:00.000Z", ...partial }) as TaskLedgerRecord;
	const records = [
		ledger({ taskId: "tsk-ok", outcome: "ok", artifacts: [{ relativePath: "tasks/tsk-ok/deck.html", bytes: 5, extension: "html" }] }),
		ledger({ taskId: "tsk-empty", outcome: "ok" }),
		ledger({ taskId: "tsk-aborted", outcome: "aborted", artifacts: [{ relativePath: "tasks/tsk-aborted/x.html", bytes: 5, extension: "html" }] }),
	];
	const okSource = resolveIterateSourceFromLedger(records, "tsk-ok");
	assert(okSource?.templateId === "deck" && okSource.artifacts[0] === "tasks/tsk-ok/deck.html", "ok row with artifacts resolves");
	assert(resolveIterateSourceFromLedger(records, "tsk-empty") === null, "ok row without artifacts must not resolve");
	assert(resolveIterateSourceFromLedger(records, "tsk-aborted") === null, "aborted rows must not resolve (never iterable, B5 doctrine)");
	assert(resolveIterateSourceFromLedger(records, "tsk-missing") === null, "missing rows must not resolve");

	// User-added shelf files (files UI slice): origin "user" projects a row with
	// the added-by-you marker, interleaved by recency; origin "room" projects
	// nothing (its task row already represents it); the live row still leads.
	{
		const userRows = projectAssetRows(
			[
				{ taskId: "tsk-mid", conversationId: "c1", templateId: "deck-html", title: "Deck", startedAt: "2026-07-16T10:00:00.000Z", endedAt: "2026-07-16T10:05:00.000Z", outcome: "ok", artifacts: [{ relativePath: "files/deck.html", bytes: 5, extension: ".html" }] },
			],
			{ liveTask: { taskId: "tsk-live", title: "Working", templateId: "deck-html" }, threadTaskIds: new Set(), liveConversationId: "c1", now: NOW },
			[
				{ name: "contract-acme.pdf", bytes: 2048, mtimeMs: Date.parse("2026-07-17T09:00:00.000Z"), origin: "user", extension: ".pdf" },
				{ name: "deck.html", bytes: 5, mtimeMs: Date.parse("2026-07-16T10:05:00.000Z"), origin: "room", madeAt: "2026-07-16T10:05:00.000Z", extension: ".html" },
			],
		);
		assert(userRows[0]?.taskId === "tsk-live", "the live row still leads with user files present");
		const userRow = userRows.find((row) => row.userFileName === "contract-acme.pdf");
		assert(Boolean(userRow), "a user-origin shelf file must project a row");
		assert(userRow?.taskId === "file:contract-acme.pdf", `user rows carry the synthetic file: id, got ${userRow?.taskId}`);
		assert(userRow?.subline === `attached · ${expectedShortTime("2026-07-17T09:00:00.000Z")}`, `user rows read attached, got ${userRow?.subline}`);
		assert(userRow?.title === "contract acme", `user row titles prettify the stem, got ${userRow?.title}`);
		assert(userRow?.artifacts[0]?.relativePath === "files/contract-acme.pdf", "user rows point at the shelf path");
		assert(!userRows.some((row) => row.taskId === "file:deck.html"), "room-origin shelf files never project a second row");
		const newerFirst = userRows.findIndex((row) => row.userFileName === "contract-acme.pdf") < userRows.findIndex((row) => row.taskId === "tsk-mid");
		assert(newerFirst, "user rows interleave by recency (newer user file above the older task row)");
	}

	// Rows are files (revise-in-place): a revise run's row claims the shelf
	// file; the older run whose files are ALL claimed folds into the origin
	// story. Rows with tasks/ paths or any unclaimed file keep their row.
	{
		const foldRows = projectAssetRows(
			[
				{ taskId: "tsk-v1", conversationId: "c1", templateId: "deck-html", title: "Deck", startedAt: "2026-07-14T10:00:00.000Z", endedAt: "2026-07-14T10:05:00.000Z", outcome: "ok", viewedAt: "2026-07-14T11:00:00.000Z", artifacts: [{ relativePath: "files/deck.html", bytes: 5, extension: ".html" }] },
				{ taskId: "tsk-v2", conversationId: "c1", templateId: "deck-html", title: "make it shorter", startedAt: "2026-07-16T10:00:00.000Z", endedAt: "2026-07-16T10:05:00.000Z", outcome: "ok", iterateParentTaskId: "tsk-v1", artifacts: [{ relativePath: "files/deck.html", bytes: 4, extension: ".html" }] },
				{ taskId: "tsk-legacy", conversationId: "c1", templateId: "deck-html", title: "Old", startedAt: "2026-07-10T10:00:00.000Z", endedAt: "2026-07-10T10:05:00.000Z", outcome: "ok", viewedAt: "2026-07-10T11:00:00.000Z", artifacts: [{ relativePath: "tasks/tsk-legacy/deck.html", bytes: 5, extension: ".html" }] },
				{ taskId: "tsk-mixed", conversationId: "c1", templateId: "deck-html", title: "Mixed", startedAt: "2026-07-12T10:00:00.000Z", endedAt: "2026-07-12T10:05:00.000Z", outcome: "ok", viewedAt: "2026-07-12T11:00:00.000Z", artifacts: [{ relativePath: "files/deck.html", bytes: 5, extension: ".html" }, { relativePath: "files/extra.svg", bytes: 5, extension: ".svg" }] },
			],
			{ liveTask: null, threadTaskIds: new Set(), liveConversationId: "c1", now: NOW },
		);
		const foldIds = foldRows.map((r) => r.taskId);
		assert(foldIds.includes("tsk-v2"), "the newest run owning the file keeps the row");
		assert(!foldIds.includes("tsk-v1"), "the fully-claimed older run folds (one document = one row)");
		assert(foldIds.includes("tsk-legacy"), "tasks/-path rows never fold");
		assert(foldIds.includes("tsk-mixed"), "a run with any unclaimed file keeps its row");
		const v2 = foldRows.find((r) => r.taskId === "tsk-v2");
		assert(v2?.originLine === `Created ${expectedShortTime("2026-07-14T10:05:00.000Z")} · revised ${expectedShortTime("2026-07-16T10:05:00.000Z")}`, `revise rows carry the origin story, got ${v2?.originLine}`);
		assert(v2?.unread === true && v2.subline.startsWith("ready"), "a fresh revision is news (unread + ready)");

		// Two revisions: the chain counts; a broken chain claims only the honest part.
		const chainRows = projectAssetRows(
			[
				{ taskId: "tsk-r2", conversationId: "c1", templateId: "deck-html", title: "again", startedAt: "2026-07-17T10:00:00.000Z", endedAt: "2026-07-17T10:05:00.000Z", outcome: "ok", iterateParentTaskId: "tsk-r1", artifacts: [{ relativePath: "files/deck.html", bytes: 4, extension: ".html" }] },
				{ taskId: "tsk-r1", conversationId: "c1", templateId: "deck-html", title: "shorter", startedAt: "2026-07-16T10:00:00.000Z", endedAt: "2026-07-16T10:05:00.000Z", outcome: "ok", iterateParentTaskId: "tsk-v0", artifacts: [{ relativePath: "files/deck.html", bytes: 4, extension: ".html" }] },
				{ taskId: "tsk-v0", conversationId: "c1", templateId: "deck-html", title: "Deck", startedAt: "2026-07-14T10:00:00.000Z", endedAt: "2026-07-14T10:05:00.000Z", outcome: "ok", viewedAt: "2026-07-14T11:00:00.000Z", artifacts: [{ relativePath: "files/deck.html", bytes: 5, extension: ".html" }] },
			],
			{ liveTask: null, threadTaskIds: new Set(), liveConversationId: "c1", now: NOW },
		);
		const r2 = chainRows.find((r) => r.taskId === "tsk-r2");
		assert(chainRows.filter((r) => ["tsk-r2", "tsk-r1", "tsk-v0"].includes(r.taskId)).length === 1, "a whole revise chain collapses to one row");
		assert(r2?.originLine === `Created ${expectedShortTime("2026-07-14T10:05:00.000Z")} · revised 2 times, last ${expectedShortTime("2026-07-17T10:05:00.000Z")}`, `multi-revision story counts, got ${r2?.originLine}`);
		const brokenRows = projectAssetRows(
			[{ taskId: "tsk-lone", conversationId: "c1", templateId: "deck-html", title: "again", startedAt: "2026-07-17T10:00:00.000Z", endedAt: "2026-07-17T10:05:00.000Z", outcome: "ok", iterateParentTaskId: "tsk-gone", artifacts: [{ relativePath: "files/deck.html", bytes: 4, extension: ".html" }] }],
			{ liveTask: null, threadTaskIds: new Set(), liveConversationId: "c1", now: NOW },
		);
		assert(brokenRows[0]?.originLine === `Revised ${expectedShortTime("2026-07-17T10:05:00.000Z")}`, `a chain whose root is gone claims only the revision, got ${brokenRows[0]?.originLine}`);
	}

	// Shelf truth (unified delete): a deleted shelf file drops its artifact and
	// its row; unknown truth (listing not loaded) makes no claims.
	{
		const truthRows = [
			{ taskId: "tsk-alive", conversationId: "c1", templateId: "deck-html", title: "Alive", startedAt: "2026-07-16T10:00:00.000Z", endedAt: "2026-07-16T10:05:00.000Z", outcome: "ok" as const, viewedAt: "x", artifacts: [{ relativePath: "files/alive.html", bytes: 5, extension: ".html" }] },
			{ taskId: "tsk-gone", conversationId: "c1", templateId: "deck-html", title: "Gone", startedAt: "2026-07-15T10:00:00.000Z", endedAt: "2026-07-15T10:05:00.000Z", outcome: "ok" as const, viewedAt: "x", artifacts: [{ relativePath: "files/gone.html", bytes: 5, extension: ".html" }] },
			{ taskId: "tsk-half", conversationId: "c1", templateId: "deck-html", title: "Half", startedAt: "2026-07-14T10:00:00.000Z", endedAt: "2026-07-14T10:05:00.000Z", outcome: "ok" as const, viewedAt: "x", artifacts: [{ relativePath: "files/gone.html", bytes: 5, extension: ".html" }, { relativePath: "files/alive.html", bytes: 5, extension: ".html" }] },
			{ taskId: "tsk-legacy2", conversationId: "c1", templateId: "deck-html", title: "Legacy", startedAt: "2026-07-13T10:00:00.000Z", endedAt: "2026-07-13T10:05:00.000Z", outcome: "ok" as const, viewedAt: "x", artifacts: [{ relativePath: "tasks/tsk-legacy2/x.html", bytes: 5, extension: ".html" }] },
		];
		const truth = new Set(["alive.html"]);
		const withTruth = projectAssetRows(truthRows, { liveTask: null, threadTaskIds: new Set(), liveConversationId: "c1", shelfTruth: truth, now: NOW });
		const truthIds = withTruth.map((r) => r.taskId);
		assert(truthIds.includes("tsk-alive"), "a row whose file exists stays");
		assert(!truthIds.includes("tsk-gone"), "a row whose only file was deleted disappears");
		assert(truthIds.includes("tsk-legacy2"), "tasks/-path rows are untouched by shelf truth");
		// tsk-half keeps only the surviving artifact — but alive.html is claimed
		// by the newer tsk-alive, so the fully-claimed remainder folds too.
		assert(!truthIds.includes("tsk-half"), "a row reduced to files another row owns folds away");
		const noTruth = projectAssetRows(truthRows, { liveTask: null, threadTaskIds: new Set(), liveConversationId: "c1", now: NOW });
		assert(noTruth.some((r) => r.taskId === "tsk-gone"), "without a loaded listing the projection makes no shelf claims");

		// Room re-entry regression (critical fix): shelfTruthForRoom is how the
		// App derives the claim, keyed on the room the listing is known-good
		// for. Replay leave + re-enter: the room-change effect resets the
		// listing AND knownFor together — a knownFor left standing (the bug)
		// would turn the emptied listing into an authoritative empty-shelf
		// claim and filter every file row until the refetch lands.
		const { shelfTruthForRoom } = await import("../../web-ui/src/assets-panel.js");
		assert([...shelfTruthForRoom("room-a", "room-a", ["alive.html"])!].join() === "alive.html", "a listing known-good for this room is the truth");
		// The bug's state: listing emptied, knownFor stale on the re-entered room.
		const staleClaim = shelfTruthForRoom("room-a", "room-a", []);
		assert(staleClaim && staleClaim.size === 0, "same-room knownFor over an empty listing IS an empty-shelf claim — which is why knownFor must reset with the listing");
		// The fixed reset state: knownFor cleared with the listing → no claim,
		// so re-entry keeps every file row while the refetch is in flight.
		const resetClaim = shelfTruthForRoom("room-a", null, []);
		assert(resetClaim === undefined, "after the room-change reset (knownFor null) the projection must make no shelf claims");
		const reentryRows = projectAssetRows(truthRows, { liveTask: null, threadTaskIds: new Set(), liveConversationId: "c1", ...(resetClaim ? { shelfTruth: resetClaim } : {}), now: NOW });
		assert(reentryRows.some((r) => r.taskId === "tsk-gone") && reentryRows.some((r) => r.taskId === "tsk-alive"), "re-entry before the listing loads must keep every file row");
		assert(shelfTruthForRoom("room-b", "room-a", ["alive.html"]) === undefined, "another room's listing is never this room's truth");
	}

	// File rows (unified delete + rename targets): exactly-one-shelf-file rows.
	{
		const fileRows = projectAssetRows(
			[
				{ taskId: "tsk-one", conversationId: "c1", templateId: "deck-html", title: "One", startedAt: "2026-07-16T10:00:00.000Z", endedAt: "2026-07-16T10:05:00.000Z", outcome: "ok" as const, viewedAt: "x", artifacts: [{ relativePath: "files/one.html", bytes: 5, extension: ".html" }] },
				{ taskId: "tsk-many", conversationId: "c1", templateId: "deck-html", title: "Many", startedAt: "2026-07-15T10:00:00.000Z", endedAt: "2026-07-15T10:05:00.000Z", outcome: "ok" as const, viewedAt: "x", artifacts: [{ relativePath: "files/a.html", bytes: 5, extension: ".html" }, { relativePath: "files/b.svg", bytes: 5, extension: ".svg" }] },
				{ taskId: "tsk-store", conversationId: "c1", templateId: "deck-html", title: "Store", startedAt: "2026-07-14T10:00:00.000Z", endedAt: "2026-07-14T10:05:00.000Z", outcome: "ok" as const, viewedAt: "x", artifacts: [{ relativePath: "tasks/tsk-store/x.html", bytes: 5, extension: ".html" }] },
			],
			{ liveTask: null, threadTaskIds: new Set(), liveConversationId: "c1", now: NOW },
			[{ name: "mine.pdf", bytes: 9, mtimeMs: Date.parse("2026-07-17T09:00:00.000Z"), origin: "user", extension: ".pdf" }],
		);
		const byTask = new Map(fileRows.map((r) => [r.taskId, r]));
		assert(rowShelfFileName(byTask.get("tsk-one")!) === "one.html", "a single-shelf-file task row is a file row");
		assert(rowShelfFileName(byTask.get("tsk-many")!) === null, "a multi-file run is not a file row");
		assert(rowShelfFileName(byTask.get("tsk-store")!) === null, "a legacy store row is not a file row");
		assert(rowShelfFileName(byTask.get("file:mine.pdf")!) === "mine.pdf", "user rows are always file rows");
	}

	// Height-derived window: the component passes a count; the default stays 3.
	{
		const rows = projectAssetRows(
			["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id, i) => row({ taskId: `tsk-${id}`, outcome: "ok", startedAt: `2026-07-18T0${Math.min(i, 9)}:0${i}:00.000Z`, artifacts: [artifact("tasks/t/x.html")], viewedAt: "x" })),
			{ liveTask: null, threadTaskIds: new Set(), now: NOW },
		);
		const nine = windowAssetRows(rows, false, 9);
		assert(nine.visible.length === 9 && nine.hiddenCount === 1, "an explicit count windows to it");
		const all = windowAssetRows(rows, false, 12);
		assert(all.visible.length === 10 && all.hiddenCount === 0, "a count above the row total shows everything");
		const garbage = windowAssetRows(rows, false, Number.NaN);
		assert(garbage.visible.length === 3, "a garbage count falls back to the conservative default");
	}

	// A revise run has no row of its own (taste pass): the TARGET file's row
	// carries "updating…" while the run lives, so Ask-for-changes never looks
	// like it produced a second file. New-file runs keep the working row.
	{
		const ledger: AssetLedgerRowInput[] = [
			{ taskId: "tsk-made", conversationId: "c1", templateId: "deck-html", title: "Deck", startedAt: "2026-07-16T10:00:00.000Z", endedAt: "2026-07-16T10:05:00.000Z", outcome: "ok", viewedAt: "2026-07-16T11:00:00.000Z", artifacts: [{ relativePath: "files/deck.html", bytes: 5, extension: ".html" }] },
			{ taskId: "tsk-other", conversationId: "c1", templateId: "diagram-svg", title: "Diagram", startedAt: "2026-07-15T10:00:00.000Z", endedAt: "2026-07-15T10:05:00.000Z", outcome: "ok", viewedAt: "2026-07-15T11:00:00.000Z", artifacts: [{ relativePath: "files/arch.svg", bytes: 5, extension: ".svg" }] },
		];
		const revising = projectAssetRows(ledger, {
			liveTask: { taskId: "tsk-revise", title: "make it shorter", templateId: "deck-html", reviseTargetNames: ["deck.html"] },
			threadTaskIds: new Set(),
			liveConversationId: "c1",
			now: NOW,
		});
		assert(!revising.some((row) => row.taskId === "tsk-revise"), "a revise run must NOT add a row of its own");
		const target = revising.find((row) => row.taskId === "tsk-made");
		assert(target?.running === true && target?.subline === "updating…", `the target row carries the working state, got ${target?.subline}`);
		const untouched = revising.find((row) => row.taskId === "tsk-other");
		assert(untouched?.running === false && untouched?.subline.startsWith("created"), "files the run does not target keep resting");
		// Rows are files while updating: rename/delete must not be offered on a
		// file being rewritten (rowShelfFileName gates those affordances).
		assert(rowShelfFileName(target!) === null, "an updating row offers no file verbs");

		// A new-file run keeps the working row it always had.
		const newFile = projectAssetRows(ledger, {
			liveTask: { taskId: "tsk-new", title: "a fresh chart", templateId: "chart-html" },
			threadTaskIds: new Set(),
			liveConversationId: "c1",
			now: NOW,
		});
		assert(newFile[0]?.taskId === "tsk-new" && newFile[0]?.subline === "working…", "a new-file run still leads with its own working row");

		// A target whose row is gone (deleted mid-run) must not make the run
		// invisible — the working row stands in.
		const orphanedTarget = projectAssetRows(ledger, {
			liveTask: { taskId: "tsk-revise", title: "make it shorter", templateId: "deck-html", reviseTargetNames: ["vanished.html"] },
			threadTaskIds: new Set(),
			liveConversationId: "c1",
			now: NOW,
		});
		assert(orphanedTarget[0]?.taskId === "tsk-revise" && orphanedTarget[0]?.subline === "working…", "a revise whose target row is gone falls back to the working row");

		// A user-added file being revised shows it on its own row too.
		const userTarget = projectAssetRows([], {
			liveTask: { taskId: "tsk-revise-user", title: "tidy it", templateId: "document-html", reviseTargetNames: ["notes.md"] },
			threadTaskIds: new Set(),
			liveConversationId: "c1",
			now: NOW,
		}, [{ name: "notes.md", bytes: 10, mtimeMs: Date.parse("2026-07-17T09:00:00.000Z"), origin: "user", extension: ".md" }]);
		assert(!userTarget.some((row) => row.taskId === "tsk-revise-user"), "a revise of a user file adds no row either");
		assert(userTarget.find((row) => row.userFileName === "notes.md")?.subline === "updating…", "the user file's own row carries the working state");
	}

	console.log("assets panel projection smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
}
