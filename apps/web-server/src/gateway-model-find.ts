// After a saved gateway's bare "not found", one look at its own model list
// says which of three things happened: the model is no longer listed, the
// list is not found at the saved address either, or the model is listed and
// its call still failed. A list that cannot be read says none of them.
//
// The look is the gateway's /models alone, with the address and key the
// room's calls use, under a short timeout of its own, and redirects are never
// followed. One read per gateway serves every room and every Memory model
// call that meets the same failure for a while, so many people stuck on the
// same 404 do not flood the gateway. Only the outcome is kept, never the
// gateway's words or its list.

import { AuthStorage } from "@exxeta/exxperts-runtime";
import type { GatewayFind } from "../../web-ui/src/turn-failure-line.js";
import { readGatewayProviderBaseUrl } from "./openai-compatible-gateway-catalog.js";
import { listGatewayModelIds, normalizeGatewayBaseUrl } from "./openai-compatible-gateway-detect.js";
import { readOpenAiCompatibleGateways } from "./openai-compatible-gateways.js";
import { serverStopping } from "./server-stop.js";

/** Long enough for a gateway that answers at all, short enough that a failure line is never held up for long. */
const READ_TIMEOUT_MS = 4_000;
/** How long one read answers for its gateway. */
const READ_KEPT_MS = 60_000;
/** How often a read in flight looks whether the server began to stop. */
const STOP_LOOK_MS = 200;

type ListRead = { ids: ReadonlySet<string> } | { status?: number };

const reads = new Map<string, { at: number; read: Promise<ListRead> }>();

/** What the gateway's list says about the model; "unread" for a provider that is no saved gateway, or while the server stops. */
export async function gatewayModelFind(provider: string, model: string): Promise<GatewayFind> {
	if (serverStopping()) return "unread";
	let gateway;
	try {
		gateway = readOpenAiCompatibleGateways().gateways.find((entry) => entry.providerId === provider);
	} catch {
		return "unread";
	}
	if (!gateway) return "unread";
	// The address the room's calls go to, from the catalog; the saved gateway's own as a fallback.
	let address = "";
	try {
		address = readGatewayProviderBaseUrl(provider);
	} catch {}
	const baseUrl = normalizeGatewayBaseUrl(address || gateway.baseUrl || "");
	const slot = `${provider}\u0000${baseUrl}`;
	let kept = reads.get(slot);
	if (!kept || Date.now() - kept.at > READ_KEPT_MS) {
		kept = { at: Date.now(), read: readList(provider, baseUrl).catch((): ListRead => ({})) };
		reads.set(slot, kept);
	}
	const read = await kept.read;
	if ("ids" in read) return read.ids.has(model) ? "model-listed" : "model-gone";
	return read.status === 404 ? "address" : "unread";
}

/** A gateway's key or address was saved again, or the gateway went: its next failure reads the list again, since a key can carry its own list. */
export function forgetGatewayModelFind(provider: string): void {
	for (const slot of reads.keys()) if (slot.startsWith(`${provider}\u0000`)) reads.delete(slot);
}

async function readList(provider: string, baseUrl: string): Promise<ListRead> {
	if (!/^https?:\/\//.test(baseUrl)) return {};
	const key = await AuthStorage.create().getApiKey(provider).catch(() => undefined);
	if (!key) return {};
	const stop = new AbortController();
	const look = setInterval(() => { if (serverStopping()) stop.abort(); }, STOP_LOOK_MS);
	try {
		return await listGatewayModelIds(baseUrl, key, { timeoutMs: READ_TIMEOUT_MS, signal: stop.signal });
	} catch {
		return {};
	} finally {
		clearInterval(look);
	}
}
