import { randomBytes } from "node:crypto";
import { serverHooks } from "./server-hooks.js";

/**
 * Whether this server gives every room its own files as the one folder its
 * file tools open (server-hooks.ts, roomFilesAreTheFolder). Asked each time,
 * never kept. This module imports nothing that reads a folder at load, so the
 * modules that render text can ask it before a test sets its home.
 */
export function roomFilesAreTheFolder(): boolean {
	return serverHooks().roomFilesAreTheFolder?.() === true;
}

/**
 * The mark in the name of a temporary file this server start may still be
 * writing in a room's files: an upload's clean-up leaves those and removes the
 * rest. The pid alone would not do, as a restarted container often gets the
 * same one.
 */
export const IN_FLIGHT_TEMPORARY_MARK = `.tmp-${process.pid}-${randomBytes(6).toString("hex")}-`;
