// Settings, Skills' own check for new versions: asked once each time the page
// opens on its list, behind it, and shown only by what the rows then say.
import { useEffect, useRef } from "react";
import { fetchRemoteClientContext, showsComputerOnlyControls } from "./remote-client-context";
import { checkSkillUpdatesQuietly, type SkillListItem } from "./skills-api";

/**
 * Asks the repositories whose check is due (the server's word, at most one an
 * hour), the first time `list` is on screen; null while it isn't. The list read
 * again later, and coming back to it, ask nothing. Only on the computer itself,
 * so never before the page knows where it is. An answer is for `onAnswer` to
 * show; a check that fails says nothing.
 */
export function useQuietSkillCheck(list: readonly SkillListItem[] | null, onAnswer: () => void): void {
	const opened = useRef(false);
	useEffect(() => {
		if (opened.current || list === null) return;
		opened.current = true;
		if (!list.some((skill) => skill.repository?.checkDue)) return;
		void fetchRemoteClientContext()
			.then(async (context) => {
				if (!showsComputerOnlyControls(context)) return;
				await checkSkillUpdatesQuietly();
				onAnswer();
			})
			.catch(() => {});
	}, [list, onAnswer]);
}
