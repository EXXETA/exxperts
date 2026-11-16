/**
 * The room's web reader asks before it opens an address the person didn't
 * give. One function decides, before any name lookup: what no yes could open
 * is refused; an address in one of the person's own messages or a search
 * result the conversation holds opens freely; so does one free by its site:
 * on the room's list, or named in the message she started this answer with.
 * The hook adds this answer's yeses for its site, and keeps an address she
 * declined in this answer declined; anything else gets a card. With nobody
 * there to answer, it is refused and nothing is saved for later: a saved
 * request would replay an address the model built. A shared server keeps the
 * reader's earlier rules (see the hook).
 *
 * A redirect to another host or port is followed only for an address free by
 * itself (her message, a search result), never for one free by its site: the
 * model may have built that path, and an open redirect on the site could
 * carry the conversation's words out.
 *
 * The conversation is read at each call from the saved entries on its active
 * branch, never from the shortened context, so a reloaded, resumed or
 * shortened conversation decides the same way.
 */

import { effectivePort, FOLLOWS_OTHER_HOSTS, refusedWithoutLookup, withoutFragment } from "../../../pi-package/extensions/fetch_url/index.js";
import { withoutAnswerNote } from "./cut-answer-note.js";
import { isAppPromptMark, withoutEditNote } from "./edit-last-message.js";
import { userAuthoredPromptText } from "./persistent-room-delegate-tool.js";
import { RESTORED_CONTEXT_CLOSE, RESTORED_CONTEXT_OPEN } from "./persistent-room-resume-context.js";
import { addAlsoAllowedSite, type AlsoAllowedSite, AnswerSites, coversSite, readAlsoAllowed } from "./room-box/also-allowed.js";
import { SITE_REQUESTS_PER_TURN, type BoxWatcher, type SiteChoice } from "./room-box/box-session.js";
import { NOBODY_TO_OPEN_PAGE, PAGE_DECLINED } from "./room-box/card-text.js";
import { isSharedServer, serverHooks } from "./server-hooks.js";
import { QuestionDeclined, type SiteApply } from "./web-ui-context.js";

export type WebAddressVerdict =
	| { kind: "refused"; reason: string }
	// In her own message or a search result.
	| { kind: "free"; by: "address" }
	// Its site is on the room's list or one she named; the hook still checks her declines first.
	| { kind: "free"; by: "site"; address: string; host: string; port: number }
	| { kind: "card"; address: string; host: string; port: number };

/** The saved entries of a conversation's active branch, as the session manager gives them. */
type BranchEntry = { id?: string; type?: string; customType?: string; message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean; details?: unknown; sources?: unknown; rawContent?: unknown } };

/** An address as the comparison sees it: parsed, normalised and with no fragment. Null for what isn't one. */
function addressKey(raw: string): string | null {
	try {
		return withoutFragment(new URL(raw));
	} catch {
		return null;
	}
}

function textParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("\n");
}

/**
 * The person's own words in a user message: the restored excerpt of an
 * earlier conversation, the notes after a cut, a Stop or an edit, and what the
 * page put in front of the typed text (a consult's handed-over answer, a file
 * note) are cut. The excerpt is cut to its last close line, so a close line
 * quoted inside it can't end it early; cutting more can only ask more.
 */
export function personsOwnText(wire: string): string {
	let text = wire.replace(/\r\n/g, "\n");
	if (text.startsWith(`${RESTORED_CONTEXT_OPEN}\n`)) {
		const close = text.lastIndexOf(`\n${RESTORED_CONTEXT_CLOSE}`);
		text = close < 0 ? "" : text.slice(close + RESTORED_CONTEXT_CLOSE.length + 1);
	}
	return userAuthoredPromptText(withoutEditNote(withoutAnswerNote(text.trimStart())));
}

// A run of characters an address can hold, from its scheme on: an apostrophe or a bracket can be part of it. What follows it in a sentence is cut below.
const ADDRESS_IN_TEXT = /https?:\/\/[^\s<>"`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}*_'"]$/;

// In an address that opens with a single quote, the quote that closes it: one with only a sentence's punctuation after it, or one before a list's punctuation. An apostrophe before a letter is the address's own.
const CLOSING_QUOTE = /'(?=[.,;:!?)\]}*_"]*$|[,;)\]}])/g;
const SCHEME = /https?:\/\//gi;

