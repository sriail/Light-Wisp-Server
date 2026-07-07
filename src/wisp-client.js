// wisp-client.js
// Browser-compatible Wisp client implementation.
// Uses the standard WebSocket API — can be used in browsers or any environment
// that provides a global WebSocket constructor.
//
// Usage:
//   const client = new WispClient("wss://example.com/wisp/");
//   client.onopen = () => {
//     const stream = client.createStream("example.com", 80);
//     stream.onmessage = (data) => console.log("received:", data);
//     stream.send(new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n"));
//   };

import {
  PacketType,
  StreamType,
  CloseReason,
  ExtensionID,
  parsePacket,
  parseContinuePayload,
  parseClosePayload,
  parseInfoPayload,
  buildConnectPacket,
  buildDataPacket,
  buildClosePacket,
  buildInfoPacket,
  serializeExtensions,
} from "./wisp-protocol.js";

// ─── WispClientStream ────────────────────────────────────────────────────────

export class WispClientStream {
  constructor(client, streamId, hostname, port, streamType) {
    this.client = client;
    this.streamId = streamId;
    this.hostname = hostname;
    this.port = port;
    this.streamType = streamType;
    this.bufferSize = 0;
    this.open = true;
    this._sendBuffer = [];

    this.onopen = () => {};
    this.onmessage = () => {};
    this.onclose = () => {};
  }

  /**
   * Send data to the remote host via the Wisp server.
   * Respects the server's buffer size — queues data if the buffer is full.
   * @param {Uint8Array} data
   */
  send(data) {
    if (!this.open) return;

    // UDP streams don't use buffer flow control
    if (this.streamType === StreamType.UDP || this.bufferSize > 0) {
      const packet = buildDataPacket(this.streamId, data);
      this.client._wsSend(packet);
      if (this.streamType !== StreamType.UDP) {
        this.bufferSize--;
      }
    } else {
      // Server buffer full — queue for later
      this._sendBuffer.push(data);
    }
  }

  /**
   * Called when a CONTINUE packet is received for this stream.
   * Flushes any buffered data.
   */
  _continueReceived(bufferSize) {
    this.bufferSize = bufferSize;
    while (this.bufferSize > 0 && this._sendBuffer.length > 0) {
      this.send(this._sendBuffer.shift());
    }
  }

  /**
   * Close the stream.
   * @param {number} reason - Wisp close reason code
   */
  close(reason = CloseReason.Voluntary) {
    if (!this.open) return;
    this.open = false;
    const packet = buildClosePacket(this.streamId, reason);
    this.client._wsSend(packet);
    this.onclose(reason);
    delete this.client.streams[this.streamId];
  }
}

// ─── WispClient ──────────────────────────────────────────────────────────────

export class WispClient {
  /**
   * @param {string} url - Wisp endpoint URL (must end with "/")
   * @param {Object} options
   * @param {number} [options.wispVersion=2] - Protocol version (1 or 2)
   */
  constructor(url, options = {}) {
    if (!url.endsWith("/")) {
      throw new TypeError("Wisp endpoints must end with a trailing forward slash");
    }

    this.url = url;
    this.wispVersion = options.wispVersion || 2;
    this.streams = {};
    this.nextStreamId = 1;
    this.maxBufferSize = 0;
    this.connected = false;
    this.connecting = false;
    this.infoReceived = false;
    this.serverMotd = null;
    this.udpEnabled = false;

    this.onopen = () => {};
    this.onclose = () => {};
    this.onerror = () => {};

    this._connect();
  }

  /**
   * Establish the WebSocket connection.
   */
  _connect() {
    const subprotocol = this.wispVersion === 2 ? "wisp-v2" : undefined;
    this.ws = new WebSocket(this.url, subprotocol);
    this.ws.binaryType = "arraybuffer";
    this.connecting = true;

    this.ws.onmessage = (event) => {
      this._onMessage(event);
      if (this.connected && this.connecting) {
        this.connecting = false;
        this.onopen();
      }
    };

    this.ws.onclose = () => {
      this._cleanup();
      this.onclose();
    };

    this.ws.onerror = () => {
      this._cleanup();
      this.onerror();
    };
  }

