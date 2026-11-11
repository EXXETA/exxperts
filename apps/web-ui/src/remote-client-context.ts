import { useEffect, useState, useSyncExternalStore } from "react";
import { apiFetch } from "./api";

// Is this page being viewed from a remote device (over the tunnel), and with
// what capability? Used only to HIDE affordances that cannot work remotely
// (native folder picker, save-to-disk): the server refuses them regardless
// of what the client renders, so failing open to "local" here is safe and
// keeps the loopback experience byte-identical when the probe cannot run.
//
// sharedServer: the server is shared by many people, so it is no one's own
// computer. The same controls are hidden as on a phone, and settings only an
// admin may change are read-only. False when the field is missing or the
// probe fails, like the rest of the local default.
//
// person: who is signed in on a shared server; null anywhere else.
// signOut: the server's own link that ends the sign-in there; null when the
// server gave none.
export interface RemoteClientContext {
	remote: boolean;
	capability: "full" | "read-only";
	sharedServer: boolean;
	person: ClientPerson | null;
	signOut: string | null;
}

export interface ClientPerson {
	id: string;
	/** Empty when the server had no readable name. */
	name: string;
	admin: boolean;
}

const LOCAL_CONTEXT: RemoteClientContext = { remote: false, capability: "full", sharedServer: false, person: null, signOut: null };

let cached: Promise<RemoteClientContext> | null = null;
// The probe's answer once it has come, so a component mounted later starts
// from it instead of from the local default.
let known: RemoteClientContext | null = null;
// Whether any read has been answered, as opposed to the local default standing in for a failed first one.
let answered = false;
let confirmedLocal = false;
// The read that is out now, and the one that will go next: everyone who asks while one is out shares the next.
let inFlight: Promise<RefreshResult> | null = null;
let queued: Promise<RefreshResult> | null = null;
const listeners = new Set<() => void>();

// The only place the answer's shape is checked; the link must be the gate's own sign-out path.
function readContext(body: unknown): RemoteClientContext {
	const value = (body ?? {}) as Record<string, unknown>;
	const person = (value.person ?? {}) as Record<string, unknown>;
	const signOut = value.signOut;
	return {
		remote: value.remote === true,
		capability: value.capability === "read-only" ? "read-only" : "full",
		sharedServer: value.sharedServer === true,
		person: typeof person.id === "string" && person.id !== ""
			? { id: person.id, name: typeof person.name === "string" ? person.name : "", admin: person.admin === true }
			: null,
		signOut: typeof signOut === "string" && signOut.startsWith("/oauth2/sign_out?rd=") ? signOut : null,
	};
}

// Set once, and for good. "other": the server says another person is signed in than the one this page was
// opened for. "unknown": the page's first read failed, so it never knew who it was opened for, and the
// first identity that arrives cannot be taken for the same person.
export type PersonChange = "other" | "unknown";
let personChange: PersonChange | null = null;

function setKnown(next: RemoteClientContext): void {
	known = next;
	// Whoever awaits the answer later gets the newest one, not the first.
	cached = Promise.resolve(next);
	for (const listener of listeners) listener();
}

// How long a read may take before it counts as unanswered: a stalled one must not hold every later retry behind it.
const READ_DEADLINE_MS = 10_000;

// null when no usable answer came; a 401 has already sent the page to sign-in, and the server's refusal of the person
// this page names has already ended it (apiFetch).
async function readAnswer(): Promise<{ context: RemoteClientContext; local: boolean } | null> {
	setConfirmedLocal(false);
	try {
		const res = await apiFetch("/api/remote/client-context", { signal: AbortSignal.timeout(READ_DEADLINE_MS) });
		if (!res.ok) return null;
		const body: unknown = await res.json();
		const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
		return { context: readContext(body), local: value?.remote === false && value.sharedServer === false };
	} catch {
		return null;
	}
}

function setConfirmedLocal(value: boolean): void {
	if (confirmedLocal === value) return;
	confirmedLocal = value;
	for (const listener of listeners) listener();
}

