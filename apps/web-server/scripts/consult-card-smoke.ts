// Smoke for the consult (DelegationCard) client state machine
// (apps/web-ui/src/consult-stream.ts, Consult MR-4 spec §3/§4.2).
//
// Covers: the happy path (request→started→deltas→end) with text accumulation
// and provenance capture; the stale-consultId discipline (events dropped before
// start, mid-stream with a wrong id, and after dismiss); the abort path
// (abort_requested → error lands in `stopped`, partial text kept); the plain
// failed path; the minimize/open/dismiss transitions; and the one-consult-at-a-
// time rejection of a second request while one is active. Effects are asserted
// too (the WS frames the host must send, and the rejected log).
//
// Run: npm run smokes -- consult-card   (or tsx this file)

import {
	abbreviateFingerprint,
	canFollowUp,
	canTransferConsult,
	consultHasDrift,
	consultStack,
	createConsultState,
	isConsultActive,
	reduceConsult,
	type ConsultAction,
	type ConsultEffect,
	type ConsultState,
} from "../../web-ui/src/consult-stream.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const FINGERPRINT = { algorithm: "sha256", value: "ab12cd34ef56aa77bb88cc99dd00ee11ff22334455667788990011223344" + "9f4e" };
const MODEL = { provider: "anthropic", model: "claude-x", label: "Claude X" };

// Drive a sequence of actions from a starting state, collecting every effect.
function run(start: ConsultState, actions: ConsultAction[]): { state: ConsultState; effects: ConsultEffect[] } {
	let state = start;
	const effects: ConsultEffect[] = [];
	for (const action of actions) {
		const result = reduceConsult(state, action);
		state = result.state;
		effects.push(...result.effects);
	}
	return { state, effects };
}

const request: ConsultAction = {
	type: "request",
	consultId: "local_abc",
	targetRoomId: "euler",
	question: "What did we decide about the pricing model?",
	requestedAt: "2026-07-11T09:00:00Z",
	targetDisplayName: "euler",
	asOfCheckpointAt: "2026-07-08T14:32:00Z",
};

