/**
 * What a room's connection tells a connector it can do, for a connection that
 * only lists: the Connectors page's check (mcp-admin.ts) and a room's warm-up
 * (pi-package/extensions/mcp/room-scope.ts). A room declares forms
 * (pi-mcp-adapter's init.ts), and some connectors offer more tools to a client
 * that declares them, so these declare the same, honouring the setting that
 * switches forms off. A form is declined, so a listing never asks anyone. No
 * connection offers a connector the model (scripts/patch-mcp-adapter.mjs,
 * patch 29).
 */

/** The setter of pi-mcp-adapter's McpServerManager this calls. */
interface ManagerDeclarations {
	setElicitationConfig(config: unknown): void;
}

/** The adapter's setting this reads: `elicitation: false` switches forms off, as in a room. */
interface AbilitySettings {
	elicitation?: unknown;
}

export function declareRoomAbilities(manager: ManagerDeclarations, settings: AbilitySettings | undefined): void {
	if (settings?.elicitation !== false) manager.setElicitationConfig({ ui: { select: async () => "Decline" }, allowUrl: false });
}
