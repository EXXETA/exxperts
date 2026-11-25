// Hooks a shared-server entry file registers before it starts this server.
//
// The desktop app and the launcher start index.ts directly and register
// nothing, so every hook stays empty and the server behaves exactly as
// without them. An entry that registers must do so before it imports
// index.ts: index.ts reads the hooks once, while it loads.
//
// This file holds only the slots and the flag. Shared code never imports an
// entry file: a release packs the server by following imports.
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from "fastify";

import type { UsageKind } from "./usage-log.js";

export type EdgeTools = {
	// True when the candidate is the server's token. The token itself is never handed out.
	readonly tokenMatches: (candidate: string) => boolean;
};

type RoomRefusal = { readonly code: string; readonly message: string };

// The liveSessionJoins slot's answer for one joining page.
export type LiveSessionJoin = "admit" | (RoomRefusal & { readonly close: { readonly code: number; readonly reason: string } });

// A live connection as the connectionOpened slot gets it: its socket.
export type LiveConnection = {
	// Sends a close frame with this code and reason; the connection ends once
	// the other side answers it.
	close(code: number, reason: string): void;
	// Ends the connection at once, without a close frame.
	terminate(): void;
	// Hands an event to the connection's listeners: "message" for each frame
	// it receives, until it has closed.
	emit(event: string | symbol, ...args: unknown[]): boolean;
	// Sends a ping frame; the other side's answer arrives as "pong".
	ping(): void;
	on(event: "pong", listener: () => void): unknown;
};

// A Forget that landed, or a room deleted for good: ids and a time, never words.
// A room's deletion also carries the room's createdAt, read from its agent.json
// before the folder went; absent when that file holds none or cannot be read.
export type DeletionLanded =
	| { readonly kind: "forget"; readonly roomId: string; readonly conversationId: string; readonly at: string }
	| { readonly kind: "room"; readonly roomId: string; readonly createdAt?: number; readonly at: string };

// A stored value's codec: seal gives a value as stored for its place (the
// file, the entry, the field and, for a connector's token or header, its
// address's origin); open gives it back, and throws for a value stored for
// another place, with another key, or not sealed at all.
export type StoredValueCodec = {
	readonly seal: (value: string, place: readonly string[]) => string;
	readonly open: (stored: string, place: readonly string[]) => string;
};

// The logger's options as server-app.ts gives them to the framework.
export type LoggerOptions = Exclude<FastifyServerOptions["logger"], boolean | undefined>;

