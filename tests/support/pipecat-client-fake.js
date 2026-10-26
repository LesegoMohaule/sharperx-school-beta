export class PipecatClient {
  constructor({ transport, callbacks }) {
    this.transport = transport;
    this.callbacks = callbacks;
    this.disconnected = false;
    globalThis.__tutorClients.push(this);
  }

  async connect() {
    await this.transport.options.mediaManager.initialize();
    await this.transport.options.mediaManager.connect();
    this.callbacks.onConnected?.();
  }

  async disconnect() {
    this.disconnected = true;
    this.callbacks.onDisconnected?.();
  }

  enableMic(enabled) {
    this.transport.options.mediaManager.enableMic(enabled);
  }
}
