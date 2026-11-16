import path from "node:path";

import { roomBoxComputer } from "../box-available.js";

/**
 * On Windows the file tools run in the server behind the fence (room-files.ts),
 * not in the box. The fence refuses a link that is there when it checks, so a
 * boxed command running at the same time on the same folders could change what
 * the fence saw before the open. This wait keeps the two apart: a file call and
 * a boxed command whose folders overlap never run at once, and the later one
 * waits. Commands share folders with commands, and file calls with file calls.
 *
 * In memory, one per server process: the commands it keeps apart run in this
 * process's own box processes, and end with them.
 */

/**
 * Whether `candidate` is `folder` or inside it, by `paths`' rule for names, so
 * Windows' ignores case. A name that only starts with two dots, as `..notes`,
 * is inside.
 */
export const atOrInside = (paths: path.PlatformPath) => (candidate: string, folder: string): boolean => {
	const relative = paths.relative(folder, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
};

/** Who holds: a boxed command, or one file call. */
export type Holder = "command" | "file";

type Hold = { holder: Holder; folders: readonly string[] };
type Waiting = { hold: Hold; start: () => void };

export class FolderWait {
	private readonly running = new Set<Hold>();
	/** The holds waiting, in the order they came. */
	private readonly waiting: Waiting[] = [];

	/** `inside(candidate, folder)`: whether candidate is folder or inside it; this computer's rule by default. */
	constructor(readonly inside: (candidate: string, folder: string) => boolean = atOrInside(path)) {}

	/**
	 * Runs `work` once no overlapping hold of the other kind runs or waits ahead
	 * of it, and holds `folders` until `work` settles. Stop while it waits rejects
	 * with `stopped()` and leaves nothing held.
	 */
	async hold<T>(holder: Holder, folders: readonly string[], signal: AbortSignal | undefined, work: () => Promise<T>, stopped: () => Error = () => new Error("aborted")): Promise<T> {
		if (signal?.aborted) throw stopped();
		const hold: Hold = { holder, folders };
		if (this.free(hold, this.waiting.length)) this.running.add(hold);
		else await this.queue(hold, signal, stopped);
		try {
			return await work();
		} finally {
			this.running.delete(hold);
			this.startWaiting();
		}
	}

	private queue(hold: Hold, signal: AbortSignal | undefined, stopped: () => Error): Promise<void> {
		return new Promise((resolve, reject) => {
			const entry: Waiting = {
				hold,
				start: () => {
					signal?.removeEventListener("abort", stop);
					this.running.add(hold);
					resolve();
				},
			};
			const stop = () => {
				const at = this.waiting.indexOf(entry);
				if (at === -1) return;
				this.waiting.splice(at, 1);
				reject(stopped());
				// One that waited behind it may start now.
				this.startWaiting();
			};
			this.waiting.push(entry);
			signal?.addEventListener("abort", stop, { once: true });
		});
	}

	/** Whether `hold` overlaps no running hold and none of the first `ahead` waiting: first come, first served, so neither side starves. */
	private free(hold: Hold, ahead: number): boolean {
		for (const other of this.running) if (this.overlap(hold, other)) return false;
		for (let at = 0; at < ahead; at++) if (this.overlap(hold, this.waiting[at].hold)) return false;
		return true;
	}

	private startWaiting(): void {
		for (let at = 0; at < this.waiting.length;) {
			const entry = this.waiting[at];
			if (!this.free(entry.hold, at)) {
				at++;
				continue;
			}
			this.waiting.splice(at, 1);
			entry.start();
		}
	}

	private overlap(one: Hold, other: Hold): boolean {
		if (one.holder === other.holder) return false;
		return one.folders.some((mine) => other.folders.some((theirs) => this.inside(mine, theirs) || this.inside(theirs, mine)));
	}
}

/** The server's one wait: every room, conversation and scheduled run on this server shares it. */
export const folderWait = new FolderWait();

/**
 * The wait a session's file tools get: every room's on a Windows PC whose box
 * runs, its protection off too, since another room's boxed command may share
 * its folders. Never on a Mac, whose file tools run in its box, nor on a shared
 * server, whose computer has no box (roomBoxComputer).
 */
export function fileToolsWait(): FolderWait | undefined {
	return roomBoxComputer() === "windows" ? folderWait : undefined;
}
