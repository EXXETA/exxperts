// Phone keyboard handling, compositor-lift design. iOS Safari does not
// resize the layout viewport when the on-screen keyboard opens: it shrinks
// the visual viewport and scrolls the page. Earlier designs mirrored the
// visual viewport height into the shell's height, which is correct but can
// only ever move the composer in relayout-sized steps - one hard teleport
// after the keyboard settles. This design never resizes the shell. While a
// text entry is focused, the composer is GLUED to the visual viewport's
// bottom edge: the lift is the gap between that edge and the layout
// viewport's bottom (height and offsetTop both count, so the shrink and
// the pan channel are covered alike); the composer and the
// dock above it translate up by that amount on the compositor (a CSS
// transition smooths the steps), and the transcript gains the same amount
// of bottom padding and re-pins, so its latest line rises with the
// composer. Movement therefore starts with the FIRST resize event - the
// round-1 fight was scroll correction and relayout during the animation,
// not movement itself, and a transform causes neither.
//
// Safari's scroll-into-view of the focused field stays handled the settled
// way: with the composer already lifted, Safari usually has nothing to
// reveal and does not scroll at all; when it scrolls anyway (late, near
// the bottom edge), the settle correction plus three bounded rechecks put
// the layout viewport back to zero, then everything detaches. Never a
// standing scroll listener.
//
// Android honours interactive-widget=resizes-content, so the layout
// viewport shrinks with the keyboard there: the overlap measures zero and
// the whole module is a natural no-op.

const PHONE_MEDIA = "(max-width: 760px)";
const LIFT_VAR = "--phone-keyboard-lift";
// Longer than the gap between iOS keyboard-animation resize events, shorter
// than feeling laggy after the keyboard settles.
const SETTLE_MS = 150;
// The transcript only follows the lift while its latest line is what the
// reader is on; further up than this is a deliberate scroll position.
const FOLLOW_DISTANCE_PX = 160;

function isTextEntry(el: Element | null): boolean {
	if (!el) return false;
	const tag = el.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
}

export function installPhoneViewportTracking(): void {
	const vv = window.visualViewport;
	if (!vv) return;
	const phone = window.matchMedia(PHONE_MEDIA);
	const root = document.documentElement;
	let appliedLift = 0;
	let liftFrame: number | null = null;
	let settleTimer: number | null = null;
	let recheckTimers: number[] = [];

	const clearRechecks = () => {
		for (const timer of recheckTimers) window.clearTimeout(timer);
		recheckTimers = [];
	};

	const measureLift = (): number => {
		// Pinch zoom also shrinks the visual viewport, and without a focused
		// text entry there is no keyboard: Safari's toolbar collapsing while
		// the transcript scrolls resizes the visual viewport too, and
		// mirroring that would bob the composer during plain reading.
		if (!phone.matches || vv.scale > 1.01 || !isTextEntry(document.activeElement)) return 0;
		// Glue, not height math: the lift is the gap between the visual
		// viewport's bottom edge and the layout viewport's bottom, so it is
		// right no matter which channel the browser used - shrinking the
		// viewport (height), panning it to reveal the field (offsetTop), or
		// both. Height-only measurement missed every pan-channel reveal,
		// which read as "keyboard open, composer never lifted".
		return Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop)));
	};

	const applyLift = () => {
		liftFrame = null;
		const lift = measureLift();
		if (lift === appliedLift) return;
		appliedLift = lift;
		if (lift === 0) root.style.removeProperty(LIFT_VAR);
		else root.style.setProperty(LIFT_VAR, `${lift}px`);
		// The lift adds the same amount of transcript bottom padding; while
		// the reader is at (or near) the latest line, follow it down so the
		// line rises with the composer instead of sliding under it.
		const messages = document.querySelector(".messages");
		if (messages && lift > 0) {
			const distance = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
			if (distance < FOLLOW_DISTANCE_PX + lift) messages.scrollTop = messages.scrollHeight;
		}
	};

	const scheduleLift = () => {
		if (liftFrame != null) return;
		liftFrame = requestAnimationFrame(applyLift);
	};

	const correctScroll = () => {
		if (!phone.matches || vv.scale > 1.01 || !isTextEntry(document.activeElement)) return;
		if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
	};

	// The scroll correction never runs during the keyboard animation (the
	// round-1 lesson): one settled shot, then three bounded rechecks for
	// Safari's late reveal scroll, then everything detaches.
	const scheduleCorrection = () => {
		if (settleTimer != null) window.clearTimeout(settleTimer);
		settleTimer = window.setTimeout(() => {
			settleTimer = null;
			clearRechecks();
			if (!isTextEntry(document.activeElement)) return;
			correctScroll();
			for (const delay of [150, 400, 900]) {
				recheckTimers.push(window.setTimeout(correctScroll, delay));
			}
		}, SETTLE_MS);
	};

	// Fallback for opens where iOS fires NO viewport event until the first
	// keystroke (field-observed: the composer popped into place only when
	// typing started). A bounded set of recomputes after focus makes the
	// lift land regardless of which event would have carried it; each tick
	// runs the same glue formula and no-ops when nothing changed.
	let liftPollTimers: number[] = [];
	const clearLiftPolls = () => {
		for (const timer of liftPollTimers) window.clearTimeout(timer);
		liftPollTimers = [];
	};
	const armLiftPolls = () => {
		clearLiftPolls();
		for (const delay of [100, 250, 500, 900]) {
			liftPollTimers.push(window.setTimeout(applyLift, delay));
		}
	};

	const onViewportChange = () => {
		scheduleLift();
		scheduleCorrection();
	};

	vv.addEventListener("resize", onViewportChange);
	// The pan channel fires scroll, not resize (a reveal with the keyboard
	// already open moves ONLY offsetTop). The transform must track it; the
	// settled correction stays armed by resize/focus alone. Updating a
	// compositor transform from here is safe where round 1's scrollTo was
	// not: it neither relayouts nor scrolls anything, so there is nothing
	// for the browser's own animation to fight.
	vv.addEventListener("scroll", scheduleLift);
	phone.addEventListener("change", scheduleLift);
	document.addEventListener("focusin", () => {
		onViewportChange();
		armLiftPolls();
	});
	document.addEventListener("focusout", () => {
		clearRechecks();
		clearLiftPolls();
		// rAF, so the next activeElement is settled: focus moving between two
		// fields keeps the lift instead of flickering it.
		requestAnimationFrame(applyLift);
	});
	scheduleLift();

	// On-device diagnosis without an inspector: a tiny fixed readout of the
	// raw inputs per event. Off unless explicitly armed.
	if (localStorage.getItem("exxperts.phoneViewportDebug") === "1") {
		const readout = document.createElement("div");
		readout.style.cssText = "position:fixed;top:64px;left:8px;z-index:9999;background:rgba(0,0,0,0.75);color:#EBFF59;font:10px monospace;padding:4px 6px;border-radius:6px;pointer-events:none;white-space:pre;";
		document.body.appendChild(readout);
		const show = (kind: string) => {
			readout.textContent = `${kind} inner=${window.innerHeight} vvH=${Math.round(vv.height)} offT=${Math.round(vv.offsetTop)} scY=${window.scrollY} lift=${measureLift()}`;
		};
		vv.addEventListener("resize", () => show("rsz"));
		vv.addEventListener("scroll", () => show("scr"));
		document.addEventListener("focusin", () => show("fin"));
		document.addEventListener("focusout", () => show("fout"));
	}
}
