// A room's file programs still alive, for the smokes that run the file tools
// in a Mac's box. A file program runs from its room's folder (box-files.ts),
// and each smoke has a folder of its own, so smokes running side by side never
// count or signal each other's programs. A program that outlived its call keeps
// that folder, whoever its parent is now.
import { spawnSync } from "node:child_process";

import { fileProgram } from "../src/room-box/box-files.js";

export function fileProgramPidsIn(folder: string): number[] {
	const pids = spawnSync("/usr/bin/pgrep", ["-f", fileProgram().files[1]], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
	if (pids.length === 0) return [];
	// A program that ends between the two lists is simply left out.
	const listed = spawnSync("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { encoding: "utf8" }).stdout.split("\n");
	const inFolder: number[] = [];
	let pid = 0;
	for (const line of listed) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line === `n${folder}`) inFolder.push(pid);
	}
	return inFolder;
}
