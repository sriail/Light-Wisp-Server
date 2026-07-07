// ws-proxy.js
// Legacy wsproxy implementation — proxies a single TCP connection over WebSocket
// where the destination host:port is encoded in the URL path.
// URL format: ws://example.com/prefix/hostname:port

import { connect } from "cloudflare:sockets";

export class WSProxyHandler {
  /**
   * @param {WebSocket} ws - Server-side WebSocket
   * @param {string} path - URL pathname (e.g. "/hostname:port")
   */
  constructor(ws, path) {
    this.ws = ws;
    this.path = path;
    this.socket = null;
    this.writer = null;
    this.reader = null;
    this.closed = false;
  }

  /**
   * Accept the WebSocket and establish the TCP connection.
   */
  async start() {
    // Parse hostname:port from the last path segment
    const segments = this.path.split("/");
    const lastSegment = segments[segments.length - 1];
    const colonIndex = lastSegment.lastIndexOf(":");

    if (colonIndex === -1) {
      this.ws.accept();
      try { this.ws.close(4000, "Invalid URL format"); } catch (e) {}
      return;
    }

    this.hostname = lastSegment.substring(0, colonIndex).trim();
    this.port = parseInt(lastSegment.substring(colonIndex + 1));

    if (!this.port || this.port < 1 || this.port > 65535 || !this.hostname) {
      this.ws.accept();
      try { this.ws.close(4000, "Invalid host or port"); } catch (e) {}
      return;
    }

    this.ws.accept();

    try {
      this.socket = connect(
        { hostname: this.hostname, port: this.port },
        { allowHalfOpen: false }
      );
      await this.socket.opened;
    } catch (err) {
      try { this.ws.close(4000, "Connection failed"); } catch (e) {}
      return;
    }

    if (this.closed) {
      this.socket.close().catch(() => {});
      return;
    }

    this.writer = this.socket.writable.getWriter();
    this.reader = this.socket.readable.getReader();

    // Start TCP → WebSocket read loop
    this._readLoop();

    // Handle WebSocket → TCP writes
    this.ws.addEventListener("message", (event) => this._onMessage(event));
    this.ws.addEventListener("close", () => this._cleanup());
    this.ws.addEventListener("error", () => this._cleanup());
  }

  /**
   * Read from TCP socket and forward to WebSocket.
   */
  async _readLoop() {
    try {
      while (true) {
        const { done, value } = await this.reader.read();
        if (done) break;
        if (this.closed) break;
        try {
          this.ws.send(value);
        } catch (e) {
          break;
        }
      }
    } catch (err) {
      // Socket read error
    }
    this._cleanup();
  }

  /**
   * Handle incoming WebSocket data — forward to TCP socket.
   */
  async _onMessage(event) {
    if (typeof event.data === "string") return;

    const data = event.data instanceof Uint8Array
      ? event.data
      : new Uint8Array(event.data);

    try {
      await this.writer.write(data);
    } catch (err) {
      this._cleanup();
    }
  }

  /**
   * Clean up both WebSocket and TCP socket.
   */
  _cleanup() {
    if (this.closed) return;
    this.closed = true;

    if (this.socket) {
      this.socket.close().catch(() => {});
    }

    try { this.ws.close(); } catch (e) {}
  }
}
