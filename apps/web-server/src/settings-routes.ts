import type { FastifyRequest } from "fastify";
import { readGlobalInstructions, ROOM_INSTRUCTIONS_MAX_CHARS, writeGlobalInstructions } from "./persistent-room-instructions.js";
import { type HiddenRooms, type RoomOrderStorageOptions, roomOrderPayload, readRoomOrder, saveRoomOrder, ROOM_ORDER_SAVE_FAILED_SENTENCE } from "./room-order-store.js";
import { readWebSearchSettings, writeWebSearchSettings, WebSearchSettingsError, WebSearchSettingsUnreadableError } from "./web-search-settings.js";
import { resolveWhatsNew, acknowledgeWhatsNew } from "./whats-new.js";
import { startSearxngSetup, searxngSetupStatus } from "./searxng-setup.js";
import { REPO_ROOT } from "./server-install-root.js";
import { app } from "./server-app.js";
import { remoteRoomExposure } from "./request-checks.js";
import { isSharedServer, serverHooks } from "./server-hooks.js";

// How the app's own web_search tool runs. Settable, and it takes effect on the
// next search rather than the next launch: the tool re-reads the file. The
// environment variable still outranks the file, so the payload says which of
// the two is actually in force instead of drawing the saved value as the truth.
function webSearchSettingsPayload() {
	const settings = readWebSearchSettings();
	return {
		provider: settings.provider,
		baseUrl: settings.baseUrl ?? "",
		source: settings.source,
		// The provider-side switch is its own answer with no environment
		// override behind it, so there is nothing to disambiguate here.
		providerSearch: settings.providerSearch,
		webPages: settings.webPages,
		saved: { provider: settings.saved.provider ?? null, baseUrl: settings.saved.baseUrl ?? "" },
		envProvider: process.env.EXXETA_SEARCH_PROVIDER?.trim() || null,
		// A broken file is drawn as broken rather than as a set of choices
		// nobody made. Provider search reads off in this state, and the screen
		// has to say why instead of showing an unticked box as a preference.
		unreadable: settings.unreadable ?? null,
	};
}

// The global instructions: one text under the app's state folder,
// read and written by the same store as a room's text (same cap, same
// refusals, same three states). Which rooms follow it is each room's switch.
app.get("/api/settings/instructions", async () => ({ instructions: readGlobalInstructions(), maxChars: ROOM_INSTRUCTIONS_MAX_CHARS }));

app.put("/api/settings/instructions", async (req, reply) => {
	try {
		const body = (req.body ?? {}) as any;
		return { instructions: writeGlobalInstructions(body.text), maxChars: ROOM_INSTRUCTIONS_MAX_CHARS };
	} catch (e) {
		const statusCode = (e as any).statusCode;
		if (statusCode === 400) return reply.code(400).send({ error: (e as Error).message });
		app.log.error({ err: e }, "global instructions save failed");
		const removing = typeof (req.body as any)?.text === "string" && !(req.body as any).text.trim();
		return reply.code(500).send({ error: `${removing ? "Removing" : "Saving"} the global instructions failed because of a server error. The previous text is unchanged. Check the server logs for details.` });
	}
});

// The order of the rooms on the home screen: one saved preference, mode and
// arrangement, for every door or, where the roomOrderFolder hook names a folder,
// for each folder it names. A remote device is told the arrangement without its
// hidden rooms and may only arrange the rooms it sees, and so does a request the
// roomViewer hook answers for; the merge in the store keeps the unseen ones in
// place, its ceiling apart (room-order-store.ts). A server with that hook has no
// remote devices: only the checks its edge hook replaces mark one.
const roomOrderHiddenRooms = async (req: FastifyRequest): Promise<HiddenRooms> => {
	const seen = await serverHooks().roomViewer?.(req);
	if (seen) return (roomId: string) => !seen.has(roomId);
	return (req as { exxRemoteDevice?: unknown }).exxRemoteDevice ? (roomId: string) => remoteRoomExposure.isHidden(roomId) : null;
};

const roomOrderStorage = (req: FastifyRequest): RoomOrderStorageOptions => {
	const appStateRoot = serverHooks().roomOrderFolder?.(req);
	return appStateRoot === undefined ? {} : { appStateRoot };
};

// The viewer's answer comes first, so the read is not older than it.
app.get("/api/settings/room-order", async (req) => {
	const hidden = await roomOrderHiddenRooms(req);
	return roomOrderPayload(readRoomOrder(roomOrderStorage(req)), hidden);
});

app.put("/api/settings/room-order", async (req, reply) => {
	try {
		const hidden = await roomOrderHiddenRooms(req);
		return roomOrderPayload(saveRoomOrder(req.body, roomOrderStorage(req), new Date(), hidden), hidden);
	} catch (e) {
		const statusCode = (e as any).statusCode;
		if (statusCode === 400) return reply.code(400).send({ error: (e as Error).message });
		app.log.error({ err: e }, "room order save failed");
		return reply.code(500).send({ error: ROOM_ORDER_SAVE_FAILED_SENTENCE });
	}
});

app.get("/api/settings/web-search", async () => webSearchSettingsPayload());

// The GET can record: a fresh install, or an update with nothing to show, is
// recorded quietly. The POST records the running version and is idempotent.
app.get("/api/whats-new", async () => resolveWhatsNew());

app.post("/api/whats-new/seen", async () => {
	acknowledgeWhatsNew();
	return { ok: true };
});

// Starting a local search engine, for the people who will never type a command
// to do it. Pulling the image takes minutes on a first run, so the POST starts
// the work and answers immediately; the GET is what the screen watches.
app.post("/api/web-search/searxng/setup", async () => startSearxngSetup(REPO_ROOT));

app.get("/api/web-search/searxng/setup", async () => {
	// The probe target when no run has claimed one: the saved local address.
	const saved = readWebSearchSettings().saved;
	return searxngSetupStatus(REPO_ROOT, saved.provider === "searxng" ? saved.baseUrl ?? null : null);
});

app.put("/api/settings/web-search", async (req, reply) => {
	const body = (req.body ?? {}) as any;
	try {
		writeWebSearchSettings({
			...("provider" in body ? { provider: body.provider } : {}),
			...("baseUrl" in body ? { baseUrl: body.baseUrl } : {}),
			...("providerSearch" in body ? { providerSearch: body.providerSearch } : {}),
			// The desktop has no web pages switch, so its PUT never stores one.
			...(isSharedServer() && "webPages" in body ? { webPages: body.webPages } : {}),
		});
	} catch (e) {
		if (e instanceof WebSearchSettingsError) return reply.code(400).send({ error: e.message });
		// Not a bad request: the request was fine and the machine's own file is
		// the problem, so this is ours to own rather than the caller's to fix.
		if (e instanceof WebSearchSettingsUnreadableError) return reply.code(500).send({ error: e.message });
		return reply.code(500).send({ error: (e as Error).message });
	}
	return webSearchSettingsPayload();
});
