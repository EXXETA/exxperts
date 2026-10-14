// The address of the screen the app shows, so Back and Forward move between
// Home, a room and Maintain as on a normal website, and a reload on a room's
// address opens that room again. The address lives in the hash: the server
// serves the one page at every path it knows, and a hash never reaches it.

export type AppRoute =
	| { screen: "home" }
	| { screen: "memory" }
	| { screen: "dashboard" }
	| { screen: "room"; agentId: string }
	| { screen: "maintain"; agentId: string };

export function appRouteHash(route: AppRoute): string {
	if (route.screen === "room" || route.screen === "maintain") return `#/${route.screen}/${encodeURIComponent(route.agentId)}`;
	return route.screen === "home" ? "#/" : `#/${route.screen}`;
}

/** The screen an address names; anything else is Home. */
export function parseAppRouteHash(hash: string): AppRoute {
	const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
	if ((parts[0] === "room" || parts[0] === "maintain") && parts[1]) {
		try {
			return { screen: parts[0], agentId: decodeURIComponent(parts[1]) };
		} catch {
			return { screen: "home" };
		}
	}
	if (parts[0] === "memory" || parts[0] === "dashboard") return { screen: parts[0] };
	return { screen: "home" };
}
