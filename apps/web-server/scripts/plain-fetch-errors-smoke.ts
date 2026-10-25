// A request the page sends when the app's own server cannot be reached fails
// in the browser's words, and each browser has its own: Chrome's "Failed to
// fetch", Safari's "Load failed" or its connection sentences, Firefox's
// "NetworkError when attempting to fetch resource.". Every fetch helper of the
// page says one plain sentence instead, still as a TypeError so the checks for
// a dropped request (a restart under way) keep working, and Review, Memorize
// and Remember show that sentence as it is. On a shared server the sentence
// sends the person to their admin, since they cannot restart it. There the
// server's absence mostly comes back as an answer from what stands in front
// of it (a 502, 503 or 504 in its own words, never our JSON): the same no
// answer, the same sentence. Our own JSON error answers keep their sentence. No server, no browser: the
// helpers run with a fetch that fails the way each browser's does. Once the
// service answers again, a line loses only the sentence: a line that gives it
// as the reason for something that did not happen keeps the rest.
export {}; // a module, so the top-level awaits below are allowed

const api = await import("../../web-ui/src/api.js");
const management = await import("../../web-ui/src/persistent-room-management-api.js");
const schedules = await import("../../web-ui/src/persistent-room-schedules-api.js");
const backgroundRuns = await import("../../web-ui/src/persistent-room-background-runs-api.js");
const workspace = await import("../../web-ui/src/persistent-room-workspace-api.js");
const mcp = await import("../../web-ui/src/mcp-api.js");
const clientContext = await import("../../web-ui/src/remote-client-context.js");
const { isPlainProductSentence, rememberFailureSentence } = await import("../../web-ui/src/remember-read.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const SENTENCE = "exxperts could not reach its own service just now. Try again; if it repeats, restart exxperts.";
const SHARED_SENTENCE = "exxperts could not reach its own service just now. Try again in a moment; if it repeats, tell your admin.";
const BROWSER_SENTENCES = [
	"Failed to fetch",
	"Load failed",
	"NetworkError when attempting to fetch resource.",
	"The network connection was lost.",
	"Could not connect to the server.",
];

const helpers: Array<[string, () => Promise<unknown>]> = [
	["apiFetch", () => api.apiFetch("/api/anything")],
	["fetchJson", () => api.fetchJson("/api/anything")],
	["restorePersistentRoom", () => management.restorePersistentRoom("room-x")],
	["archivePersistentRoom", () => management.archivePersistentRoom("room-x", { confirmation: "x" } as never)],
	["purgePersistentRoom", () => management.purgePersistentRoom("room-x", "x")],
	["fetchArchivedPersistentRooms", () => management.fetchArchivedPersistentRooms()],
	["fetchPersistentRoomSchedules", () => schedules.fetchPersistentRoomSchedules("room-x")],
	["fetchPersistentRoomBackgroundRuns", () => backgroundRuns.fetchPersistentRoomBackgroundRuns("room-x")],
	["fetchPersistentRoomWorkspaceDefault", () => workspace.fetchPersistentRoomWorkspaceDefault("room-x")],
	["fetchMcpConnectorsStatus", () => mcp.fetchMcpConnectorsStatus()],
];

const realFetch = globalThis.fetch;
const failures: string[] = [];
try {
	for (const browserSentence of BROWSER_SENTENCES) {
		globalThis.fetch = (async () => { throw new TypeError(browserSentence); }) as typeof fetch;
		for (const [name, call] of helpers) {
			try {
				await call();
				failures.push(`${name}: resolved although the request never got an answer`);
			} catch (error) {
				const message = (error as Error)?.message;
				if (message !== SENTENCE) failures.push(`${name} with "${browserSentence}": got "${message}"`);
				else if (!(error instanceof TypeError)) failures.push(`${name}: the plain error is no longer a TypeError, so a restart's dropped request reads as a refusal`);
			}
		}
	}

	// A cancel is the caller's own, never "could not reach".
	globalThis.fetch = (async () => { throw new DOMException("The operation was aborted.", "AbortError"); }) as typeof fetch;
	for (const [name, call] of helpers) {
		try {
			await call();
		} catch (error) {
			if ((error as Error)?.name !== "AbortError") failures.push(`${name}: a cancel came back as "${(error as Error)?.message}"`);
		}
	}

	// What stands in front of the server answers for it while it is down.
	const gatewayAnswers: Array<[string, () => Response]> = [
		["503 no healthy upstream", () => new Response("no healthy upstream", { status: 503, headers: { "content-type": "text/plain" } })],
		["502 HTML", () => new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", { status: 502, headers: { "content-type": "text/html" } })],
		["504 empty", () => new Response("", { status: 504 })],
		["503 JSON not ours", () => new Response(JSON.stringify({ upstream: "down" }), { status: 503, headers: { "content-type": "application/json" } })],
	];
	for (const [label, answer] of gatewayAnswers) {
		globalThis.fetch = (async () => answer()) as typeof fetch;
		for (const [name, call] of helpers) {
			try {
				const result = await call();
				failures.push(`${name} with a gateway's ${label}: resolved with ${result instanceof Response ? `status ${result.status}` : "a value"}`);
			} catch (error) {
				const message = (error as Error)?.message;
				if (message !== SENTENCE) failures.push(`${name} with a gateway's ${label}: got "${message}"`);
			}
		}
	}
	// Our own 503 (a model that is not answering) keeps its sentence, and apiFetch hands the answer on.
	const OWN = "Claude Scripted isn't answering right now. Nothing was lost.";
	globalThis.fetch = (async () => new Response(JSON.stringify({ error: OWN, code: "model_unreachable" }), { status: 503, headers: { "content-type": "application/json; charset=utf-8" } })) as typeof fetch;
	for (const [name, call] of helpers) {
		try {
			const result = await call();
			if (!(name === "apiFetch" && result instanceof Response && result.status === 503)) failures.push(`${name} with our own 503: resolved`);
		} catch (error) {
			const message = (error as Error)?.message;
			if (message !== OWN) failures.push(`${name} with our own 503: got "${message}"`);
		}
	}

	// A page the server told it is on a shared server: the person cannot restart it.
	globalThis.fetch = (async () => new Response(JSON.stringify({ remote: false, capability: "full", sharedServer: true }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
	await clientContext.fetchRemoteClientContext();
	globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
	for (const [name, call] of helpers) {
		try {
			await call();
		} catch (error) {
			const message = (error as Error)?.message;
			if (message !== SHARED_SENTENCE) failures.push(`${name} on a shared server: got "${message}"`);
		}
	}
} finally {
	globalThis.fetch = realFetch;
}

// Review and Memorize show a plain sentence as it is; Remember too.
for (const sentence of [SENTENCE, SHARED_SENTENCE]) {
	if (!isPlainProductSentence(sentence)) failures.push(`Review and Memorize would hide "${sentence}" behind their generic stop`);
	if (rememberFailureSentence(sentence) !== sentence) failures.push(`Remember shows "${rememberFailureSentence(sentence)}" instead of "${sentence}"`);
}

// What did not happen is still true when the service answers again, or while
// the lost-connection banner speaks for the outage.
for (const sentence of [SENTENCE, SHARED_SENTENCE]) {
	const lines: Array<[string | null, string | null]> = [
		[sentence, null],
		[`Old Room was NOT deleted: ${sentence}`, "Old Room was NOT deleted."],
		[`The conversation was reset, but the room could not be reopened automatically: ${sentence} Enter it again from its card.`, "The conversation was reset, but the room could not be reopened automatically. Enter it again from its card."],
		[`${sentence} Old Room holds as many remembered conversations as it can.`, "Old Room holds as many remembered conversations as it can."],
		["Old Room is busy right now.", "Old Room is busy right now."],
		[null, null],
	];
	for (const [line, wanted] of lines) {
		const got = api.withoutServiceLine(line);
		if (got !== wanted) failures.push(`withoutServiceLine(${JSON.stringify(line)}): got ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}`);
	}
}

assert(failures.length === 0, `plain fetch errors:\n  ${failures.join("\n  ")}`);
console.log("plain-fetch-errors smoke: ok");
