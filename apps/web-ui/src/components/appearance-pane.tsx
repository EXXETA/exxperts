import { useState } from "react";
import { PaneHeader } from "./pane-header";
import type { AppearancePreference } from "./product-shell";

/** The room's reading column: Standard is 768 px, Wide is 960 px (01-base.css). */
type ChatWidth = "standard" | "wide";

const CHAT_WIDTH_KEY = "exxperts.chatWidth";

function savedChatWidth(): ChatWidth {
	try {
		return localStorage.getItem(CHAT_WIDTH_KEY) === "wide" ? "wide" : "standard";
	} catch {
		return "standard";
	}
}

// Set as this file loads, before the first render, so a room never opens at
// one width and jumps to the other.
document.documentElement.dataset.chatWidth = savedChatWidth();

const THEMES: { id: AppearancePreference; label: string }[] = [
	{ id: "system", label: "System" },
	{ id: "light", label: "Light" },
	{ id: "dark", label: "Dark" },
];

const CHAT_WIDTHS: { id: ChatWidth; label: string; title: string }[] = [
	{ id: "standard", label: "Standard", title: "The reading width of most AI apps" },
	{ id: "wide", label: "Wide", title: "More room for tables and code" },
];

/** Settings, Appearance: the gear menu's theme choice, and the chat width, which a phone is not offered. */
export function AppearancePane({ appearance, onSetAppearance }: { appearance: AppearancePreference; onSetAppearance: (pref: AppearancePreference) => void }) {
	const [chatWidth, setChatWidth] = useState<ChatWidth>(document.documentElement.dataset.chatWidth === "wide" ? "wide" : "standard");
	function chooseChatWidth(next: ChatWidth): void {
		setChatWidth(next);
		document.documentElement.dataset.chatWidth = next;
		try {
			localStorage.setItem(CHAT_WIDTH_KEY, next);
		} catch {
			// Without storage the choice holds until the page reloads.
		}
	}
	return (
		<div className="landing ai-setup-page">
			<PaneHeader title="Appearance" line="How exxperts looks on this device." />
			<div className="settings-rows">
				<div className="settings-row">
					<div className="settings-row-main">
						<span className="settings-row-label">Theme</span>
						<span className="settings-row-sub">System follows this device's light or dark setting.</span>
					</div>
					<div className="settings-segments" role="group" aria-label="Theme">
						{THEMES.map((theme) => (
							<button key={theme.id} type="button" className={`settings-segment${appearance === theme.id ? " active" : ""}`} aria-pressed={appearance === theme.id} onClick={() => onSetAppearance(theme.id)}>{theme.label}</button>
						))}
					</div>
				</div>
				<div className="settings-row settings-chat-width-row">
					<div className="settings-row-main">
						<span className="settings-row-label">Chat width</span>
						<span className="settings-row-sub">Wide gives answers more room for tables and code.</span>
					</div>
					<div className="settings-segments" role="group" aria-label="Chat width">
						{CHAT_WIDTHS.map((choice) => (
							<button key={choice.id} type="button" className={`settings-segment${chatWidth === choice.id ? " active" : ""}`} aria-pressed={chatWidth === choice.id} title={choice.title} onClick={() => chooseChatWidth(choice.id)}>{choice.label}</button>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
