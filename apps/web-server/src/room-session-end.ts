/**
 * Every room conversation ends here: its extensions are told it ended, as the
 * runtime's own teardown tells them (agent-session-runtime.ts), so the
 * connector adapter closes the conversation's connections and their programs
 * exit; then the session is disposed. `dispose()` alone tells no extension, so
 * a conversation's programs ran on until the adapter's idle close.
 */
import type { AgentSession } from "@exxeta/exxperts-runtime";

/**
 * The most an end waits for its extensions. A program's close is its input
 * closed, then the library's own two steps of 2 s each before it kills it, and
 * a connector start still under way is waited for first (patch 26 in
 * scripts/patch-mcp-adapter.mjs), so a stuck program or a slow start never
 * holds an end longer than this; the close goes on after.
 */
const SESSION_END_WAIT_MS = 5_000;

/**
 * Each conversation's end still under way, by its session id. A session opened on that conversation meanwhile shares
 * what the model's provider keeps under the id, which the end's dispose closes, so it asks the model after the end.
 */
const endsUnderWay = new Map<string, Promise<void>>();

/** Every end of an earlier session with this id still under way, as one wait. */
export function endUnderWay(sessionId: string | undefined): Promise<void> | undefined {
	return sessionId ? endsUnderWay.get(sessionId) : undefined;
}

/** Tells the session's extensions it ended, waits for them up to the limit, then disposes it. Never throws. */
export async function endRoomSession(session: AgentSession | null | undefined): Promise<void> {
	if (!session) return;
	let sessionId: string | undefined;
	try { sessionId = session.sessionId; } catch {}
	const ending = endSession(session);
	if (!sessionId) return ending;
	// A quicker later end of the same conversation doesn't stand for a slower earlier one: the record waits for both.
	const earlier = endsUnderWay.get(sessionId);
	const all = earlier ? Promise.all([earlier, ending]).then(() => undefined) : ending;
	endsUnderWay.set(sessionId, all);
	void all.then(() => { if (endsUnderWay.get(sessionId) === all) endsUnderWay.delete(sessionId); });
	return ending;
}

/**
 * Ends a conversation whose turn was ended by force (turn-forced-end.ts): at once, with nothing waited for, since what
 * would not stop may never end. From here nothing of it reaches the conversation, and a model call it starts late is
 * cancelled. `late` hears what still comes: an answer (its usage was spent) and the end of a run.
 */
export function endCutSession(session: AgentSession, late: { answered(message: unknown): void; ended(): void }): void {
	session.agent.subscribe((event) => {
		if (event.type === "agent_start") session.agent.abort();
		else if (event.type === "message_end" && event.message.role === "assistant") late.answered(event.message);
		else if (event.type === "agent_end") late.ended();
	});
	try { session.abortCompaction(); } catch {}
	try {
		const runner = session.extensionRunner;
		if (runner?.hasHandlers("session_shutdown")) void runner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
	} catch {
		// A session whose extensions were never bound has nothing to tell.
	}
	try {
		session.dispose();
	} catch {
		// dispose is best-effort cleanup
	}
}

async function endSession(session: AgentSession): Promise<void> {
	try {
		const runner = session.extensionRunner;
		if (runner?.hasHandlers("session_shutdown")) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				runner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {}),
				new Promise<void>((resolve) => { timer = setTimeout(resolve, SESSION_END_WAIT_MS); }),
			]);
			clearTimeout(timer);
		}
	} catch {
		// A session whose extensions were never bound has nothing to tell.
	}
	try {
		session.dispose();
	} catch {
		// dispose is best-effort cleanup
	}
}
