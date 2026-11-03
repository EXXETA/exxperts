// Smoke for the web-ui connection health reducer
// (apps/web-ui/src/connection-health.ts).
//
// Each scenario is a script of things that happen to a socket, replayed
// through the host that ships. Every scenario here is one where an older
// host was wrong, either by announcing trouble that did not exist or by
// staying silent through trouble that did:
//
//   * A socket wedged in CONNECTING must still fail, through the connect
//     deadline, and so warn.
//   * Reaching OPEN is not recovery: a server that accepts and drops in the
//     same breath must not restart the grace window on every cycle.
//   * A deliberate swap is not recovery either: clicking between rooms
//     against a dead server must not postpone the warning.
//
// Every warning time below is pinned to a literal, not recomputed from the
// constants, so shortening a grace window fails the smoke instead of silently
// moving the goalposts with it.
//
// Run: npm run smokes -- connection-health   (or tsx this file)

import {
	appendErrorLineOnce,
	CONNECT_DEADLINE_MS,
	createConnectionHealthState,
	msUntilWarn,
	OPEN_DWELL_MS,
	reduceConnectionHealth,
	type ConnectionHealthState,
} from "../../web-ui/src/connection-health.js";

type SocketEvent =
	/** The socket reached OPEN. */
	| "opened"
	/** A frame arrived on an open socket. */
	| "frame"
	/** The socket closed unexpectedly, or the connect attempt was refused. */
	| "closed"
	/** We closed it ourselves to build its replacement. */
	| "swapped"
	/** The socket hung in CONNECTING and will never produce an event itself. */
	| "wedged";

interface Step { at: number; event: SocketEvent }

interface Scenario {
	name: string;
	/** What the user is doing, for the failure message. */
	story: string;
	steps: Step[];
	untilMs: number;
	/** Exact ms at which the shipped host must first warn, or null for never. */
	expectWarnAt: number | null;
	/** Whether the shipped host must be quiet again at the end. */
	expectQuietAtEnd: boolean;
}

const TICK_MS = 250;

interface Replay {
	warnMs: number;
	warnAtEnd: boolean;
	firstWarnAt: number | null;
	/** How many failed attempts the host ever registered. */
	attempts: number;
}

/**
 * Replays a socket script through the shipped host: it arms a connect deadline
 * for a wedged socket, and only settles a run once an open connection has
 * carried a frame or outlasted the dwell.
 */
function replay(scenario: Scenario): Replay {
	const reduce = (s: ConnectionHealthState, a: { type: string; now: number }) => reduceConnectionHealth(s, a as any);
	let state: ConnectionHealthState = createConnectionHealthState();
	let open = false;
	let warnMs = 0;
	let attempts = 0;
	let firstWarnAt: number | null = null;
	// Host-side timers, modelled exactly as App.tsx arms them.
	let dwellDueAt: number | null = null;
	let deadlineDueAt: number | null = null;
	const steps = [...scenario.steps].sort((a, b) => a.at - b.at);
	let next = 0;

	const fail = (now: number) => { attempts += 1; state = reduce(state, { type: "attempt_failed", now }); };

	for (let now = 0; now <= scenario.untilMs; now += TICK_MS) {
		while (next < steps.length && steps[next].at <= now) {
			const step = steps[next];
			next += 1;
			switch (step.event) {
				case "opened":
					deadlineDueAt = null;
					open = true;
					state = reduce(state, { type: "opened", now });
					dwellDueAt = now + OPEN_DWELL_MS;
					break;
				case "frame":
					dwellDueAt = null;
					state = reduce(state, { type: "settled", now });
					break;
				case "closed":
					dwellDueAt = null;
					deadlineDueAt = null;
					open = false;
					fail(now);
					break;
				case "swapped":
					dwellDueAt = null;
					deadlineDueAt = null;
					open = false;
					state = reduce(state, { type: "swapped", now });
					break;
				case "wedged":
					// Stuck mid-handshake: only the deadline will ever hear from
					// this socket again.
					open = false;
					deadlineDueAt = now + CONNECT_DEADLINE_MS;
					break;
			}
		}
		if (deadlineDueAt !== null && now >= deadlineDueAt) {
			deadlineDueAt = null;
			fail(now);
		}
		if (dwellDueAt !== null && now >= dwellDueAt) {
			dwellDueAt = null;
			if (open) state = reduce(state, { type: "settled", now });
		}
		state = reduce(state, { type: "tick", now });
		if (state.warn) {
			warnMs += TICK_MS;
			if (firstWarnAt === null) firstWarnAt = now;
		}
	}
	return { warnMs, warnAtEnd: state.warn, firstWarnAt, attempts };
}

