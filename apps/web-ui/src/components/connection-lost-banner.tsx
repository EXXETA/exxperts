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
export function ConnectionLostBanner() {
	return (
		<div className="connection-lost-banner" role="alert">
			<span className="connection-lost-dot" aria-hidden="true" />
			<span>exxperts lost its connection. Restarting the app usually fixes this.</span>
		</div>
	);
}
