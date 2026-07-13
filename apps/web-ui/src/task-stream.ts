/**
 * Specialist-task client state machine as one explicit, pure reducer — the
 * Phase-2 sibling of consult-stream.ts (visuals track V4, the task card).
 *
 * A "task" delegates a visual artifact (deck, diagram, chart, document) to an
 * ephemeral server-side specialist. Unlike a consult, a task is *server*-
 * originated: the user approves the assistant's `delegate_task` tool
 * call, the server launches the specialist and emits `task_started`. The client
 * only ever LEARNS about a task from the WS event family (it never sends the
 * opening frame), so there is no client `request` action here — the card is
 * born on `started` and the specialist's text + tool markers stream in as
 * `task_delta`s. `task_end` is authoritative for the result (summary text +
 * artifacts + optional write-time thumbnails); `task_error` carries the
 * stopped/failed message and any artifacts already written.
 *
 * The reducer clones consult-stream's discipline exactly:
 *   - `taskId` is the server's id, echoed on every event; any event whose
 *     taskId is not the active one is a stale replay and is dropped *inside the
 *     reducer* (the same stale-nonce discipline the consult + assistant stream
 *     reducers apply). One task card at a time (single slot) — see `started`.
 *   - The delta stream is accumulated into a TAIL buffer capped at the LAST
 *     ~2,000 chars: the running card's status box only ever shows the tail, so
 *     the reducer never grows unboundedly on a chatty specialist.
 *   - Stopped vs failed is decided by whether *this client* asked to abort
 *     (`abort_requested` arms `stopRequested`), not by string-matching the
 *     server message.
 *
 * Pure — (state, action) → { state, effects } — with no React imports. The only
 * side effect is the `task_abort` WS frame the host sends when the user stops a
 * running task; it is returned as an effect and applied by the host, mirroring
 * the consult-stream.ts / assistant-stream.ts house pattern. Fully testable in
 * plain node: apps/web-server/scripts/task-card-smoke.ts.
 *
 * HARD RULE (Borja): the card FACE shows only high-signal content — title,
 * state, thumbnails/chips, summary. Task ids, store paths, timestamps, model,
 * and usage are kept in state for the V5 panel-viewer / provenance header but
 * are NEVER rendered on the card face. This reducer keeps them; the component
 * (delegation-card.tsx) is what enforces the face contract.
 */

/** The specialist folder prefix in every store-relative path: `tasks/<taskId>/…`. */
const TASK_FOLDER_PREFIX = "tasks";

/**
 * The status box shows only the tail of the delta stream, so the buffer is
 * capped at the LAST N characters. ~2,000 is a few dozen lines — plenty of
 * scrollback for the mono box while keeping the reducer's memory bounded on a
 * long-running, chatty specialist.
 */
export const TASK_TAIL_CAP = 2_000;

export interface TaskModel {
	provider: string;
	model: string;
	label?: string;
}

/** One written artifact, as it rides `task_end` / `task_error`. */
export interface TaskArtifact {
	/** Store-relative, e.g. "tasks/tsk-abc123/deck.html" — never shown on the face. */
	relativePath: string;
	bytes: number;
	/** Lower-cased, INCLUDING the leading dot, e.g. ".html" / ".svg" (server precedent). */
	extension: string;
}

/** A write-time thumbnail (data: URI) for an artifact, keyed by its relativePath. */
export interface TaskThumbnail {
	relativePath: string;
	/** A `data:image/png;base64,…` URI — rendered directly, never a live artifact render. */
	dataUri: string;
	/** Present for decks: the slide count badge on the thumbnail. */
	slideCount?: number;
}

/**
 * none    — no task (initial, and after dismiss).
 * running — task_started arrived / streaming; deltas fill the status tail.
 * done    — task_end arrived; summary + artifacts + thumbnails are authoritative.
 * error   — task_error (stopped by the user, or a genuine failure); partial
 *           artifacts kept. Stopped vs failed is `stopRequested`, not the message.
 */
export type TaskPhase = "none" | "running" | "done" | "error";

export interface TaskState {
	phase: TaskPhase;
	/** The server task id, echoed on every event; the stale-event key. NEVER on the face. */
	taskId: string | null;
	/** Template id, e.g. "deck" / "diagram-svg". Drives the DECK vs HTML chip label. */
	template: string | null;
	/** Registry template version, learned at `started`; threads into the §2.2 transfer block. */
	templateVersion: number | null;
	/** Human template label, e.g. "Slide deck" — the speaker chip ("<label> specialist"). */
	templateLabel: string | null;
	/**
	 * The task's display title (e.g. "Q3 client review deck"). NOT carried by the
	 * server event contract, so it is an OPTIONAL client-supplied field on
	 * `started`: the host may pass the brief-derived title it already holds from
	 * the delegation approval. When absent, the card simply omits the Task line —
	 * it never fabricates one. See wiring-spec-v4.md.
	 */
	title: string | null;
	/** The worker model, learned at `started`. Kept for provenance; NEVER on the face. */
	model: TaskModel | null;
	/** Tail of the delta stream, capped at TASK_TAIL_CAP chars — the status box's content. */
	tail: string;
	/** task_end.text — the specialist's summary of what it built. */
	summary: string;
	artifacts: TaskArtifact[];
	thumbnails: TaskThumbnail[];
	/** ISO generation time, kept for the V5 provenance header; NEVER on the face. */
	generatedAt: string | null;
	/** Worker usage, kept for the ledger; NEVER on the face. */
	usage: unknown | null;
	/** Folded to the pill (the task runs identically either way). */
	minimized: boolean;
	/** True once the user asked to stop — routes the task_error to "stopped" wording. */
	stopRequested: boolean;
	/** The server's plain message for the error/stopped body. */
	errorMessage: string | null;
}

