// One continuous PCM capture supplies both the saved WAV and transcription chunks.
class MeetingPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.reset();
    this.port.onmessage = ({data}) => {
      if (data === 'start') { this.reset(); this.active = true; this.port.postMessage({type:'started'}); }
      if (data === 'stop') { this.active = false; this.flush(); this.port.postMessage({type:'stopped'}); }
    };
  }
  reset() { this.buffer = new ArrayBuffer(Math.round(sampleRate * 30) * 2); this.view = new DataView(this.buffer); this.count = 0; }
  flush() {
    if (this.count) {
      const pcm = this.buffer.slice(0, this.count * 2);
      this.port.postMessage({type:'chunk', pcm, sampleRate}, [pcm]);
    }
    this.reset();
  }
  process(inputs) {
    const channels = inputs[0];
    if (!this.active || !channels?.length) return true;
    for (let i=0;i<channels[0].length;i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      value = Math.max(-1, Math.min(1, value));
      this.view.setInt16(this.count++ * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
      if (this.count * 2 === this.buffer.byteLength) this.flush();
    }
    return true;
  }
}
registerProcessor('meeting-pcm', MeetingPCM);
