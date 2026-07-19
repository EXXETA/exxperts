const {
	buildPersistentRoomRestoredLiveThreadContext,
	MAX_RESTORED_MESSAGES,
	MAX_RESTORED_MESSAGE_CHARS,
	MAX_RESTORED_TOTAL_CHARS,
} = await import("../src/persistent-room-resume-context.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertIncludes(haystack: string, needle: string, label: string): void {
	assert(haystack.includes(needle), `${label}: expected block to include ${needle}`);
}

function assertNotIncludes(haystack: string, needle: string, label: string): void {
	assert(!haystack.includes(needle), `${label}: expected block not to include ${needle}`);
}

function assertBefore(haystack: string, first: string, second: string, label: string): void {
	const firstIndex = haystack.indexOf(first);
	const secondIndex = haystack.indexOf(second);
	assert(firstIndex >= 0, `${label}: missing first marker ${first}`);
	assert(secondIndex >= 0, `${label}: missing second marker ${second}`);
	assert(firstIndex < secondIndex, `${label}: expected ${first} before ${second}`);
}

function makeFixedLengthMessage(prefix: string, length: number): string {
	assert(prefix.length < length, "test prefix must be shorter than requested fixed length");
	return prefix + "x".repeat(length - prefix.length);
}

try {
	assert(buildPersistentRoomRestoredLiveThreadContext([]) === null, "empty array should return null");
	assert(
		buildPersistentRoomRestoredLiveThreadContext([
			{ kind: "system", text: "system-only" },
			{ kind: "tool", text: "tool-only" },
			{ kind: "approval", text: "approval-only" },
			{ kind: "handoff", text: "handoff-only" },
			{ kind: "assistant", text: "streaming-only", streaming: true },
			{ kind: "user", text: "" },
			{ kind: "assistant", text: "   " },
			{ kind: "user", text: 123 },
			null,
			"malformed",
		] as unknown[]) === null,
		"no eligible items should return null",
	);

	const filtered = buildPersistentRoomRestoredLiveThreadContext([
		{ kind: "system", text: "SYSTEM_SENTINEL_SHOULD_NOT_APPEAR" },
		{ kind: "user", text: "  hello from user  \r\n" },
		{ kind: "tool", text: "TOOL_SENTINEL_SHOULD_NOT_APPEAR" },
		{ kind: "assistant", text: "assistant reply" },
		{ kind: "approval", text: "APPROVAL_SENTINEL_SHOULD_NOT_APPEAR" },
		{ kind: "handoff", text: "HANDOFF_SENTINEL_SHOULD_NOT_APPEAR" },
		{ kind: "assistant", text: "STREAMING_SENTINEL_SHOULD_NOT_APPEAR", streaming: true },
		{ kind: "assistant", text: 42 },
		{ nope: true },
	] as unknown[]);
	assert(filtered != null, "eligible user/assistant text should produce restored context");
	assert(filtered.metadata.sourceItemCount === 9, "sourceItemCount should count all source items");
	assert(filtered.metadata.eligibleItemCount === 2, "eligibleItemCount should count only eligible user/assistant text");
	assert(filtered.metadata.includedItemCount === 2, "includedItemCount should include both eligible messages under caps");
	assert(filtered.metadata.omittedOlderCount === 0, "under caps should omit no older messages");
	assertIncludes(filtered.block, "User: hello from user", "filtered transcript");
	assertIncludes(filtered.block, "Assistant: assistant reply", "filtered transcript");
	assertBefore(filtered.block, "User: hello from user", "Assistant: assistant reply", "filtered transcript order");
	for (const sentinel of [
		"SYSTEM_SENTINEL_SHOULD_NOT_APPEAR",
		"TOOL_SENTINEL_SHOULD_NOT_APPEAR",
		"APPROVAL_SENTINEL_SHOULD_NOT_APPEAR",
		"HANDOFF_SENTINEL_SHOULD_NOT_APPEAR",
		"STREAMING_SENTINEL_SHOULD_NOT_APPEAR",
	]) {
		assertNotIncludes(filtered.block, sentinel, "excluded item filtering");
	}

	const allIncludedItems = [
		{ kind: "user", text: "first under caps" },
		{ kind: "assistant", text: "second under caps" },
		{ kind: "user", text: "third under caps" },
	];
	const allIncluded = buildPersistentRoomRestoredLiveThreadContext(allIncludedItems);
	assert(allIncluded != null, "all eligible under caps should produce restored context");
	assert(allIncluded.metadata.eligibleItemCount === allIncludedItems.length, "all-under-caps eligible count should match input");
	assert(allIncluded.metadata.includedItemCount === allIncludedItems.length, "all-under-caps should include all eligible messages");
	assert(allIncluded.metadata.messageCountTruncated === false, "all-under-caps should not be message-count truncated");
	assert(allIncluded.metadata.totalCharsTruncated === false, "all-under-caps should not be total-chars truncated");
	assertBefore(allIncluded.block, "first under caps", "second under caps", "all-under-caps chronological order 1");
	assertBefore(allIncluded.block, "second under caps", "third under caps", "all-under-caps chronological order 2");

	const overMessageCapItems = Array.from({ length: MAX_RESTORED_MESSAGES + 2 }, (_, index) => ({
		kind: "user",
		text: `COUNT_MSG_${String(index).padStart(2, "0")}`,
	}));
	const overMessageCap = buildPersistentRoomRestoredLiveThreadContext(overMessageCapItems);
	assert(overMessageCap != null, "over message cap should produce restored context");
	assert(overMessageCap.metadata.eligibleItemCount === MAX_RESTORED_MESSAGES + 2, "over-message-cap eligible count should include all eligible messages");
	assert(overMessageCap.metadata.includedItemCount === MAX_RESTORED_MESSAGES, "over-message-cap should include capped tail length");
	assert(overMessageCap.metadata.omittedOlderCount === 2, "over-message-cap should omit oldest two messages");
	assert(overMessageCap.metadata.messageCountTruncated === true, "over-message-cap should set messageCountTruncated");
	assert(overMessageCap.metadata.totalCharsTruncated === false, "short over-message-cap case should not set totalCharsTruncated");
	assertNotIncludes(overMessageCap.block, "COUNT_MSG_00", "over-message-cap oldest omitted");
	assertNotIncludes(overMessageCap.block, "COUNT_MSG_01", "over-message-cap second-oldest omitted");
	assertIncludes(overMessageCap.block, "COUNT_MSG_02", "over-message-cap tail starts at message 02");
	assertIncludes(overMessageCap.block, `COUNT_MSG_${String(MAX_RESTORED_MESSAGES + 1).padStart(2, "0")}`, "over-message-cap newest retained");
	assertBefore(overMessageCap.block, "COUNT_MSG_02", "COUNT_MSG_03", "over-message-cap chronological order");

	const totalCapMessageLength = 1_180;
	const overTotalCapItems = Array.from({ length: 11 }, (_, index) => ({
		kind: "user",
		text: makeFixedLengthMessage(`TOTAL_MSG_${String(index).padStart(2, "0")}_`, totalCapMessageLength),
	}));
	const overTotalCap = buildPersistentRoomRestoredLiveThreadContext(overTotalCapItems);
	assert(overTotalCap != null, "over total char cap should produce restored context");
	assert(overTotalCap.metadata.eligibleItemCount === overTotalCapItems.length, "over-total-cap eligible count should include all eligible messages");
	assert(overTotalCap.metadata.includedItemCount < overTotalCap.metadata.eligibleItemCount, "over-total-cap should omit older messages");
	assert(overTotalCap.metadata.omittedOlderCount > 0, "over-total-cap should track omitted older messages");
	assert(overTotalCap.metadata.messageCountTruncated === false, "over-total-cap with few messages should not set messageCountTruncated");
	assert(overTotalCap.metadata.totalCharsTruncated === true, "over-total-cap should set totalCharsTruncated");
	assertNotIncludes(overTotalCap.block, "TOTAL_MSG_00_", "over-total-cap oldest omitted");
	assertIncludes(overTotalCap.block, "TOTAL_MSG_10_", "over-total-cap newest retained");
	assertBefore(overTotalCap.block, "TOTAL_MSG_02_", "TOTAL_MSG_10_", "over-total-cap chronological tail order");

	const longPrivateText = `LONG_PRIVATE_TRANSCRIPT_SENTINEL_${"z".repeat(MAX_RESTORED_MESSAGE_CHARS + 200)}`;
	const longMessage = buildPersistentRoomRestoredLiveThreadContext([{ kind: "user", text: longPrivateText }]);
	assert(longMessage != null, "long message should produce restored context");
	assert(longMessage.metadata.truncatedMessageCount === 1, "long message should increment truncatedMessageCount");
	assert(longMessage.metadata.includedItemCount === 1, "long message should still be included after truncation");
	assert(longMessage.block.includes("Messages truncated to the per-message cap"), "long message block should disclose per-message truncation");
	assert(longMessage.block.length < longPrivateText.length + 800, "long message block should not include full over-cap raw text");

	const metadataKeys = Object.keys(longMessage.metadata).sort();
	assert(metadataKeys.join(",") === [
		"eligibleItemCount",
		"includedItemCount",
		"maxRestoredMessageChars",
		"maxRestoredMessages",
		"maxRestoredTotalChars",
		"messageCountTruncated",
		"omittedOlderCount",
		"sourceItemCount",
		"totalCharsTruncated",
		"truncatedMessageCount",
	].sort().join(","), "metadata should expose the approved key set");
	assert(longMessage.metadata.maxRestoredMessages === MAX_RESTORED_MESSAGES, "metadata should include maxRestoredMessages");
	assert(longMessage.metadata.maxRestoredTotalChars === MAX_RESTORED_TOTAL_CHARS, "metadata should include maxRestoredTotalChars");
	assert(longMessage.metadata.maxRestoredMessageChars === MAX_RESTORED_MESSAGE_CHARS, "metadata should include maxRestoredMessageChars");
	const metadataJson = JSON.stringify(longMessage.metadata);
	assert(!metadataJson.includes("LONG_PRIVATE_TRANSCRIPT_SENTINEL"), "metadata serialization must not include raw transcript strings");
	assert(!metadataJson.includes(longPrivateText), "metadata serialization must not include full raw transcript text");

	for (const requiredTerm of [
		"RESTORED PERSISTENT ROOM LIVE THREAD CONTEXT",
		"continuation context",
	]) {
		assertIncludes(filtered.block, requiredTerm, "required prompt wording");
	}
	for (const bannedJargonTerm of ["L1b", "uncheckpointed", "durable memory"]) {
		assertNotIncludes(filtered.block, bannedJargonTerm, "prompt wording must not narrate memory mechanics");
	}

	console.log("persistent-room resume context smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
}

export {};
