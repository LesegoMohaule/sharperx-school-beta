export class SmallWebRTCTransport {
  constructor(options) { this.options = options; }
  tracks() { return this.options.mediaManager.tracks(); }
  get isMicEnabled() { return this.options.mediaManager.isMicEnabled; }
}
