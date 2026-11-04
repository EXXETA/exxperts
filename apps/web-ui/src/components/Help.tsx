import { useEffect, useRef, useState } from "react";
import { fetchJson } from "../api";
import { fetchArchivedPersistentRooms } from "../persistent-room-management-api";
import { fetchRemoteClientContext, sharedServerRole, useRemoteClientContext } from "../remote-client-context";
import { fetchPersistentAgentStatuses } from "../room-list-api";
import { useEscapeKey } from "./use-escape-key";
import { onWhatsNewClosed, sharedServerReleases, type WhatsNewSections } from "./whats-new-dialog";

interface Props {
	onClose: () => void;
}

type Step = { lead: string; body: string };
type Role = "member" | "admin" | null;

/** The first step on a shared server: nobody signs in there, and only the admin sets up the models. */
const SHARED_FIRST_STEP: Record<"member" | "admin", Step> = {
	member: { lead: "Your AI.", body: "Your admin sets up the models for this server. Each room picks one in Room settings, Model." },
	admin: { lead: "Connect your AI.", body: "Open the gear, then Settings, AI setup. Add an API key or connect your company gateway. Set the default models for your rooms there." },
};

const CONNECT_STEP: Step = { lead: "Connect your AI.", body: "Open the gear, then Settings, AI setup. Sign in with a subscription, add an API key, or connect your company gateway. Set the default models for your rooms there." };
const CREATE_STEP: Step = { lead: "Create a room.", body: "One room per project or topic. Press New room on Home, give it a name and start talking: ask questions, share files, work things through." };
const REMEMBER_STEP: Step = { lead: "Remember what matters.", body: "When a conversation is worth keeping, press Remember. You see what the room will keep before anything is saved, unless you switched that preview off in Room settings, Memory. Forget closes a conversation without keeping it." };
const COME_BACK_STEP: Step = { lead: "Come back any time.", body: "A room rests fully saved. Press Resume to continue where you left off." };
const TIDY_STEP: Step = { lead: "Keep the memory tidy.", body: "When conversations pile up, press Maintain on the room's card. Memorize turns them into notes, and Review tidies the notes. Nothing changes without your approval, unless you let Memorize apply by itself in Room settings, Memory." };

/** The steps grouped by when a person takes them, numbered straight through. */
function stepGroups(role: Role): { title: string; steps: Step[] }[] {
	return [
		{ title: "Set up once", steps: [role ? SHARED_FIRST_STEP[role] : CONNECT_STEP, CREATE_STEP] },
		{ title: "Every conversation", steps: [REMEMBER_STEP, COME_BACK_STEP] },
		{ title: "Now and then", steps: [TIDY_STEP] },
	];
}

const FLOW = [
	{ name: "Talk", line: "in a room" },
	{ name: "Remember", line: "keeps what matters" },
	{ name: "Memorize", line: "turns it into notes" },
	{ name: "Review", line: "tidies the notes" },
];

const ROOM_MODEL_NOTE = "Each room can have its own model: Room settings, Model.";
const ONE_PLACE_NOTE = "A room is open in one place at a time. If it's open in another window, close it there first.";

/** A shared server offers neither the Wallet nor a choice of order: its rooms are listed A to Z. */
function goodToKnow(role: Role): string[] {
	return role
		? [ROOM_MODEL_NOTE, ONE_PLACE_NOTE, "The Memory page shows what your rooms remember."]
		: [ROOM_MODEL_NOTE, "Sort your rooms on Home by last used, by name, or drag them into your own order.", ONE_PLACE_NOTE, "The Memory page shows what your rooms remember. The Wallet shows what you spend."];
}

