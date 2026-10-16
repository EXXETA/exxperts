import { useSyncExternalStore } from "react";
import { fetchJson } from "./api";
import { createDisplayCache } from "./display-cache";
import { fetchRemoteClientContext, showsComputerOnlyControls } from "./remote-client-context";

export interface SkillUpdateNotice {
	id: string;
	name: string;
	status: string;
	revision?: string;
	lastSuccessfulCheckAt?: string;
	rooms: Array<{ id: string; reviewRequired: boolean }>;
}
const cache = createDisplayCache<{ libraries: SkillUpdateNotice[] }>();
const empty: SkillUpdateNotice[] = [];
let notices = empty;
let generation = 0;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
const publish = (value: SkillUpdateNotice[]) => { notices = value; for (const listener of listeners) listener(); };

async function refresh() {
	const started = generation;
	try {
		if (!showsComputerOnlyControls(await fetchRemoteClientContext())) return;
		const result = await cache.load(() => fetchJson("/api/skills/update-notices"), true);
		if (generation === started) publish(result.libraries);
	} catch { /* Background failures retain the last known notice; review always fetches fresh data. */ }
}
function subscribe(listener: () => void) {
	listeners.add(listener);
	if (!stop) {
		const changed = () => { generation++; cache.invalidate(); void refresh(); };
		const cleared = () => { generation++; cache.clear(); publish(empty); void refresh(); };
		const focused = () => { if (!document.hidden) void refresh(); };
		const timer = setInterval(focused, 15000);
		window.addEventListener("skill-libraries-changed", changed);
		window.addEventListener("display-caches-cleared", cleared);
		window.addEventListener("focus", focused);
		void refresh();
		stop = () => { clearInterval(timer); window.removeEventListener("skill-libraries-changed", changed); window.removeEventListener("display-caches-cleared", cleared); window.removeEventListener("focus", focused); stop = undefined; };
	}
	return () => { listeners.delete(listener); if (!listeners.size) stop?.(); };
}

export function useSkillUpdateNotices(): SkillUpdateNotice[] {
	return useSyncExternalStore(subscribe, () => notices, () => empty);
}

export function roomSkillUpdateLabel(notices: SkillUpdateNotice[], roomId: string): string | null {
	if (notices.some((source) => source.rooms.some((room) => room.id === roomId && room.reviewRequired))) return "Review room changes";
	return notices.some((source) => source.status === "updates" && source.rooms.some((room) => room.id === roomId)) ? "Repository update" : null;
}
