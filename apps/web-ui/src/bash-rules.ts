export type PermissionAction = "ask" | "allow" | "deny";
export type PermissionRule = PermissionAction | Record<string, PermissionAction>;
export interface RoomPermissionDocument {
	permission: PermissionAction | Partial<Record<"skill" | "bash", PermissionRule>>;
}
export interface BashRuleRow { pattern: string; action: PermissionAction }
export interface RoomPermissionsResponse {
	exists: boolean;
	document: RoomPermissionDocument | null;
	error: string | null;
	bashRows: BashRuleRow[];
	/** Source-ordered skill entries; JS objects alone cannot retain numeric-key precedence. */
	skillRows: BashRuleRow[] | null;
	categoryOrder: ("skill" | "bash")[];
}

// Extract map entries from the response text, never from JSON.parse's reordered
// object keys. JSON.parse still validates syntax and supplies decoded values.
function orderedObjectEntries(source: string, start: number): { entries: [string, number][]; end: number } {
	let pos = start;
	const space = () => { while (/\s/.test(source[pos] ?? "")) pos++; };
	const stringEnd = () => {
		const begin = pos++;
		while (pos < source.length) {
			if (source[pos] === "\\") { pos += 2; continue; }
			if (source[pos++] === '"') return { value: JSON.parse(source.slice(begin, pos)) as string, end: pos };
		}
		throw new Error("Invalid permission response JSON.");
	};
	const valueEnd = (): number => {
		space();
		if (source[pos] === '"') return stringEnd().end;
		if (source[pos] === "{" || source[pos] === "[") {
			const stack = [source[pos++] === "{" ? "}" : "]"];
			while (stack.length && pos < source.length) {
				const char = source[pos];
				if (char === '"') { stringEnd(); continue; }
				if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
				else if (char === stack.at(-1)) stack.pop();
				pos++;
			}
			if (stack.length) throw new Error("Invalid permission response JSON.");
			return pos;
		}
		while (pos < source.length && !/[,}\]\s]/.test(source[pos])) pos++;
		return pos;
	};
	space();
	if (source[pos++] !== "{") throw new Error("Invalid permission response object.");
	const entries: [string, number][] = [];
	space();
	while (source[pos] !== "}") {
		const key = stringEnd().value;
		space();
		if (source[pos++] !== ":") throw new Error("Invalid permission response object.");
		space();
		entries.push([key, pos]);
		valueEnd();
		space();
		if (source[pos] === "}") break;
		if (source[pos++] !== ",") throw new Error("Invalid permission response object.");
		space();
	}
	return { entries, end: pos + 1 };
}

export function parsePermissionsResponse(text: string): RoomPermissionsResponse {
	const response = JSON.parse(text) as Omit<RoomPermissionsResponse, "bashRows" | "skillRows">;
	if (!response || typeof response !== "object" || !("document" in response) || !("error" in response)) throw new Error("Invalid permission response.");
	const result: RoomPermissionsResponse = { ...response, bashRows: [], skillRows: null, categoryOrder: [] };
	if (response.error || !response.document) return result;
	const root = orderedObjectEntries(text, 0);
	const documentStart = root.entries.filter(([key]) => key === "document").at(-1)?.[1];
	if (documentStart === undefined) throw new Error("Invalid permission response document.");
	const document = orderedObjectEntries(text, documentStart);
	const permissionStart = document.entries.filter(([key]) => key === "permission").at(-1)?.[1];
	if (permissionStart === undefined) throw new Error("Invalid permission response document.");
	const permission = response.document.permission;
	if (typeof permission === "string") {
		result.bashRows = [{ pattern: "*", action: permission }];
		return result;
	}
	const categories = orderedObjectEntries(text, permissionStart);
	result.categoryOrder = [...new Set(categories.entries.map(([key]) => key))].filter((key): key is "skill" | "bash" => key === "skill" || key === "bash");
	for (const category of ["skill", "bash"] as const) {
		const rule = permission[category];
		if (!rule) continue;
		if (typeof rule === "string") {
			if (category === "bash") result.bashRows = [{ pattern: "*", action: rule }];
			continue;
		}
		const ruleStart = categories.entries.filter(([key]) => key === category).at(-1)?.[1];
		if (ruleStart === undefined) throw new Error("Invalid permission response rule.");
		const ordered = [...new Set(orderedObjectEntries(text, ruleStart).entries.map(([pattern]) => pattern))].map((pattern) => ({ pattern, action: rule[pattern] }));
		if (category === "bash") result.bashRows = ordered;
		else result.skillRows = ordered;
	}
	return result;
}

export function serializeDocumentWithBashRows(response: RoomPermissionsResponse, rows: BashRuleRow[]): string {
	const current = response.document?.permission;
	const skill = typeof current === "string" ? current : current?.skill;
	const skillJson = typeof skill === "string" ? JSON.stringify(skill) : skill
		? `{${(response.skillRows ?? []).map(({ pattern, action }) => `${JSON.stringify(pattern)}:${JSON.stringify(action)}`).join(",")}}` : null;
	const bashJson = rows.length ? `{${rows.map(({ pattern, action }) => `${JSON.stringify(pattern)}:${JSON.stringify(action)}`).join(",")}}` : null;
	const categories: string[] = [];
	for (const category of [...response.categoryOrder, "skill", "bash"]) {
		if (category === "skill" && skillJson !== null && !categories.some((entry) => entry.startsWith('"skill":'))) categories.push(`"skill":${skillJson}`);
		if (category === "bash" && bashJson !== null && !categories.some((entry) => entry.startsWith('"bash":'))) categories.push(`"bash":${bashJson}`);
	}
	return `{"permission":{${categories.join(",")}}}`;
}

export function bashRowsError(rows: BashRuleRow[]): string | null {
	const seen = new Set<string>();
	for (const row of rows) {
		if (!row.pattern.trim()) return "A rule needs a pattern.";
		if (seen.has(row.pattern)) return `Pattern "${row.pattern}" is used twice.`;
		seen.add(row.pattern);
	}
	return null;
}
