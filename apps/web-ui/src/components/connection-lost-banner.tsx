import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useRemoteClientContext } from "../remote-client-context";

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

// The sign-in ended while the page was open. The server's sign-in page is at
// "/", where the gate takes a person who has no session.
export function SignedOutBanner() {
	return (
		<div className="connection-lost-banner" role="alert">
			<span className="connection-lost-dot" aria-hidden="true" />
			<span>You were signed out. <a href="/">Sign in again</a> to carry on.</span>
		</div>
	);
}

// Another person is signed in on this server than the one this page was opened for.
// It covers the page so nothing of the first person's stays on screen or usable; the
// page is already reloading, and the button is the way on if a prompt on unsaved work held that.
// Everything else in the document is made inert and hidden from assistive technology, and focus
// moves in, so a held reload leaves nothing reachable by keyboard or screen reader either.
export function PersonChangedCover({ kind, onReload }: { kind: "other" | "unknown"; onReload: () => void }) {
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
			<p id="person-changed-text">{kind === "other" ? "Someone else is now signed in on this server." : "This page could not tell who is signed in. Reload to carry on."}</p>
			<button type="button" className="rs-btn rs-btn-primary" ref={buttonRef} onClick={onReload}>Reload</button>
		</div>,
		document.body,
	);
}
