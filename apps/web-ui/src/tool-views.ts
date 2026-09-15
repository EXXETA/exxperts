/**
 * Human chip labels for the tools without a bespoke chip, matching the
 * web_search / fetch_url / mcp treatment: an emoji plus what the tool is doing
 * in user terms, never the internal tool name. Running gets the in-flight
 * form; done and error get the finished form (the status icon carries the
 * outcome). Shared with the spoken filler in conversation mode, so what the
 * room shows and what it says come from one table.
 */
export const GENERIC_TOOL_VIEWS: Record<string, { icon: string; running: string; done: string }> = {
	bash: { icon: "⌨️", running: "Running command", done: "Ran command" },
	read: { icon: "📄", running: "Reading file", done: "Read file" },
	write: { icon: "✏️", running: "Writing file", done: "Wrote file" },
	edit: { icon: "✏️", running: "Editing file", done: "Edited file" },
	ls: { icon: "📁", running: "Listing files", done: "Listed files" },
	find: { icon: "📁", running: "Finding files", done: "Found files" },
	grep: { icon: "🔎", running: "Searching files", done: "Searched files" },
	// The room's Files tools (persistent-room-shelf-tools.ts): a chip reading
	// "Read file" says what happened, where the raw name "read_file" only said
	// which tool did it.
	read_file: { icon: "📄", running: "Reading file", done: "Read file" },
	search_file: { icon: "🔎", running: "Searching file", done: "Searched file" },
	memory_recall: { icon: "🗄️", running: "Reading archived notes", done: "Read archived notes" },
	kb_search: { icon: "📚", running: "Searching knowledge base", done: "Searched knowledge base" },
	artifact_list: { icon: "🗂️", running: "Listing artifacts", done: "Listed artifacts" },
	artifact_read: { icon: "🗂️", running: "Reading artifact", done: "Read artifact" },
	artifact_write: { icon: "🗂️", running: "Writing artifact", done: "Wrote artifact" },
	artifact_write_html_deck: { icon: "🗂️", running: "Building deck", done: "Built deck" },
};

export function domainOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}
