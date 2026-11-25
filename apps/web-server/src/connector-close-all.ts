/**
 * A removed connector stops everywhere at once: its questions still waiting for
 * an answer close with nothing sent (their calls read as removed), its running
 * calls end as "removed" with a cancel to the connector (connector-call-ends.ts),
 * then its connection closes in every conversation, its program with it, and
 * none connects it again there. The adapter keeps its managers and its running
 * calls where this reads them (scripts/patch-mcp-adapter.mjs, patches 21 and 22).
 */
import { endConnectorQuestions } from "../../../pi-package/extensions/mcp/room-scope.js";

/** The adapter's registries, as patches 21 and 22 put them on globalThis. */
interface AdapterRegistries {
	exxpertsConnectorManagers?: Set<{ endConnector(name: string): Promise<void>; close(name: string): Promise<void> }>;
	exxpertsConnectorCalls?: Map<string, Set<() => void>>;
}

/**
 * Closes the connector's open connections in every conversation, which may
 * connect it again at their next use: after a sign-out or an address change, a
 * connection made before it no longer writes its saved entry back.
 */
export async function closeConnectorConnections(name: string): Promise<void> {
	const registries = globalThis as AdapterRegistries;
	await Promise.all([...(registries.exxpertsConnectorManagers ?? [])].map((manager) => manager.close(name).catch(() => {})));
}

export async function closeConnectorEverywhere(name: string): Promise<void> {
	endConnectorQuestions(name);
	const registries = globalThis as AdapterRegistries;
	for (const endCall of [...(registries.exxpertsConnectorCalls?.get(name) ?? [])]) endCall();
	await Promise.all([...(registries.exxpertsConnectorManagers ?? [])].map((manager) => manager.endConnector(name).catch(() => {})));
}
