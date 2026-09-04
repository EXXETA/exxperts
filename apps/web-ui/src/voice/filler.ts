import { GENERIC_TOOL_VIEWS, domainOf } from "../tool-views";

/**
 * The small talk of conversation mode: what the app says on its own behalf
 * while the model is silent. Spoken only, never written into the room, which
 * is why it is generated here from things the client already knows (the tool
 * chips) instead of being asked of the model.
 *
 * Pure: the timing lives in the conversation controller, the words live here,
 * and the smoke checks the words.
 */

export type SpokenLanguage = "de" | "en";
export type ToolCall = { name: string; args?: Record<string, unknown> };

const GERMAN = new Set(["der", "die", "das", "und", "ist", "nicht", "ich", "mit", "für", "auf", "ein", "eine", "sie", "wir", "zu", "sind", "im", "den", "auch", "es", "bitte", "was", "wie"]);
const ENGLISH = new Set(["the", "and", "is", "not", "i", "with", "for", "on", "a", "an", "you", "we", "to", "of", "it", "are", "in", "that", "this", "have", "please", "what", "how"]);

/** German or English from the words a sentence cannot do without; the fallback when they tie. */
export function guessLanguage(text: string, fallback: SpokenLanguage = "en"): SpokenLanguage {
	let de = 0;
	let en = 0;
	for (const word of text.toLowerCase().split(/[^a-zäöüß]+/)) {
		if (GERMAN.has(word)) de++;
		if (ENGLISH.has(word)) en++;
	}
	if (de === en) return fallback;
	return de > en ? "de" : "en";
}

const ACKNOWLEDGEMENTS: Record<SpokenLanguage, string[]> = {
	de: ["Okay.", "Verstanden.", "Einen Moment.", "Gut."],
	en: ["Okay.", "Got it.", "One moment.", "Sure."],
};

type Kind = "search" | "page" | "knowledge" | "specialist" | "connector" | "document" | "files" | "other";

/** Memory housekeeping is silent, as it is hidden on screen too. */
function kindOf(name: string): Kind | null {
	if (name.startsWith("memory_")) return null;
	if (name === "web_search") return "search";
	if (name === "fetch_url") return "page";
	if (name.startsWith("kb_")) return "knowledge";
	if (name === "delegate_task" || name.startsWith("consult")) return "specialist";
	if (name === "mcp" || name.startsWith("mcp_") || name.startsWith("graph_")) return "connector";
	if (name.startsWith("artifact_") || name === "write_markdown_file") return "document";
	if (["bash", "read", "write", "edit", "ls", "find", "grep", "read_spreadsheet"].includes(name)) return "files";
	return "other";
}

const LABELS: Record<Kind, Record<SpokenLanguage, string>> = {
	search: { de: "Suche im Web", en: "Searching the web" },
	page: { de: "Lese eine Seite", en: "Reading a page" },
	knowledge: { de: "Wissensbasis", en: "Knowledge base" },
	specialist: { de: "Spezialist", en: "Specialist" },
	connector: { de: "Connector", en: "Connector" },
	document: { de: "Dokument", en: "Document" },
	files: { de: "Dateien", en: "Files" },
	other: { de: "Arbeite", en: "Working" },
};

function phrase(kind: Kind, call: ToolCall, lang: SpokenLanguage): string {
	const args = call.args ?? {};
	switch (kind) {
		case "search": {
			const query = String(args.query ?? "").trim().slice(0, 80);
			if (lang === "de") return query ? `ich suche im Web nach „${query}“.` : "ich suche im Web.";
			return query ? `searching the web for "${query}".` : "searching the web.";
		}
		case "page": {
			const domain = domainOf(String(args.url ?? ""));
			if (lang === "de") return domain ? `ich lese eine Seite von ${domain}.` : "ich lese die Seite.";
			return domain ? `reading a page from ${domain}.` : "reading the page.";
		}
		case "knowledge": return lang === "de" ? "ich schaue in der Wissensbasis nach." : "checking the knowledge base.";
		case "specialist": return lang === "de" ? "ich gebe das an einen Spezialisten weiter." : "handing this to a specialist.";
		case "connector": return lang === "de" ? "ich frage einen Connector." : "asking a connector.";
		case "document": return lang === "de" ? "ich arbeite am Dokument." : "working on the document.";
		case "files": return lang === "de" ? "ich arbeite an den Dateien." : "working on the files.";
		default: {
			const view = GENERIC_TOOL_VIEWS[call.name];
			if (lang === "de" || !view) return lang === "de" ? "ich arbeite daran." : "working on it.";
			return `${view.running.charAt(0).toLowerCase()}${view.running.slice(1)}.`;
		}
	}
}

/**
 * One turn's worth of decisions. The app speaks only while the model has said
 * nothing, once per kind of tool, and never repeats an "Okay" it already gave.
 */
export class FillerPlanner {
	private spoke = false;
	private acked = false;
	private announced = new Set<Kind>();
	private ackIndex = 0;

	startTurn(): void {
		this.spoke = false;
		this.acked = false;
		this.announced.clear();
	}

	/** The model produced text: from here on the answer speaks for itself. */
	onModelText(): void {
		this.spoke = true;
	}

	get quiet(): boolean {
		return !this.spoke;
	}

	/** Two words for a silence, rotating so a long session does not sound like a loop. */
	acknowledgement(lang: SpokenLanguage): string {
		this.acked = true;
		const list = ACKNOWLEDGEMENTS[lang];
		return list[this.ackIndex++ % list.length];
	}

	/** What to say, if anything, when these tools start; and the label the bar shows meanwhile. */
	planForTools(calls: ToolCall[], lang: SpokenLanguage): { speak: string | null; label: string | null } {
		let first: { call: ToolCall; kind: Kind } | null = null;
		for (const call of calls) {
			const kind = kindOf(call.name);
			if (kind) { first = { call, kind }; break; }
		}
		if (!first) return { speak: null, label: null };
		const label = LABELS[first.kind][lang];
		if (this.spoke || this.announced.has(first.kind)) return { speak: null, label };
		const opening = !this.acked && this.announced.size === 0;
		this.announced.add(first.kind);
		const line = phrase(first.kind, first.call, lang);
		return { speak: opening ? `Okay, ${line}` : `${line.charAt(0).toUpperCase()}${line.slice(1)}`, label };
	}
}
