

// A stored width means the user dragged the divider. The old key also captured
// auto-persisted defaults, which would mask the equal-split open size forever,
// so the key is bumped once instead of migrating those values.
const KNOWLEDGE_PANE_WIDTH_STORAGE_KEY = "exxperts.rightPane.width";

const RIGHT_PANE_MIN_WIDTH = 360;
// Keep at least this much of the workbench for the chat column when the pane
// grows; without it a wide pane can squeeze the chat (a 1fr track) to zero.
const RIGHT_PANE_MIN_CHAT_WIDTH = 360;
const RIGHT_PANE_RESIZER_WIDTH = 8;

function getRightPaneMaxWidth(hostWidth?: number) {
	// Clamp against the workbench (chat + divider + pane) when we can measure
	// it; the window is only a bootstrap fallback (initial state, no ref yet).
	if (typeof hostWidth === "number" && hostWidth > 0) {
		return Math.floor(hostWidth - RIGHT_PANE_RESIZER_WIDTH - RIGHT_PANE_MIN_CHAT_WIDTH);
	}
	if (typeof window === "undefined") return 820;
	return Math.floor(window.innerWidth * 0.7);
}

function clampRightPaneWidth(width: number, hostWidth?: number) {
	const max = Math.max(RIGHT_PANE_MIN_WIDTH, getRightPaneMaxWidth(hostWidth));
	return Math.max(RIGHT_PANE_MIN_WIDTH, Math.min(max, Math.round(width)));
}

function getDefaultKnowledgePaneWidth() {
	if (typeof window === "undefined") return 520;
	return clampRightPaneWidth(window.innerWidth * 0.5);
}

function equalSplitPaneWidth(hostWidth?: number) {
	// The pane opens sharing the workbench with the chat half and half; the
	// sidebar sits outside the workbench, so this splits what they share.
	if (typeof hostWidth === "number" && hostWidth > 0) {
		return clampRightPaneWidth(Math.floor((hostWidth - RIGHT_PANE_RESIZER_WIDTH) / 2), hostWidth);
	}
	return getDefaultKnowledgePaneWidth();
}

export { KNOWLEDGE_PANE_WIDTH_STORAGE_KEY, clampRightPaneWidth, equalSplitPaneWidth, getDefaultKnowledgePaneWidth };
