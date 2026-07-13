// Smoke for the specialist-task (DelegationCard variant B) client state machine
// (apps/web-ui/src/task-stream.ts, visuals track V4).
//
// Covers: the happy path (started→deltas→end) with tail accumulation and the
// authoritative result (summary + artifacts + thumbnails); the stale-taskId
// discipline (events for a non-active/finished task dropped); the tail cap
// (a chatty specialist never grows the buffer past TASK_TAIL_CAP, and the tail
// keeps the MOST RECENT chars); the abort path (abort_requested → send_abort
// effect → task_error lands as an error with partial artifacts kept); the
// single-slot started discipline (a second running task is dropped; a finished
// card is superseded by a fresh delegation); minimize/open/dismiss; and the
// pure helpers — route-URL derivation (incl. malformed → null), basename, and
// the DECK/HTML/SVG kind label. Effects are asserted too.
//
// Run: npm run smoke:task-card   (or: node scripts/run-smokes.mjs task-card)

import {
	artifactBasename,
	artifactKindLabel,
	createTaskState,
	isSvgArtifact,
	isTaskActive,
	reduceTask,
	TASK_TAIL_CAP,
	taskArtifactUrl,
	thumbnailFor,
	type TaskAction,
	type TaskArtifact,
	type TaskEffect,
	type TaskState,
	type TaskThumbnail,
} from "../../web-ui/src/task-stream.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const MODEL = { provider: "anthropic", model: "claude-x", label: "Claude X" };
const DECK: TaskArtifact = { relativePath: "tasks/tsk-abc/q3-review.html", bytes: 4096, extension: ".html" };
const SVG: TaskArtifact = { relativePath: "tasks/tsk-abc/margin-split.svg", bytes: 512, extension: ".svg" };
const DECK_THUMB: TaskThumbnail = { relativePath: "tasks/tsk-abc/q3-review.html", dataUri: "data:image/png;base64,AAAA", slideCount: 7 };

const started: TaskAction = { type: "started", taskId: "tsk-abc", template: "deck", templateVersion: 2, templateLabel: "Slide deck", model: MODEL, title: "Q3 client review deck" };

// Drive a sequence of actions from a starting state, collecting every effect.
function run(start: TaskState, actions: TaskAction[]): { state: TaskState; effects: TaskEffect[] } {
	let state = start;
	const effects: TaskEffect[] = [];
	for (const action of actions) {
		const result = reduceTask(state, action);
		state = result.state;
		effects.push(...result.effects);
	}
	return { state, effects };
}

