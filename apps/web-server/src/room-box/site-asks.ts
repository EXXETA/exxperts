import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";

import { classifyAddress } from "../../../../pi-package/extensions/fetch_url/address-class.js";
import { CLOSED_ON_PURPOSE, FREE_PRIVATE_REFUSAL } from "./card-text.js";

/**
 * The address side of a room's site decision, shared by the Mac's box
 * (box-session.ts) and the Windows box's proxy (windows/box-proxy.ts), which
 * carries it into the Windows worker's bundle: so it imports nothing of the
 * server's.
 */

/** An address in one spelling, by the URL parser: `192.168.1.5`, `::ffff:192.168.1.5` and `::ffff:c0a8:105` are one address. */
function oneSpelling(address: string): string {
	const bare = address.split("%")[0];
	return new URL(`http://[${net.isIPv4(bare) ? `::ffff:${bare}` : bare}]`).hostname;
}

/** A host as a connection would mean it: `127.1`, `2130706433` and `0x7f.0.0.1` are one address, and `localhost.` is `localhost`. Null for what no URL can hold. */
function canonicalHost(host: string): string | null {
	try {
		return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
	} catch {
		return null;
	}
}

const LOCAL_REFUSAL = `local addresses can't be reached from this room; ${CLOSED_ON_PURPOSE}`;

/** Whether an address is this computer's own or one no site has: loopback, unspecified, link-local, reserved, or an address of this computer's. */
function localAddress(address: string): boolean {
	const ownAddresses = new Set(Object.values(os.networkInterfaces()).flat().flatMap((entry) => (entry ? [oneSpelling(entry.address)] : [])));
	return ownAddresses.has(oneSpelling(address)) || ["loopback", "unspecified", "link-local", "reserved"].includes(classifyAddress(address));
}

/**
 * Where a room on Auto may not dial beyond the local addresses: the person's own
 * network and what `classifyAddress` calls reserved, as ranges for the Mac's
 * sandbox library, which refuses them at the dial on the address it checked
 * (the IPv6 forms that carry an IPv4 address included). Windows' proxy judges
 * each address with `publicOnlyRefusal` instead.
 */
const FREE_DENIED_RANGES: readonly string[] = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "224.0.0.0/3", "fc00::/7"];

/** Why a room on Auto can't reach a name that led to these addresses, or null when each is public. */
function publicOnlyRefusal(addresses: readonly string[]): string | null {
	if (addresses.some(localAddress)) return LOCAL_REFUSAL;
	return addresses.some((address) => classifyAddress(address) !== "public") ? FREE_PRIVATE_REFUSAL : null;
}

/**
 * Why a command can't reach this target, from its text alone, or null when a
 * person may be asked. Never a lookup: a command chooses the name, so looking it
 * up here would carry whatever it spells to that name's server before anyone has said yes.
 */
function siteRefusal(host: string): string | null {
	const name = canonicalHost(host);
	if (name === null) return "this isn't a site's name";
	if (net.isIP(name)) return localAddress(name) ? LOCAL_REFUSAL : "a raw address can't be reached from this room; use the site's name";
	return name === "localhost" || name.endsWith(".localhost") ? LOCAL_REFUSAL : null;
}

/**
 * Why a name a person or the room's list has allowed still can't be reached.
 * The library's guard refuses local addresses again at the dial, on the address
 * it connects to; this check is what tells the model why. Each side keeps its own
 * policy over the shared classes.
 */
async function addressRefusal(host: string): Promise<string | null> {
	const name = canonicalHost(host) as string;
	let addresses: string[];
	try {
		addresses = (await dns.lookup(name, { all: true })).map((entry) => entry.address);
	} catch {
		return `${name} did not resolve`;
	}
	return addresses.some(localAddress) ? LOCAL_REFUSAL : null;
}

export { addressRefusal, canonicalHost, FREE_DENIED_RANGES, LOCAL_REFUSAL, localAddress, oneSpelling, publicOnlyRefusal, siteRefusal };
