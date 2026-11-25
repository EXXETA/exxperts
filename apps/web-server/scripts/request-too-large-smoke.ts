// A conversation that has read many pictures keeps working where the provider
// limits a request's size, end to end: a real server, a room over its socket,
// and a provider that refuses a request over its limit.
//
// - Pictures are read one per message until a request is refused, as HTTP 413
//   and as HTTP 400 "Input is too long.": the message is answered without a
//   second click, the next one is not refused first, the saved conversation
//   still holds every picture, and the send-again is paid for as the first
//   send is: the same key, and the same kind of usage row for its answer.
// - A refusal over a rate limit is not sent again, though it speaks of a size.
// - One message that reads 25 pictures (35 MB) ends once, with no loop and no
//   shortening, in Anthropic's own words too, and its failure is named as one
//   of size. In words that leave size or tokens open it is shortened once.
// - Where a provider gives a request that big no answer at all, the older
//   pictures are left out before it is sent, once they pass the high mark; after
//   a restart too, and the saved conversation still holds them.
// - Pictures attached to the room, and a scanned PDF's pages, travel as what a
//   tool read, so they are left out the same way.
// - A conversation already too big answers after a restart: one refusal, sent
//   again by itself.
import { EARLIER_PICTURES_HIGH_MARK, EARLIER_PICTURES_LOW_MARK } from "@exxeta/exxperts-runtime";
import { ANTHROPIC_TOO_LARGE, assert, INPUT_TOO_LONG, REQUEST_TOO_LARGE, scannedPdf, SizeLimitRooms, TOO_LONG_FOR_MODEL, TOO_LONG_LITELLM, waitUntil, type Turn } from "./size-limit-setup.js";

const LIMIT = 20 * 1024 * 1024;
// Under the high mark, so that older pictures meet a refusal before they are left out ahead of one.
const SMALL_LIMIT = 14 * 1024 * 1024;
const rooms = new SizeLimitRooms();
const { gateway } = rooms;

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

function shape(turn: Turn): string {
	return JSON.stringify(turn.requests.map((request) => `${(request.bytes / 1048576).toFixed(1)} MB, ${request.pictures} pictures${request.refused ? ", refused" : ""}${request.summary ? ", summary" : ""}`));
}

const name = (i: number) => `big-${String(i).padStart(2, "0")}.png`;