try {
	// ---- initial state ---------------------------------------------------
	const initial = createTaskState();
	assert(initial.phase === "none", "initial phase is none");
	assert(!isTaskActive(initial), "initial state is not active");
	assert(TASK_TAIL_CAP >= 1_000, "tail cap is a sane bound");

	// ---- happy path: started → deltas → end ------------------------------
	const afterStart = reduceTask(initial, started);
	assert(afterStart.state.phase === "running", "started opens the card running");
	assert(afterStart.state.taskId === "tsk-abc", "taskId captured");
	assert(afterStart.state.templateLabel === "Slide deck", "template label captured (speaker chip)");
	assert(afterStart.state.templateVersion === 2, "template version captured (threads into the transfer block)");
	assert(reduceTask(initial, { type: "started", taskId: "tsk-abc", template: "deck", templateLabel: "Slide deck" }).state.templateVersion === null, "absent template version stays null (readers fall back to 1)");
	assert(afterStart.state.title === "Q3 client review deck", "client-supplied title captured for the face");
	assert(afterStart.state.model?.model === "claude-x", "model captured (kept off the face, for provenance)");
	// Minimized-by-default (Borja, 2026-07-12): a new task opens as the pill;
	// the user expands deliberately. A same-id refresh keeps the fold state.
	assert(afterStart.state.minimized, "a new task starts folded to the pill");
	assert(!reduceTask(reduceTask(initial, started).state, { type: "open" }).state.minimized, "open expands the fresh pill");
	assert(isTaskActive(afterStart.state), "a running task is active");

	const happy = run(afterStart.state, [
		{ type: "delta", taskId: "tsk-abc", delta: "Structuring the narrative…" },
		{ type: "delta", taskId: "tsk-abc", delta: "\n[artifact_write_html_deck]\n" },
		{ type: "delta", taskId: "tsk-abc", delta: "Writing q3-review.html (7 slides)…" },
		{ type: "end", taskId: "tsk-abc", template: "deck", text: "Built a 7-slide review deck plus the margin-split diagram.", artifacts: [DECK, SVG], thumbnails: [DECK_THUMB], generatedAt: "2026-07-11T09:11:00Z", usage: { tokens: 1 } },
	]);
	assert(happy.state.phase === "done", "end moves to done");
	assert(happy.state.summary === "Built a 7-slide review deck plus the margin-split diagram.", "end.text becomes the summary");
	assert(happy.state.artifacts.length === 2, "artifacts captured");
	assert(happy.state.thumbnails.length === 1 && happy.state.thumbnails[0].slideCount === 7, "thumbnails captured with slide count");
	assert(happy.state.generatedAt === "2026-07-11T09:11:00Z", "generatedAt captured (provenance, off the face)");
	assert(happy.state.usage != null, "usage captured (ledger, off the face)");
	assert(happy.effects.every((e) => e.kind !== "dropped"), "no in-band events dropped on the happy path");

	// mid-stream tail accumulation is observable before end:
	const midStream = run(afterStart.state, [
		{ type: "delta", taskId: "tsk-abc", delta: "abc" },
		{ type: "delta", taskId: "tsk-abc", delta: "def" },
	]);
	assert(midStream.state.tail === "abcdef" && midStream.state.phase === "running", "deltas accumulate into the tail");

	// thumbnail lookup + kind labels for the done card
	assert(thumbnailFor(happy.state, DECK.relativePath)?.slideCount === 7, "thumbnailFor finds the deck thumbnail");
	assert(thumbnailFor(happy.state, SVG.relativePath) === null, "thumbnailFor returns null when no thumbnail matches");

	// ---- TAIL CAP enforced (chatty specialist stays bounded, keeps the tail) --
	const noise = "x".repeat(TASK_TAIL_CAP + 500);
	const capped = run(afterStart.state, [
		{ type: "delta", taskId: "tsk-abc", delta: noise },
		{ type: "delta", taskId: "tsk-abc", delta: "TAILEND" },
	]);
	assert(capped.state.tail.length === TASK_TAIL_CAP, `tail is capped at ${TASK_TAIL_CAP}; got ${capped.state.tail.length}`);
	assert(capped.state.tail.endsWith("TAILEND"), "the cap keeps the MOST RECENT chars (the tail), not the head");

	// ---- stale-taskId discipline -----------------------------------------
	// before start: an event with no active task is dropped
	const beforeStart = reduceTask(initial, { type: "delta", taskId: "ghost", delta: "x" });
	assert(beforeStart.state.phase === "none" && beforeStart.state.tail === "", "event before any task is dropped");
	assert(beforeStart.effects.some((e) => e.kind === "dropped"), "stale-before-start emits a dropped effect");

	// mid-stream: a wrong taskId is dropped, the live one is untouched
	const midStale = run(afterStart.state, [
		{ type: "delta", taskId: "tsk-abc", delta: "keep" },
		{ type: "delta", taskId: "OTHER", delta: "DROP" },
		{ type: "end", taskId: "OTHER", template: "deck", text: "DROP", artifacts: [], generatedAt: "x" },
	]);
	assert(midStale.state.tail === "keep" && midStale.state.phase === "running", "mid-stream stale delta + end are dropped");
	assert(midStale.effects.filter((e) => e.kind === "dropped").length === 2, "two stale events dropped mid-stream");

	// after dismiss: the just-ended task's events no longer apply
	const afterDismiss = run(happy.state, [
		{ type: "dismiss" },
		{ type: "delta", taskId: "tsk-abc", delta: "late" },
		{ type: "end", taskId: "tsk-abc", template: "deck", text: "late", artifacts: [], generatedAt: "x" },
	]);
	assert(afterDismiss.state.phase === "none" && afterDismiss.state.taskId === null, "dismiss returns to none");
	assert(!afterDismiss.state.tail && !afterDismiss.state.summary, "post-dismiss events do not resurrect content");
	assert(afterDismiss.effects.filter((e) => e.kind === "dropped").length === 2, "post-dismiss events are dropped");

	// ---- abort path: abort_requested → send_abort, error keeps partials --
	const stopped = run(afterStart.state, [
		{ type: "delta", taskId: "tsk-abc", delta: "partial progress" },
		{ type: "abort_requested" },
		{ type: "error", taskId: "tsk-abc", message: "Task stopped by you. Artifacts already written are kept.", artifacts: [SVG] },
	]);
	assert(stopped.state.phase === "error", "user abort lands the task_error in error phase");
	assert(stopped.state.stopRequested === true, "abort_requested arms stopRequested (stopped vs failed wording)");
	assert(stopped.state.artifacts.length === 1 && stopped.state.artifacts[0].relativePath === SVG.relativePath, "partial artifacts are kept on stop");
	assert(stopped.state.errorMessage === "Task stopped by you. Artifacts already written are kept.", "error message captured for the body");
	const abortEffect = stopped.effects.find((e) => e.kind === "send_abort");
	assert(abortEffect && abortEffect.kind === "send_abort" && abortEffect.taskId === "tsk-abc", "abort_requested emits send_abort with the live id");
	assert(isTaskActive(stopped.state), "a stopped (undismissed) task is still active");

	// abort_requested while not running is a no-op (no frame)
	const noAbort = reduceTask(happy.state, { type: "abort_requested" });
	assert(noAbort.effects.length === 0 && noAbort.state.phase === "done", "abort_requested after done is a no-op");

	// ---- failed path: error without a user abort → error, not stopped ----
	const failed = run(afterStart.state, [
		{ type: "delta", taskId: "tsk-abc", delta: "half" },
		{ type: "error", taskId: "tsk-abc", message: "The specialist ran out of context." },
	]);
	assert(failed.state.phase === "error" && failed.state.stopRequested === false, "error without abort → error (not stopped)");
	assert(failed.state.errorMessage === "The specialist ran out of context.", "failed message names it plainly");

	// ---- single-slot started discipline ----------------------------------
	// a SECOND task started while one is still RUNNING is dropped (protects the in-flight card)
	const secondWhileRunning = reduceTask(afterStart.state, { type: "started", taskId: "tsk-two", template: "deck", templateLabel: "Slide deck" });
	assert(secondWhileRunning.state.taskId === "tsk-abc", "a second task while one is running keeps the running card");
	assert(secondWhileRunning.effects.some((e) => e.kind === "dropped"), "the second running task is dropped");
	// a fresh delegation SUPERSEDES a finished (done) card
	const supersede = reduceTask(happy.state, { type: "started", taskId: "tsk-new", template: "diagram-svg", templateLabel: "SVG diagram" });
	assert(supersede.state.taskId === "tsk-new" && supersede.state.phase === "running", "a fresh delegation supersedes a finished card");
	assert(supersede.state.artifacts.length === 0 && supersede.state.summary === "", "the superseding card starts clean");
	// a same-id refresh keeps the fold state
	const foldedThenRefresh = run(afterStart.state, [{ type: "minimize" }, { type: "started", taskId: "tsk-abc", template: "deck", templateLabel: "Slide deck" }]);
	assert(foldedThenRefresh.state.minimized && foldedThenRefresh.state.phase === "running", "a same-id re-start keeps the fold state");

	// ---- minimize / open / dismiss ---------------------------------------
	const minimized = reduceTask(afterStart.state, { type: "minimize" });
	assert(minimized.state.minimized && minimized.state.phase === "running", "minimize folds to the pill, task keeps running");
	const reopened = reduceTask(minimized.state, { type: "open" });
	assert(!reopened.state.minimized, "open re-expands the card");
	// a folded task reaching done stays folded (ready pill)
	const foldedThenDone = run(minimized.state, [{ type: "end", taskId: "tsk-abc", template: "deck", text: "done", artifacts: [DECK], thumbnails: [DECK_THUMB], generatedAt: "g" }]);
	assert(foldedThenDone.state.minimized && foldedThenDone.state.phase === "done", "a folded task reaching done stays folded");
	assert(reduceTask(initial, { type: "minimize" }).state.phase === "none", "minimize with no task is a no-op");
	// dismiss from any state clears everything
	assert(reduceTask(stopped.state, { type: "dismiss" }).state.phase === "none", "dismiss from error clears the card");
	assert(reduceTask(happy.state, { type: "dismiss" }).state.phase === "none", "dismiss from done clears the card");

	// ---- route-URL derivation (safe by construction) ---------------------
	assert(taskArtifactUrl("tsk-x", "tasks/tsk-x/sub/a.svg") === "/api/artifacts/tsk-x/sub/a.svg", `nested SVG path maps to the V3 route; got ${taskArtifactUrl("tsk-x", "tasks/tsk-x/sub/a.svg")}`);
	assert(taskArtifactUrl("tsk-abc", DECK.relativePath) === "/api/artifacts/tsk-abc/q3-review.html", "top-level artifact maps to the route");
	// malformed / cross-task / unsafe → null (no render, no broken URL)
	assert(taskArtifactUrl("tsk-x", "q3-review.html") === null, "a path WITHOUT the tasks/<id>/ prefix yields null");
	assert(taskArtifactUrl("tsk-x", "tasks/OTHER/a.svg") === null, "a cross-task path (wrong id) yields null");
	assert(taskArtifactUrl("tsk-x", "tasks/tsk-x/") === null, "a path with no file within the task folder yields null");
	assert(taskArtifactUrl("tsk-x", "tasks/tsk-x/../escape.svg") === null, "a traversal segment yields null");
	assert(taskArtifactUrl("tsk-x", "tasks/tsk-x/.thumbs/a.png") === null, "a dot-leading segment (server-internal) yields null");
	assert(taskArtifactUrl("", "tasks//a.svg") === null, "an empty taskId yields null");

	// ---- basename + kind label + svg predicate ---------------------------
	assert(artifactBasename("tasks/tsk-x/sub/a.svg") === "a.svg", "basename is the last path segment (never the store path)");
	assert(artifactBasename("solo.html") === "solo.html", "basename of a bare name is itself");
	assert(artifactKindLabel(".html", "deck") === "DECK", "html from the deck template reads DECK");
	assert(artifactKindLabel("html", "chart-html") === "HTML", "html from another template reads HTML (dot optional)");
	assert(artifactKindLabel(".svg", "deck") === "SVG", "svg reads SVG regardless of template");
	assert(artifactKindLabel(".pdf", null) === "PDF", "an unknown extension reads its upper-cased self");
	assert(isSvgArtifact(".svg") && isSvgArtifact("svg") && !isSvgArtifact(".html"), "isSvgArtifact detects svg (dot optional), rejects html");

	// ---- reset (teardown) ------------------------------------------------
	assert(reduceTask(happy.state, { type: "reset" }).state.phase === "none", "reset forgets everything (socket teardown)");
	assert(createTaskState().artifacts.length === 0 && createTaskState().tail === "", "fresh state starts empty");

	console.log("task card reducer smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
}