/** A connection that comes up and proves itself, the ordinary healthy case. */
function healthyOpen(at: number): Step[] {
	return [{ at, event: "opened" }, { at: at + 250, event: "frame" }];
}

/** A retry ladder that keeps failing. */
function failingRetries(from: number, count: number, everyMs = 2_000): Step[] {
	return Array.from({ length: count }, (_, i) => ({ at: from + i * everyMs, event: "closed" as const }));
}

const scenarios: Scenario[] = [
	// ── Silence where the old corner shouted ────────────────────────────────
	{
		name: "boot: the engine takes eight seconds to accept a socket",
		story: "The page is up before the engine accepts sockets. The corner read trouble for the whole stretch.",
		steps: [...failingRetries(0, 4, 2_000), ...healthyOpen(8_000)],
		untilMs: 20_000,
		expectWarnAt: null,
		expectQuietAtEnd: true,
	},
	{
		name: "boot: a slow engine still gets the long first-connect grace",
		story: "Slower than the ordinary grace window. The first-connect grace has to cover it, or boot itself is a warning.",
		steps: [...failingRetries(0, 8, 2_000), ...healthyOpen(16_000)],
		untilMs: 30_000,
		expectWarnAt: null,
		expectQuietAtEnd: true,
	},
	{
		name: "entering a room: the home socket is swapped for the room socket",
		story: "One socket closes and the next opens. The closing socket used to flip the corner for the gap.",
		steps: [...healthyOpen(0), { at: 5_000, event: "swapped" }, ...healthyOpen(5_400)],
		untilMs: 20_000,
		expectWarnAt: null,
		expectQuietAtEnd: true,
	},
	{
		name: "leaving a room and going back in, twice in a row",
		story: "Ordinary navigation. Four swaps, four old-rule flashes, nothing wrong.",
		steps: [
			...healthyOpen(0),
			{ at: 3_000, event: "swapped" }, ...healthyOpen(3_300),
			{ at: 6_000, event: "swapped" }, ...healthyOpen(6_400),
			{ at: 9_000, event: "swapped" }, ...healthyOpen(9_200),
			{ at: 12_000, event: "swapped" }, ...healthyOpen(12_500),
		],
		untilMs: 30_000,
		expectWarnAt: null,
		expectQuietAtEnd: true,
	},
	{
		name: "a single blip the next attempt heals",
		story: "One dropped socket, back a second later. Never worth telling anyone.",
		steps: [...healthyOpen(0), { at: 5_000, event: "closed" }, ...healthyOpen(6_000)],
		untilMs: 30_000,
		expectWarnAt: null,
		expectQuietAtEnd: true,
	},
	{
		name: "a drop whose retries all fail inside the grace window, then succeed",
		story: "Several attempts fail, but the app recovers before the grace is out.",
		steps: [...healthyOpen(0), ...failingRetries(5_000, 4, 1_500), ...healthyOpen(15_000)],
		untilMs: 40_000,
		expectWarnAt: null,
		expectQuietAtEnd: true,
	},

	// ── Trouble the reducer must actually report ────────────────────────────
	{
		name: "the engine really is gone: retries that keep failing",
		story: "The one case worth a banner. It must appear, and at the pinned moment.",
		steps: [...healthyOpen(0), ...failingRetries(5_000, 20, 2_000)],
		untilMs: 60_000,
		expectWarnAt: 17_000,
		expectQuietAtEnd: false,
	},
	{
		name: "a sustained failure that later heals clears the banner",
		story: "The banner is a live state, not a sticky one.",
		steps: [...healthyOpen(0), ...failingRetries(5_000, 12, 2_000), ...healthyOpen(40_000)],
		untilMs: 60_000,
		expectWarnAt: 17_000,
		expectQuietAtEnd: true,
	},
	{
		name: "the app never connects at all",
		story: "Boot grace covers the start; after it, the banner is the honest answer rather than eternal silence.",
		steps: failingRetries(0, 30, 2_000),
		untilMs: 70_000,
		expectWarnAt: 30_000,
		expectQuietAtEnd: false,
	},

	// ── The three the old host got wrong by staying silent ──────────────────
	{
		name: "a socket wedged in CONNECTING, twice over",
		story:
			"A port that accepts TCP and never finishes the upgrade. With no connect deadline the socket " +
			"produces no event ever: the old host registered zero failed attempts, never retried, and never " +
			"warned, while the UI sat there looking usable.",
		// Each retry can only be built after the previous socket's deadline has
		// fired and closed it, so the wedges are one deadline plus a backoff step
		// apart, exactly as the host would space them.
		steps: [{ at: 0, event: "wedged" }, { at: 11_000, event: "wedged" }, { at: 22_000, event: "wedged" }],
		untilMs: 60_000,
		expectWarnAt: 40_000,
		expectQuietAtEnd: false,
	},
	{
		name: "a server that accepts and drops in the same breath, forty times over",
		story:
			"Reaching OPEN used to count as recovery, so every cycle restarted the grace window and the app " +
			"stayed silent through an outage that never ended. Only a connection that survives may clear a run.",
		steps: Array.from({ length: 40 }, (_, i) => [
			{ at: i * 1_000, event: "opened" as const },
			{ at: i * 1_000 + 250, event: "closed" as const },
		]).flat(),
		untilMs: 60_000,
		expectWarnAt: 12_250,
		expectQuietAtEnd: false,
	},
	{
		name: "clicking between rooms every four seconds while the engine is dead",
		story:
			"A swap used to clear the run, so a user navigating faster than the grace window could hold the " +
			"warning off for as long as they kept clicking. Navigating is not a fault, but it is not a cure.",
		steps: [
			...healthyOpen(0),
			{ at: 5_000, event: "closed" },
			{ at: 9_000, event: "swapped" }, { at: 9_500, event: "closed" },
			{ at: 13_000, event: "swapped" }, { at: 13_500, event: "closed" },
			{ at: 17_000, event: "swapped" }, { at: 17_500, event: "closed" },
			{ at: 21_000, event: "swapped" }, { at: 21_500, event: "closed" },
			{ at: 25_000, event: "swapped" }, { at: 25_500, event: "closed" },
		],
		untilMs: 60_000,
		expectWarnAt: 17_000,
		expectQuietAtEnd: false,
	},
];

