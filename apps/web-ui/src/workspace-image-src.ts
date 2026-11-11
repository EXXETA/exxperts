// A Markdown image keeps the source its author wrote; only what the browser loads
// is rewritten. Relative sources resolve against the Markdown file, a leading
// slash means the workspace root, and anything above the root does not resolve.
export function workspaceImageUrl(agentId: string, conversationId: string, markdownPath: string, src: string): string | null {
	const source = src.trim();
	if (!source) return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith("//")) return null;
	const bare = source.split(/[?#]/, 1)[0];
	let decoded: string;
	try {
		decoded = decodeURIComponent(bare);
	} catch {
		decoded = bare;
	}
	const base = decoded.startsWith("/") ? [] : markdownPath.split("/").slice(0, -1);
	const segments = [...base];
	for (const segment of decoded.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return null;
			segments.pop();
		} else segments.push(segment);
	}
	if (segments.length === 0) return null;
	const query = new URLSearchParams({ conversationId, path: segments.join("/") });
	return `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-image?${query}`;
}
