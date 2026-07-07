// wisp-server.js
// Wisp server implementation for Cloudflare Workers.
// Manages WebSocket connections, stream lifecycle, and TCP proxying via cloudflare:sockets.

import { connect } from "cloudflare:sockets";
import {
  PacketType,
  StreamType,
  CloseReason,
  ExtensionID,
  parsePacket,
  parseConnectPayload,
  parseClosePayload,
  parseInfoPayload,
  buildContinuePacket,
  buildClosePacket,
  buildDataPacket,
  buildInfoPacket,
} from "./wisp-protocol.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const STREAM_BUFFER_SIZE = 128;       // Max packets buffered per stream
const CONTINUE_INTERVAL = 64;          // Send CONTINUE every N processed packets (buffer_size / 2)
const WISP_MAJOR_VERSION = 2;
const WISP_MINOR_VERSION = 0;
const MAX_QUEUE_SIZE = STREAM_BUFFER_SIZE * 2; // Hard limit to prevent unbounded growth

// ─── WispStream ──────────────────────────────────────────────────────────────

class WispStream {
  constructor(streamId, server, hostname, port) {
    this.streamId = streamId;
    this.server = server;
    this.hostname = hostname;
    this.port = port;

    this.socket = null;
    this.writer = null;
    this.reader = null;

    this.closed = false;
    this.writing = false;
    this.packetsReceived = 0;

    this.writeQueue = [];
  }

  /**
   * Establish the TCP connection and start proxy loops.
   */
  async setup() {
    try {
      this.socket = connect(
        { hostname: this.hostname, port: this.port },
        { allowHalfOpen: false }
      );
      await this.socket.opened;
    } catch (err) {
      if (this.closed) return;
      const reason = this._classifyError(err);
      this.close(reason);
      return;
    }

    // Stream might have been closed while we were connecting
    if (this.closed) {
      this.socket.close().catch(() => {});
      return;
    }

    this.writer = this.socket.writable.getWriter();
    this.reader = this.socket.readable.getReader();

    // Start TCP → WebSocket read loop
    this._readLoop().catch(() => {
      if (!this.closed) this.close(CloseReason.NetworkError);
    });

    // Send initial CONTINUE (stream open confirmation)
    this._sendContinue();

    // Drain any data queued before connection completed
    this._processWriteQueue();
  }

  /**
   * Read from TCP socket and send DATA packets to the WebSocket client.
   */
  async _readLoop() {
    while (true) {
      const { done, value } = await this.reader.read();
      if (done) break;
      if (this.closed) break;
      this.server.send(buildDataPacket(this.streamId, value));
    }
    if (!this.closed) this.close(CloseReason.Voluntary);
  }

  /**
   * Queue data from the client to be written to the TCP socket.
   */
  writeData(data) {
    if (this.closed) return;

    // Prevent unbounded queue growth
    if (this.writeQueue.length >= MAX_QUEUE_SIZE) {
      this.close(CloseReason.Throttled);
      return;
    }

    this.writeQueue.push(data);
    this._processWriteQueue();
  }

  /**
   * Process queued data — writes to the TCP socket sequentially.
   * Called from both writeData() and setup(); guarded by `this.writing`.
   */
  async _processWriteQueue() {
    if (this.writing || !this.writer || this.closed) return;
    this.writing = true;

    while (this.writeQueue.length > 0 && !this.closed) {
      const data = this.writeQueue.shift();
      try {
        await this.writer.write(data);
      } catch (err) {
        this.writing = false;
        this.close(CloseReason.NetworkError);
        return;
      }

      this.packetsReceived++;

      // Periodically send CONTINUE so the client knows it can send more
      if (this.packetsReceived % CONTINUE_INTERVAL === 0) {
        this._sendContinue();
      }
    }

    this.writing = false;
  }

  /**
   * Send a CONTINUE packet with the current buffer remaining.
   */
  _sendContinue() {
    if (this.closed) return;
    const remaining = Math.max(0, STREAM_BUFFER_SIZE - this.writeQueue.length);
    this.server.send(buildContinuePacket(this.streamId, remaining));
  }

  /**
   * Close the stream and optionally notify the client.
   * @param {number|null} reason - Close reason code, or null to suppress notification.
   */
  close(reason = null) {
    if (this.closed) return;
    this.closed = true;

    if (this.socket) {
      this.socket.close().catch(() => {});
    }

    if (reason !== null) {
      this.server.send(buildClosePacket(this.streamId, reason));
    }

    this.server.removeStream(this.streamId);
  }

  /**
   * Map a connection error to an appropriate Wisp close reason.
   */
  _classifyError(err) {
    if (!err) return CloseReason.ConnectionRefused;
    const msg = (err.message || "").toLowerCase();
    if (msg.includes("resolve") || msg.includes("dns") || msg.includes("nxdomain") || msg.includes("nodata")) {
      return CloseReason.UnreachableHost;
    }
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return CloseReason.ConnectionTimeout;
    }
    if (msg.includes("refused") || msg.includes("reset") || msg.includes("econnrefused")) {
      return CloseReason.ConnectionRefused;
    }
    return CloseReason.ConnectionRefused;
  }
}

// ─── WispServer ──────────────────────────────────────────────────────────────

export class WispServer {
  /**
   * @param {WebSocket} ws - Server-side WebSocket from WebSocketPair
   * @param {string} path - URL pathname
   * @param {number} wispVersion - 1 or 2, determined by Sec-WebSocket-Protocol header
   */
  constructor(ws, path, wispVersion) {
    this.ws = ws;
    this.path = path;
    this.wispVersion = wispVersion;
    this.streams = new Map();
    this.handshakeComplete = false;
    this.extensions = [];
  }

