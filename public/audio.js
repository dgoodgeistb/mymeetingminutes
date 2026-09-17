function wavBlob(parts, sampleRate) {
  const size = parts.reduce((n, p) => n + (p.size ?? p.byteLength), 0);
  const header = new ArrayBuffer(44), view = new DataView(header);
  const str = (offset, value) => [...value].forEach((c,i) => view.setUint8(offset+i,c.charCodeAt(0)));
  str(0,'RIFF'); view.setUint32(4,36+size,true); str(8,'WAVE'); str(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*2,true);
  view.setUint16(32,2,true); view.setUint16(34,16,true); str(36,'data'); view.setUint32(40,size,true);
  return new Blob([header,...parts],{type:'audio/wav'});
}
class MeetingCapture {
  constructor(onChunk, onFailure) { this.onChunk=onChunk; this.onFailure=onFailure; this.pending={}; }
  async prepare(deviceId) {
    if (this.stream?.getAudioTracks().some(t=>t.readyState==='live')) {
      await this.context.resume(); return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error('HTTPS 또는 localhost에서 최신 브라우저로 열어 주세요.');
    try {
      this.context = new AudioContext();
      // Resume during the user gesture, before waiting for microphone permission.
      await this.context.resume();
      this.stream = await navigator.mediaDevices.getUserMedia({audio:{
        deviceId:deviceId ? {exact:deviceId} : undefined,
        channelCount:{ideal:1}, noiseSuppression:true, autoGainControl:true, echoCancellation:true
      }});
      await this.context.audioWorklet.addModule('/public/pcm-worklet.js');
      this.source = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser(); this.analyser.fftSize=512;
      this.node = new AudioWorkletNode(this.context,'meeting-pcm');
      this.mute = this.context.createGain(); this.mute.gain.value=0;
      this.source.connect(this.analyser); this.source.connect(this.node);
      this.node.connect(this.mute).connect(this.context.destination);
      this.node.port.onmessage = ({data}) => {
        if (data.type==='chunk') this.onChunk(data);
        else this.pending[data.type]?.();
      };
      this.node.onprocessorerror = () => this.onFailure('오디오 처리가 중단됐습니다. 저장된 구간을 확인해 주세요.');
      for (const track of this.stream.getTracks()) track.onended = () => this.onFailure('마이크 연결이 끊어졌습니다.');
      this.context.onstatechange = () => {
        if (this.active && this.context.state !== 'running') this.onFailure('브라우저가 오디오를 중단했습니다. 화면을 켜고 다시 녹음해 주세요.');
      };
    } catch (error) { await this.release(); throw error; }
  }
  command(command, response) {
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{delete this.pending[response];reject(new Error('오디오 장치 응답 시간이 초과됐습니다.'));},4000);
      this.pending[response]=()=>{clearTimeout(timer);delete this.pending[response];resolve();};
      this.node.port.postMessage(command);
    });
  }
  async start() { await this.context.resume(); await this.command('start','started'); this.active=true; }
  async stop() { this.active=false; await this.command('stop','stopped'); }
  async release() {
    this.active=false;
    this.stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});
    this.source?.disconnect(); this.node?.disconnect(); this.mute?.disconnect();
    if (this.context) { this.context.onstatechange=null; await this.context.close().catch(()=>{}); }
    this.stream=null; this.context=null; this.node=null;
  }
}
