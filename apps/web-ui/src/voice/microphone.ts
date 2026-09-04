/**
 * The microphone half of conversation mode: capture in the browser, recognise
 * on the computer. Frames leave through the audio worklet as 16 kHz PCM and
 * travel over the voice websocket; partial and final text comes back. Audio
 * is only sent after the server says it is ready, because the model may be
 * loading on first use and a frame sent before that would be lost.
 */

export type MicrophoneFailure = { code: string; message: string };

export type Microphone = {
	close(): void;
};

export async function openMicrophone(hooks: {
	language: string;
	onReady(): void;
	onPartial(text: string): void;
	onFinal(text: string): void;
	onError(failure: MicrophoneFailure): void;
}): Promise<Microphone> {
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
	} catch (error) {
		const refused = (error as { name?: string }).name === "NotAllowedError";
		throw Object.assign(
			new Error(refused ? "Microphone access was refused. Allow it for exxperts and try again." : `The microphone could not be opened (${(error as Error).message}).`),
			{ code: "microphone" },
		);
	}
	const context = new AudioContext();
	try {
		// Emitted as a real file (see vite.config.ts): the page's script policy
		// allows only its own origin, so an inlined data: URL would not load.
		await context.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
	} catch (error) {
		for (const track of stream.getTracks()) track.stop();
		void context.close().catch(() => {});
		throw Object.assign(new Error(`The microphone helper could not be loaded (${(error as Error).message}).`), { code: "microphone" });
	}
	const source = context.createMediaStreamSource(stream);
	const capture = new AudioWorkletNode(context, "pcm-capture", { processorOptions: { targetRate: 16000 } });
	source.connect(capture);

	const scheme = location.protocol === "https:" ? "wss" : "ws";
	const socket = new WebSocket(`${scheme}://${location.host}/ws/voice?language=${encodeURIComponent(hooks.language)}`);
	socket.binaryType = "arraybuffer";
	let ready = false;
	let closed = false;

	capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
		if (ready && socket.readyState === WebSocket.OPEN) socket.send(event.data);
	};
	socket.onmessage = (event) => {
		let message: { type?: string; text?: string; code?: string; message?: string };
		try { message = JSON.parse(String(event.data)); } catch { return; }
		switch (message.type) {
			case "ready": ready = true; hooks.onReady(); break;
			case "partial": hooks.onPartial(String(message.text ?? "")); break;
			case "final": hooks.onFinal(String(message.text ?? "")); break;
			case "error": hooks.onError({ code: String(message.code ?? "voice"), message: String(message.message ?? "Voice failed.") }); break;
		}
	};
	socket.onclose = () => {
		if (!closed) hooks.onError({ code: "connection", message: "The voice connection closed." });
	};

	return {
		close() {
			closed = true;
			try { socket.close(); } catch {}
			capture.port.onmessage = null;
			try { source.disconnect(); capture.disconnect(); } catch {}
			for (const track of stream.getTracks()) track.stop();
			void context.close().catch(() => {});
		},
	};
}
