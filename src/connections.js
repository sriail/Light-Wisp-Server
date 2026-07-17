// connections.js
'use strict';

import { Client } from './client.js';

export default {
  /**
   * Handles incoming HTTP requests, validates WebSocket upgrade requirements,
   * and initializes the Wisp v2 client state encapsulated within the WebSocket lifetime.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Spec: The URL of the websocket should always end with a trailing forward slash (/)
    // to prevent confusion with wsproxy endpoints.
    if (!url.pathname.endsWith('/')) {
      return new Response('Not Found', { status: 404 });
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Spec: The Sec-WebSocket-Protocol request header must be present for Wisp v2
    const secWsProtocol = request.headers.get('Sec-WebSocket-Protocol');
    if (!secWsProtocol) {
      // If missing, the spec dictates acting like a Wisp v1 server. 
      // We explicitly reject it to enforce strict v2 compliance.
      return new Response('Wisp v1 is not supported by this endpoint', { status: 400 });
    }

    // Establish WebSocket pair
    const [clientSocket, serverSocket] = Object.values(new WebSocketPair());
    serverSocket.accept();

    // Instantiate the Wisp Client handler, encapsulating state per connection
    const wispClient = new Client(serverSocket);
    
    // Keep the Worker alive for the duration of the WebSocket connection
    ctx.waitUntil(wispClient.initialize());

    // Return the WebSocket response to the client, echoing the subprotocol
    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
      headers: {
        'Sec-WebSocket-Protocol': secWsProtocol.split(',')[0].trim()
      }
    });
  }
};
