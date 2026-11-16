import * as net from "node:net";

/**
 * What kind of address an IP is. One classification for every guard that
 * decides by address; each guard keeps its own policy over these classes:
 * fetch_url refuses everything but "public", a room's commands refuse
 * loopback, unspecified and link-local and keep a card for a private name,
 * and a connector at a loopback or unspecified address gets no lasting yes.
 */
export type AddressClass = "public" | "private" | "loopback" | "unspecified" | "link-local" | "reserved";

function classifyIpv4(ip: string): AddressClass {
	const parts = ip.split(".").map((n) => Number(n));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return "reserved";
	const [a, b] = parts;
	if (a === 0) return "unspecified"; // 0.0.0.0/8
	if (a === 127) return "loopback";
	if (a === 169 && b === 254) return "link-local"; // incl. 169.254.169.254 metadata
	if (a === 10) return "private"; // 10.0.0.0/8
	if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
	if (a === 192 && b === 168) return "private"; // 192.168.0.0/16
	if (a === 100 && b >= 64 && b <= 127) return "private"; // 100.64.0.0/10 CGNAT
	if (a >= 224) return "reserved"; // multicast + reserved
	return "public";
}

// Expand an IPv6 literal into its 8 16-bit groups. Handles "::" compression,
// a trailing embedded dotted IPv4 ("::ffff:1.2.3.4"), and zone suffixes.
// Returns null when the address is not parseable.
function parseIpv6Groups(ip: string): number[] | null {
	let addr = ip.toLowerCase().replace(/^\[|\]$/g, "");
	const zone = addr.indexOf("%");
	if (zone !== -1) addr = addr.slice(0, zone);
	const dotted = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (dotted) {
		const parts = dotted[1].split(".").map((n) => Number(n));
		if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
		const hexTail = `${(((parts[0] << 8) | parts[1]) >>> 0).toString(16)}:${(((parts[2] << 8) | parts[3]) >>> 0).toString(16)}`;
		addr = addr.slice(0, addr.length - dotted[1].length) + hexTail;
	}
	const halves = addr.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	if (halves.length === 2 ? head.length + tail.length > 7 : head.length !== 8) return null;
	const fill = halves.length === 2 ? new Array(8 - head.length - tail.length).fill("0") : [];
	const groups: number[] = [];
	for (const g of [...head, ...fill, ...tail]) {
		if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
		groups.push(Number.parseInt(g, 16));
	}
	return groups;
}

function classifyIpv6(ip: string): AddressClass {
	const groups = parseIpv6Groups(ip);
	if (!groups) return "reserved"; // unparseable → refuse
	// IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) addresses embed a
	// v4 address in the low 32 bits; judge that v4 in ANY spelling — `new URL()`
	// normalises "[::ffff:169.254.169.254]" to the hex form "::ffff:a9fe:a9fe",
	// so matching only the dotted spelling is bypassable. "::1" and "::" are
	// loopback and unspecified in their own right.
	if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
		if (groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return "loopback";
		return classifyIpv4(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`);
	}
	if ((groups[0] & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
	if ((groups[0] & 0xfe00) === 0xfc00) return "private"; // unique local fc00::/7
	return "public";
}

/** The class of an IP literal; anything that is not a recognisable IP reads "reserved", which every policy refuses. */
export function classifyAddress(ip: string): AddressClass {
	const kind = net.isIP(ip);
	if (kind === 4) return classifyIpv4(ip);
	if (kind === 6) return classifyIpv6(ip);
	return "reserved";
}
