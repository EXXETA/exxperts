/**
 * Write-time task-artifact thumbnails (visuals contract D8).
 *
 * Generated ONCE when a specialist task completes, stored under the task's
 * server-internal `.thumbs/` dir (unservable and cap-exempt by design), and
 * shipped to the card as data: URIs on `task_end` — the card never executes
 * artifact bytes. Everything here is best-effort: Playwright missing, render
 * failure, or oversized frames simply mean no thumbnail, and the card falls
 * back to typed chips. SVG artifacts need no thumbnail at all — the card
 * renders them via <img> off the hardened route.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	artifactRoot,
	htmlRenderAvailability,
	renderDeckHtmlToSlideImages,
	renderHtmlToPreviewImage,
} from "../../../pi-package/extensions/artifacts/index.js";
import type { SpecialistWorkerArtifact } from "./persistent-room-specialist-execution.js";

export interface TaskArtifactThumbnail {
	relativePath: string;
	/** data:image/png;base64,… — safe to inline in the card. */
	dataUri: string;
	/** For decks: how many slides the artifact has (first slide is the thumb). */
	slideCount?: number;
}

const MAX_THUMBNAIL_SOURCE_BYTES = 5_000_000;

/**
 * The whole generation races this deadline: `task_end` is awaited behind this
 * call, and `chromium.launch()` has no timeout of its own — an environment
 * where the browser hangs must degrade to chips, not strand the card in
 * "running" (and the cap slot with it) forever.
 */
const THUMBNAIL_OVERALL_TIMEOUT_MS = 45_000;

/**
 * NEVER throws and ALWAYS settles within the overall deadline — thumbnails are
 * cosmetic, the task_end that waits on them is not. Any failure resolves [].
 */
export async function generateTaskArtifactThumbnails(
	taskFolder: string,
	artifacts: readonly SpecialistWorkerArtifact[],
	log?: (message: string) => void,
): Promise<TaskArtifactThumbnail[]> {
	let timer: NodeJS.Timeout | undefined;
	try {
		const deadline = new Promise<TaskArtifactThumbnail[]>((resolve) => {
			timer = setTimeout(() => {
				log?.(`task thumbnail generation timed out after ${THUMBNAIL_OVERALL_TIMEOUT_MS}ms; the card falls back to typed chips`);
				resolve([]);
			}, THUMBNAIL_OVERALL_TIMEOUT_MS);
			// A hung render must not keep the process alive on shutdown either.
			timer.unref?.();
		});
		return await Promise.race([renderTaskArtifactThumbnails(taskFolder, artifacts, log), deadline]);
	} catch (e) {
		log?.(`task thumbnail generation failed: ${(e as Error).message}`);
		return [];
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function renderTaskArtifactThumbnails(
	taskFolder: string,
	artifacts: readonly SpecialistWorkerArtifact[],
	log?: (message: string) => void,
): Promise<TaskArtifactThumbnail[]> {
	const htmlArtifacts = artifacts.filter((artifact) => artifact.extension === ".html" && artifact.bytes <= MAX_THUMBNAIL_SOURCE_BYTES);
	if (htmlArtifacts.length === 0) return [];
	try {
		const availability = await htmlRenderAvailability();
		if (!availability.available) return [];
	} catch {
		return [];
	}
	const storeRoot = artifactRoot();
	const thumbsDir = path.resolve(storeRoot, ...taskFolder.split("/"), ".thumbs");
	const thumbnails: TaskArtifactThumbnail[] = [];
	for (const artifact of htmlArtifacts) {
		try {
			const fullPath = path.resolve(storeRoot, ...artifact.relativePath.split("/"));
			const html = fs.readFileSync(fullPath, "utf-8");
			// Deterministic decks carry <section class="slide"> frames; anything
			// without them falls back to a whole-page screenshot.
			let pngBase64: string | undefined;
			let slideCount: number | undefined;
			if (/<section[^>]+class="[^"]*\bslide\b/i.test(html)) {
				const rendered = await renderDeckHtmlToSlideImages(html, { maxSlides: 1 });
				pngBase64 = rendered.images[0]?.pngBase64;
				slideCount = (html.match(/<section[^>]+class="[^"]*\bslide\b/gi) ?? []).length;
			} else {
				const rendered = await renderHtmlToPreviewImage(html);
				pngBase64 = rendered?.pngBase64;
			}
			if (!pngBase64) continue;
			fs.mkdirSync(thumbsDir, { recursive: true, mode: 0o700 });
			const thumbName = `${path.basename(artifact.relativePath, ".html")}.png`;
			fs.writeFileSync(path.join(thumbsDir, thumbName), Buffer.from(pngBase64, "base64"), { mode: 0o600 });
			thumbnails.push({
				relativePath: artifact.relativePath,
				dataUri: `data:image/png;base64,${pngBase64}`,
				...(slideCount ? { slideCount } : {}),
			});
		} catch (e) {
			log?.(`task thumbnail render failed for ${artifact.relativePath}: ${(e as Error).message}`);
		}
	}
	return thumbnails;
}
