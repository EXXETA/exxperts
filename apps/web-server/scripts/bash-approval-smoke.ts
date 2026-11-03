// Workspace reshape slice e: the per-command bash approval card. Pins the
// guard's gate order (auto-approve → no-UI → card), the card's exact title
// and anti-spoof fence, the no-retry decline reason, the 1200-char command
// clip, the per-room settings file (default off, tolerant read, 0600), the
// loopback-only PUT route class, the wire bridge (a confirm frame flows, a
// detach auto-declines), and the extension shape (only bash is touched).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-bash-approval-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempRoot;

const approval = await import("../src/persistent-room-bash-approval.js");
const bashSettings = await import("../src/persistent-room-bash-settings.js");
const routePolicy = await import("../src/remote-route-policy.js");
const webUiContext = await import("../src/web-ui-context.js");

const APPROVAL_TITLE = "Run this command?";
const FENCE_LINE = "─── Command (written by the room's model; the app has not verified it) ───";
const DECLINE_REASON = "The user declined this command. Do not run it or retry variants of it unless the user asks.";

function makeCtx(input: { confirmResult?: boolean; cwd?: string } = {}) {
	const confirms: Array<{ title: string; message: string }> = [];
	const ctx = {
		hasUI: true,
		...(input.cwd ? { cwd: input.cwd } : {}),
		ui: {
			async confirm(title: string, message: string) {
				confirms.push({ title, message });
				return input.confirmResult ?? true;
			},
		},
	};
	return { ctx, confirms };
}

