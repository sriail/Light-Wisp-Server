// server.js
'use strict';

import { connect } from 'cloudflare:sockets';

export const packet_types = {
  CONNECT: 0x01, DATA: 0x02, CONTINUE: 0x03, CLOSE: 0x04
};

export const stream_types = {
  TCP: 0x01, UDP: 0x02
};

export const close_reasons = {
  Unknown: 0x01, Voluntary: 0x02, NetworkError: 0x03,
  InvalidInfo: 0x41, UnreachableHost: 0x42, NoResponse: 0x43, ConnRefused: 0x44,
  TransferTimeout: 0x47, HostBlocked: 0x48, ConnThrottled: 0x49
};

class AsyncQueue {
  constructor() { this.queue = []; this.waiting = null; this.closed = false; }
  put(item) {
    if (this.closed) return;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w.resolve(item); } 
    else { this.queue.push(item); }
  }
  close() {
    this.closed = true;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w.resolve(null); }
  }
  async get() {
    if (this.queue.length > 0) return this.queue.shift();
    if (this.closed) return null;
    return new Promise((resolve) => { this.waiting = { resolve }; });
  }
  get size() { return this.queue.length; }
}

/**
 * RAW TCP STREAM (Used for non-HTTP ports like SSH, IRC, etc.)
 */
export class ServerStream {
  static buffer_size = 128;

  constructor(stream_id, conn, hostname, port, type) {
    this.stream_id = stream_id; this.conn = conn; this.hostname = hostname; this.port = port; this.type = type;
    this.socket = null; this.writer = null; this.send_buffer = new AsyncQueue(); this.packets_sent = 0; this.closed = false;
  }

  async setup() {
    if (this.type === stream_types.UDP) {
      await this.conn.close_stream(this.stream_id, close_reasons.InvalidInfo);
      return;
    }
    try {
      this.socket = connect({ hostname: this.hostname, port: Number(this.port) });
      this.writer = this.socket.writable.getWriter();
      await this.socket.opened;
    } catch (err) {
      let reason = close_reasons.UnreachableHost;
      if (err?.cause?.code === 'ECONNREFUSED') reason = close_reasons.ConnRefused;
      await this.conn.close_stream(this.stream_id, reason);
      return;
    }
    this.tcp_to_ws().catch(() => this.close(close_reasons.NetworkError));
    this.ws_to_tcp().catch(() => this.close(close_reasons.NetworkError));
  }

  async tcp_to_ws() {
    const reader = this.socket.readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.conn.send_packet(packet_types.DATA, this.stream_id, value);
      }
      await this.conn.close_stream(this.stream_id, close_reasons.Voluntary);
    } catch (err) {
      if (!this.closed) await this.conn.close_stream(this.stream_id, close_reasons.NetworkError);
    } finally {
      try { reader.releaseLock(); } catch(e) {}
    }
  }

  async ws_to_tcp() {
    while (true) {
      const data = await this.send_buffer.get();
      if (data == null) break;
      try { await this.writer.write(data); } catch (err) {
        if (!this.closed) await this.conn.close_stream(this.stream_id, close_reasons.NetworkError);
        break;
      }
      this.packets_sent++;
      if (this.packets_sent % (ServerStream.buffer_size / 2) !== 0) continue;
      const payload = new Uint8Array(4);
      new DataView(payload.buffer).setUint32(0, ServerStream.buffer_size - this.send_buffer.size, true);
      this.conn.send_packet(packet_types.CONTINUE, this.stream_id, payload.buffer);
    }
    await this.close();
  }

  put_data(data) {
    if (this.send_buffer.size >= ServerStream.buffer_size) {
      this.conn.close_stream(this.stream_id, close_reasons.ConnThrottled);
      return;
    }
    this.send_buffer.put(data);
  }

  async close(reason = null) {
    if (this.closed) return;
    this.closed = true;
    this.send_buffer.close();
    try { if (this.writer) await this.writer.releaseLock(); } catch(e) {}
    try { if (this.socket) this.socket.close(); } catch(e) {}
    if (reason !== null) {
      const payload = new Uint8Array(1);
      payload[0] = reason;
      this.conn.send_packet(packet_types.CLOSE, this.stream_id, payload.buffer);
    }
  }
}