  /**
   * Send raw bytes on the underlying WebSocket.
   */
  _wsSend(data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /**
   * Handle incoming WebSocket messages.
   */
  _onMessage(event) {
    const data = new Uint8Array(event.data);
    if (data.byteLength < 5) return;

    let packet;
    try {
      packet = parsePacket(data);
    } catch (err) {
      return;
    }

    // Handle handshake packets (stream ID 0 during connecting phase)
    if (packet.streamId === 0 && this.connecting) {
      if (packet.type === PacketType.CONTINUE) {
        this.maxBufferSize = parseContinuePayload(packet.payload).bufferRemaining;
        this.connected = true;
        if (!this.infoReceived) {
          // No INFO received — server is V1
          this.wispVersion = 1;
        }
      } else if (packet.type === PacketType.INFO && this.wispVersion === 2) {
        this._handleServerInfo(packet);
      }
      return;
    }

    // Route to the appropriate stream
    const stream = this.streams[packet.streamId];
    if (!stream) return;

    if (packet.type === PacketType.DATA) {
      stream.onmessage(packet.payload);
    } else if (packet.type === PacketType.CONTINUE) {
      const { bufferRemaining } = parseContinuePayload(packet.payload);
      stream._continueReceived(bufferRemaining);
    } else if (packet.type === PacketType.CLOSE) {
      const { reason } = parseClosePayload(packet.payload);
      stream.open = false;
      stream.onclose(reason);
      delete this.streams[packet.streamId];
    }
  }

  /**
   * Process the server's INFO packet and respond with our own.
   */
  _handleServerInfo(packet) {
    const info = parseInfoPayload(packet.payload);
    this.infoReceived = true;

    // Process server extensions
    for (const ext of info.extensions) {
      if (ext.id === ExtensionID.UDP) {
        this.udpEnabled = true;
      } else if (ext.id === ExtensionID.MOTD) {
        this.serverMotd = new TextDecoder().decode(ext.metadata);
      }
    }

    // Build and send client INFO packet
    const clientExtensions = [
      { id: ExtensionID.UDP, metadata: new Uint8Array(0) },
      { id: ExtensionID.MOTD, metadata: new Uint8Array(0) },
    ];

    const infoPacket = buildInfoPacket(0, this.wispVersion, 0, clientExtensions);
    this._wsSend(infoPacket);
  }

  /**
   * Create a new stream to a remote host.
   * @param {string} hostname - Destination hostname or IP
   * @param {number} port - Destination port
   * @param {number|string} [type=StreamType.TCP] - Stream type (TCP or "tcp"/"udp")
   * @returns {WispClientStream}
   */
  createStream(hostname, port, type = StreamType.TCP) {
    let streamType = type;
    if (typeof streamType === "string") {
      streamType = type === "udp" ? StreamType.UDP : StreamType.TCP;
    }

    if (streamType === StreamType.UDP && !this.udpEnabled) {
      throw new Error("UDP is not enabled for this Wisp connection");
    }

    const streamId = this.nextStreamId++;
    const stream = new WispClientStream(this, streamId, hostname, port, streamType);
    stream.bufferSize = this.maxBufferSize;
    this.streams[streamId] = stream;
    stream.open = this.connected;

    // Send CONNECT packet
    const packet = buildConnectPacket(streamId, streamType, port, hostname);
    this._wsSend(packet);

    return stream;
  }

  /**
   * Close the Wisp connection and all active streams.
   */
  close() {
    this.ws.close();
  }

  /**
   * Clean up all streams on disconnect.
   */
  _cleanup() {
    this.connected = false;
    this.connecting = false;
    for (const id of Object.keys(this.streams)) {
      const stream = this.streams[id];
      stream.open = false;
      stream.onclose(CloseReason.NetworkError);
    }
    this.streams = {};
  }
}
