// connections.js
'use strict';

import { WispClient } from './client.js';
import { INDEX_HTML } from './index.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get('Upgrade');

    // Serve the test HTML page for standard HTTP requests
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(INDEX_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
      return new Response('Not Found', { status: 404 });
    }

    // Spec V1: The URL of the websocket should always end with a trailing forward slash (/)
    if (!url.pathname.endsWith('/')) {
      return new Response('Not Found', { status: 404 });
    }

    // Spec V1: The Sec-WebSocket-Protocol header does not need to be set.
    const [clientSocket, serverSocket] = Object.values(new WebSocketPair());
    serverSocket.accept();

    const wispClient = new WispClient(serverSocket);
    ctx.waitUntil(wispClient.run());

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    });
  }
};