export type TaskAction =
	/**
	 * The server launched the specialist (`task_started`). Opens the card
	 * expanded and running. `title` is the only client-supplied field (see
	 * TaskState.title) — everything else is echoed straight from the event.
	 */
	| {
			type: "started";
			taskId: string;
			template: string;
			templateVersion?: number | null;
			templateLabel: string;
			model?: TaskModel | null;
			title?: string | null;
	  }
	/** A text delta or a terse tool marker ("\n[artifact_write_html_deck]\n"). */
	| { type: "delta"; taskId: string; delta: string }
	/** `task_end` — authoritative result: summary text, artifacts, optional thumbnails. */
	| {
			type: "end";
			taskId: string;
			template: string;
			text: string;
			artifacts: TaskArtifact[];
			thumbnails?: TaskThumbnail[];
			generatedAt: string;
			usage?: unknown;
	  }
	/** `task_error` — stopped by the user or failed; partial artifacts may ride along. */
	| { type: "error"; taskId: string; message: string; artifacts?: TaskArtifact[] }
	/** The user pressed Stop; the host sends `task_abort` (effect). */
	| { type: "abort_requested" }
	/** Fold to the pill; the task keeps running. */
	| { type: "minimize" }
	/** Re-open the expanded card from the pill. */
	| { type: "open" }
	/** Remove the card/pill entirely. */
	| { type: "dismiss" }
	/** Connection/room teardown: forget everything. */
	| { type: "reset" };

export type TaskEffect =
	/** Send the abort WS frame `{type:"task_abort", taskId}`. */
	| { kind: "send_abort"; taskId: string }
	/** A stale or out-of-phase event was dropped — host may log for tracing. */
	| { kind: "dropped"; reason: string; taskId: string | null };

export interface TaskResult {
	state: TaskState;
	effects: TaskEffect[];
}

export function createTaskState(): TaskState {
	return {
		phase: "none",
		taskId: null,
		template: null,
		templateVersion: null,
		templateLabel: null,
		title: null,
		model: null,
		tail: "",
		summary: "",
		artifacts: [],
		thumbnails: [],
		generatedAt: null,
		usage: null,
		minimized: false,
		stopRequested: false,
		errorMessage: null,
	};
}

/** Active = there is a card or pill on screen (running, or an undismissed result). */
export function isTaskActive(state: TaskState): boolean {
	return state.phase !== "none";
}

/** A server event matches the live task only when its id is the active one. */
function isForActiveTask(state: TaskState, taskId: string): boolean {
	return state.taskId !== null && state.taskId === taskId;
}

/** Append a delta and keep only the trailing TASK_TAIL_CAP chars (bounded status box). */
function appendTail(tail: string, delta: string): string {
	const next = tail + delta;
	return next.length > TASK_TAIL_CAP ? next.slice(-TASK_TAIL_CAP) : next;
}