try {
	// ---- initial state ---------------------------------------------------
	const initial = createConsultState();
	assert(initial.phase === "none", "initial phase is none");
	assert(!isConsultActive(initial), "initial state is not active");

	// ---- happy path: request → started → deltas → end --------------------
	const afterRequest = reduceConsult(initial, request);
	assert(afterRequest.state.phase === "streaming", "request opens the card expanded (streaming)");
	assert(afterRequest.state.consultId === "local_abc", "consultId captured");
	assert(afterRequest.state.question === request.question, "question captured for the card + MR-5 transfer");
	assert(afterRequest.state.targetDisplayName === "euler", "display name captured at request");
	assert(afterRequest.state.asOfCheckpointAt === "2026-07-08T14:32:00Z", "as-of checkpoint captured at request");
	assert(afterRequest.state.requestedAt === "2026-07-11T09:00:00Z", "request time captured for the handoff block's Requested-on line");
	assert(!afterRequest.state.minimized, "expanded-on-send: not minimized");
	assert(isConsultActive(afterRequest.state), "streaming consult is active");
	const sendEffect = afterRequest.effects.find((e) => e.kind === "send_consult");
	assert(sendEffect && sendEffect.kind === "send_consult" && sendEffect.consultId === "local_abc" && sendEffect.targetRoomId === "euler" && sendEffect.question === request.question, "request emits the send_consult frame");

	const happy = run(afterRequest.state, [
		{ type: "started", consultId: "local_abc", targetRoomId: "euler", targetDisplayName: "euler", model: MODEL },
		{ type: "delta", consultId: "local_abc", delta: "Two models" },
		{ type: "delta", consultId: "local_abc", delta: ", priced differently." },
		{ type: "end", consultId: "local_abc", text: "Two models, priced differently — final.", l1bFingerprint: FINGERPRINT, generatedAt: "2026-07-10T14:32:00Z", warnings: [] },
	]);
	assert(happy.state.model?.model === "claude-x", "started captures the worker model");
	assert(happy.state.phase === "done", "end moves to done");
	// deltas accumulated during streaming, but end.text is authoritative.
	assert(happy.state.text === "Two models, priced differently — final.", "end.text is authoritative (replaces accumulated deltas)");
	assert(happy.state.l1bFingerprint?.value === FINGERPRINT.value, "provenance fingerprint captured");
	assert(happy.state.generatedAt === "2026-07-10T14:32:00Z", "generatedAt captured");
	assert(happy.effects.every((e) => e.kind !== "dropped"), "no in-band events dropped on the happy path");

	// mid-stream text accumulation is observable before end:
	const midStream = run(afterRequest.state, [
		{ type: "delta", consultId: "local_abc", delta: "abc" },
		{ type: "delta", consultId: "local_abc", delta: "def" },
	]);
	assert(midStream.state.text === "abcdef" && midStream.state.phase === "streaming", "deltas accumulate into the live view");

	// fingerprint abbreviation for the footer meta
	assert(abbreviateFingerprint(FINGERPRINT) === "sha256:ab12…9f4e", `fingerprint abbreviates to sha256:ab12…9f4e; got ${abbreviateFingerprint(FINGERPRINT)}`);
	assert(abbreviateFingerprint(null) === null, "no fingerprint → null");

	// ---- stale-id discipline ---------------------------------------------
	// before start: an event with no active consult is dropped
	const beforeStart = reduceConsult(initial, { type: "delta", consultId: "ghost", delta: "x" });
	assert(beforeStart.state.phase === "none" && beforeStart.state.text === "", "event before any request is dropped");
	assert(beforeStart.effects.some((e) => e.kind === "dropped"), "stale-before-start emits a dropped effect");

	// mid-stream: a wrong consultId is dropped, the live one is untouched
	const midStale = run(afterRequest.state, [
		{ type: "delta", consultId: "local_abc", delta: "keep" },
		{ type: "delta", consultId: "OTHER", delta: "DROP" },
		{ type: "end", consultId: "OTHER", text: "DROP", l1bFingerprint: FINGERPRINT, generatedAt: "x", warnings: [] },
	]);
	assert(midStale.state.text === "keep" && midStale.state.phase === "streaming", "mid-stream stale delta + end are dropped");
	assert(midStale.effects.filter((e) => e.kind === "dropped").length === 2, "two stale events dropped mid-stream");

	// after dismiss: the just-ended consult's events no longer apply
	const afterDismiss = run(happy.state, [
		{ type: "dismiss" },
		{ type: "delta", consultId: "local_abc", delta: "late" },
		{ type: "end", consultId: "local_abc", text: "late", l1bFingerprint: FINGERPRINT, generatedAt: "x", warnings: [] },
	]);
	assert(afterDismiss.state.phase === "none" && afterDismiss.state.consultId === null, "dismiss returns to none");
	assert(!afterDismiss.state.text, "post-dismiss events do not resurrect text");
	assert(afterDismiss.effects.filter((e) => e.kind === "dropped").length === 2, "post-dismiss events are dropped");

	// ---- abort path: abort_requested → error = stopped, partial kept -----
	const stopped = run(afterRequest.state, [
		{ type: "delta", consultId: "local_abc", delta: "partial answer so far" },
		{ type: "abort_requested" },
		{ type: "error", consultId: "local_abc", message: "Consult stopped by you." },
	]);
	assert(stopped.state.phase === "stopped", "user abort lands the error in stopped");
	assert(stopped.state.text === "partial answer so far", "stopped keeps the partial text");
	assert(stopped.state.errorMessage === "Consult stopped by you.", "stopped subline is the server message");
	const abortEffect = stopped.effects.find((e) => e.kind === "send_abort");
	assert(abortEffect && abortEffect.kind === "send_abort" && abortEffect.consultId === "local_abc", "abort_requested emits send_abort with the live id");
	assert(isConsultActive(stopped.state), "a stopped (undismissed) consult is still active");

	// abort_requested while not streaming is a no-op (no frame)
	const noAbort = reduceConsult(happy.state, { type: "abort_requested" });
	assert(noAbort.effects.length === 0 && noAbort.state.phase === "done", "abort_requested after done is a no-op");

	// ---- failed path: error without a user abort → failed ----------------
	const failed = run(afterRequest.state, [
		{ type: "delta", consultId: "local_abc", delta: "half" },
		{ type: "error", consultId: "local_abc", message: "The consulted room ran out of context." },
	]);
	assert(failed.state.phase === "failed", "error without abort → failed");
	assert(failed.state.text === "half", "failed keeps the partial text greyed");
	assert(failed.state.errorMessage === "The consulted room ran out of context.", "failed subline names it plainly");

	// ---- minimize / open / dismiss ---------------------------------------
	const minimized = reduceConsult(afterRequest.state, { type: "minimize" });
	assert(minimized.state.minimized && minimized.state.phase === "streaming", "minimize folds to the pill, consult keeps running");
	const reopened = reduceConsult(minimized.state, { type: "open" });
	assert(!reopened.state.minimized, "open re-expands the card");
	// minimize survives a phase change (streaming → done while folded)
	const foldedThenDone = run(minimized.state, [{ type: "end", consultId: "local_abc", text: "done text", l1bFingerprint: FINGERPRINT, generatedAt: "g", warnings: [] }]);
	assert(foldedThenDone.state.minimized && foldedThenDone.state.phase === "done", "a folded consult reaching done stays folded (ready pill)");
	// minimize is a no-op with no consult
	assert(reduceConsult(initial, { type: "minimize" }).state.phase === "none", "minimize with no consult is a no-op");

	// dismiss from any state clears everything
	assert(reduceConsult(stopped.state, { type: "dismiss" }).state.phase === "none", "dismiss from stopped clears the card");
	assert(reduceConsult(failed.state, { type: "dismiss" }).state.phase === "none", "dismiss from failed clears the card");

	// ---- warnings capture (needs_absorb lag) -----------------------------
	const warned = run(afterRequest.state, [
		{ type: "end", consultId: "local_abc", text: "answer", l1bFingerprint: FINGERPRINT, generatedAt: "g", warnings: ["Recent context is awaiting Learn — the answer may lag."] },
	]);
	assert(warned.state.warnings.length === 1, "end warnings captured for the card notice");

	// ---- one consult at a time: second request rejected ------------------
	const second = reduceConsult(afterRequest.state, { ...request, consultId: "local_xyz", targetRoomId: "eugene" });
	assert(second.state.consultId === "local_abc", "a second request while active keeps the current consult");
	assert(second.effects.length === 1 && second.effects[0].kind === "rejected", "a second request is rejected (no send_consult)");
	// also rejected while a done card is undismissed
	const secondWhileDone = reduceConsult(happy.state, { ...request, consultId: "local_xyz" });
	assert(secondWhileDone.effects.some((e) => e.kind === "rejected"), "second request rejected while an undismissed done card is up");
	// after dismiss, a new request is accepted
	const freshAfterDismiss = run(happy.state, [{ type: "dismiss" }, { ...request, consultId: "local_new" }]);
	assert(freshAfterDismiss.state.consultId === "local_new" && freshAfterDismiss.state.phase === "streaming", "a new consult starts after dismiss");
	assert(freshAfterDismiss.effects.some((e) => e.kind === "send_consult"), "the fresh consult emits send_consult");

	// ---- STACKED CONSULT (§8) --------------------------------------------
	const FINGERPRINT_2 = { algorithm: "sha256", value: "1122334455667788990011223344556677889900112233445566778899aabb" };

	// followUp is legal only from `done`: from streaming it is rejected, stack untouched.
	const followUpFromStreaming = reduceConsult(afterRequest.state, { type: "followUp", consultId: "local_f1", question: "and what about renewals?", requestedAt: "2026-07-11T09:10:00Z" });
	assert(followUpFromStreaming.state.phase === "streaming" && followUpFromStreaming.state.consultId === "local_abc", "followUp from streaming is rejected (still exchange 1)");
	assert(followUpFromStreaming.effects.some((e) => e.kind === "rejected"), "followUp from streaming emits a rejected effect (no send_consult)");

	// followUp from done: the completed answer becomes exchange 1, re-enters streaming
	// with a fresh id, and the send_consult carries the prior exchange (§8.1).
	const followed = reduceConsult(happy.state, { type: "followUp", consultId: "local_f2", question: "and what about renewals?", requestedAt: "2026-07-11T09:10:00Z", asOfCheckpointAt: "2026-07-09T00:00:00Z" });
	assert(followed.state.phase === "streaming", "followUp from done re-enters streaming");
	assert(followed.state.consultId === "local_f2", "followUp adopts the fresh consultId");
	assert(followed.state.exchanges.length === 1 && followed.state.exchanges[0].answer === "Two models, priced differently — final.", "the completed answer is pushed onto the stack");
	assert(followed.state.question === "and what about renewals?" && followed.state.text === "", "the current fields reset to the new question");
	assert(canFollowUp(happy.state), "a done consult offers follow-up");
	const followSend = followed.effects.find((e) => e.kind === "send_consult");
	assert(followSend && followSend.kind === "send_consult" && followSend.priorExchanges?.length === 1 && followSend.priorExchanges[0].answerMarkdown === "Two models, priced differently — final.", "send_consult carries the prior exchange (question + answerMarkdown)");

	// second exchange completes → the stack (via consultStack) holds both, latest current.
	const secondDone = run(followed.state, [
		{ type: "started", consultId: "local_f2", targetRoomId: "euler", targetDisplayName: "euler", model: MODEL },
		{ type: "end", consultId: "local_f2", text: "Renewals auto-roll at the same rate.", l1bFingerprint: FINGERPRINT_2, generatedAt: "2026-07-11T09:11:00Z", warnings: [] },
	]);
	assert(secondDone.state.phase === "done" && secondDone.state.exchanges.length === 1, "after the follow-up ends, one prior exchange remains stacked");
	const stack = consultStack(secondDone.state);
	assert(stack.length === 2 && stack[0].answer.includes("Two models") && stack[1].answer.includes("Renewals auto-roll"), "consultStack returns both exchanges, current last");

	// ---- DRIFT (§8.5): differing fingerprints across the stack ------------
	assert(consultHasDrift(secondDone.state), "differing per-exchange fingerprints flag drift");
	const noDriftState = run(reduceConsult(happy.state, { type: "followUp", consultId: "local_f3", question: "q2", requestedAt: "t" }).state, [
		{ type: "end", consultId: "local_f3", text: "same-memory answer", l1bFingerprint: FINGERPRINT, generatedAt: "g", warnings: [] },
	]);
	assert(!consultHasDrift(noDriftState.state), "identical fingerprints across the stack → no drift");

	// ---- FAILED FOLLOW-UP PRESERVES THE STACK (§8.1) ---------------------
	const failedFollowUp = run(followed.state, [
		{ type: "started", consultId: "local_f2", targetRoomId: "euler", targetDisplayName: "euler", model: MODEL },
		{ type: "error", consultId: "local_f2", message: "The consulted room ran out of context." },
	]);
	assert(failedFollowUp.state.phase === "failed", "a failed follow-up lands in failed");
	assert(failedFollowUp.state.exchanges.length === 1, "a failed follow-up PRESERVES the prior stack");
	assert(canTransferConsult(failedFollowUp.state), "a failed follow-up still offers Transfer (completed exchanges)");
	assert(canFollowUp(failedFollowUp.state), "a failed follow-up re-enables the follow-up input (retry)");
	// retry after a failed follow-up: the incomplete exchange is discarded, stack preserved.
	const retried = reduceConsult(failedFollowUp.state, { type: "followUp", consultId: "local_f4", question: "retry", requestedAt: "t2" });
	assert(retried.state.phase === "streaming" && retried.state.exchanges.length === 1, "retry keeps the one completed exchange (does not stack the failed one)");
	const retrySend = retried.effects.find((e) => e.kind === "send_consult");
	assert(retrySend && retrySend.kind === "send_consult" && retrySend.priorExchanges?.length === 1, "retry re-feeds the preserved stack");

	// exchange 1 failing (empty stack) is today's dismiss-only footer, no follow-up.
	const exchange1Failed = run(afterRequest.state, [{ type: "error", consultId: "local_abc", message: "boom" }]);
	assert(exchange1Failed.state.exchanges.length === 0, "exchange 1 failing leaves an empty stack");
	assert(!canTransferConsult(exchange1Failed.state) && !canFollowUp(exchange1Failed.state), "exchange 1 failing keeps the dismiss-only footer (no transfer, no follow-up)");

	// ---- OVERFLOW (§8.6): a coded error disables follow-up, keeps Transfer -
	const overflowed = run(followed.state, [
		{ type: "started", consultId: "local_f2", targetRoomId: "euler", targetDisplayName: "euler", model: MODEL },
		{ type: "error", consultId: "local_f2", message: "no longer fits", code: "prompt_overflow" },
	]);
	assert(overflowed.state.overflow === true, "an overflow-coded error sets the overflow flag");
	assert(!canFollowUp(overflowed.state), "overflow disables the follow-up input");
	assert(canTransferConsult(overflowed.state), "overflow still offers Transfer");
	assert(failedFollowUp.state.overflow === false, "a plain failure does not set the overflow flag");
	// followUp is rejected while overflowed.
	const blockedByOverflow = reduceConsult(overflowed.state, { type: "followUp", consultId: "local_f5", question: "x", requestedAt: "t" });
	assert(blockedByOverflow.state.consultId === "local_f2" && blockedByOverflow.effects.some((e) => e.kind === "rejected"), "followUp is rejected while overflowed");

	// ---- reset (teardown) ------------------------------------------------
	assert(reduceConsult(happy.state, { type: "reset" }).state.phase === "none", "reset forgets everything (socket teardown)");
	assert(createConsultState().exchanges.length === 0 && createConsultState().overflow === false, "fresh state starts with an empty stack and no overflow");

	console.log("consult card reducer smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
}
