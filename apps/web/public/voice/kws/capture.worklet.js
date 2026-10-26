// Copies microphone input into 20 ms blocks for the local keyword detector. It writes nothing to
// its output, so the node is silent wherever it is connected. Loaded from 'self' because the
// desktop CSP refuses blob: worklet modules.
"use strict";

class KwsCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 50);
    this.block = new Float32Array(this.size);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel === undefined) return true;
    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.size - this.filled);
      this.block.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.size) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("kws-capture", KwsCapture);
