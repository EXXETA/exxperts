import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMostRecentSession, loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

describe("loadEntriesFromFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns empty array for non-existent file", () => {
		const entries = loadEntriesFromFile(join(tempDir, "nonexistent.jsonl"));
		expect(entries).toEqual([]);
	});

	it("adds a newline after an unterminated valid record", () => {
		const file = join(tempDir, "unterminated.jsonl");
		const content =
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}';
		writeFileSync(file, content);

		expect(loadEntriesFromFile(file)).toHaveLength(2);
		expect(readFileSync(file, "utf8")).toBe(`${content}\n`);
	});

	it("adds a newline after an unterminated malformed final fragment", () => {
		const file = join(tempDir, "malformed-tail.jsonl");
		const content =
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' + '{"type":"message"';
		writeFileSync(file, content);

		expect(loadEntriesFromFile(file)).toHaveLength(1);
		expect(readFileSync(file, "utf8")).toBe(`${content}\n`);
	});

	it("does not modify an unterminated non-session file", () => {
		const file = join(tempDir, "invalid.jsonl");
		const content = '{"type":"message","id":"1"}';
		writeFileSync(file, content);

		expect(loadEntriesFromFile(file)).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it("keeps an entry appended after resuming an unterminated file readable", () => {
		const file = join(tempDir, "resume-unterminated.jsonl");
		// Current-version header: open() must take the append path, not a migration rewrite.
		const content =
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}';
		writeFileSync(file, content);

		const manager = SessionManager.open(file, tempDir);
		manager.appendMessage(userMsg("second"));

		const entries = loadEntriesFromFile(file);
		expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "message"]);
	});

	it("returns empty array for empty file", () => {
		const file = join(tempDir, "empty.jsonl");
		writeFileSync(file, "");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for file without valid session header", () => {
		const file = join(tempDir, "no-header.jsonl");
		writeFileSync(file, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("returns empty array for malformed JSON", () => {
		const file = join(tempDir, "malformed.jsonl");
		writeFileSync(file, "not json\n");
		expect(loadEntriesFromFile(file)).toEqual([]);
	});

	it("loads valid session file", () => {
		const file = join(tempDir, "valid.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("session");
		expect(entries[1].type).toBe("message");
	});

	it("skips malformed lines but keeps valid ones", () => {
		const file = join(tempDir, "mixed.jsonl");
		writeFileSync(
			file,
			'{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				"not valid json\n" +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(2);
	});
});

describe("findMostRecentSession", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns null for empty directory", () => {
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns null for non-existent directory", () => {
		expect(findMostRecentSession(join(tempDir, "nonexistent"))).toBeNull();
	});

	it("ignores non-jsonl files", () => {
		writeFileSync(join(tempDir, "file.txt"), "hello");
		writeFileSync(join(tempDir, "file.json"), "{}");
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("ignores jsonl files without valid session header", () => {
		writeFileSync(join(tempDir, "invalid.jsonl"), '{"type":"message"}\n');
		expect(findMostRecentSession(tempDir)).toBeNull();
	});

	it("returns single valid session file", () => {
		const file = join(tempDir, "session.jsonl");
		writeFileSync(file, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		expect(findMostRecentSession(tempDir)).toBe(file);
	});

	it("returns most recently modified session", async () => {
		const file1 = join(tempDir, "older.jsonl");
		const file2 = join(tempDir, "newer.jsonl");

		writeFileSync(file1, '{"type":"session","id":"old","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');
		// Small delay to ensure different mtime
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(file2, '{"type":"session","id":"new","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(file2);
	});

	it("skips invalid files and returns valid one", async () => {
		const invalid = join(tempDir, "invalid.jsonl");
		const valid = join(tempDir, "valid.jsonl");

		writeFileSync(invalid, '{"type":"not-session"}\n');
		await new Promise((r) => setTimeout(r, 10));
		writeFileSync(valid, '{"type":"session","id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n');

		expect(findMostRecentSession(tempDir)).toBe(valid);
	});
});

describe("SessionManager.ensurePersisted", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes a JSONL header immediately for a newly created persisted session", () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile();
		expect(sessionFile).toBeTruthy();
		expect(existsSync(sessionFile!)).toBe(false);

		sm.ensurePersisted();

		expect(existsSync(sessionFile!)).toBe(true);
		const entries = loadEntriesFromFile(sessionFile!);
		expect(entries).toHaveLength(1);
		expect(entries[0].type).toBe("session");
		expect(entries[0].id).toBe(sm.getSessionId());
	});

	it("reopens an immediately flushed empty session with the same session id and empty context", () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile()!;
		const sessionId = sm.getSessionId();

		sm.ensurePersisted();
		const reopened = SessionManager.open(sessionFile, tempDir);

		expect(reopened.getSessionId()).toBe(sessionId);
		expect(reopened.getSessionFile()).toBe(sessionFile);
		expect(reopened.buildSessionContext().messages).toEqual([]);
	});

	it("materializes an explicit missing session path without changing the path on reopen", () => {
		const sessionFile = join(tempDir, "thread-123.jsonl");
		const sm = SessionManager.open(sessionFile, tempDir, tempDir);
		const sessionId = sm.getSessionId();

		expect(sm.getSessionFile()).toBe(sessionFile);
		expect(existsSync(sessionFile)).toBe(false);

		sm.ensurePersisted();
		const reopened = SessionManager.open(sessionFile, tempDir);

		expect(existsSync(sessionFile)).toBe(true);
		expect(reopened.getSessionFile()).toBe(sessionFile);
		expect(reopened.getSessionId()).toBe(sessionId);
	});

	it("does not change assistant-gated persistence unless explicitly called", () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile()!;

		sm.appendMessage(userMsg("hello"));
		expect(existsSync(sessionFile)).toBe(false);

		sm.appendMessage(assistantMsg("hi"));
		expect(existsSync(sessionFile)).toBe(true);

		const records = readFileSync(sessionFile, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(records.filter((record) => record.type === "session")).toHaveLength(1);
	});

	it("keeps an explicitly materialized header-only file consistent through the first assistant", () => {
		const sm = SessionManager.create(tempDir, tempDir);
		const sessionFile = sm.getSessionFile()!;

		sm.ensurePersisted();
		sm.appendModelChange("test-provider", "test-model");
		sm.appendMessage(userMsg("hello"));
		sm.appendMessage(assistantMsg("hi"));

		const records = readFileSync(sessionFile, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(records.filter((record) => record.type === "session")).toHaveLength(1);
		expect(records.map((record) => record.type)).toEqual(["session", "model_change", "message", "message"]);
	});
});

describe("SessionManager.setSessionFile with corrupted files", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("truncates and rewrites empty file with valid header", () => {
		const emptyFile = join(tempDir, "empty.jsonl");
		writeFileSync(emptyFile, "");

		const sm = SessionManager.open(emptyFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain a valid header
		const content = readFileSync(emptyFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());
	});

	it("truncates and rewrites file without valid header", () => {
		const noHeaderFile = join(tempDir, "no-header.jsonl");
		// File with messages but no session header (corrupted state)
		writeFileSync(
			noHeaderFile,
			'{"type":"message","id":"abc","parentId":"orphaned","timestamp":"2025-01-01T00:00:00Z","message":{"role":"assistant","content":"test"}}\n',
		);

		const sm = SessionManager.open(noHeaderFile, tempDir);

		// Should have created a new session with valid header
		expect(sm.getSessionId()).toBeTruthy();
		expect(sm.getHeader()).toBeTruthy();
		expect(sm.getHeader()?.type).toBe("session");

		// File should now contain only a valid header (old content truncated)
		const content = readFileSync(noHeaderFile, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		expect(lines.length).toBe(1);
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.id).toBe(sm.getSessionId());
	});

	it("preserves explicit session file path when recovering from corrupted file", () => {
		const explicitPath = join(tempDir, "my-session.jsonl");
		writeFileSync(explicitPath, "");

		const sm = SessionManager.open(explicitPath, tempDir);

		// The session file path should be preserved
		expect(sm.getSessionFile()).toBe(explicitPath);
	});

	it("subsequent loads of recovered file work correctly", () => {
		const corruptedFile = join(tempDir, "corrupted.jsonl");
		writeFileSync(corruptedFile, "garbage content\n");

		// First open recovers the file
		const sm1 = SessionManager.open(corruptedFile, tempDir);
		const sessionId = sm1.getSessionId();

		// Second open should load the recovered file successfully
		const sm2 = SessionManager.open(corruptedFile, tempDir);
		expect(sm2.getSessionId()).toBe(sessionId);
		expect(sm2.getHeader()?.type).toBe("session");
	});
});
