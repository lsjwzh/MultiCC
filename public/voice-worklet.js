// AudioWorklet: downsample mic audio to mono PCM16 at a target rate and post
// Int16Array chunks back to the main thread for streaming to the ASR server.
// processorOptions: { targetRate }  (the AudioContext runs at sampleRate, often 48000)
class PCM16Downsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = (options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.ratio = sampleRate / this.targetRate;   // sampleRate is a global in the worklet scope
    this._pos = 0;                                // fractional read position for resampling
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const ch = input[0];                          // mono (first channel)
    const out = [];
    // Linear-decimation resample from sampleRate → targetRate.
    while (this._pos < ch.length) {
      const i = Math.floor(this._pos);
      let s = ch[i];
      // clamp + convert float[-1,1] → int16
      s = Math.max(-1, Math.min(1, s));
      out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      this._pos += this.ratio;
    }
    this._pos -= ch.length;                        // carry fractional remainder to next block

    if (out.length) {
      const pcm = new Int16Array(out);
      this.port.postMessage(pcm, [pcm.buffer]);    // transfer, no copy
    }
    return true;
  }
}

registerProcessor('pcm16-downsampler', PCM16Downsampler);
