import { assetDisplayTitle, assetTemplateShortName, projectAssetRows, windowAssetRows, type AssetLedgerRowInput } from "../../web-ui/src/assets-panel.js";
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

	// Subline precedence: in conversation > in workspace > aborted > orphaned > error > time.
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
	assert(byId.get("tsk-conv")?.subline === "in conversation", `in-conversation wins over in-workspace, got ${byId.get("tsk-conv")?.subline}`);
	assert(byId.get("tsk-conv")?.inConversation === true, "in-conversation flag should be set");
	assert(byId.get("tsk-ws")?.subline === "in workspace", `exports should read in workspace, got ${byId.get("tsk-ws")?.subline}`);
	assert(byId.get("tsk-stop")?.subline === "stopped", `aborted subline, got ${byId.get("tsk-stop")?.subline}`);
	assert(byId.get("tsk-orphan")?.subline === `${expectedShortTime("2026-07-15T09:05:00.000Z")} · past session`, `orphan subline dated, got ${byId.get("tsk-orphan")?.subline}`);
	assert(byId.get("tsk-orphan")?.orphan === true, "orphan flag should be set");
	assert(byId.get("tsk-fail")?.subline === "didn't finish", `error subline, got ${byId.get("tsk-fail")?.subline}`);
	assert(byId.get("tsk-plain")?.subline === `html · ${expectedShortTime("2026-07-18T13:41:00.000Z")}`, `same-day ok subline is HH:MM, got ${byId.get("tsk-plain")?.subline}`);
	assert(byId.get("tsk-old")?.subline === `html · ${expectedShortTime("2026-07-15T10:00:00.000Z")}`, `other-day ok subline is dated, got ${byId.get("tsk-old")?.subline}`);
	assert(byId.get("tsk-plain")?.iconLabel === "HTM" && byId.get("tsk-orphan")?.iconLabel === "SVG", "icon labels derive from the first artifact extension");

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
	assert(originById.get("tsk-earlier")?.subline === `html · ${expectedShortTime("2026-07-12T10:00:00.000Z")}`, "the rail subline stays origin-free (one thing per subline)");
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
	assert(grammarById.get("tsk-seen")?.subline === `html · ${expectedShortTime("2026-07-18T13:41:00.000Z")}`, "a seen row is the plain filetype · time row");
	assert(grammarById.get("tsk-acted")?.unread === false && grammarById.get("tsk-acted")?.subline === "in workspace", "export implies seen; the workspace subline stands");
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

	console.log("assets panel projection smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
}
