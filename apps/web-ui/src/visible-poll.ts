// Asks now and every `everyMs` while the tab is shown. A hidden tab asks
// nothing, so a forgotten tab costs a shared server no load; showing it asks at
// once and starts the rounds again. Returns the way to stop.
export function pollWhileShown(ask: () => void, everyMs: number): () => void {
	let timer: ReturnType<typeof setInterval> | undefined;
	const follow = () => {
		clearInterval(timer);
		if (document.hidden) return;
		ask();
		timer = setInterval(ask, everyMs);
	};
	follow();
	document.addEventListener("visibilitychange", follow);
	return () => {
		clearInterval(timer);
		document.removeEventListener("visibilitychange", follow);
	};
}