try {
	// ── 1. Guard gate order and card text ────────────────────────────────────
	{
		// Approve: exactly one card, and every pinned line of it.
		const { ctx, confirms } = makeCtx({ cwd: "/tmp/room-workspace" });
		const guard = approval.createPersistentRoomBashApprovalGuard({ isAutoApproved: () => false });
		const decision = await guard.beforeBashCall('echo "hello approval"', ctx);
		assert(decision.allow === true, "an approved command must be allowed");
		assert(confirms.length === 1, "approval must ask exactly once");
		const message = confirms[0].message;
		assert(message.includes(FENCE_LINE), "card must carry the anti-spoof fence line");
		assert(message.includes('echo "hello approval"'), "card must show the command");
		assert(message.indexOf(FENCE_LINE) < message.indexOf('echo "hello approval"'), "the command must render below the fence, never above it");
		assert(message.includes("Runs in: /tmp/room-workspace"), "card must name the working directory when the context has one");
		assert(message.includes("You can auto-approve bash for this room in Room settings, Folder."), "card must mention the auto-approve setting");
		assert(message.indexOf("You can auto-approve bash") < message.indexOf(FENCE_LINE), "the app-drawn facts must sit above the fence");
	}
	{
		// A context without a cwd omits the facts line instead of faking one.
		const { ctx, confirms } = makeCtx();
		const guard = approval.createPersistentRoomBashApprovalGuard({ isAutoApproved: () => false });
		await guard.beforeBashCall("ls", ctx);
		assert(!confirms[0].message.includes("Runs in:"), "a cwd-less context must not invent a working directory");
	}
	{
		// Decline: one card, the pinned no-retry reason, nothing else.
		const { ctx, confirms } = makeCtx({ confirmResult: false });
		const guard = approval.createPersistentRoomBashApprovalGuard({ isAutoApproved: () => false });
		const decision = await guard.beforeBashCall("rm -rf /", ctx);
		assert(decision.allow === false, "a declined command must be blocked");
		assert(!decision.allow && decision.reason === DECLINE_REASON, `decline reason must be pinned, got ${JSON.stringify(!decision.allow ? decision.reason : null)}`);
		assert(confirms.length === 1, "decline must ask exactly once");
	}
	{
		// No UI: structural deny, never a prompt (background/scheduled shape).
		const guard = approval.createPersistentRoomBashApprovalGuard({ isAutoApproved: () => false });
		const decision = await guard.beforeBashCall("ls", { hasUI: false } as any);
		assert(decision.allow === false, "a UI-less context must be denied");
		assert(!decision.allow && decision.reason.includes("interactive room UI"), "the no-UI reason must name the missing surface");
		const undefinedCtxDecision = await guard.beforeBashCall("ls", undefined);
		assert(undefinedCtxDecision.allow === false, "a missing context must be denied");
	}
	{
		// Auto-approve on: allowed with zero cards, and read LIVE per call.
		let autoApproved = true;
		const { ctx, confirms } = makeCtx();
		const guard = approval.createPersistentRoomBashApprovalGuard({ isAutoApproved: () => autoApproved });
		const decision = await guard.beforeBashCall("ls", ctx);
		assert(decision.allow === true && confirms.length === 0, "auto-approve must allow without asking");
		autoApproved = false;
		await guard.beforeBashCall("ls", ctx);
		const asksAfterFlip: number = confirms.length;
		assert(asksAfterFlip === 1, "flipping auto-approve off must make the very next call ask (live read, no rebind)");
	}
	{
		// The 1200-char clip: head shown, tail withheld, marker pinned.
		const head = "x".repeat(1_200);
		const longCommand = `${head}SECRET_TAIL_MARKER`;
		const { ctx, confirms } = makeCtx();
		const guard = approval.createPersistentRoomBashApprovalGuard({ isAutoApproved: () => false });
		await guard.beforeBashCall(longCommand, ctx);
		const message = confirms[0].message;
		assert(message.includes(head), "the clipped card must keep the first 1200 chars");
		assert(!message.includes("SECRET_TAIL_MARKER"), "the clipped card must not show text beyond the clip");
		assert(message.includes("[command preview clipped]"), "the clipped card must say it clipped");
		const { ctx: exactCtx, confirms: exactConfirms } = makeCtx();
		await guard.beforeBashCall(head, exactCtx);
		assert(!exactConfirms[0].message.includes("[command preview clipped]"), "a command at exactly the limit must not claim a clip");
	}
	console.log("ok: the guard asks once, pins its card text, and honors decline, no-UI, auto-approve, and the clip");

	// ── 2. Per-room settings file ────────────────────────────────────────────
	{
		const agentId = "bash-approval-smoke-room";
		const initial = bashSettings.readPersistentRoomBashSettings(agentId);
		assert(initial.autoApprove === false, "default must be approve-each-command");
		assert(!fs.existsSync(bashSettings.persistentRoomBashSettingsPath(agentId)), "read must not create the settings file");
		const written = bashSettings.writePersistentRoomBashSettings(agentId, { autoApprove: true }, {}, new Date("2026-08-20T12:00:00.000Z"));
		assert(written.autoApprove === true, "write should persist the toggle");
		assert(written.updatedAt === "2026-08-20T12:00:00.000Z", "write should stamp updatedAt");
		assert(bashSettings.readPersistentRoomBashSettings(agentId).autoApprove === true, "reread should see the persisted toggle");
		const merged = bashSettings.writePersistentRoomBashSettings(agentId, {});
		assert(merged.autoApprove === true, "a field-less write must preserve the stored value");
		assert(bashSettings.writePersistentRoomBashSettings(agentId, { autoApprove: false }).autoApprove === false, "toggle off should persist");
		let threw = false;
		try {
			bashSettings.writePersistentRoomBashSettings(agentId, { autoApprove: "yes" as unknown as boolean });
		} catch (error) {
			threw = /autoApprove must be a boolean/.test((error as Error).message);
		}
		assert(threw, "non-boolean input should be rejected");
		let threwId = false;
		try {
			bashSettings.readPersistentRoomBashSettings("../escape");
		} catch (error) {
			threwId = /invalid persistent-room agent id/.test((error as Error).message);
		}
		assert(threwId, "path-escaping agent ids should be rejected");
		const settingsPath = bashSettings.persistentRoomBashSettingsPath(agentId);
		assert(settingsPath === path.join(tempRoot, agentId, "runtime", "bash-settings.json"), "settings file should live under the room runtime dir");
		if (process.platform !== "win32") {
			const mode = fs.statSync(settingsPath).mode & 0o777;
			assert(mode === 0o600, `settings file should be 0600, got ${mode.toString(8)}`);
		}
		// Malformed content and wrong schema versions read as the safe default:
		// a broken file must never read as consent to stop asking.
		bashSettings.writePersistentRoomBashSettings(agentId, { autoApprove: true });
		fs.writeFileSync(settingsPath, "not json", "utf-8");
		assert(bashSettings.readPersistentRoomBashSettings(agentId).autoApprove === false, "corrupt settings must fall back to asking");
		fs.writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 2, autoApprove: true }), "utf-8");
		assert(bashSettings.readPersistentRoomBashSettings(agentId).autoApprove === false, "an unknown schema version must fall back to asking");
		fs.writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 1, autoApprove: "true" }), "utf-8");
		assert(bashSettings.readPersistentRoomBashSettings(agentId).autoApprove === false, "a non-boolean stored value must fall back to asking");
	}
	console.log("ok: the setting defaults to asking, round-trips, and every malformed shape reads as asking");

	// ── 2b. One-time upgrade grant for rooms predating the card ─────────────
	{
		const legacyRoom = "bash-legacy-room";
		const chosenRoom = "bash-chosen-room";
		const noBashRoom = "no-bash-room";
		bashSettings.writePersistentRoomBashSettings(chosenRoom, { autoApprove: false });
		const first = bashSettings.migratePersistentRoomBashAutoApproveDefaults([
			{ id: legacyRoom, bashEnabled: true },
			{ id: chosenRoom, bashEnabled: true },
			{ id: noBashRoom, bashEnabled: false },
		]);
		assert(first.migrated.join(",") === legacyRoom, "only a bash room without an explicit choice gets the grant");
		assert(bashSettings.readPersistentRoomBashSettings(legacyRoom).autoApprove === true, "a pre-card bash room keeps running without asking");
		assert(bashSettings.readPersistentRoomBashSettings(chosenRoom).autoApprove === false, "an explicit choice is never overridden by the sweep");
		assert(bashSettings.readPersistentRoomBashSettings(noBashRoom).autoApprove === false, "a room without bash gets nothing");
		const second = bashSettings.migratePersistentRoomBashAutoApproveDefaults([
			{ id: "post-card-bash-room", bashEnabled: true },
		]);
		assert(second.migrated.length === 0, "the sweep runs once: bash enabled after the marker starts at ask-each");
		assert(bashSettings.readPersistentRoomBashSettings("post-card-bash-room").autoApprove === false, "a room enabling bash after the upgrade asks per command");
	}
	console.log("ok: the upgrade grant preserves pre-card bash rooms, respects choices, and never fires twice");

	// ── 2c. A grant that fails still finishes the step ──────────────────────
	{
		// Its own root, so this run starts before any marker exists.
		const options = { persistentAgentsRoot: path.join(tempRoot, "upgrade-with-a-failed-grant") };
		const failedRoom = "bash-grant-fails-room";
		const grantedRoom = "bash-grant-lands-room";
		const lateRoom = "bash-enabled-later-room";
		const asksPerCommand = async (agentId: string): Promise<boolean> => {
			const { ctx, confirms } = makeCtx();
			const guard = approval.createPersistentRoomBashApprovalGuard({
				isAutoApproved: () => bashSettings.readPersistentRoomBashSettings(agentId, options).autoApprove === true,
			});
			await guard.beforeBashCall("ls", ctx);
			return confirms.length === 1;
		};
		// A file where the room's runtime folder belongs makes its write fail.
		const blocker = path.join(options.persistentAgentsRoot, failedRoom, "runtime");
		fs.mkdirSync(path.dirname(blocker), { recursive: true });
		fs.writeFileSync(blocker, "not a folder", "utf-8");
		const warnings: string[] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
		const first = (() => {
			try {
				return bashSettings.migratePersistentRoomBashAutoApproveDefaults([
					{ id: failedRoom, bashEnabled: true },
					{ id: grantedRoom, bashEnabled: true },
				], options);
			} finally {
				console.warn = realWarn;
			}
		})();
		assert(first.migrated.join(",") === grantedRoom && first.failed.join(",") === failedRoom, `one failed grant must not stop the others, got ${JSON.stringify(first)}`);
		assert(warnings.length === 1 && warnings[0].includes(JSON.stringify(failedRoom)), `the failed room must be logged with its id, got ${JSON.stringify(warnings)}`);
		const markerPath = path.join(options.persistentAgentsRoot, ".bash-auto-approve-defaults-v1");
		const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
		assert(typeof marker.startedAt === "string" && JSON.stringify([marker.migrated, marker.failed]) === JSON.stringify([[grantedRoom], [failedRoom]]),`the marker must name the granted and the failed rooms, got ${JSON.stringify(marker)}`);
		assert(await asksPerCommand(failedRoom), "the room whose grant failed asks before each command");
		assert(!(await asksPerCommand(grantedRoom)), "the room whose grant landed runs without asking");

		// The next start: the failed room could be written now, and another room
		// turned commands on in between. Neither may gain auto-approve.
		fs.rmSync(blocker);
		const second = bashSettings.migratePersistentRoomBashAutoApproveDefaults([
			{ id: failedRoom, bashEnabled: true },
			{ id: grantedRoom, bashEnabled: true },
			{ id: lateRoom, bashEnabled: true },
		], options);
		assert(second.migrated.length === 0 && second.failed.length === 0, `the step must not run again after a failed grant, got ${JSON.stringify(second)}`);
		assert(fs.readFileSync(markerPath, "utf-8") === JSON.stringify(marker, null, 2) + "\n", "the next start leaves the marker as the upgrade wrote it");
		assert(!fs.existsSync(bashSettings.persistentRoomBashSettingsPath(failedRoom, options)), "the next start writes nothing for the room whose grant failed");
		assert(!fs.existsSync(bashSettings.persistentRoomBashSettingsPath(lateRoom, options)), "the next start writes nothing for a room that turned commands on later");
		assert(await asksPerCommand(failedRoom), "after the next start, the room whose grant failed still asks before each command");
		assert(await asksPerCommand(lateRoom), "after the next start, a room that turned commands on later asks before each command");
	}
	console.log("ok: a failed grant is logged, the step still finishes, and the next start grants nothing");

	// ── 3. Remote route policy ───────────────────────────────────────────────
	{
		assert(routePolicy.classifyRemoteRoute("PUT", "/api/persistent-agents/:id/bash-settings") === "local", "PUT bash-settings must be loopback-only: a phone must never flip a room to auto-approve");
		assert(routePolicy.classifyRemoteRoute("GET", "/api/persistent-agents/:id/bash-settings") === "read", "GET bash-settings should be readable like the sibling settings routes");
	}
	console.log("ok: the auto-approve mutation is loopback-only");

	// ── 4. Wire bridge: a confirm frame flows, a detach auto-declines ────────
	{
		const autoDeclined: Array<{ kind: string; title: string }> = [];
		const sentFrames: any[] = [];
		const uiContext = webUiContext.createWebUiContext((msg: unknown) => sentFrames.push(msg), (question) => autoDeclined.push(question));
		const guard = approval.createPersistentRoomBashApprovalGuard({ isAutoApproved: () => false });
		const liveCtx = { hasUI: true, ui: uiContext } as any;
		const pendingDecision = guard.beforeBashCall("git status", liveCtx);
		const frame = sentFrames.find((f) => f?.type === "ui_request" && f?.kind === "confirm");
		assert(frame, "the approval must reach the client as a ui_request confirm frame");
		assert(frame.title === APPROVAL_TITLE && String(frame.message).includes(FENCE_LINE), "the wire frame must carry the pinned card");
		uiContext.resolveResponse(frame.id, true);
		assert((await pendingDecision).allow === true, "a ui_response approval must allow the command");

		// Detach: the pending card rejects with the detach message (the tool
		// call fails with it) and the auto-decline listener — where index.ts
		// hangs the question log whose note the landing writes into the
		// transcript — hears about the card exactly once.
		const detachMessage = "The user left the room while this response was being written, so interactive questions cannot be answered right now.";
		const detachDecision = guard.beforeBashCall("git status", liveCtx).then(
			() => { throw new Error("a detached confirm must not resolve"); },
			(error: Error) => error.message,
		);
		uiContext.detach(detachMessage);
		assert((await detachDecision) === detachMessage, "a detach must fail the pending approval with the detach message");
		assert(autoDeclined.length === 1 && autoDeclined[0].kind === "confirm" && autoDeclined[0].title === APPROVAL_TITLE, `the detach must report the card to the transcript-note listener, got ${JSON.stringify(autoDeclined)}`);
	}
	console.log("ok: the card rides the ui_request bridge and a detach auto-declines with the transcript note");

	// ── 4b. Stop answers the open card, then the next turn asks again ───────
	{
		const { STOPPED_BEFORE_ANSWER_SENTENCE } = await import("../src/turn-ended-by.js");
		const autoDeclined: unknown[] = [];
		const sentFrames: any[] = [];
		const uiContext = webUiContext.createWebUiContext((msg: unknown) => sentFrames.push(msg), (question) => autoDeclined.push(question));
		const guard = approval.createPersistentRoomBashApprovalGuard({ isAutoApproved: () => false });
		const liveCtx = { hasUI: true, ui: uiContext } as any;
		const outcome = (command: string) => guard.beforeBashCall(command, liveCtx).then((d) => `allowed:${d.allow}`, (error: Error) => error.message);
		const open = outcome("rm notes.txt");
		const asked = sentFrames.find((f) => f?.type === "ui_request" && f?.kind === "confirm");
		assert(asked, "the card is asked");
		uiContext.declineOpenQuestions(STOPPED_BEFORE_ANSWER_SENTENCE);
		assert((await open) === STOPPED_BEFORE_ANSWER_SENTENCE, "Stop answers the open card with the stop's sentence for the model");
		assert(sentFrames.some((f) => f?.type === "ui_request_closed" && f.id === asked.id && f.reason === "stopped"), "the page is told the card closed");
		const framesBefore = sentFrames.length;
		assert((await outcome("rm other.txt")) === STOPPED_BEFORE_ANSWER_SENTENCE && sentFrames.length === framesBefore, "a card asked while the stop is under way is answered at once, never shown");
		assert(autoDeclined.length === 0, "a Stop is not an away decline: nothing is noted for the landing");
		uiContext.reopen();
		const next = outcome("ls");
		const askedAgain = sentFrames.slice(framesBefore).find((f) => f?.type === "ui_request" && f?.kind === "confirm");
		assert(askedAgain, "the next turn asks again");
		uiContext.resolveResponse(askedAgain.id, true);
		assert((await next) === "allowed:true", "and its answer counts");
	}
	console.log("ok: Stop answers the open card and later cards, then the next turn asks again");

	// ── 5. Extension shape: only bash is touched ─────────────────────────────
	{
		let guardCalls = 0;
		const { ctx, confirms } = makeCtx({ confirmResult: false });
		const innerGuard = approval.createPersistentRoomBashApprovalGuard({ isAutoApproved: () => false });
		const countingGuard = {
			beforeBashCall: async (command: string, callCtx: any) => {
				guardCalls += 1;
				return innerGuard.beforeBashCall(command, callCtx);
			},
		};
		const handlers = new Map<string, (event: any, eventCtx: any) => Promise<any>>();
		await approval.createPersistentRoomBashApprovalExtension(countingGuard)({ on: (name: any, handler: any) => handlers.set(name, handler) });
		const handler = handlers.get("tool_call");
		assert(handler, "the extension must register a tool_call handler");
		const readResult = await handler({ type: "tool_call", toolCallId: "t1", toolName: "read", input: { path: "notes.md" } }, ctx);
		assert(readResult === undefined && guardCalls === 0 && confirms.length === 0, "a non-bash tool must pass through untouched, guard never invoked");
		const bashResult = await handler({ type: "tool_call", toolCallId: "t2", toolName: "bash", input: { command: "rm -rf /" } }, ctx);
		const guardCallsAfterBash: number = guardCalls;
		const asksAfterBash: number = confirms.length;
		assert(guardCallsAfterBash === 1 && asksAfterBash === 1, "a bash call must reach the guard and ask");
		assert(bashResult?.block === true && bashResult?.reason === DECLINE_REASON, "a declined bash call must block with the no-retry reason");
	}
	console.log("ok: the extension touches bash only and blocks a declined command");

	fs.rmSync(tempRoot, { recursive: true, force: true });
	console.log("bash approval smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${tempRoot}`);
	process.exitCode = 1;
}