let failures = 0;
function fail(message: string): void {
	failures += 1;
	console.error(`FAIL  ${message}`);
}

console.log("connection health\n");
for (const scenario of scenarios) {
	const after = replay(scenario);
	const label = (r: Replay) => (r.firstWarnAt === null ? "never warns" : `warns at ${(r.firstWarnAt / 1000).toFixed(2)}s`);
	console.log(`  ${scenario.name}: ${label(after)}`);

	if (after.firstWarnAt !== scenario.expectWarnAt) {
		fail(`${scenario.name}: warned at ${after.firstWarnAt}, expected ${scenario.expectWarnAt}. ${scenario.story}`);
	}
	if (scenario.expectQuietAtEnd && after.warnAtEnd) {
		fail(`${scenario.name}: still warning at the end of the timeline`);
	}
	if (!scenario.expectQuietAtEnd && !after.warnAtEnd) {
		fail(`${scenario.name}: expected a warning still standing at the end of the timeline`);
	}
}

// A wedged socket produces no event itself: only the connect deadline turns
// it into failed attempts.
{
	const wedged = scenarios.find((s) => s.name.includes("wedged"))!;
	const after = replay(wedged);
	if (after.attempts < 2) fail(`the connect deadline produced ${after.attempts} failed attempts, want at least 2`);
}

