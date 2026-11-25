/**
 * Every stop of a turn is bounded. A model call, a tool or a connector that
 * ignores the stop would otherwise hold its turn "stopping" without end, and
 * with it the room's Remember, Forget, model and conversation switches.
 *
 * A turn races what it waits for against its limit, which starts with the
 * first stop. At the limit the race throws `TurnEndForced`, so the turn runs
 * the same end as any other, once; what it waited for is cut loose
 * (`endCutSession`, room-session-end.ts) and its late end is nobody's.
 */

/** The most a stopped turn takes to end: the time Forget and a conversation's end give. */
export const STOP_LIMIT_MS = 5_000;

export class TurnEndForced extends Error {
	constructor() {
		super("The stopped turn did not end in time.");
	}
}

export interface StopLimit {
	/** A stop began. Only the first starts the limit; none does after the turn's end. */
	stopBegan(): void;
	/** What the turn waits for, or `TurnEndForced` once the limit passed. */
	race<T>(work: Promise<T>): Promise<T>;
	/** The turn's end, forced or not. */
	turnEnded(): void;
	/** Resolves at the turn's end. */
	readonly ended: Promise<void>;
}

export function createStopLimit(): StopLimit {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let over = false;
	let force = () => {};
	let end = () => {};
	const forced = new Promise<never>((_, reject) => { force = () => reject(new TurnEndForced()); });
	// A limit nothing waits on is no unhandled rejection.
	forced.catch(() => {});
	const ended = new Promise<void>((resolve) => { end = resolve; });
	return {
		stopBegan() {
			if (over || timer) return;
			timer = setTimeout(force, STOP_LIMIT_MS);
		},
		race: (work) => Promise.race([work, forced]),
		turnEnded() {
			over = true;
			clearTimeout(timer);
			end();
		},
		ended,
	};
}
