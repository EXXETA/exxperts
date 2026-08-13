import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Work that finishes with nobody in the room has to say so by itself. Two
// halves, proven here against the real modules:
//   1. a scheduled run that lands an answer records the same unseen-landed
//      marker the detached-turn landing records, so the room card badges it —
//      including the fresh-thread flavor, whose answer goes into a thread the
//      room never made active and which the detached-turn clearing rule would
//      throw away the instant it was written;
//   2. a question auto-declined because nobody is watching leaves one plain
//      note in the persisted thread, from the detached web bridge and from the
//      headless background context alike.
// A run that never landed an answer (deferred on a busy room) records nothing.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function expectRejection(promise: Promise<unknown>, label: string): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return String((error as Error)?.message ?? error);
	}
	throw new Error(`${label}: dialog should have been declined, but it resolved`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-away-visibility-"));
const tempHome = path.join(tmp, "home");
const tempAgentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempAgentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(tempAgentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(tempAgentRuntimeRoot, { recursive: true, mode: 0o700 });

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
writeJson(path.join(smokeAppDir, "openai-compatible-ai-profile.json"), {
	profileId: "openai-compatible",
	providerId: "openai-compatible",
	label: "Synthetic Gateway",
	roomModels: [{ modelId: "gpt-5.5" }],
	maintenanceModel: "gpt-5.5",
});
writeJson(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });
process.env.EXXPERTS_CODING_AGENT_DIR = tempAgentRuntimeRoot;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;
process.env.EXXETA_HOME = repoRoot;

try {
	const persistentAgents = await import("../src/persistent-agents.js");
	const {
		clearPersistentAgentUnseenLandedAnswerForBind,
		createPersistentAgentFromScaffoldInput,
		createPersistentAgentPiSessionJsonlThreadRuntime,
		createPersistentRoomAutoDeclinedQuestionLog,
		beginPersistentAgentTurn,
		finishPersistentAgentTurn,
		getPersistentAgentRuntimeState,
		getPersistentAgentStatus,
		getPersistentAgentThread,
		getPersistentAgentUnseenLandedAnswer,
		recordPersistentAgentUnseenLandedAnswer,
		writePersistentAgentMementoBoundary,
		writePersistentAgentThread,
	} = persistentAgents;
	const { createWebUiContext } = await import("../src/web-ui-context.js");
	const executionAdapter = await import("../src/persistent-room-background-execution.js");
	const {
		createHeadlessUiContext,
		scheduledPromptBackgroundAssistantItemId,
		scheduledPromptBackgroundDeclinedQuestionItemIdPrefix,
		scheduledPromptBackgroundThreadId,
		scheduledPromptBackgroundUserItemId,
	} = executionAdapter;
	const { createScheduledPromptBackgroundRunPreflight } = await import("../src/scheduled-prompt-runs.js");
	const { processScheduledPromptBackgroundRunExecutionOnce } = await import("../src/scheduled-prompt-background-execution.js");
	const { readBackgroundRun } = await import("../src/background-runs.js");
	const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
	const { addPersistentRoomScheduleJob } = await import("../../../pi-package/extensions/schedule-prompt/index.js");

	writePersistentAgentAiProfileState("openai-compatible");
	writeJson(path.join(tempAgentRuntimeRoot, "models.json"), {
		providers: {
			"openai-compatible": {
				name: "Synthetic Gateway",
				baseUrl: "https://synthetic.invalid/v1",
				api: "openai-completions",
				models: [{ id: "gpt-5.5", name: "GPT 5.5" }],
			},
		},
	});
	writeJson(path.join(tempAgentRuntimeRoot, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-key" } });

	const baseNow = new Date("2026-01-01T00:00:00.000Z");
	const dueNow = new Date("2026-01-01T01:00:00.000Z");
	const promptText = "AWAY_VISIBILITY_SCHEDULED_PROMPT";
	const roomModel = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT 5.5" };

	function createRoom(displayName: string): string {
		const created = createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
		return String(created.agent.agentId);
	}

	function addSchedule(roomId: string, name: string) {
		return addPersistentRoomScheduleJob(roomId, { name, type: "once", schedule: "+30m", prompt: promptText, now: baseNow });
	}

	function preflight(roomId: string, scheduleJobId: string, dueAt: string) {
		return createScheduledPromptBackgroundRunPreflight({ roomId, scheduleJobId, dueAt, now: baseNow }).run;
	}

	// Stands in for the model: writes the same user/assistant items the real
	// execution writes, so the worker's landing bookkeeping runs for real.
	const fakeExecute = async (input: any) => {
		const runId = String(input.executionId);
		const model = input.target.model;
		const threadId = input.target.kind === "fresh-thread" ? scheduledPromptBackgroundThreadId(runId) : String(input.target.threadId ?? "");
		if (input.target.kind === "fresh-thread" && !getPersistentAgentThread(input.roomId, threadId)) {
			writePersistentAgentThread(input.roomId, threadId, { state: "standby", origin: "home", model, items: [] }, {
				createRuntime: ({ instance, threadId: createdThreadId, model: createdModel }: any) => createPersistentAgentPiSessionJsonlThreadRuntime({
					agentId: instance.agentId,
					threadId: createdThreadId,
					model: createdModel,
					cwd: repoRoot,
				}),
			});
		}
		const before = getPersistentAgentThread(input.roomId, threadId)!;
		const turn = beginPersistentAgentTurn(input.roomId, threadId, { turnId: `fake_${runId}`, connectionId: `fake:${runId}` });
		const assistantText = `synthetic assistant output for ${runId}`;
		const write = writePersistentAgentThread(input.roomId, threadId, {
			state: "standby",
			origin: before.origin,
			model: before.model,
			items: [
				...before.items,
				{ kind: "user", id: scheduledPromptBackgroundUserItemId(runId), text: input.prompt },
				{ kind: "assistant", id: scheduledPromptBackgroundAssistantItemId(runId), text: assistantText, streaming: false },
			],
		});
		finishPersistentAgentTurn(input.roomId, threadId, { turnId: turn.turnId, terminalReason: "completed" });
		return {
			roomId: input.roomId,
			threadId,
			targetKind: input.target.kind,
			model,
			assistantText,
			items: { userItemId: scheduledPromptBackgroundUserItemId(runId), assistantItemId: scheduledPromptBackgroundAssistantItemId(runId) },
			thread: write.thread,
		};
	};

	async function processOne(label: string) {
		return processScheduledPromptBackgroundRunExecutionOnce({
			workerId: `scheduler-execution:away-visibility:${label}`,
			now: dueNow,
			limit: 1,
			leaseMs: 5_000,
			heartbeatMs: 1_000,
			executePrompt: fakeExecute as any,
		});
	}

	// -----------------------------------------------------------------------
	// 1. A resume-thread scheduled run badges the room.
	// -----------------------------------------------------------------------
	const resumeRoom = createRoom("Away Visibility Resume Room");
	const resumeThreadId = "away_resume_0001";
	writePersistentAgentThread(resumeRoom, resumeThreadId, { state: "standby", origin: "home", model: roomModel, items: [{ kind: "user", id: "prior-user", text: "prior message" }] }, {
		createRuntime: ({ instance, threadId, model }: any) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: instance.agentId, threadId, model, cwd: repoRoot }),
	});
	const resumeJob = addSchedule(resumeRoom, "resume job");
	const resumeRun = preflight(resumeRoom, resumeJob.id, String(resumeJob.nextRunAt));
	const resumeSummary = await processOne("resume");
	assert(resumeSummary.processed.some((item) => item.runId === resumeRun.runId && item.finalStatus === "succeeded"), "resume-thread scheduled run should succeed");
	const resumeStatus = getPersistentAgentStatus(resumeRoom);
	assert(resumeStatus.unseenLandedAnswer, `a completed resume-thread scheduled run should record an unseen marker, got ${JSON.stringify(resumeStatus.unseenLandedAnswer)}`);
	assert(resumeStatus.unseenLandedAnswer.threadId === resumeThreadId, `resume marker should name the landed thread, got ${JSON.stringify(resumeStatus.unseenLandedAnswer)}`);
	assert(resumeStatus.unseenLandedAnswer.terminalReason === "completed", `resume marker should carry terminalReason completed, got ${JSON.stringify(resumeStatus.unseenLandedAnswer)}`);
	assert(resumeStatus.unseenLandedAnswer.origin === "scheduled-run", `resume marker should carry the scheduled-run origin, got ${JSON.stringify(resumeStatus.unseenLandedAnswer)}`);
	assert(getPersistentAgentStatus(resumeRoom).unseenLandedAnswer, "the resume marker should still be reported on a second status read");
	console.log("ok: a completed resume-thread scheduled run leaves a marker the status read reports");

	// -----------------------------------------------------------------------
	// 2. The fresh-thread flavor survives the same read, and the detached-turn
	//    clearing rule (which it must not be subject to) is proven to bite.
	// -----------------------------------------------------------------------
	const freshRoom = createRoom("Away Visibility Fresh Room");
	const freshJob = addSchedule(freshRoom, "fresh job");
	const freshRun = preflight(freshRoom, freshJob.id, String(freshJob.nextRunAt));
	const freshSummary = await processOne("fresh");
	assert(freshSummary.processed.some((item) => item.runId === freshRun.runId && item.finalStatus === "succeeded"), "fresh-thread scheduled run should succeed");
	const freshThreadId = scheduledPromptBackgroundThreadId(freshRun.runId);
	assert(readBackgroundRun(freshRun.runId).target?.threadId === freshThreadId, "fresh run should land in its deterministic scheduled thread");
	const freshStatus = getPersistentAgentStatus(freshRoom);
	assert(freshStatus.unseenLandedAnswer?.threadId === freshThreadId, `a fresh-thread scheduled run's badge should survive the status read, got ${JSON.stringify(freshStatus.unseenLandedAnswer)}`);
	assert(freshStatus.unseenLandedAnswer.origin === "scheduled-run", `fresh marker should carry the scheduled-run origin, got ${JSON.stringify(freshStatus.unseenLandedAnswer)}`);
	// The scheduled answer sits in its own thread, which any other door moving
	// the room on (a bind resuming the previous conversation, a boundary opening
	// a fresh one) stops being the active one. The answer is still there to walk
	// into, so the badge has to survive that; the detached-turn flavor, whose
	// answer lives in the room's live conversation, must still self-heal away.
	const otherThreadId = "away_fresh_other_0001";
	writePersistentAgentThread(freshRoom, otherThreadId, { state: "standby", origin: "home", model: roomModel, items: [] }, {
		createRuntime: ({ instance, threadId, model }: any) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: instance.agentId, threadId, model, cwd: repoRoot }),
	});
	assert(getPersistentAgentRuntimeState(freshRoom).activeThreadId === otherThreadId, "the interfering write should have taken over the room's active thread");
	assert(getPersistentAgentStatus(freshRoom).unseenLandedAnswer?.threadId === freshThreadId, `a scheduled badge must outlive another door moving the room on, got ${JSON.stringify(getPersistentAgentStatus(freshRoom).unseenLandedAnswer)}`);
	recordPersistentAgentUnseenLandedAnswer(freshRoom, { threadId: freshThreadId, turnId: "detached-flavour-check", terminalReason: "completed" });
	assert(!getPersistentAgentStatus(freshRoom).unseenLandedAnswer, "a detached-turn marker for a thread that is no longer active must still self-heal away");
	console.log("ok: a fresh-thread scheduled run keeps its badge while the detached-turn rule stays unchanged");

	// -----------------------------------------------------------------------
	// 3. A run that never landed an answer badges nothing.
	// -----------------------------------------------------------------------
	const deferredRoom = createRoom("Away Visibility Deferred Room");
	const deferredJob = addSchedule(deferredRoom, "deferred job");
	writeJson(path.join(smokeAppDir, ".room-locks", `${deferredRoom}.json`), {
		surface: "web",
		pid: process.pid,
		connectionId: "synthetic-lock",
		host: os.hostname(),
		label: "smoke foreground",
		acquiredAt: Date.now(),
		lastSeen: Date.now(),
	});
	const deferredRun = preflight(deferredRoom, deferredJob.id, String(deferredJob.nextRunAt));
	const deferredSummary = await processOne("deferred");
	assert(deferredSummary.processed.some((item) => item.runId === deferredRun.runId && item.finalStatus === "deferred"), `a run on a busy room should defer, got ${JSON.stringify(deferredSummary.processed)}`);
	assert(!getPersistentAgentStatus(deferredRoom).unseenLandedAnswer, `a deferred run must record no marker, got ${JSON.stringify(getPersistentAgentStatus(deferredRoom).unseenLandedAnswer)}`);
	console.log("ok: a deferred scheduled run records no marker");

	// -----------------------------------------------------------------------
	// 3b. The badge only dies where the answer is actually reached.
	// -----------------------------------------------------------------------
	const survivalRoom = createRoom("Away Visibility Survival Room");
	const liveThreadId = "away_survival_live_0001";
	const scheduledThreadId = "away_survival_scheduled_0001";
	for (const threadId of [scheduledThreadId, liveThreadId]) {
		writePersistentAgentThread(survivalRoom, threadId, { state: "standby", origin: "home", model: roomModel, items: [{ kind: "user", id: `${threadId}-user`, text: "prior message" }] }, {
			createRuntime: ({ instance, threadId: createdThreadId, model }: any) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: instance.agentId, threadId: createdThreadId, model, cwd: repoRoot }),
		});
	}
	const scheduledMarker = { threadId: scheduledThreadId, turnId: "scheduled_survival", terminalReason: "completed" as const, origin: "scheduled-run" as const };
	recordPersistentAgentUnseenLandedAnswer(survivalRoom, scheduledMarker);

	// A bind that opens some other conversation never showed the answer.
	clearPersistentAgentUnseenLandedAnswerForBind(survivalRoom, liveThreadId);
	assert(getPersistentAgentUnseenLandedAnswer(survivalRoom)?.threadId === scheduledThreadId, "a bind on another conversation must leave the scheduled badge lit");
	// A live landing must not truncate a scheduled badge for another conversation.
	recordPersistentAgentUnseenLandedAnswer(survivalRoom, { threadId: liveThreadId, turnId: "detached_survival", terminalReason: "completed" });
	assert(getPersistentAgentUnseenLandedAnswer(survivalRoom)?.threadId === scheduledThreadId, "a detached-turn landing must not overwrite a still-unseen scheduled marker for another conversation");
	// A boundary on the live conversation closes that transcript, not this badge.
	const boundary = writePersistentAgentMementoBoundary(survivalRoom, liveThreadId, new Date("2026-01-01T02:00:00.000Z"), { runtimeCwd: repoRoot });
	assert(boundary.postMemento.activeThreadId !== liveThreadId, "the boundary should have moved the room onto a fresh conversation");
	assert(getPersistentAgentStatus(survivalRoom).unseenLandedAnswer?.threadId === scheduledThreadId, `a boundary on another conversation must not delete the scheduled badge, got ${JSON.stringify(getPersistentAgentStatus(survivalRoom).unseenLandedAnswer)}`);
	// A boundary DOES take the badge that points at the conversation it closes.
	const boundaryThreadId = String(boundary.postMemento.activeThreadId);
	recordPersistentAgentUnseenLandedAnswer(survivalRoom, { threadId: boundaryThreadId, turnId: "scheduled_boundary", terminalReason: "completed", origin: "scheduled-run" });
	writePersistentAgentMementoBoundary(survivalRoom, boundaryThreadId, new Date("2026-01-01T02:05:00.000Z"), { runtimeCwd: repoRoot });
	assert(!getPersistentAgentUnseenLandedAnswer(survivalRoom), "a boundary must still take the badge that points at the conversation it closes");
	// And the bind that actually opens the landed conversation clears it.
	recordPersistentAgentUnseenLandedAnswer(survivalRoom, scheduledMarker);
	clearPersistentAgentUnseenLandedAnswerForBind(survivalRoom, scheduledThreadId);
	assert(!getPersistentAgentUnseenLandedAnswer(survivalRoom), "a bind that opens the landed conversation should clear the badge");
	// Detached-turn markers keep clearing on any bind, as they always have.
	recordPersistentAgentUnseenLandedAnswer(survivalRoom, { threadId: liveThreadId, turnId: "detached_any_bind", terminalReason: "completed" });
	clearPersistentAgentUnseenLandedAnswerForBind(survivalRoom, "some_other_thread");
	assert(!getPersistentAgentUnseenLandedAnswer(survivalRoom), "a detached-turn marker must keep clearing on any bind");
	console.log("ok: a scheduled badge survives every door that did not show the answer, and dies at the one that did");

	// -----------------------------------------------------------------------
	// 4. The detached web bridge: an auto-declined confirm leaves exactly one
	//    honest note in the persisted thread.
	// -----------------------------------------------------------------------
	const detachMessage = "The user left the room while this response was being written, so interactive questions cannot be answered right now.";
	const declineRoom = createRoom("Away Visibility Decline Room");
	const declineThreadId = "away_decline_0001";
	writePersistentAgentThread(declineRoom, declineThreadId, { state: "standby", origin: "home", model: roomModel, items: [{ kind: "user", id: "decline-user", text: "do the thing" }] }, {
		createRuntime: ({ instance, threadId, model }: any) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: instance.agentId, threadId, model, cwd: repoRoot }),
	});
	const questionTitle = "Overwrite the existing report file?";
	const declineLog = createPersistentRoomAutoDeclinedQuestionLog();
	const sentFrames: any[] = [];
	const uiContext = createWebUiContext((msg) => sentFrames.push(msg), (question) => declineLog.note(question));
	const pendingConfirm = uiContext.confirm(questionTitle, "The report file already exists.");
	assert(sentFrames.some((frame) => frame?.kind === "confirm" && frame?.title === questionTitle), "the confirm should have reached the client while it was still watching");
	uiContext.detach(detachMessage);
	assert(await expectRejection(pendingConfirm, "pending confirm") === detachMessage, "the pending confirm should reject with the detach message");
	// The same dialog firing again after the detach must not stack notes.
	await expectRejection(uiContext.confirm(questionTitle, "The report file already exists."), "repeated confirm");
	await expectRejection(uiContext.select(questionTitle, ["yes", "no"]), "repeated select");
	// The note names the title only, so a second confirm carrying a different
	// message would say exactly the same thing; one note covers both.
	await expectRejection(uiContext.confirm(questionTitle, "A different explanation of the same question."), "same-title confirm with another message");
	assert(declineLog.titles().length === 1, `a repeated dialog should leave one note, got ${JSON.stringify(declineLog.titles())}`);

	const landingTurnId = "away_decline_turn";
	const notePrefix = `detached-declined-${landingTurnId}`;
	const declineThread = getPersistentAgentThread(declineRoom, declineThreadId)!;
	let landedItems: unknown[] = [...declineThread.items, { kind: "assistant", id: `detached-assistant-${landingTurnId}`, text: "I finished what I could.", streaming: false }];
	landedItems = declineLog.appendItems(landedItems, notePrefix);
	// A landing that runs twice (a retry of the same turn) must not stack notes.
	landedItems = declineLog.appendItems(landedItems, notePrefix);
	// The landing supersedes its own assistant tail and its own notes, then
	// re-appends both, so the second pass leaves the transcript in the order it
	// happened rather than stranding the note in front of the answer.
	const lastUserIndex = landedItems.map((item: any) => item?.kind).lastIndexOf("user");
	landedItems = landedItems.filter((item: any, index) => !(index > lastUserIndex && (item?.kind === "assistant" || String(item?.id ?? "").startsWith(`${notePrefix}-`))));
	landedItems.push({ kind: "assistant", id: `detached-assistant-${landingTurnId}`, text: "I finished what I could.", streaming: false });
	landedItems = declineLog.appendItems(landedItems, notePrefix);
	const landedKinds = landedItems.slice(lastUserIndex).map((item: any) => item?.kind);
	assert(JSON.stringify(landedKinds) === JSON.stringify(["user", "assistant", "system"]), `a re-landed turn should read user then answer then note, got ${JSON.stringify(landedKinds)}`);
	writePersistentAgentThread(declineRoom, declineThreadId, { state: "standby", origin: declineThread.origin, model: declineThread.model, items: landedItems });
	const persistedDeclineThread = getPersistentAgentThread(declineRoom, declineThreadId)!;
	const declineNotes = persistedDeclineThread.items.filter((item: any) => item?.kind === "system" && String(item?.text ?? "").includes("answered with a safe default"));
	assert(declineNotes.length === 1, `the detached landing should persist exactly one decline note, got ${JSON.stringify(declineNotes)}`);
	assert((declineNotes[0] as any).level === "info", `the decline note should read as info, got ${JSON.stringify(declineNotes[0])}`);
	assert((declineNotes[0] as any).text === `While you were away, a question came up and was answered with a safe default: ${questionTitle}`, `the decline note should name the question plainly, got ${JSON.stringify(declineNotes[0])}`);
	assert(!String((declineNotes[0] as any).text).includes("—"), "user-facing notes must not use em-dashes");
	console.log("ok: an auto-declined confirm in a detached turn leaves exactly one honest note in the persisted thread");

	// -----------------------------------------------------------------------
	// 5. The headless background context tells the same story.
	// -----------------------------------------------------------------------
	const headlessRunId = "run_away_headless";
	const headlessLog = createPersistentRoomAutoDeclinedQuestionLog();
	const headlessContext = createHeadlessUiContext(undefined, (question) => headlessLog.note(question));
	const headlessTitle = "Send the summary by email?";
	const headlessRejection = await expectRejection((headlessContext as any).confirm(headlessTitle, "The recipient list is not empty."), "headless confirm");
	assert(headlessRejection.includes("cannot answer interactive UI requests"), `the headless confirm should still fail the asking tool, got ${headlessRejection}`);
	await expectRejection((headlessContext as any).confirm(headlessTitle, "The recipient list is not empty."), "repeated headless confirm");
	await expectRejection((headlessContext as any).input("Which folder should the summary go to?", "folder"), "headless input");
	assert(headlessLog.titles().length === 2, `two distinct headless questions should leave two notes, got ${JSON.stringify(headlessLog.titles())}`);
	// Titles long enough to be truncated must not leave a pair of notes that
	// read as the same sentence twice.
	const longTitle = `Approve the export of ${"a".repeat(220)}`;
	await expectRejection((headlessContext as any).confirm(`${longTitle} to the shared drive?`, "first variant"), "long headless confirm");
	await expectRejection((headlessContext as any).confirm(`${longTitle} to the archive?`, "second variant"), "long headless confirm twin");
	assert(headlessLog.titles().length === 3, `two titles that read alike after truncation should leave one note, got ${JSON.stringify(headlessLog.titles().length)}`);

	const headlessThreadId = "away_headless_0001";
	writePersistentAgentThread(freshRoom, headlessThreadId, { state: "standby", origin: "home", model: roomModel, items: [{ kind: "user", id: "headless-user", text: promptText }] }, {
		createRuntime: ({ instance, threadId, model }: any) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: instance.agentId, threadId, model, cwd: repoRoot }),
	});
	const headlessThread = getPersistentAgentThread(freshRoom, headlessThreadId)!;
	writePersistentAgentThread(freshRoom, headlessThreadId, {
		state: "standby",
		origin: headlessThread.origin,
		model: headlessThread.model,
		items: headlessLog.appendItems([...headlessThread.items, { kind: "assistant", id: scheduledPromptBackgroundAssistantItemId(headlessRunId), text: "Summary written.", streaming: false }], scheduledPromptBackgroundDeclinedQuestionItemIdPrefix(headlessRunId)),
	});
	const persistedHeadlessThread = getPersistentAgentThread(freshRoom, headlessThreadId)!;
	const headlessNotes = persistedHeadlessThread.items.filter((item: any) => item?.kind === "system" && String(item?.text ?? "").includes("answered with a safe default"));
	assert(headlessNotes.length === 3, `the headless run should persist one note per distinct question, got ${JSON.stringify(headlessNotes)}`);
	assert((headlessNotes[0] as any).text.endsWith(headlessTitle), `the first headless note should name its question, got ${JSON.stringify(headlessNotes[0])}`);
	assert(headlessNotes.every((item: any) => item.level === "info" && String(item.id).startsWith(scheduledPromptBackgroundDeclinedQuestionItemIdPrefix(headlessRunId))), `headless notes should be info items under the run's id prefix, got ${JSON.stringify(headlessNotes)}`);
	console.log("ok: the headless background context produces the same honest note");

	console.log("persistent-room away visibility smoke passed");
} catch (error) {
	console.error(`persistent-room away visibility smoke failed: ${(error as Error)?.stack ?? error}`);
	process.exitCode = 1;
} finally {
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