/** The addresses written in the text, as runs from their scheme on. One that opens with a single quote ends at its closing quote, so each address in a quoted list is its own. One pass, forward only. */
function addressesIn(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(ADDRESS_IN_TEXT)) {
		const run = match[0];
		let from = 0;
		let quoted = text[match.index - 1] === "'";
		for (;;) {
			CLOSING_QUOTE.lastIndex = from;
			const close = quoted ? CLOSING_QUOTE.exec(run) : null;
			if (!close) {
				found.push(run.slice(from));
				break;
			}
			found.push(run.slice(from, close.index));
			SCHEME.lastIndex = close.index;
			const next = SCHEME.exec(run);
			if (!next) break;
			quoted = run[next.index - 1] === "'";
			from = next.index;
		}
	}
	return found;
}

/** Whether this address, by its key, is written in the text: each candidate is tried with the punctuation a sentence puts after it cut, one character at a time. */
function textHolds(text: string, key: string): boolean {
	for (const candidate of addressesIn(text)) {
		let tried = candidate;
		for (;;) {
			if (addressKey(tried) === key) return true;
			if (!TRAILING_PUNCTUATION.test(tried)) break;
			tried = tried.slice(0, -1);
		}
	}
	return false;
}

// File endings people type that would read as a site's last label: a file's name names no site. Endings that are also many sites' own (ai, io, app, co, dev, me, tv) are left out.
const FILE_ENDINGS = new Set([
	"md", "markdown", "txt", "rtf", "pdf", "doc", "docx", "odt", "xls", "xlsx", "ods", "csv", "tsv", "ppt", "pptx", "odp", "key", "pages", "numbers",
	"json", "yaml", "yml", "toml", "xml", "html", "htm", "css", "scss", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "ipynb", "rb", "pl", "php", "java", "kt",
	"swift", "go", "rs", "cc", "cpp", "cs", "sh", "zsh", "bash", "ps", "sql", "log", "ini", "cfg", "conf", "env", "lock", "bak", "tmp",
	"zip", "tar", "gz", "tgz", "rar", "dmg", "pkg", "exe", "msi", "so", "dylib", "dll", "jar",
	"png", "jpg", "jpeg", "gif", "svg", "webp", "heic", "tif", "tiff", "bmp", "ico", "wav", "mov", "avi", "mkv", "webm", "eml", "msg", "ics", "vcf",
]);
// The punctuation a sentence puts after an address, all of it: a comma can stand in a host.
const SENTENCE_AFTER = /[.,;:!?)\]}*_'"]+$/;
// An @ in each of its forms: the ASCII one, the full-width one and the small one.
const AT_SIGN = /[@\uFF20\uFE6B]/;
// What may stand around a bare name in a sentence: brackets, quotes and emphasis before it; those, a possessive and the sentence's punctuation after it.
const BEFORE_NAME = /^[([{<"'`*_]+/;
const AFTER_NAME = /(?:[)\]}>"'`*_]*['’]s)?[)\]}>"'`*_.,;:!?]*$/;
// A bare name: labels of letters, digits and hyphens joined by dots, the last of two or more letters.
const BARE_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.([a-z]{2,})$/;

/**
 * The sites the person names in her own text, ports 80 and 443 alone: the host
 * of each address she wrote on a web port, and each bare name: a word that is
 * the name alone, with only what a sentence puts around it. A message that
 * holds an @ in any of its forms names none: an e-mail address can be written
 * in more ways than a reading of it can follow, so no way of writing one frees
 * a site (an address written out in it still opens by itself). A word with a
 * `/` or a `\` in it is a path, never a name.
 */
export function namedSites(text: string): AlsoAllowedSite[] {
	if (AT_SIGN.test(text)) return [];
	const hosts = new Set<string>();
	for (const candidate of addressesIn(text)) {
		try {
			const url = new URL(candidate.replace(SENTENCE_AFTER, ""));
			if (effectivePort(url) === 80 || effectivePort(url) === 443) hosts.add(url.hostname);
		} catch {
			// Not an address after all.
		}
	}
	// An address's own words are its path and query, never a name.
	for (const word of text.replace(ADDRESS_IN_TEXT, " ").toLowerCase().split(/\s+/)) {
		const name = word.replace(BEFORE_NAME, "").replace(AFTER_NAME, "");
		const ending = BARE_NAME.exec(name)?.[1];
		if (ending && !FILE_ENDINGS.has(ending)) hosts.add(name);
	}
	return [...hosts].map((host) => ({ host, port: 443 }));
}

/** Whose messages name sites that free their pages: none, the last user message, or every message after this entry (null: all of them). */
export type NamesFrom = "none" | "last" | { after: string | null };

function urlsOf(list: unknown): string[] {
	return Array.isArray(list) ? list.flatMap((item) => (item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string" ? [(item as { url: string }).url] : [])) : [];
}

/**
 * The addresses a web search returned in this conversation, as far as its
 * messages hold them: the room's own search tool's results, the citations and
 * sources a provider's search tied to an answer, and the results Anthropic's
 * search keeps in the raw blocks. A provider that keeps only what it cited
 * holds no uncited result, which then asks.
 */
function searchResultUrls(message: NonNullable<BranchEntry["message"]>): string[] {
	if (message.role === "toolResult") {
		if (message.toolName !== "web_search" || message.isError === true) return [];
		return urlsOf((message.details as { results?: unknown } | undefined)?.results);
	}
	if (message.role !== "assistant") return [];
	const content = Array.isArray(message.content) ? message.content : [];
	const raw = Array.isArray(message.rawContent) ? message.rawContent : [];
	return [
		...content.flatMap((part) => (part?.type === "text" ? urlsOf(part.citations) : [])),
		...urlsOf(message.sources),
		...raw.flatMap((block) => (block?.type === "web_search_tool_result" ? urlsOf(block.content) : [])),
	];
}

/**
 * Free, a card, or refused, for one address in this conversation and room. Runs no name lookup.
 * `names`: which of her messages name sites whose pages are free, never one the app sent.
 */
export function judgeWebAddress(raw: string, branch: readonly BranchEntry[], roomSites: readonly AlsoAllowedSite[], names: NamesFrom = "none"): WebAddressVerdict {
	const refused = refusedWithoutLookup(raw);
	if (refused) return { kind: "refused", reason: refused };
	const url = new URL(raw);
	const key = withoutFragment(url);
	const host = url.hostname;
	const port = effectivePort(url);
	// A prompt the server sent by itself, as the request for a missing answer, holds tool output: it is never hers.
	let appPrompt = false;
	// Her own text of the last user message, or of each one in this answer; empty where the app sent it.
	let lastOwnText = "";
	const answerTexts: string[] = [];
	// This answer's first entry; past the end where the entry it follows is not on this branch.
	const answerFrom = typeof names !== "object" ? branch.length : names.after === null ? 0 : (() => {
		const at = branch.findIndex((entry) => entry.id === names.after);
		return at < 0 ? branch.length : at + 1;
	})();
	for (const [index, entry] of branch.entries()) {
		if (isAppPromptMark(entry)) appPrompt = true;
		const message = entry.type === "message" ? entry.message : undefined;
		if (!message) continue;
		const fromApp = appPrompt;
		appPrompt = false;
		if (message.role === "user") {
			lastOwnText = fromApp ? "" : personsOwnText(textParts(message.content));
			if (index >= answerFrom) answerTexts.push(lastOwnText);
			if (textHolds(lastOwnText, key)) return { kind: "free", by: "address" };
		}
		if (searchResultUrls(message).some((found) => addressKey(found) === key)) return { kind: "free", by: "address" };
	}
	const site = { host, port };
	const namedTexts = names === "none" ? [] : names === "last" ? [lastOwnText] : answerTexts;
	if (coversSite(roomSites, site) || namedTexts.some((text) => coversSite(namedSites(text), site))) return { kind: "free", by: "site", address: key, host, port };
	return { kind: "card", address: key, host, port };
}

/** The slice of the room's question bridge the web reader asks with. */
export interface WebReaderQuestions {
	watcher(): BoxWatcher;
	/** `apply` stores a yes before the card says so; the answer still decides on its own whether the page opens. */
	askSite(card: { host: string; port: number; lasting: boolean; address: string }, apply: SiteApply): Promise<{ choice: SiteChoice; answeredBy: BoxWatcher }>;
}

interface WebReaderExtensionApi {
	on(event: "agent_start", handler: () => void): void;
	on(event: "tool_call", handler: (event: any, ctx: any) => Promise<{ block: boolean; reason: string } | undefined>): void;
}

/**
 * The hook on `fetch_url` calls, as the command card hooks `bash`: it runs
 * before the tool's own code, so the judgement comes before any name lookup.
 * `questions` is null where nobody can be asked, as in a scheduled run.
 * `answer` is the running answer's sites, which its commands' yeses fill too;
 * without it, each run of the model keeps its own. `free`: the room is on Auto
 * (`roomReachesFreely`, or `unprotectedRoomOnAuto` without protection), read at
 * each call, so what would ask opens, as an address free by itself does; the
 * tool's own refusals still hold. Never on a shared server.
 */
export function createRoomWebReaderExtension(options: { roomId: string; questions: WebReaderQuestions | null; answer?: () => AnswerSites; free?: () => boolean }) {
	return function roomWebReader(pi: WebReaderExtensionApi) {
		// The addresses this turn has put on a card, so a loop can't fill the room with them.
		let cardsThisTurn = new Set<string>();
		let ownSites = new AnswerSites();
		pi.on("agent_start", () => {
			cardsThisTurn = new Set();
			ownSites.end();
			ownSites = new AnswerSites();
		});
		pi.on("tool_call", async (event: any, ctx: any) => {
			if (event?.toolName !== "fetch_url") return undefined;
			const raw = typeof event?.input?.url === "string" ? event.input.url.trim() : "";
			const branch: BranchEntry[] = ctx?.sessionManager?.getBranch?.() ?? [];
			// A shared server can't show the room's site list or take a site off it yet, so it borrows the
			// stored-workspace-settings answer: no stored site counts there, and no yes adds one. The file stays as it is.
			const noStoredSites = serverHooks().ignoresStoredWorkspaceSettings?.() === true;
			// A shared server keeps the reader's earlier rules: a page's yes opens that call alone, no command's yes reaches a page, and a named site frees nothing.
			const shared = isSharedServer();
			const answer = (!shared && options.answer?.()) || ownSites;
			// The sites she names count from this answer's first message where the answer says where that is, else from her last.
			const startsAfter = answer.messagesAfter();
			const names: NamesFrom = shared ? "none" : startsAfter === undefined ? "last" : { after: startsAfter };
			const verdict = judgeWebAddress(raw, branch, noStoredSites ? [] : readAlsoAllowed(options.roomId).sites, names);
			if (verdict.kind === "refused") return { block: true, reason: verdict.reason };
			if ((verdict.kind === "free" && verdict.by === "address") || (!shared && options.free?.() === true)) {
				// The runtime hands this same input to the tool.
				event.input[FOLLOWS_OTHER_HOSTS] = true;
				return undefined;
			}
			const declined = { block: true, reason: `${PAGE_DECLINED} Don't open it or a variant of it unless the person asks.` };
			// Free by its site, and never followed to another site; an address she declined in this answer stays declined, whatever its site was given since.
			if (verdict.kind === "free" || (!shared && answer.pagesReach(verdict))) return answer.pageDeclined(verdict.address) ? declined : undefined;
			const { questions } = options;
			const watcher = questions?.watcher() ?? "none";
			if (!questions || watcher === "none") return { block: true, reason: NOBODY_TO_OPEN_PAGE };
			if (answer.pageDeclined(verdict.address)) return declined;
			if (!cardsThisTurn.has(verdict.address) && cardsThisTurn.size >= SITE_REQUESTS_PER_TURN) {
				return { block: true, reason: "Too many addresses were asked for in this turn, so this one was not opened. The person can send it in a message." };
			}
			cardsThisTurn.add(verdict.address);
			// A Stop, a person who left or the turn's end rejects the card; the runtime gives that sentence as the call's error.
			// Only the computer changes the room's list; a phone's yes covers the site's pages for this answer. On a shared
			// server the card offers no room yes, and any yes that arrives opens this call alone and stores nothing.
			const apply: SiteApply = (choice, answeredBy) => {
				if (choice !== "room" || answeredBy !== "computer" || noStoredSites) {
					if (!shared) answer.give(verdict, "pages");
					return "once";
				}
				addAlsoAllowedSite(options.roomId, verdict.host, verdict.port);
				return "room";
			};
			const { choice } = await questions.askSite({ host: verdict.host, port: verdict.port, lasting: watcher === "computer" && !noStoredSites, address: verdict.address }, apply).catch((error: unknown) => {
				// A message sent instead of an answer is her no to this address; a Stop or a person who left is not.
				if (error instanceof QuestionDeclined) answer.declinePage(verdict.address);
				throw error;
			});
			if (choice === "decline") {
				answer.declinePage(verdict.address);
				return declined;
			}
			return undefined;
		});
	};
}
