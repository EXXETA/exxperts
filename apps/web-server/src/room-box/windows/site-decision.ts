import { addAlsoAllowedSite, AnswerSites, coversSite, readAlsoAllowed, sameSite } from "../also-allowed.js";
import type { SiteAnswer, SiteAsk, SiteAskHow } from "../box-process.js";
import { type BoxQuestions, SITE_REQUESTS_PER_TURN } from "../box-session.js";
import { WINDOWS_CERTIFICATE_CHECK, WINDOWS_SITE_DECLINED, WINDOWS_SITE_NOBODY_THERE, WINDOWS_SITE_STOPPED, WINDOWS_SITE_TOO_MANY, WINDOWS_SITE_TURN_ENDED, WINDOWS_SITE_UNANSWERED, windowsSiteRefusedLine } from "./model-lines.js";
import { QuestionDeclined, type SiteApply } from "../../web-ui-context.js";
import type { WorkerSites } from "./start-check.js";

/**
 * A Windows room's decision on each site its commands ask for, by the Mac's
 * rules (`permission` and `askPerson` in ../box-session.ts): this answer's yes,
 * the room's list, then one card per site with its three answers, where only
 * the computer's "for this room" adds to the list and a phone's yes lasts for
 * the answer. Nobody there, past the cap of cards in a turn, or after the turn's
 * end, the site is refused. What the proxy refuses on its own, before or after
 * a yes (a local address, a raw one), comes back through `refused` as well, so
 * every refusal becomes one line after its command.
 *
 * On Windows a command's programs end with it, so a card lives only while a
 * connection waits for it: it closes unanswered when the last one has gone, or
 * when a command ends and no other runs. A no holds for the site until no
 * command runs. Windows' own certificate checks never raise a card.
 */

type Card = {
	host: string;
	answer: Promise<SiteAnswer>;
	/** Connections waiting for the answer now. */
	waiting: number;
	/** Asked by a caller that can't say it has gone: only a command's end or the turn's closes it. */
	held: boolean;
	/** Aborted when it closes unanswered, which closes its question alone. */
	close: AbortController;
};

type Turn = {
	ended: boolean;
	/** This turn's yeses, where the answer's own aren't given. */
	sites: AnswerSites;
	openCards: Map<string, Card>;
	cards: Set<string>;
	refusals: Set<string>;
	/** Certificate checks refused since the last command's end, by host: said only after a command that failed. */
	checks: Set<string>;
	/** Sites the person said no to: refused without a card until no command runs. */
	declined: SiteAsk[];
	/** Commands running now. */
	running: number;
};

const freshTurn = (): Turn => ({ ended: false, sites: new AnswerSites(), openCards: new Map(), cards: new Set(), refusals: new Set(), checks: new Set(), declined: [], running: 0 });

export interface WindowsSites extends WorkerSites {
	/**
	 * A command starts. The function it gives is that command's end: the refusal
	 * lines since the last time, each once, certificate checks only after a
	 * command that failed. With no other command of the turn running, every open
	 * card closes unanswered and the person's noes end.
	 */
	startCommand(): (failed: boolean) => string[];
	/** The turn's end: its open cards close, and its yeses go with it. */
	endTurn(): void;
}

/**
 * `sites`: the running answer's, which its pages read too; without it, a turn
 * keeps its own. `free`: whether the running answer reaches public websites
 * without asking (`roomReachesFreely`): then every site is allowed with no
 * card, certificate checks too, for public addresses alone, which the proxy
 * enforces on the address it dials.
 */