// The scheduling helper the app uses to arm its re-check timer.
{
	let state = createConnectionHealthState();
	state = reduceConnectionHealth(state, { type: "opened", now: 0 });
	state = reduceConnectionHealth(state, { type: "settled", now: 0 });
	if (msUntilWarn(state, 0) !== null) fail("msUntilWarn armed a timer while a socket was open");
	state = reduceConnectionHealth(state, { type: "attempt_failed", now: 1_000 });
	if (msUntilWarn(state, 1_000) !== null) fail("msUntilWarn armed a timer before a retry had failed");
	state = reduceConnectionHealth(state, { type: "attempt_failed", now: 2_000 });
	if (msUntilWarn(state, 2_000) !== 11_000) fail(`msUntilWarn returned ${msUntilWarn(state, 2_000)}, want 11000`);
	const swapped = reduceConnectionHealth(state, { type: "swapped", now: 3_000 });
	if (swapped.unhealthySince !== 1_000) fail("a swap erased the run it was sitting in the middle of");
	if (msUntilWarn(swapped, 3_000) !== 10_000) fail(`a swap moved the warning deadline to ${msUntilWarn(swapped, 3_000)}, want 10000`);
	// An open that never settles must not clear a warning already standing.
	let warned = reduceConnectionHealth(state, { type: "tick", now: 13_001 });
	if (!warned.warn) fail("the reducer did not warn after the grace window");
	warned = reduceConnectionHealth(warned, { type: "opened", now: 13_100 });
	if (!warned.warn) fail("merely reaching OPEN switched the banner off");
	warned = reduceConnectionHealth(warned, { type: "settled", now: 13_200 });
	if (warned.warn) fail("a settled connection left the banner up");
	// A settle that arrives after the socket is gone must not wipe a live run.
	const closed = reduceConnectionHealth(state, { type: "settled", now: 4_000 });
	if (closed.unhealthySince !== 1_000) fail("a stale settle wiped an unhealthy run on a closed socket");
}

// A bind that fails the same way on every reconnect attempt says so once.
{
	type Line = { kind: string; id: string; text?: string; level?: string };
	const failed = (id: string, text: string) => ({ kind: "system" as const, id, text, level: "error" as const });
	let items: Line[] = [{ kind: "user", id: "u1", text: "Hello" }];
	for (let attempt = 0; attempt < 25; attempt += 1) items = appendErrorLineOnce(items, failed(`e${attempt}`, "failed to create session: model not found: fake/gone"));
	const repeated = items.filter((item) => item.kind === "system").length;
	if (repeated !== 1) { failures += 1; console.error(`FAIL repeated error: 25 identical failures should leave one line, got ${repeated}`); } else console.log("ok   a failure repeated on every reconnect attempt is said once");
	items = appendErrorLineOnce(items, failed("e-other", "failed to create session: the provider refused the key"));
	items = appendErrorLineOnce([...items, { kind: "user", id: "u2", text: "Again" }], failed("e-again", "failed to create session: the provider refused the key"));
	const lines = items.filter((item) => item.kind === "system").map((item) => item.text);
	if (lines.length !== 3) { failures += 1; console.error(`FAIL repeated error: a different error, and the same one after a message, are added, got ${JSON.stringify(lines)}`); } else console.log("ok   a different error, or the same one after something else, is added");
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nconnection health smoke passed");