/** A local-only action needs an explicit, current answer, not the fallback. */
export function useConfirmedLocalClientContext(): boolean {
	useEffect(() => { void fetchRemoteClientContext(); }, []);
	return useSyncExternalStore(
		(listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		() => confirmedLocal && !personChange,
		() => false,
	);
}

/** Whether this page can no longer be taken for the person it was opened for. */
export function personHasChanged(): boolean {
	return personChange !== null;
}

/** For the app's root: re-renders when the page can no longer be taken for its person's, and says which case. */
export function usePersonChanged(): PersonChange | null {
	return useSyncExternalStore(
		(listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		() => personChange,
	);
}

/** For apiFetch: the server refused the person this page names, so another person is signed in now. */
export function endPageForAnotherPerson(): void {
	// Requests already in flight may all come back refused: the page ends once.
	if (!personChange) endPage("other");
}

function endPage(kind: PersonChange): "person changed" {
	personChange = kind;
	for (const listener of listeners) listener();
	reloadForNewPerson();
	return "person changed";
}

/** The page's way out of a changed person; the root offers it if a prompt on unsaved work held the first try. */
export function reloadForNewPerson(): void {
	location.reload();
}

export type RefreshResult = "answered" | "no answer" | "person changed";

export function fetchRemoteClientContext(): Promise<RemoteClientContext> {
	if (!cached) {
		cached = readAnswer().then((answer) => {
			answered = answer !== null;
			setKnown(answer?.context ?? LOCAL_CONTEXT);
			setConfirmedLocal(answer?.local === true && !personChange);
			return known as RemoteClientContext;
		});
	}
	return cached;
}

/**
 * Reads the answer again, for a page that stays open: on a shared server the
 * person can change under it (another sign-in in the same browser, a session
 * restored from the back-forward cache). A different person ends this page:
 * every request after it is refused (apiFetch), the root blanks the screen
 * and closes the sockets, and the page reloads; a prompt on unsaved work that
 * holds the reload leaves a blank page with a Reload button, never the old
 * person's data. A failed read changes nothing, so a page that saw a shared
 * server never falls back to the desktop view. On this computer, once
 * answered, it is a no-op.
 */
export function refreshRemoteClientContext(): Promise<RefreshResult> {
	if (personChange) return Promise.resolve("person changed");
	if (answered && known && !known.sharedServer) return Promise.resolve("answered");
	if (!inFlight) {
		const read = readOnce().finally(() => { if (inFlight === read) inFlight = null; });
		inFlight = read;
		// Someone who asked while this read was out is owed one sent after they asked, and so is whoever started this
		// one: its answer, if another read is waiting behind it, is that read's.
		return read.then((result) => queued ?? result);
	}
	// A read already out may have been sent before this event, with the old person's cookie: wait for it, then ask again.
	queued ??= inFlight.then(() => {
		queued = null;
		return refreshRemoteClientContext();
	});
	return queued;
}

async function readOnce(): Promise<RefreshResult> {
	// The first read is this one's answer.
	if (!cached) { await fetchRemoteClientContext(); return answered ? "answered" : "no answer"; }
	await cached;
	const answer = await readAnswer();
	if (!answer) return personChange ? "person changed" : "no answer";
	const next = answer.context;
	answered = true;
	const first = known?.person ?? null;
	if (first && next.person && first.id !== next.person.id) return endPage("other");
	// The page never learned who it was opened for (the first read failed): the first identity to arrive is not adopted.
	if (!first && next.sharedServer && next.person) return endPage("unknown");
	setKnown(next);
	setConfirmedLocal(answer.local && !personChange);
	return "answered";
}

if (typeof window !== "undefined") {
	window.addEventListener("focus", () => void refreshRemoteClientContext());
	// A page restored from the back-forward cache keeps its old answer, and its person may have signed out since.
	window.addEventListener("pageshow", (event) => { if (event.persisted) void refreshRemoteClientContext(); });
}

/** The person this page was opened for, which it names on every request and its socket; null when it knows none. */
export function pagePersonId(): string | null {
	return known?.person?.id ?? null;
}

/** The socket's protocol list: the edge reads the page's person from it, and the server answers the first entry. */
export function pagePersonProtocols(): string[] | undefined {
	const person = pagePersonId();
	return person === null ? undefined : ["exxperts", `exxperts-person.${person}`];
}

/** The probe's answer once it has come; null before, for code outside a component. */
export function knownRemoteClientContext(): RemoteClientContext | null {
	return known;
}

/**
 * Whether a control that only works on this computer is shown: not on a
 * remote device, and not on a shared server. Every such control asks here,
 * so the two cases always read the same way.
 */
export function showsComputerOnlyControls(context: RemoteClientContext): boolean {
	return !context.remote && !context.sharedServer;
}

/** The one line a read-only setting shows on a shared server. */
export const SHARED_SERVER_ADMIN_LINE = "On a shared server, your admin sets this up.";

/** Beside that line for a person who is not an admin yet: roles come with the sign-in. */
export const NEW_ADMIN_HINT = "Just made an admin? Sign out and in again to get the admin's controls.";

/** On a shared server, someone who is not its admin: the settings only an admin may change are read-only for them. */
export function sharedServerNonAdmin(context: RemoteClientContext): boolean {
	return context.sharedServer && context.person?.admin !== true;
}

/**
 * Who reads the words about the AI setup on a shared server: a member, who
 * cannot change it, or the admin, who can; null anywhere else, remote access
 * included, where the words stay this computer's.
 */
export function sharedServerRole(context: RemoteClientContext | null): "member" | "admin" | null {
	return !context?.sharedServer ? null : sharedServerNonAdmin(context) ? "member" : "admin";
}

/**
 * Whether the AI setup (keys, gateways, custom profiles) is read-only: on a
 * remote device always, on a shared server unless the person is its admin.
 */
export function aiSetupLocked(context: RemoteClientContext): boolean {
	return context.remote || sharedServerNonAdmin(context);
}

export function useRemoteClientContext(): RemoteClientContext {
	const [context, setContext] = useState<RemoteClientContext>(() => known ?? LOCAL_CONTEXT);
	useEffect(() => {
		let alive = true;
		void fetchRemoteClientContext().then((resolved) => {
			if (alive) setContext(resolved);
		});
		const onChange = () => { if (alive && known) setContext(known); };
		listeners.add(onChange);
		return () => {
			alive = false;
			listeners.delete(onChange);
		};
	}, []);
	return context;
}