export function reduceTask(previous: TaskState, action: TaskAction): TaskResult {
	const effects: TaskEffect[] = [];

	switch (action.type) {
		case "reset":
			return { state: createTaskState(), effects };

		case "started": {
			// One task card at a time (single slot), mirroring the consult dock. A
			// fresh `task_started` for the SAME id is an idempotent refresh; a NEW id
			// adopts a fresh card only when the slot is free (none) or holds a
			// finished result (done/error) — a new delegation supersedes a lingering
			// card. A different id while one is still RUNNING is dropped defensively
			// so an in-flight card is never clobbered. The server cap matches this
			// single slot (WEB_TASK_CAP = 1 for v1), so this branch is a pure
			// defensive floor; when the multi-card slice raises the cap, the host
			// keys one reducer per taskId (the reducer is pure and taskId-scoped)
			// and this instance still only ever sees its own task. See
			// wiring-spec-v4.md.
			if (previous.phase === "running" && previous.taskId !== null && previous.taskId !== action.taskId) {
				effects.push({ kind: "dropped", reason: "a second task started while one is still running", taskId: action.taskId });
				return { state: previous, effects };
			}
			const state: TaskState = {
				...createTaskState(),
				phase: "running",
				taskId: action.taskId,
				template: action.template,
				templateVersion: action.templateVersion ?? null,
				templateLabel: action.templateLabel,
				title: action.title ?? null,
				model: action.model ?? null,
				// A same-id refresh keeps whatever the card has folded to. A NEW task
				// starts as the pill (Borja, 2026-07-12): the run is run-free by
				// design, so the default surface is the unobtrusive "working…" pill
				// and the user expands deliberately.
				minimized: previous.taskId === action.taskId ? previous.minimized : true,
			};
			return { state, effects };
		}

		case "delta": {
			if (!isForActiveTask(previous, action.taskId) || previous.phase !== "running") {
				effects.push({ kind: "dropped", reason: "delta outside the active run", taskId: action.taskId });
				return { state: previous, effects };
			}
			return { state: { ...previous, tail: appendTail(previous.tail, action.delta) }, effects };
		}

		case "end": {
			if (!isForActiveTask(previous, action.taskId) || previous.phase !== "running") {
				effects.push({ kind: "dropped", reason: "end outside the active run", taskId: action.taskId });
				return { state: previous, effects };
			}
			// task_end is authoritative for the result. stopRequested resets here so
			// an abort-vs-end race that the end wins never leaks a live stop flag into
			// `done` (same hardening as consult-stream's end).
			return {
				state: {
					...previous,
					phase: "done",
					template: action.template,
					summary: action.text,
					artifacts: action.artifacts,
					thumbnails: action.thumbnails ?? [],
					generatedAt: action.generatedAt,
					usage: action.usage ?? null,
					stopRequested: false,
				},
				effects,
			};
		}

		case "error": {
			if (!isForActiveTask(previous, action.taskId) || previous.phase !== "running") {
				effects.push({ kind: "dropped", reason: "error outside the active run", taskId: action.taskId });
				return { state: previous, effects };
			}
			// Stopped vs failed is decided by whether this client asked to abort, not
			// by the server's wording. Partial artifacts (already written) are kept.
			return {
				state: {
					...previous,
					phase: "error",
					errorMessage: action.message,
					artifacts: action.artifacts ?? previous.artifacts,
				},
				effects,
			};
		}

		case "abort_requested": {
			// Only a running task can be stopped; arm the flag and ask the server to
			// abort. The stop resolves when the server's task_error arrives.
			if (previous.phase !== "running" || !previous.taskId) return { state: previous, effects };
			effects.push({ kind: "send_abort", taskId: previous.taskId });
			return { state: { ...previous, stopRequested: true }, effects };
		}

		case "minimize": {
			if (previous.phase === "none") return { state: previous, effects };
			return { state: { ...previous, minimized: true }, effects };
		}

		case "open": {
			if (previous.phase === "none") return { state: previous, effects };
			return { state: { ...previous, minimized: false }, effects };
		}

		case "dismiss":
			// Remove the card/pill entirely, in any state.
			return { state: createTaskState(), effects };
	}
}

/**
 * Derive the safe-by-construction artifact route URL from a store-relative path
 * (V3's `/api/artifacts/:taskId/*`). `relativePath` is store-relative like
 * `tasks/<taskId>/sub/a.svg`; the route wants the path WITHIN the task folder,
 * so the leading `tasks/<taskId>/` is stripped:
 *
 *   taskArtifactUrl("tsk-x", "tasks/tsk-x/sub/a.svg") === "/api/artifacts/tsk-x/sub/a.svg"
 *
 * Returns null for anything that is not under this task's folder (a malformed or
 * cross-task path) so the card renders NOTHING rather than a broken/unsafe URL.
 * Dot-leading segments (e.g. server-internal `.thumbs`) are refused too — the
 * V3 route rejects them, and the card must never even attempt them.
 */
export function taskArtifactUrl(taskId: string, relativePath: string): string | null {
	if (!taskId || !relativePath) return null;
	const prefix = `${TASK_FOLDER_PREFIX}/${taskId}/`;
	if (!relativePath.startsWith(prefix)) return null;
	const within = relativePath.slice(prefix.length);
	if (!within) return null;
	const segments = within.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith("."))) return null;
	return `/api/artifacts/${taskId}/${within}`;
}

/** The basename shown on a chip/thumbnail — the last path segment, never the store path. */
export function artifactBasename(relativePath: string): string {
	const segments = relativePath.split("/").filter(Boolean);
	return segments.length ? segments[segments.length - 1] : relativePath;
}

/**
 * The typed-chip kind label (DECK / HTML / SVG / …), per extension and template,
 * exactly as the mockup shows: an HTML artifact from the deck template reads
 * DECK; other HTML reads HTML; an SVG reads SVG; anything else is its bare,
 * upper-cased extension. `extension` may or may not carry the leading dot.
 */
export function artifactKindLabel(extension: string, template: string | null): string {
	const ext = extension.replace(/^\./, "").toLowerCase();
	if (ext === "svg") return "SVG";
	if (ext === "html" || ext === "htm") return template === "deck" ? "DECK" : "HTML";
	return ext ? ext.toUpperCase() : "FILE";
}

/** True when the extension is an SVG — the one artifact the card renders inline via <img>. */
export function isSvgArtifact(extension: string): boolean {
	return extension.replace(/^\./, "").toLowerCase() === "svg";
}

/** The thumbnail whose relativePath matches this artifact, if the server sent one. */
export function thumbnailFor(state: TaskState, relativePath: string): TaskThumbnail | null {
	return state.thumbnails.find((thumb) => thumb.relativePath === relativePath) ?? null;
}