/** The one user guide, behind Help › How it works in the gear menu (on a phone too): guidance for a new user, not a manual. It opens by itself once, useFirstRunGuide. */
export function Help({ onClose }: Props) {
	// However it was opened: someone who has read it is not shown it by itself later.
	const close = (): void => {
		markGuideSeen();
		onClose();
	};
	useEscapeKey(close);
	const role = sharedServerRole(useRemoteClientContext());
	const bodyRef = useRef<HTMLDivElement>(null);
	// Opened by itself nothing else says it is there: the focus takes a screen reader into it, and the arrow keys scroll it.
	useEffect(() => { bodyRef.current?.focus(); }, []);
	let stepNumber = 0;
	return (
		<div className="help-overlay" onClick={close} role="dialog" aria-modal="true" aria-label="How exxperts works">
			<div className="help-modal" onClick={(e) => e.stopPropagation()}>
				<div className="help-head">
					<h2>How exxperts works</h2>
					<button className="icon-btn" onClick={close} aria-label="Close">✕</button>
				</div>
				<div className="help-body" ref={bodyRef} tabIndex={-1}>
					<p className="help-lede">Your rooms remember your work, and you decide what they keep.</p>
					<ol className="help-flow" aria-label="How a conversation becomes memory">
						{FLOW.map((stage) => (
							<li key={stage.name}><strong>{stage.name}</strong><span>{stage.line}</span></li>
						))}
					</ol>
					{stepGroups(role).map((group) => (
						<section key={group.title}>
							<h3>{group.title}</h3>
							<ol className="help-steps">
								{group.steps.map((step) => (
									<li key={step.lead}>
										<span className="help-step-number">{(stepNumber += 1)}</span>
										<p><strong>{step.lead}</strong> {step.body}</p>
									</li>
								))}
							</ol>
						</section>
					))}
					<h3>Good to know</h3>
					<ul className="help-tiles">
						{goodToKnow(role).map((note) => <li key={note}>{note}</li>)}
					</ul>
				</div>
			</div>
		</div>
	);
}

// Set once the guide has had its turn: closed, or never needed because rooms were here.
const GUIDE_SEEN_KEY = "exxperts.first-run-guide-seen";

function markGuideSeen(): void {
	try { localStorage.setItem(GUIDE_SEEN_KEY, "1"); } catch {}
}

/** A browser that keeps nothing counts as seen: the guide would otherwise open at every arrival. */
function guideSeen(): boolean {
	try { return localStorage.getItem(GUIDE_SEEN_KEY) !== null; } catch { return true; }
}

/** Whether the What's new window opens on this load: the same reading as the app's. */
async function whatsNewDue(): Promise<boolean> {
	const data = await fetchJson<{ version: string; sections: WhatsNewSections | null; show: boolean }>("/api/whats-new");
	if (!data.show || !data.version || !data.sections) return false;
	let seenMark: string | null = null;
	try { seenMark = localStorage.getItem("exxperts.whats-new-seen"); } catch {}
	if (seenMark === data.version) return false;
	const sections = (await fetchRemoteClientContext()).sharedServer ? sharedServerReleases(data.sections, seenMark) : data.sections;
	return sections.major.length + sections.minor.length > 0;
}

type GuideTurn = "now" | "after-whats-new" | "not-due";

/**
 * Asks the server, not the page's list of rooms, which is also empty before
 * its first read and after a failed one. Archived rooms count: their owner is
 * no newcomer.
 */
async function guideTurn(): Promise<GuideTurn> {
	const [rooms, archived] = await Promise.all([fetchPersistentAgentStatuses(), fetchArchivedPersistentRooms()]);
	if (rooms.length + archived.length > 0) {
		markGuideSeen();
		return "not-due";
	}
	return (await whatsNewDue()) ? "after-whats-new" : "now";
}

/** The guide opening by itself, once, for a person with no rooms yet, never over What's new. Any failure means no window this time. */
export function useFirstRunGuide(): { open: boolean; close: () => void } {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (guideSeen()) return;
		let cancelled = false;
		let stopWaiting = (): void => {};
		guideTurn().then((turn) => {
			if (cancelled) return;
			if (turn === "now") setOpen(true);
			else if (turn === "after-whats-new") stopWaiting = onWhatsNewClosed(() => setOpen(true));
		}, () => {});
		return () => {
			cancelled = true;
			stopWaiting();
		};
	}, []);
	return { open, close: () => setOpen(false) };
}