/**
 * HTTP FETCH STREAM (Used for ports 80, 443, 8080, 8443 to bypass Cloudflare TCP blocks)
 */
export class FetchStream {
  static buffer_size = 128;

  constructor(stream_id, conn, hostname, port, type) {
    this.stream_id = stream_id; this.conn = conn; this.hostname = hostname; this.port = port; this.type = type;
    this.buffer = []; this.bufferSize = 0; this.headersParsed = false; this.closed = false;
  }

  async setup() {
    // Tell the client it can start sending the HTTP request data
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setUint32(0, FetchStream.buffer_size, true);
    this.conn.send_packet(packet_types.CONTINUE, this.stream_id, payload.buffer);
  }

  put_data(data) {
    if (this.headersParsed || this.closed) return;
    this.buffer.push(data);
    this.bufferSize += data.length;
    
    let combined = new Uint8Array(this.bufferSize);
    let offset = 0;
    for (let chunk of this.buffer) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    
    // Look for end of HTTP headers
    let headerEnd = -1;
    for (let i = 0; i < combined.length - 3; i++) {
      if (combined[i] === 13 && combined[i+1] === 10 && combined[i+2] === 13 && combined[i+3] === 10) {
        headerEnd = i + 4; break;
      }
    }
    
    if (headerEnd !== -1) {
      this.headersParsed = true;
      let headerStr = new TextDecoder().decode(combined.slice(0, headerEnd));
      let body = combined.slice(headerEnd);
      this.executeFetch(headerStr, body);
    }
  }

  async executeFetch(headerStr, body) {
    try {
      let lines = headerStr.split('\r\n');
      let firstLine = lines[0].split(' ');
      let method = firstLine[0];
      let path = firstLine[1] || '/';
      
      let headers = {};
      for (let i = 1; i < lines.length; i++) {
        let idx = lines[i].indexOf(':');
        if (idx !== -1) {
          let key = lines[i].substring(0, idx).trim();
          let val = lines[i].substring(idx + 1).trim();
          if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'connection') {
            headers[key] = val;
          }
        }
      }
      
      let protocol = this.port === 443 || this.port === 8443 ? 'https' : 'http';
      let url = `${protocol}://${this.hostname}${path}`;
      
      let fetchOptions = { method, headers };
      if (method !== 'GET' && method !== 'HEAD' && body.length > 0) fetchOptions.body = body;
      
      let response = await fetch(url, fetchOptions);
      
      let statusLine = `HTTP/1.1 ${response.status} ${response.statusText}\r\n`;
      let respHeaders = '';
      for (let [key, value] of response.headers.entries()) {
        let lk = key.toLowerCase();
        // Strip headers that fetch manages so raw HTTP parsing doesn't break
        if (lk !== 'transfer-encoding' && lk !== 'content-encoding' && lk !== 'content-length' && lk !== 'connection') {
          respHeaders += `${key}: ${value}\r\n`;
        }
      }
      respHeaders += 'Connection: close\r\n\r\n';
      
      let respHeaderBytes = new TextEncoder().encode(statusLine + respHeaders);
      this.conn.send_packet(packet_types.DATA, this.stream_id, respHeaderBytes);
      
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.conn.send_packet(packet_types.DATA, this.stream_id, value);
        }
      }
      await this.conn.close_stream(this.stream_id, close_reasons.Voluntary);
    } catch (err) {
      const err_msg = new TextEncoder().encode("FETCH ERROR: " + (err?.message || JSON.stringify(err)));
      this.conn.send_packet(packet_types.DATA, this.stream_id, err_msg.buffer);
      await this.conn.close_stream(this.stream_id, close_reasons.NetworkError);
    }
  }

  async close(reason = null) {
    if (this.closed) return;
    this.closed = true;
    if (reason !== null) {
      const payload = new Uint8Array(1);
      payload[0] = reason;
      this.conn.send_packet(packet_types.CLOSE, this.stream_id, payload.buffer);
    }
  }
}
