import { useEffect, useMemo, useRef, useState } from "react";
import type { ToastView } from "./components/toast-stack";
import { fetchPersistentRoomSkillSettings } from "./persistent-room-management-api";
import { pausedSkillsDecision } from "./paused-skills";

/**
 * Skills a room paused because they changed after it turned them on. The
 * pause is the safety rule: a changed skill is not used until someone
 * reviews the new version. But it happened silently: the room lost abilities
 * and only Room settings, Skills said so. Skills change outside the app (an
 * edited file, another tool updating a shared skill), so the moment to say
 * it is entering the room: one notice with Review, in the room's usual
 * notice slot, once per change. Each skill version is remembered on this
 * device once shown, so reviewing one of two paused skills does not bring
 * the notice back for the other; Room settings keeps the count until the
 * review.
 */

const SEEN_KEY = "exxperts.pausedSkillsSeen";
const SHOWN_FOR_MS = 12_000;

function readSeen(): string[] {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((mark): mark is string => typeof mark === "string") : [];
	} catch {
		return [];
	}
}

function rememberSeen(marks: readonly string[]): void {
	try {
		localStorage.setItem(SEEN_KEY, JSON.stringify(marks));
	} catch {
		// A blocked store only means the notice may come again; never break the room.
	}
}

/**
 * The notice for the room just entered, as a room toast, or null. `onReview`
 * opens Room settings at Skills.
 */
export function usePausedSkillsNotice(agentId: string | null, onReview: () => void): ToastView | null {
	const [notice, setNotice] = useState<{ agentId: string; text: string; sub: string } | null>(null);
	const onReviewRef = useRef(onReview);
	onReviewRef.current = onReview;

	useEffect(() => {
		setNotice(null);
		if (!agentId) return;
		let cancelled = false;
		fetchPersistentRoomSkillSettings(agentId)
			.then((response) => {
				if (cancelled) return;
				const decision = pausedSkillsDecision(agentId, response.skills, readSeen());
				if (!decision.show) return;
				rememberSeen(decision.remember);
				setNotice({ agentId, ...decision.show });
			})
			// The room works without the notice; Room settings still shows the pause.
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [agentId]);

	useEffect(() => {
		if (!notice) return;
		const timer = window.setTimeout(() => setNotice(null), SHOWN_FOR_MS);
		return () => window.clearTimeout(timer);
	}, [notice]);

	return useMemo<ToastView | null>(
		() =>
			notice && {
				id: `paused-skills:${notice.agentId}`,
				tone: "neutral",
				text: notice.text,
				sub: notice.sub,
				action: {
					label: "Review",
					onClick: () => {
						setNotice(null);
						onReviewRef.current();
					},
				},
			},
		[notice],
	);
}