try {
	await rooms.open();
	rooms.addPictures("big", 10, 900, 700);
	rooms.addPictures("small", 25, 610, 600);
	gateway.limitBytes = SMALL_LIMIT;

	for (const [label, refusal] of [["HTTP 413", REQUEST_TOO_LARGE], ['HTTP 400 "Input is too long."', INPUT_TOO_LONG]] as const) {
		gateway.refusal = refusal;
		const room = await rooms.room(`Pictures ${refusal.status}`);
		const roomStart = gateway.requests.length;
		let read = 0;
		let refused: Turn | undefined;
		while (!refused && read < 10) {
			const turn = await room.say(`read ${name(++read)}`);
			assert(turn.answer === `Answered: read ${name(read)}` && turn.failures.length === 0, `${label}: picture ${read} is answered, got "${turn.answer}", requests ${shape(turn)}, ${JSON.stringify(turn.failures).slice(0, 400)}`);
			if (turn.requests.some((request) => request.refused)) refused = turn;
		}
		assert(refused, `${label}: the pictures pass the limit`);
		const tries = refused.requests.slice(1);
		assert(tries.length === 2 && tries[0]!.refused && !tries[1]!.refused, `${label}: one request is refused and sent again once, got ${shape(refused)}`);
		assert(tries[0]!.pictures === read && tries[1]!.pictures < read && tries[1]!.pictures > 0, `${label}: some of the pictures are left out, got ${shape(refused)}`);
		assert(refused.frames.filter((frame) => frame.event?.type === "agent_end").length === 1, `${label}: the message ends once`);
		assert(tries[0]!.key === "Bearer synthetic-key" && tries[1]!.key === tries[0]!.key, `${label}: the same key pays for the send-again`);
		const rows = rooms.usageRows(room.id);
		const answered = gateway.requests.slice(roomStart).filter((request) => !request.refused).length;
		assert(rows.length === answered, `${label}: each answered request has its usage row, got ${rows.length} for ${answered}`);
		const keys = (row: any) => JSON.stringify({ agent: row.agent, persona: row.persona, kind: row.kind, provider: row.provider, model: row.model });
		assert(rows.every((row) => keys(row) === keys(rows[0])), `${label}: the send-again is recorded as every other answer, got ${JSON.stringify([...new Set(rows.map(keys))])}`);
		const next = await room.say("hello");
		assert(next.answer === "Answered: hello" && next.requests.length === 1 && !next.requests[0]!.refused, `${label}: the next message is answered and not refused first, got ${shape(next)}`);
		assert(next.requests[0]!.pictures === tries[1]!.pictures, `${label}: what was left out stays out, got ${shape(next)}`);
		assert(rooms.savedPictures(room.id) === read, `${label}: the saved conversation holds all ${read} pictures, got ${rooms.savedPictures(room.id)}`);
		pass(`${label}: the refused message is sent again smaller and answered, and the next is not refused (${shape(refused)})`);
	}

	gateway.limitBytes = LIMIT;
	{
		gateway.refusal = { status: 413, body: { error: { message: "Request too large for model `room-model` on tokens per minute (TPM): Limit 6000, Requested 7000", type: "tokens", code: "rate_limit_exceeded" } } };
		const room = await rooms.room("Rate Limit");
		gateway.limitBytes = undefined;
		await room.say(`read ${name(1)}`);
		gateway.limitBytes = 1024;
		const turn = await room.say("hello");
		assert(turn.requests.length === 1 && turn.failures.length > 0, `a rate limit's refusal is not sent again, got ${shape(turn)}`);
		gateway.limitBytes = LIMIT;
		pass("a refusal over a rate limit is not sent again");
	}

	for (const [label, refusal] of [["a gateway's 413", REQUEST_TOO_LARGE], ["Anthropic's 413", ANTHROPIC_TOO_LARGE]] as const) {
		gateway.refusal = refusal;
		const room = await rooms.room(`Many At Once ${refusal === REQUEST_TOO_LARGE ? 1 : 2}`);
		const turn = await room.say("read small-01..25");
		assert(turn.requests.length === 2 && turn.requests[1]!.refused && turn.requests[1]!.pictures === 25, `${label}: 25 pictures in one message: the call and one refused request, got ${shape(turn)}`);
		assert(turn.frames.filter((frame) => frame.event?.type === "agent_end").length === 1, "the turn ends once");
		assert(turn.failures.length === 1 && turn.failures[0]!.event?.failure === "request-size", `${label}: the page is told once, of a size, got ${JSON.stringify(turn.failures).slice(0, 400)}`);
		assert(!turn.frames.some((frame) => frame.event?.type === "compaction_start"), `${label}: nothing is shortened`);
		const next = await room.say("hello");
		assert(next.requests.length === 1 && next.answer === "Answered: hello" && next.failures.length === 0, `the next message is sent smaller, not refused, and answered, got ${shape(next)}`);
		pass(`${label}: 25 pictures (35 MB) in one message end once, with no loop: ${shape(turn)}; then "hello": ${shape(next)}`);
	}

	for (const [label, refusal] of [["Bedrock's words", TOO_LONG_FOR_MODEL], ["LiteLLM's words for them", TOO_LONG_LITELLM]] as const) {
		gateway.refusal = refusal;
		gateway.limitBytes = undefined;
		const room = await rooms.room(`Open Words ${refusal === TOO_LONG_LITELLM ? 2 : 1}`);
		gateway.limitPictures = 1;
		const from = room.start("read small-01..25");
		const failures = () => room.framesFrom(from.frames).filter((frame) => frame.event?.type === "message_end" && frame.event.failure);
		await waitUntil(() => failures().length === 2, "the refusal after the shortening");
		await room.settled("the refused message settles");
		const turn = { requests: gateway.requests.slice(from.requests), frames: room.framesFrom(from.frames) };
		assert(failures().length === 2 && failures()[1]!.event.failure === "request-size", `the last failure is named as one of size, got ${JSON.stringify(failures().map((frame) => frame.event.failure))}`);
		assert(turn.frames.filter((frame) => frame.event?.type === "compaction_start").length === 1, "the conversation is shortened once");
		assert(!turn.frames.some((frame) => frame.kind === "notify" && frame.failure === "could-not-shorten"), "the page is not told that it could not be shortened");
		gateway.limitPictures = undefined;
		const next = await room.say("hello");
		assert(next.answer === "Answered: hello" && next.failures.length === 0, `the next message is answered, got "${next.answer}", ${shape(next)}`);
		gateway.limitBytes = LIMIT;
		pass(`${label}, which leave size or tokens open, are shortened once for a message, then fail as a size: ${turn.requests.map((request) => `${request.pictures}${request.refused ? " refused" : request.summary ? " summary" : ""}`).join(", ")}`);
	}

	{
		const room = await rooms.room("No Answer");
		const bytes = Math.ceil(rooms.picture(name(1)).length / 3) * 4;
		const read = Math.floor(EARLIER_PICTURES_HIGH_MARK / bytes) + 1;
		const kept = Math.floor(EARLIER_PICTURES_LOW_MARK / bytes);
		gateway.limitBytes = undefined;
		for (let i = 0; i < read; i++) {
			const turn = await room.say(`read ${name((i % 10) + 1)}`);
			assert(turn.requests.at(-1)!.pictures === i + 1, `no answer: up to the high mark nothing is left out, got ${shape(turn)}`);
		}
		gateway.silentBytes = EARLIER_PICTURES_HIGH_MARK;
		const first = await room.say("hello");
		assert(first.answer === "Answered: hello" && first.failures.length === 0 && first.requests.length === 1 && first.requests[0]!.pictures === kept, `no answer: past the high mark the next message is sent with ${kept} pictures and answered, got "${first.answer}", ${shape(first)}`);
		await rooms.restart();
		await room.connect();
		const second = await room.say("hello again");
		assert(second.answer === "Answered: hello again" && second.failures.length === 0 && second.requests.length === 1 && second.requests[0]!.pictures === kept, `no answer: and so is the first one after a restart, got "${second.answer}", ${shape(second)}`);
		assert(rooms.savedPictures(room.id) === read, `no answer: the saved conversation holds all ${read} pictures, got ${rooms.savedPictures(room.id)}`);
		const logged = rooms.output.join("").split("\n").filter((line) => line.includes("[pictures past the high mark]"));
		assert(logged.some((line) => line.includes(`without ${read - kept} more earlier pictures that tools returned`)) && !logged.some((line) => /png|pdf/.test(line)), `no answer: the log counts what was left out and names none, got ${JSON.stringify(logged)}`);
		gateway.silentBytes = undefined;
		gateway.limitBytes = LIMIT;
		pass(`no answer over the high mark: ${read} pictures pass the high mark, and the next message is sent smaller: ${shape(first)}; after a restart: ${shape(second)}`);
	}

	{
		gateway.refusal = REQUEST_TOO_LARGE;
		const room = await rooms.room("Attached");
		const photos = [1, 2, 3].map((i) => `photo-${i}.png`);
		for (const [i, photo] of photos.entries()) await rooms.attach(room.id, photo, rooms.picture(`small-0${i + 1}.png`));
		await rooms.attach(room.id, "scan.pdf", scannedPdf(8));
		for (const file of [...photos, "scan.pdf"]) {
			const turn = await room.say(`open ${file}`);
			assert(turn.answer === `Answered: open ${file}` && turn.failures.length === 0 && turn.requests.length === 2, `attached: ${file} is answered, got "${turn.answer}", ${shape(turn)}`);
		}
		const refused = await room.say("open scan.pdf");
		assert(refused.answer === "Answered: open scan.pdf" && refused.failures.length === 0, `attached: the files pass the limit and the message is answered, got "${refused.answer}", ${shape(refused)}`);
		const [, big, smaller] = refused.requests;
		assert(refused.requests.length === 3 && big!.refused && big!.pictures === 3 + 8 + 8, `attached: one refusal, at three photos and the scan's 8 pages twice, got ${shape(refused)}`);
		assert(!smaller!.refused && smaller!.pictures === 8, `attached: the photos and the pages read before are left out, the pages just read are not, got ${shape(refused)}`);
		const next = await room.say("hello");
		assert(next.answer === "Answered: hello" && next.requests.length === 1, `attached: the next message is not refused, got ${shape(next)}`);
		assert(rooms.savedPictures(room.id) === big!.pictures, `attached: the saved conversation holds all ${big!.pictures}, got ${rooms.savedPictures(room.id)}`);
		const logged = rooms.output.join("").split("\n").filter((line) => line.includes("[request refused as too big]"));
		assert(logged.length > 0 && logged.at(-1)!.includes(`without ${big!.pictures - smaller!.pictures} more earlier pictures that tools returned`) && !logged.some((line) => /png|pdf/.test(line)), `the log counts what was left out and names none, got ${JSON.stringify(logged)}`);
		pass(`attached pictures and a scanned PDF's pages are left out the same way: ${shape(refused)}`);
	}

	{
		gateway.limitBytes = undefined;
		const room = await rooms.room("Already Too Big");
		for (let i = 1; i <= 7; i++) await room.say(`read ${name(i)}`);
		gateway.limitBytes = SMALL_LIMIT;
		await rooms.restart();
		await room.connect();
		const first = await room.say("hello");
		assert(first.requests.length === 2 && first.requests[0]!.refused && first.requests[0]!.pictures === 7, `after a restart the first message is refused once, got ${shape(first)}`);
		assert(!first.requests[1]!.refused && first.answer === "Answered: hello" && first.failures.length === 0, `and sent again by itself and answered, got "${first.answer}", ${shape(first)}`);
		const second = await room.say("hello again");
		assert(second.requests.length === 1 && second.answer === "Answered: hello again", `the one after it is answered at once, got ${shape(second)}`);
		pass(`a conversation already too big answers after a restart: ${shape(first)}`);
	}
	console.log("request-too-large smoke passed");
} catch (error) {
	console.error(`request-too-large-smoke FAILED: ${(error as Error).message}`);
	console.error(rooms.output.join("").slice(-3000));
	process.exitCode = 1;
} finally {
	await rooms.close();
}