export function windowsSiteDecision(options: { roomId: string; questions: BoxQuestions; sites?: () => AnswerSites; free?: () => boolean }): WindowsSites {
	const { roomId, questions } = options;
	let turn = freshTurn();
	const answerSites = (at: Turn): AnswerSites => options.sites?.() ?? at.sites;

	/** Closes a card nobody waits for: its question alone, its line once. */
	function closeCard(at: Turn, card: Card): void {
		if (card.close.signal.aborted) return;
		at.refusals.add(windowsSiteRefusedLine(card.host, WINDOWS_SITE_UNANSWERED));
		card.close.abort();
	}

	async function askPerson(at: Turn, host: string, port: number, closed: AbortSignal): Promise<SiteAnswer> {
		const watcher = questions.watcher();
		if (watcher === "none") return { allow: false, reason: WINDOWS_SITE_NOBODY_THERE };
		const key = `${host}:${port}`;
		if (!at.cards.has(key) && at.cards.size >= SITE_REQUESTS_PER_TURN) return { allow: false, reason: WINDOWS_SITE_TOO_MANY };
		at.cards.add(key);
		const declined = (): SiteAnswer => {
			at.declined.push({ host, port });
			return { allow: false, reason: WINDOWS_SITE_DECLINED };
		};
		try {
			// Only the computer changes the list; a phone's yes lasts for this answer, and reaches its pages too.
			const apply: SiteApply = (choice, answeredBy) => {
				if (at.ended) return null;
				if (choice === "room" && answeredBy === "computer") {
					addAlsoAllowedSite(roomId, host, port);
					return "room";
				}
				return answerSites(at).give({ host, port }, "commands") ? "once" : null;
			};
			const { choice } = await questions.askSite({ host, port, lasting: watcher === "computer" }, apply, closed);
			if (at.ended) return { allow: false, reason: WINDOWS_SITE_TURN_ENDED };
			if (choice === "decline") return declined();
			return { allow: true };
		} catch (error) {
			if (at.ended) return { allow: false, reason: WINDOWS_SITE_TURN_ENDED };
			if (closed.aborted) return { allow: false, reason: WINDOWS_SITE_UNANSWERED };
			// A message sent while the card waited is the person's no.
			if (error instanceof QuestionDeclined) return declined();
			// The person left, or stopped the turn.
			return questions.watcher() !== "none" ? { allow: false, reason: WINDOWS_SITE_STOPPED } : { allow: false, reason: WINDOWS_SITE_NOBODY_THERE };
		}
	}

	/** One connection's wait for a card's answer: a connection that goes stops waiting, and the last one to go closes the card. */
	function wait(at: Turn, card: Card, signal: AbortSignal | undefined): Promise<SiteAnswer> {
		card.waiting += 1;
		if (!signal) {
			card.held = true;
			return card.answer;
		}
		return new Promise((resolve) => {
			const gone = () => {
				card.waiting -= 1;
				if (card.waiting === 0 && !card.held) closeCard(at, card);
				resolve({ allow: false, reason: WINDOWS_SITE_UNANSWERED });
			};
			signal.addEventListener("abort", gone, { once: true });
			void card.answer.then((answer) => {
				signal.removeEventListener("abort", gone);
				resolve(answer);
			});
		});
	}

	return {
		async ask(site: SiteAsk, how: SiteAskHow = {}): Promise<SiteAnswer> {
			const { host, port } = site;
			const at = turn;
			if (at.ended) return { allow: false, reason: WINDOWS_SITE_TURN_ENDED };
			if (options.free?.() === true) return { allow: true, publicOnly: true };
			if (answerSites(at).commandsReach(site)) return { allow: true };
			// The room's own list, read now: a yes in the pane or on a card reaches the next connection.
			if (coversSite(readAlsoAllowed(roomId).sites, site)) return { allow: true };
			if (how.certificateCheck) {
				at.checks.add(host);
				return { allow: false, reason: WINDOWS_CERTIFICATE_CHECK };
			}
			if (coversSite(at.declined, site)) return { allow: false, reason: WINDOWS_SITE_DECLINED };
			// Gone before it was asked: nobody to show a card for.
			if (how.signal?.aborted) return { allow: false, reason: WINDOWS_SITE_UNANSWERED };
			const key = `${host}:${port}`;
			let card = at.openCards.get(key);
			if (!card) {
				const close = new AbortController();
				const opened: Card = { host, waiting: 0, held: false, close, answer: askPerson(at, host, port, close.signal).finally(() => {
					if (at.openCards.get(key) === opened) at.openCards.delete(key);
				}) };
				at.openCards.set(key, opened);
				card = opened;
			}
			return wait(at, card, how.signal);
		},
		refused(site: SiteAsk, reason: string): void {
			// Said after the turn's end, it is the ended turn's: the next turn's first command never shows it.
			// An unanswered card and a certificate check have their lines from the decision itself, when they are due.
			if (reason === WINDOWS_SITE_TURN_ENDED || reason === WINDOWS_SITE_UNANSWERED || reason === WINDOWS_CERTIFICATE_CHECK) return;
			// A refusal by an earlier no is named as the person declined it: one site, one line, its www name included.
			const declined = reason === WINDOWS_SITE_DECLINED ? turn.declined.find((each) => sameSite(each, site)) : undefined;
			turn.refusals.add(windowsSiteRefusedLine((declined ?? site).host, reason));
		},
		startCommand(): (failed: boolean) => string[] {
			const at = turn;
			// A command started after every other had ended asks again.
			if (at.running === 0) at.declined = [];
			at.running += 1;
			let ended = false;
			return (failed) => {
				if (!ended) {
					ended = true;
					at.running -= 1;
				}
				if (at.running === 0) {
					for (const card of at.openCards.values()) closeCard(at, card);
					at.declined = [];
				}
				const lines = [...at.refusals, ...(failed ? [...at.checks].map((host) => windowsSiteRefusedLine(host, WINDOWS_CERTIFICATE_CHECK)) : [])];
				at.refusals.clear();
				// Kept past a command that ended well while another runs: the check may be that one's, and it may still fail.
				if (failed || at.running === 0) at.checks.clear();
				return lines;
			};
		},
		endTurn(): void {
			const ended = turn;
			ended.ended = true;
			ended.sites.end();
			turn = freshTurn();
			if (ended.cards.size > 0) questions.closeSiteCards(WINDOWS_SITE_TURN_ENDED);
		},
	};
}
