import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SidebarCollapsedAffordance } from "./sidebar-collapse";


// Desktop-app gating: the Electron shell appends this UA token, and the
// desktop-only CSS (drag region, traffic-light clearance) keys off these
// classes. Lives in the bundle because the app origin's CSP deliberately
// blocks inline scripts; runs before the first render.
if (navigator.userAgent.includes("ExxpertsDesktop")) {
	document.documentElement.classList.add("desktop-app");
	if (navigator.userAgent.includes("Macintosh")) document.documentElement.classList.add("desktop-app-mac");
}

createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		{/* Desktop-only window drag strip (display:none in browsers); a real
		    element because -webkit-app-region does not apply to pseudo-elements. */}
		<div className="desktop-drag-strip" aria-hidden="true" />
		<SidebarCollapsedAffordance />
		<App />
	</React.StrictMode>,
);
