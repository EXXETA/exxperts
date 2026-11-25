// Loaded before team-room-session-smoke.ts's server, to make it a shared
// server whose person is named by the smoke: the `smoke_person` cookie, or one
// made-up person when there is none. It fills only what the smoke needs: who
// a room page's person is, with the name others see (Lena and Ben for the two
// people the smoke names, none for anyone else, and the same names for who sent
// a message, of whom one person has left; a page with the
// `smoke_person_unread` cookie is one whose person can't be read); who may join a room's live
// session (a page of the person whose page opened it, and of the one person its
// `smoke_shares_with` cookie names, never anyone by default; anyone else's gets
// stand-in words); a route that ends a page's live
// connection as a sign-out does (POST /smoke/end-pages?page=<label>, every page
// of the person when no label), and one that shortens a room's quiet spell
// (POST /smoke/quiet-spell?ms=<ms>).
import type { FastifyRequest } from "fastify";
import { registerServerHooks, type LiveConnection } from "../src/server-hooks.js";
import { shortenRoomQuietSpellForSmoke } from "../src/room-live-sessions.js";

const cookieOf = (req: FastifyRequest, name: string): string | undefined => {
	const header = String(req.headers.cookie ?? "");
	for (const part of header.split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return decodeURIComponent(value.join("="));
	}
	return undefined;
};
const personOf = (req: FastifyRequest) => cookieOf(req, "smoke_person") ?? "smoke-person-a";
// The names other people in a room see, by person; a person not listed has none, and `smoke-person-left` is no longer known.
const NAMES: Readonly<Record<string, string>> = { "smoke-person-a": "Lena", "smoke-person-b": "Ben" };
const LEFT = "smoke-person-left";

const open = new Set<{ person: string; page: string | undefined; connection: LiveConnection }>();

registerServerHooks({
	connectionOpened: (req, connection) => {
		const entry = { person: personOf(req), page: cookieOf(req, "smoke_page"), connection };
		open.add(entry);
		(connection as unknown as { on(event: "close", listener: () => void): void }).on("close", () => open.delete(entry));
	},
	routes: (app) => {
		app.post("/smoke/end-pages", async (req) => {
			const page = (req.query as { page?: string }).page;
			let ended = 0;
			for (const entry of [...open]) {
				if (entry.person !== personOf(req) || (page !== undefined && entry.page !== page)) continue;
				entry.connection.close(4401, "signed_out");
				ended++;
			}
			return { ended };
		});
		app.post("/smoke/quiet-spell", async (req) => {
			const ms = Number((req.query as { ms?: string }).ms);
			if (!Number.isInteger(ms) || ms < 0) throw new Error("ms must be a whole number");
			shortenRoomQuietSpellForSmoke(ms);
			return { ms };
		});
	},
	roomPerson: (req) => {
		if (cookieOf(req, "smoke_person_unread") !== undefined) throw new Error("the smoke's stand-in for a person that can't be read");
		return { person: personOf(req), space: "smoke-space", name: NAMES[personOf(req)] ?? "" };
	},
	personName: (who) => (who.person === LEFT ? undefined : NAMES[who.person] ?? ""),
	liveSessionJoins: (req) => {
		const opener = personOf(req);
		const sharesWith = cookieOf(req, "smoke_shares_with");
		return (joinReq) => personOf(joinReq) === opener || (sharesWith !== undefined && personOf(joinReq) === sharesWith) ? "admit" : { code: "smoke_not_yours", message: "The smoke's stand-in for another person's page.", close: { code: 4403, reason: "smoke_not_yours" } };
	},
});
