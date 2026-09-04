// Microphone frames for the recogniser: mono, 16 kHz, signed 16-bit, posted
// every 100 ms. Runs on the audio thread, so the page never touches samples.
// ponytail: linear-interpolation downsampler, which is plenty for speech
// recognition; a windowed filter is the upgrade if aliasing ever shows.
class PcmCapture extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const targetRate = options?.processorOptions?.targetRate ?? 16000;
		this.ratio = sampleRate / targetRate;
		this.position = 0;
		this.frame = new Int16Array(Math.round(targetRate / 10));
		this.filled = 0;
	}

	process(inputs) {
		const input = inputs[0] && inputs[0][0];
		if (!input) return true;
		let position = this.position;
		while (position < input.length) {
			const low = Math.floor(position);
			const high = Math.min(low + 1, input.length - 1);
			const sample = input[low] + (input[high] - input[low]) * (position - low);
			this.frame[this.filled++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
			if (this.filled === this.frame.length) {
				this.port.postMessage(this.frame.buffer.slice(0));
				this.filled = 0;
			}
			position += this.ratio;
		}
		this.position = position - input.length;
		return true;
	}
}

registerProcessor("pcm-capture", PcmCapture);
