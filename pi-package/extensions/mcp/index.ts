/**
 * MCP support, provided by pi-mcp-adapter.
 *
 * The adapter exposes every configured MCP server through a single `mcp`
 * proxy tool (search/describe/call). Transports: stdio, HTTP (StreamableHTTP
 * with SSE fallback), and OAuth-protected servers.
 *
 * Server configuration is read from the person's own settings, in
 * precedence order:
 *   ~/.config/mcp/mcp.json     shared user-global (Cursor/Claude compatible)
 *   ~/.exxperts/agent/mcp.json exxperts user-global
 * It runs only in a room's session, and a room never reads a project's
 * .mcp.json or .pi/mcp.json: the adapter's cwd is the room connector folder.
 */

import * as path from "node:path";
import { stateHome } from "../../product-state-paths.js";
import { ensureRoomScopedMcpGrantsMigration, prepareRoomScopedMcpSessionCache, roomConnectorConfigCwd, roomScopedMcpToolRegistration, type RegisteredToolLike, type RoomScopeRegistrationOptions } from "./room-scope.js";

// Kept non-literal so tsc never resolves the specifiers into raw .ts sources,
// and so no tsconfig `paths` remap is needed — a remap would also be applied
// by tsx at runtime and break the real import.
const PI_MCP_ADAPTER_SPECIFIER = "pi-mcp-adapter" as string;

type EventHandlerLike = (event: unknown, ctx: unknown) => unknown;

/**
 * The session context a room's adapter sees: everything as the runtime made it,
 * except `cwd`, which is the room connector folder. The adapter reads `cwd`
 * only to find config files, so a room's connectors come from the person's
 * settings while each connector still starts where it always did. The guarded
 * getters are carried over as getters, never read eagerly.
 */
function withRoomConnectorConfigCwd(ctx: unknown): unknown {
	if (!ctx || typeof ctx !== "object") return ctx;
	const descriptors = Object.getOwnPropertyDescriptors(ctx);
	descriptors.cwd = { get: () => roomConnectorConfigCwd(), enumerable: true, configurable: true };
	return Object.create(Object.getPrototypeOf(ctx), descriptors);
}

/**
 * Per-room MCP: the session assemblers (web server room sessions, scheduled
 * background room runs) pass the room id explicitly. This is the only door:
 * the adapter never registers without a room scope.
 */
export function createRoomScopedMcpExtension(roomId: string, options: RoomScopeRegistrationOptions = {}) {
	const scopedRoomId = String(roomId ?? "").trim();
	if (!scopedRoomId) throw new Error("createRoomScopedMcpExtension requires a room id");
	return (pi: unknown) => registerMcpExtension(pi, scopedRoomId, options);
}

async function registerMcpExtension(pi: unknown, roomScopeId: string, scopeOptions: RoomScopeRegistrationOptions) {
	// The adapter resolves its agent-global config dir from PI_CODING_AGENT_DIR
	// (defaulting to ~/.pi/agent); point it at the exxperts agent dir instead.
	if (!process.env.PI_CODING_AGENT_DIR) {
		process.env.PI_CODING_AGENT_DIR = path.join(stateHome(), ".exxperts", "agent");
	}
	// Whichever room door registers first after the update runs the
	// marker-guarded migration. Then, on a truly cold
	// metadata cache, warm ONLY this room's granted connectors so the
	// adapter's bootstrap-all never connects ungranted servers.
	try {
		await ensureRoomScopedMcpGrantsMigration();
	} catch {
		// migration is retried by the next door; enforcement stays fail-closed
	}
	await prepareRoomScopedMcpSessionCache(roomScopeId);
	// Dynamic import: default-export interop differs between the jiti and tsx
	// loading paths — including a double `default` wrapper when this module
	// itself is loaded through an extension factory. Unwrap until callable.
	let register: unknown = await import(PI_MCP_ADAPTER_SPECIFIER);
	while (register && typeof register !== "function" && typeof (register as any).default !== "undefined") {
		register = (register as any).default;
	}
	if (typeof register !== "function") throw new Error("pi-mcp-adapter did not export a register function");

	const api = pi as {
		registerTool?: (tool: RegisteredToolLike) => void;
		on?: (event: string, handler: EventHandlerLike) => void;
	};
	// Per-room MCP: the adapter's tool registrations
	// (the `mcp` proxy tool, optional per-server direct tools) are captured and
	// re-registered through the shared room-scope wrapper, which filters what
	// the room's model can see, gates what it can call, and sanitizes results
	// against the room's live grant list. The adapter only registers tools
	// synchronously inside its register call, so deferring them past it loses
	// nothing.
	const deferredRoomScopedTools: RegisteredToolLike[] = [];
	const originalRegisterTool = api.registerTool?.bind(pi);
	if (originalRegisterTool) {
		api.registerTool = (tool: RegisteredToolLike) => {
			deferredRoomScopedTools.push(tool);
		};
	}
	// The adapter's session handlers (its session start loads the config) see
	// the room connector folder as their cwd.
	const originalOn = api.on?.bind(pi);
	if (originalOn) {
		api.on = (event: string, handler: EventHandlerLike) => {
			originalOn(event, (eventValue: unknown, ctx: unknown) => handler(eventValue, withRoomConnectorConfigCwd(ctx)));
		};
	}
	// ...and its startup config read (direct tools, settings) uses the same
	// folder (scripts/patch-mcp-adapter.mjs, patch 6).
	const configCwdCarrier = pi as { exxpertsConnectorConfigCwd?: string };
	configCwdCarrier.exxpertsConnectorConfigCwd = roomConnectorConfigCwd();
	let result: unknown;
	try {
		result = await (register as (pi: unknown) => unknown)(pi);
	} finally {
		if (originalRegisterTool) api.registerTool = originalRegisterTool;
		if (originalOn) api.on = originalOn;
		delete configCwdCarrier.exxpertsConnectorConfigCwd;
	}
	if (originalRegisterTool) {
		const getAllTools = (pi as { getAllTools?: () => Array<{ name: string }> }).getAllTools?.bind(pi);
		const registrationOptions: RoomScopeRegistrationOptions = {
			...scopeOptions,
			...(getAllTools ? { getAllTools } : {}),
		};
		for (const tool of deferredRoomScopedTools) {
			const scoped = await roomScopedMcpToolRegistration(roomScopeId, tool, registrationOptions);
			if (scoped) originalRegisterTool(scoped);
		}
	}

	return result;
}
