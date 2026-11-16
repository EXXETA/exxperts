import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { pageEndedLine, useRemoteClientContext, type PersonChange } from "../remote-client-context";
import { useOwnSignOutPressed } from "./product-shell";

// The app's only connectivity surface.
//
// It replaces a permanent corner dot that reported raw socket state, which
// meant it announced trouble through app boot and through every ordinary
// screen change while nothing was wrong. This appears only once
// connection-health.ts is certain the failure is sustained and confirmed.
//
// The wording is deliberate. Everything the app talks to is an implementation
// detail the user did not install, cannot see and cannot restart, so the copy
// names none of it, and offers the one remedy that is actually theirs.
const CONNECTION_LOST_DESKTOP = "exxperts lost its connection. Restarting the app usually fixes this.";
const CONNECTION_LOST_SHARED = "exxperts lost its connection to the server. It usually comes back by itself within a minute. If it doesn't, reload the page.";

export function ConnectionLostBanner() {
	// A shared server comes back by itself and is not the person's to restart.
	const { sharedServer } = useRemoteClientContext();
	return (
		<div className="connection-lost-banner" role="alert">
			<span className="connection-lost-dot" aria-hidden="true" />
			<span>{sharedServer ? CONNECTION_LOST_SHARED : CONNECTION_LOST_DESKTOP}</span>
		</div>
	);
}

// The sign-in ended while the page was open. The way back is the server's
// sign-out link when it gives one: a session ended by a sign-out on another
// device still holds this browser's cookie, and only the full sign-out clears
// it, so the next sign-in asks for the password. Without the link, "/", where
// the gate takes a person who has no session. After the page's own Sign out
// was pressed, its footer line says where things stand and offers the ways on,
// so this says nothing beside it.
export function SignedOutBanner() {
	const { signOut } = useRemoteClientContext();
	if (useOwnSignOutPressed()) return null;
	return (
		<div className="connection-lost-banner" role="alert">
			<span className="connection-lost-dot" aria-hidden="true" />
			<span>You were signed out. <a href={signOut ?? "/"}>Sign in again</a> to carry on.</span>
		</div>
	);
}

// The page has ended: another person is signed in on this server than the one it was opened for,
// it cannot tell who is, or the server refused a request and said the page ends; a refusal's line
// is the server's own words (pageEndedLine). It covers the page so nothing of the first person's stays on screen or usable; the
// page is already reloading, and the button is the way on if a prompt on unsaved work held that.
// Everything else in the document is made inert and hidden from assistive technology, and focus
// moves in, so a held reload leaves nothing reachable by keyboard or screen reader either.
export function PersonChangedCover({ kind, onReload }: { kind: PersonChange; onReload: () => void }) {
	const coverRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		const cover = coverRef.current;
		const hidden = Array.from(document.body.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node !== cover);
		for (const node of hidden) {
			node.inert = true;
			node.setAttribute("aria-hidden", "true");
		}
		buttonRef.current?.focus();
		return () => {
			for (const node of hidden) {
				node.inert = false;
				node.removeAttribute("aria-hidden");
			}
		};
	}, []);
	return createPortal(
		<div className="person-changed-cover" role="alertdialog" aria-modal="true" aria-labelledby="person-changed-text" ref={coverRef}>
			<p id="person-changed-text">{pageEndedLine(kind)}</p>
			<button type="button" className="rs-btn rs-btn-primary" ref={buttonRef} onClick={onReload}>Reload</button>
		</div>,
		document.body,
	);
}