export type ServerHooks = {
	// The folder the web page is served from, given the app root; without it,
	// apps/web-ui/dist under the app root.
	webUiDist?: (appRoot: string) => string;
	// The logger's options, asked once while server-app.ts loads, given the
	// server's own; what it returns is what the logger uses. Without it, the
	// server's own.
	loggerOptions?: (base: LoggerOptions) => LoggerOptions;
	// Runs at the top of the server's own onRequest hook for every request
	// that reaches the server's hooks, the /ws upgrade included (only the
	// websocket plugin's own onRequest hook, which marks an upgrade, runs
	// before it), and decides instead of the server's own proxy, loopback and
	// token checks, which then do not run. It refuses by sending a reply and
	// returning it; returning without a reply lets the request on, to the
	// request guard and the handler. A request no route matches, and OPTIONS,
	// arrive with req.routeOptions.url undefined, as for the guard.
	edgeRequest?: (req: FastifyRequest, reply: FastifyReply, tools: EdgeTools) => unknown | Promise<unknown>;
	// The server's token, asked once while index.ts loads. When it is
	// registered, it is the token: the EXXPERTS_AUTH_TOKEN variable and the
	// token file are not read, and no token is minted or written.
	authToken?: () => string;
	// The security headers for the page and its files on the loopback
	// listener, given the server's own; asked once while index.ts loads.
	pageSecurityHeaders?: (base: Readonly<Record<string, string>>) => Record<string, string>;
	// Runs after the loopback and token checks, or after the edge when one is
	// registered, before the body is read and before any handler, the /ws
	// upgrade included. It may only refuse: send a reply and return it.
	// Returning without a reply lets the request through. A route is known by
	// req.routeOptions.url, except for requests no route matches (answered
	// 404) and OPTIONS requests, where it is undefined; a HEAD request carries
	// its GET route's url with req.method "HEAD", except on /ws, which has no
	// HEAD route. Decide those explicitly.
	guardRequest?: (req: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>;
	// Asked for every client-context request that phone mode's branch does not
	// answer, given the server's own answer as base; it may add to the answer
	// and set the reply's headers, and what it returns is the answer.
	clientContext?: (req: FastifyRequest, reply: FastifyReply, base: Readonly<Record<string, unknown>>) => Record<string, unknown>;
	// Whether this server can reach public web pages, as its setup says, asked
	// at each page call, each read of the web search setting and each save
	// turning web pages on; null, or without it, when the setup does not say.
	publicPages?: () => "reachable" | "unreachable" | null;
	// How long a stop waits for running work, in seconds, asked when a stop
	// begins (server-stop.ts); without it, or when it gives nothing, two seconds.
	stopWaitSeconds?: () => number | undefined;
	// Asked each time a room's stored workspace setting is read; when it gives
	// true, every stored setting reads as none: no workspace tools, no terminal.
	ignoresStoredWorkspaceSettings?: () => boolean;
	// Asked each time a room's file tools are set up or used: true gives every
	// room its own files (<room>/files, the room's Attachments) as the one
	// folder its six file tools open, by paths relative to it, with no
	// commands. Without it, or when it gives false, the stored setting decides.
	roomFilesAreTheFolder?: () => boolean;
	// The options the server's own prompt calls pass to a session, asked at
	// each call; without it, or when it gives nothing, the session's defaults.
	// expandPromptTemplates false means a message that starts with "/" reaches
	// the model as written instead of running a command.
	promptOptions?: () => { readonly expandPromptTemplates?: boolean };
	// How long a scheduled run's turn may take, in milliseconds, asked when a
	// scheduler tick starts (scheduled-prompt-background-execution.ts); without
	// it, or when it gives nothing, no limit.
	scheduledRunLimitMs?: () => number | undefined;
	// Whether a scheduled run whose lease ran out (the server ended while it
	// ran) is run again, asked when a scheduler tick starts; without it, yes.
	// No ends the run instead, unless its answer had already landed.
	retriesInterruptedScheduledRuns?: () => boolean;
	// Asked each time a room is checked for a scheduled run
	// (persistent-agent-room-settings.ts), after the room's own checks and
	// before its lock, with the room's "Response ready" mark, nothing when it
	// has none. A sentence ends the run as blocked owner_paused, never retried,
	// with that sentence as its message. It answers at once. Without it, or
	// when it gives nothing, the run goes on as before.
	scheduledRunPause?: (roomId: string, unopened: { readonly firstUnopenedAt: number; readonly unopenedCount: number } | undefined) => string | undefined;
	// Asked once per connector add and address change (mcp-admin.ts), after
	// their own checks, with the entry it would write, and the connector's name
	// when it is new or its address changes; a sentence refuses with that
	// sentence and nothing is written. A throw takes the route's own failure
	// path. Without it, or when it gives nothing, the add or change goes on.
	connectorEntryRefusal?: (entry: Readonly<{ url?: string; command?: string; auth?: string | false }>, name?: string) => string | undefined;
	// Asked with a room and connector names: those of them the room may use. It
	// answers at once. Without it, all of them.
	roomConnectors?: (roomId: string, names: readonly string[]) => readonly string[];
	// Asked by AI setup's gateway discover and save (gateways.ts) with the address
	// it would use or keep; a sentence refuses with a 400 and nothing is fetched
	// or written. Without it, or when it gives nothing, as before.
	gatewayAddressRefusal?: (baseUrl: string) => string | undefined;
	// Asked once per room the create route makes, after the room exists and
	// before the reply, with the createdAt in its agent.json; the reply waits for
	// it. A throw or a rejection takes the route's own failure path, its statusCode
	// and sentence, and the room stays. Without it, nothing happens.
	roomCreated?: (req: FastifyRequest, room: { readonly roomId: string; readonly createdAt: number }) => void | Promise<void>;
	// Asked whether this request's person may be refused this room: the refusal,
	// or nothing to let them in, at once or as a promise. Without it, nobody is
	// refused. The live connection's consult frame asks for the room it names
	// (room-socket.ts), with the upgrade's request, before it reads that room.
	roomRefusal?: (req: FastifyRequest, roomId: string) => RoomRefusal | undefined | Promise<RoomRefusal | undefined>;
	// Asked for the room ids this request's person may see: the set, or nothing
	// for every room, at once or as a promise. Without it, every room. The saved
	// room order's two routes ask (settings-routes.ts), and every other route
	// through viewerOf (persistent-agent-status.ts): each list that reads across
	// rooms and the room name check. Each asks once per request and waits for the
	// answer before it reads a room.
	roomViewer?: (req: FastifyRequest) => ReadonlySet<string> | undefined | Promise<ReadonlySet<string> | undefined>;
	// Asked once per request of the artifact routes (artifact-routes.ts) for the
	// room whose shelf serves this task's files: its id, or null for none (the
	// route answers 404), at once or as a promise. When it is registered, the
	// file route serves only that room's shelf, never the server-wide task store.
	// Without it, the room task-room-lookup.ts finds, after the store.
	taskRoomOf?: (req: FastifyRequest, taskId: string) => string | null | Promise<string | null>;
	// Asked once per request of the saved room order's two routes, for the
	// folder this request's order lives in. A throw takes the route's own failure
	// path and nothing is written. Without it, the app's state folder, one order
	// for every door.
	roomOrderFolder?: (req: FastifyRequest) => string;
	// Asked once per attempt at a new room's id, for the whole id; a taken id
	// asks again, and one the id rule refuses refuses the create before anything
	// of the room is written. It answers at once. Without it, ids are the name's
	// slug, then a count when that is taken.
	newRoomId?: () => string;
	// Who this request's person and space are, as opaque ids, at once or as a
	// promise; nothing when no one is known. The memory ask asks
	// (memory-routes.ts), once per request, for its usage row, and the usage
	// views (usage-api.ts), for whose rows to count.
	whoIsAsking?: (req: FastifyRequest) => { person: string; space: string } | undefined | Promise<{ person: string; space: string } | undefined>;
	// Asked for the person of a page on a room's live session on a shared
	// server (room-socket.ts), with the page's request: opaque ids, the same for
	// every page of one person, and the name other people in the room see ("" when
	// unknown), at once; nothing when no one is known, as for a throw. A question
	// asked in an answer a person's message started is answered from that
	// person's pages alone, and every other page is shown it waiting for them; a
	// page with no person answers none of these. Where the starting page's person
	// is not known, this slot missing too, that page alone answers. A scheduled
	// answer is answered from any page.
	roomPerson?: (req: FastifyRequest) => { readonly person: string; readonly space: string; readonly name: string } | undefined;
	// Asked on a shared server for the name of a person who sent a message in a
	// room, by the ids the server stamped on it (roomPerson's person and space),
	// whenever a page is shown that message (room-live-sessions.ts): the name
	// they have now ("" when their sign-in gives none), or nothing when the
	// server no longer knows them, at once. A throw, and this slot missing,
	// name nobody.
	personName?: (who: { readonly person: string; readonly space: string }) => string | undefined;
	// Asked once when a room's live session opens on a shared server
	// (room-socket.ts), with the opening page's request, for who may join it: a
	// function asked with each joining page's request, which answers "admit", or
	// the error frame's code and sentence that page gets and the close its
	// connection ends with, at once or as a promise. Only "admit" lets a page in.
	// Without it, or on a throw, the page is closed with no frame.
	liveSessionJoins?: (req: FastifyRequest) => (joinReq: FastifyRequest) => LiveSessionJoin | Promise<LiveSessionJoin>;
	// A gateway the server's start provides: its provider id and key. index.ts
	// asks once while it loads and hands the key to the runtime in memory
	// (AuthStorage.setProcessKey), never to a file; AI setup asks at each save,
	// delete and key save, and refuses any change to that gateway but its
	// models (openai-compatible-gateways.ts, startGatewayProviderId). Without
	// it, or when it gives nothing, no gateway is provided.
	startGateway?: () => { readonly providerId: string; readonly key: string } | undefined;
	// The codec of stored keys and connector values, asked once while index.ts
	// loads (stored-values.ts says which values and where they open). Without
	// it, or when it gives nothing, values are stored as typed.
	storedValues?: () => StoredValueCodec | undefined;
	// Called once, while the server registers its routes (request-checks.ts),
	// with the server, so an entry can add routes of its own. Without it, none.
	routes?: (app: FastifyInstance) => void;
	// Called once as each live connection's handler starts, a room's or Home's,
	// with that connection. Without it, nothing.
	connectionOpened?: (req: FastifyRequest, connection: LiveConnection) => void;
	// Asked for every message a room's live connection takes (room-socket.ts),
	// held ones included, before it is handled, with the room and the parsed
	// message. True means it refused, and the message is not handled. Without
	// it, every message is handled.
	frameRefusal?: (req: FastifyRequest, roomId: string, message: unknown, connection: LiveConnection & { send(data: string): void }) => boolean;
	// Asked once per usage row as it is written (usage-log.ts), when the row names
	// no person, with the room it names and its kind: the person and space it is
	// written with, or nothing to write it without them. Asked the same way once
	// per model session (modelCallMetadata), so its calls name that person. It
	// answers at once. Without it, rows and calls carry neither.
	usageOwner?: (roomId: string, kind: UsageKind | undefined) => { person: string; space: string } | undefined;
	// Called once a Forget has landed (persistent-agent-forget.ts, after the
	// conversation is closed as forgotten, and again when a Forget a cut left is
	// finished, with the same time) and once a room is deleted for good
	// (persistent-agent-archive.ts, right after its folder is detached, so a
	// detach that fails notes nothing). It answers at once, never throws, and
	// says whether it noted the deletion: one it did not keeps the room's
	// detached folder, which the server's next start reads. A Forget answers
	// the same either way. Without it, nothing, and the folder goes.
	deletionLanded?: (deletion: DeletionLanded) => boolean;
};

let registered: Readonly<ServerHooks> | null = null;

// Called once, by an entry file, before it imports index.ts.
export function registerServerHooks(hooks: ServerHooks): void {
	if (registered) throw new Error("server hooks are already registered");
	registered = Object.freeze({ ...hooks });
}

// The registered hooks; empty when no entry registered.
export function serverHooks(): Readonly<ServerHooks> {
	return registered ?? {};
}

// True only once an entry has registered: this process is a shared server.
export function isSharedServer(): boolean {
	return registered !== null;
}