  /**
   * Accept the WebSocket and begin the Wisp handshake.
   */
  start() {
    this.ws.accept();

    // Build server-side extensions
    // NOTE: No UDP extension — Workers don't support UDP sockets.
    this.extensions = [
      {
        id: ExtensionID.MOTD,
        metadata: new TextEncoder().encode("Wisp server on Cloudflare Workers — TCP only"),
      },
      {
        id: ExtensionID.StreamOpenConfirmation,
        metadata: new Uint8Array(0),
      },
    ];

    if (this.wispVersion === 2) {
      // V2: send INFO packet first, wait for client INFO, then send CONTINUE
      this.send(buildInfoPacket(0, WISP_MAJOR_VERSION, WISP_MINOR_VERSION, this.extensions));
    } else {
      // V1: send CONTINUE immediately, no INFO exchange
      this.send(buildContinuePacket(0, STREAM_BUFFER_SIZE));
      this.handshakeComplete = true;
    }

    this.ws.addEventListener("message", (event) => this._onMessage(event));
    this.ws.addEventListener("close", () => this._onClose());
    this.ws.addEventListener("error", () => this._onClose());
  }

  /**
   * Safely send data on the WebSocket, ignoring errors if already closed.
   */
  send(data) {
    try {
      this.ws.send(data);
    } catch (e) {
      // WebSocket is closed or closing — silently ignore
    }
  }

  /**
   * Handle incoming WebSocket messages.
   */
  _onMessage(event) {
    // Ignore text frames
    if (typeof event.data === "string") return;

    const data = event.data instanceof Uint8Array
      ? event.data
      : new Uint8Array(event.data);

    // Minimum packet size: 1 byte type + 4 bytes stream ID
    if (data.byteLength < 5) return;

    let packet;
    try {
      packet = parsePacket(data);
    } catch (err) {
      return; // Malformed packet — ignore
    }

    // Handle handshake phase
    if (!this.handshakeComplete) {
      if (packet.type === PacketType.INFO) {
        this._handleClientInfo(packet);
        return;
      }
      // Client sent non-INFO before handshake completed — treat as V1
      if (packet.type === PacketType.CONNECT) {
        this.handshakeComplete = true;
        this._handleConnect(packet);
        return;
      }
      return;
    }

    // Route established-connection packets
    try {
      this._routePacket(packet);
    } catch (err) {
      // Ignore routing errors
    }
  }

  /**
   * Process the client's INFO packet and complete the V2 handshake.
   */
  _handleClientInfo(packet) {
    // Parse client info (we don't need most of it for this lightweight impl)
    try {
      parseInfoPayload(packet.payload);
    } catch (err) {
      this.send(buildClosePacket(0, CloseReason.IncompatibleExtensions));
      try { this.ws.close(); } catch (e) {}
      return;
    }

    this.handshakeComplete = true;

    // Send initial CONTINUE with stream ID 0
    this.send(buildContinuePacket(0, STREAM_BUFFER_SIZE));
  }

  /**
   * Route a packet from the client to the appropriate handler.
   */
  _routePacket(packet) {
    switch (packet.type) {
      case PacketType.CONNECT:
        this._handleConnect(packet);
        break;
      case PacketType.DATA:
        this._handleData(packet);
        break;
      case PacketType.CLOSE:
        this._handleClose(packet);
        break;
      case PacketType.CONTINUE:
        // Client should never send CONTINUE — ignore
        break;
      default:
        // Unknown packet type — ignore
        break;
    }
  }

  /**
   * Handle a CONNECT packet — create a new TCP stream.
   */
  _handleConnect(packet) {
    const { streamType, port, hostname } = parseConnectPayload(packet.payload);

    // Workers only support TCP
    if (streamType !== StreamType.TCP) {
      this.send(buildClosePacket(packet.streamId, CloseReason.Unspecified));
      return;
    }

    // Validate port
    if (!port || port < 1 || port > 65535 || !hostname) {
      this.send(buildClosePacket(packet.streamId, CloseReason.InvalidInfo));
      return;
    }

    // Close existing stream with the same ID if it exists
    if (this.streams.has(packet.streamId)) {
      this.streams.get(packet.streamId).close(null);
    }

    // Create and start the new stream
    const stream = new WispStream(packet.streamId, this, hostname, port);
    this.streams.set(packet.streamId, stream);
    stream.setup();
  }

  /**
   * Handle a DATA packet — forward payload to the TCP socket.
   */
  _handleData(packet) {
    const stream = this.streams.get(packet.streamId);
    if (!stream) return;
    stream.writeData(packet.payload);
  }

  /**
   * Handle a CLOSE packet — tear down the stream.
   */
  _handleClose(packet) {
    const stream = this.streams.get(packet.streamId);
    if (!stream) return;
    // Client-initiated close — don't send CLOSE back
    stream.close(null);
  }

  /**
   * Remove a stream from the active map.
   */
  removeStream(streamId) {
    this.streams.delete(streamId);
  }

  /**
   * Close a specific stream with a reason.
   */
  closeStream(streamId, reason) {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    stream.close(reason);
  }

  /**
   * Handle WebSocket closure — clean up all streams.
   */
  _onClose() {
    for (const stream of this.streams.values()) {
      stream.close(null);
    }
    this.streams.clear();
  }
}
