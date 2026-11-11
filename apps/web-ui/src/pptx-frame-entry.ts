// Runs alone inside a preview's sandboxed frame: no app code, no cookies, no network.
// The parent fetches the file and hands the bytes over.
import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from "@aiden0z/pptx-renderer";

window.addEventListener("message", (event) => {
	if (event.source !== window.parent || !(event.data instanceof ArrayBuffer)) return;
	const container = document.getElementById("slides");
	if (!container) return;
	void PptxViewer.open(event.data, container, { zipLimits: RECOMMENDED_ZIP_LIMITS, listOptions: { windowed: true } })
		.then(() => window.parent.postMessage({ kind: "frame-rendered" }, "*"))
		.catch(() => window.parent.postMessage({ kind: "frame-failed" }, "*"));
});
window.parent.postMessage({ kind: "frame-ready" }, "*");
