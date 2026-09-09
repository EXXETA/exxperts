export {};

// F1: a worker turn that ended in the session's own error must surface that
// error, never "produced no text". The decision is the ONE pure function the
// runtime calls after the turn; this smoke imports it rather than copying it.

const { isolatedPersistentAgentWorkerFailure, IsolatedPersistentAgentWorkerTurnError } = await import("../src/persistent-agent-worker-runtime.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const workerLabel = "structural review worker";
const emptyTextError = "structural review proposal worker produced no text";
const providerText = '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}';

// 1. Error stop with no text: the provider's text is the story, and it is typed.
const authFailure = isolatedPersistentAgentWorkerFailure({ workerLabel, text: "", stopReason: "error", errorMessage: providerText, emptyTextError });
assert(authFailure instanceof IsolatedPersistentAgentWorkerTurnError, "an error stop must produce the typed turn error");
assert(authFailure.stopReason === "error", "turn error carries its stop reason");
assert(authFailure.providerMessage === providerText, "turn error carries the provider text verbatim");
assert(authFailure.message === `${workerLabel} failed: ${providerText}`, `turn error message names the worker and the provider text, got: ${authFailure.message}`);
assert(!/produced no text/i.test(authFailure.message), "an error stop must never read as an empty reply");

// 2. Error stop WITH partial text: still a failure — partial text before a provider error is not a draft.
const partial = isolatedPersistentAgentWorkerFailure({ workerLabel, text: "## Prune memory proposal\n\n### Mode\nSTC_DIAGNOSTIC", stopReason: "error", errorMessage: "stream reset by peer", emptyTextError });
assert(partial instanceof IsolatedPersistentAgentWorkerTurnError, "partial text with an error stop is still a failure");
assert(/stream reset by peer/.test(partial.message), "partial-text failure keeps the provider text");

// 3. Error stop without any message: named as such, not as an empty reply.
const bare = isolatedPersistentAgentWorkerFailure({ workerLabel, text: "", stopReason: "error", errorMessage: undefined, emptyTextError });
assert(bare instanceof IsolatedPersistentAgentWorkerTurnError && /without a message/.test(bare.message), "an error stop without text is named as an error, not an empty reply");
assert(bare.providerMessage === undefined, "blank provider text is not carried as an empty string");

// 4. Aborted: its own story, provider text appended only when present.
const aborted = isolatedPersistentAgentWorkerFailure({ workerLabel, text: "", stopReason: "aborted", errorMessage: "  ", emptyTextError });
assert(aborted instanceof IsolatedPersistentAgentWorkerTurnError && aborted.stopReason === "aborted", "an aborted stop produces the typed error with stopReason aborted");
assert(aborted.message === `${workerLabel} was aborted before it answered`, `aborted message without detail, got: ${aborted.message}`);

// 5. Normal stop with nothing to show: the empty-reply story is now true, and it stays the caller's exact string.
const empty = isolatedPersistentAgentWorkerFailure({ workerLabel, text: "   \n", stopReason: "stop", emptyTextError, errorMessage: undefined });
assert(empty instanceof Error && !(empty instanceof IsolatedPersistentAgentWorkerTurnError), "a normal empty turn is a plain error");
assert(empty.message === emptyTextError, "empty-reply error keeps the caller's exact string");

// 6. Normal stop with text, and a length stop: no failure — truncation is the caller's refusal, not this function's.
assert(isolatedPersistentAgentWorkerFailure({ workerLabel, text: "ok", stopReason: "stop", errorMessage: undefined, emptyTextError }) === undefined, "a normal answer is not a failure");
assert(isolatedPersistentAgentWorkerFailure({ workerLabel, text: "cut", stopReason: "length", errorMessage: undefined, emptyTextError }) === undefined, "a length stop with text is left to the truncation refusal");
// A stale errorMessage on a normal stop is not a failure either: the stop reason decides.
assert(isolatedPersistentAgentWorkerFailure({ workerLabel, text: "ok", stopReason: "stop", errorMessage: "retried once", emptyTextError }) === undefined, "an errorMessage alongside a normal stop does not fail the turn");

console.log("lifecycle-worker-error-surfacing smoke passed");
