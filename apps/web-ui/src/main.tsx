import React from "react";
import { createRoot } from "react-dom/client";
import { installAnswerCopy } from "./answer-copy";
import { App } from "./App";
import { AppErrorBoundary } from "./components/app-error-boundary";
import { ConfirmDialogHost } from "./components/confirm-dialog";
import { KeysList } from "./components/keys-list";
import { HistoryArrows, installHistoryKeys } from "./history-arrows";
import { SidebarCollapsedAffordance } from "./sidebar-collapse";
import { installPhoneViewportTracking } from "./phone-viewport";


// Desktop-app gating: the Electron shell appends this UA token, and the
// desktop-only CSS (drag region, traffic-light clearance) keys off these
// classes. Lives in the bundle because the app origin's CSP deliberately
// blocks inline scripts; runs before the first render.
if (navigator.userAgent.includes("ExxpertsDesktop")) {
	document.documentElement.classList.add("desktop-app");
	if (navigator.userAgent.includes("Macintosh")) document.documentElement.classList.add("desktop-app-mac");
}

// Phone keyboard/viewport tracking (no-op above the phone breakpoint).
installPhoneViewportTracking();

// A copy inside an answer leaves the page's look behind.
installAnswerCopy();

installHistoryKeys();

createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		{/* Desktop-only window drag strip (display:none in browsers); a real
		    element because -webkit-app-region does not apply to pseudo-elements. */}
		<div className="desktop-drag-strip" aria-hidden="true" />
		{/* A render error shows one sentence and Reload, not a blank page. */}
		<AppErrorBoundary>
			<App />
			{/* After the app: the mac app takes a no-drag box out of the drag area in the
			    page's order, so a bar that drags and comes later would cover these buttons. */}
			<SidebarCollapsedAffordance />
			<HistoryArrows />
			<ConfirmDialogHost />
			<KeysList />
		</AppErrorBoundary>
	</React.StrictMode>,
);
