// Live transcription microphone capture (Chat Test → Live transcription).
// Runs in the AudioWorklet scope: mixes the input to mono, resamples it from
// the context rate to 24 kHz (linear interpolation, averaging when the source
// is faster) and posts 16-bit little-endian PCM in 100 ms chunks. A "flush"
// message posts the partial chunk, then `{ type: "flushed" }`, so the page can
// commit a turn after the last of its audio. Served same-origin from /public,
// so no blob: or unsafe-* CSP source is needed.
const TARGET_RATE = 24_000;
const CHUNK_SAMPLES = 2_400;

class RealtimePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.position = 0;
    this.previous = 0;
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.length = 0;
    this.port.onmessage = (event) => {
      if (event.data !== "flush") return;
      this.post();
      this.port.postMessage({ type: "flushed" });
    };
  }

  post() {
    if (this.length === 0) return;
    const out = this.chunk.slice(0, this.length);
    this.port.postMessage(out.buffer, [out.buffer]);
    this.length = 0;
  }

  push(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    this.chunk[this.length] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.length += 1;
    if (this.length === CHUNK_SAMPLES) this.post();
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0 || !channels[0]) return true;
    const frames = channels[0].length;
    const mono = new Float32Array(frames);
    for (const channel of channels) {
      for (let index = 0; index < frames; index += 1)
        mono[index] += channel[index] / channels.length;
    }
    const at = (index) => (index < 0 ? this.previous : mono[index]);
    // `position` is a fractional index into this block, where -1 is the last
    // sample of the previous block.
    while (Math.floor(this.position) + 1 < frames) {
      const base = Math.floor(this.position);
      const fraction = this.position - base;
      let value = at(base) * (1 - fraction) + at(base + 1) * fraction;
      if (this.step >= 2) value = (value + at(base - 1)) / 2;
      this.push(value);
      this.position += this.step;
    }
    this.position -= frames;
    this.previous = mono[frames - 1];
    return true;
  }
}

registerProcessor("realtime-pcm", RealtimePcmProcessor);
