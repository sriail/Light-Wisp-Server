// wisp-routes.js
// HTTP request routing — determines whether to handle a Wisp or wsproxy connection
// based on the URL path structure.

import { WispServer } from "./wisp-server.js";
import { WSProxyHandler } from "./ws-proxy.js";

/**
 * Main request handler. Routes WebSocket upgrades to Wisp or wsproxy handlers.
 */
export function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const upgradeHeader = request.headers.get("Upgrade");

  if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
    // Wisp endpoints end with "/", wsproxy endpoints have host:port at the end
    if (url.pathname.endsWith("/")) {
      return handleWisp(request);
    } else {
      return handleWsProxy(request);
    }
  }

  // Non-WebSocket requests get a simple status response
  return new Response(
    JSON.stringify({
      service: "wisp-worker",
      protocol: "wisp v2.1 / v1",
      transports: ["tcp"],
      endpoints: {
        wisp: "wss://<host>/<path>/  (trailing slash)",
        wsproxy: "wss://<host>/<path>/<hostname>:<port>",
      },
    }, null, 2),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Handle a Wisp WebSocket upgrade.
 */
function handleWisp(request) {
  const pair = new WebSocketPair();
  const [server, client] = [pair[0], pair[1]];

  // Determine Wisp version from Sec-WebSocket-Protocol header
  const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
  const isV2 = protocolHeader !== null;
  const wispVersion = isV2 ? 2 : 1;

  // Create and start the Wisp server
  const url = new URL(request.url);
  const wispServer = new WispServer(server, url.pathname, wispVersion);
  wispServer.start();

  // Build response headers
  const responseHeaders = {};
  if (isV2) {
    // Echo back the client's requested subprotocol to satisfy browser WS implementations
    responseHeaders["Sec-WebSocket-Protocol"] = protocolHeader.split(",")[0].trim();
  }

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: responseHeaders,
  });
}

/**
 * Handle a legacy wsproxy WebSocket upgrade.
 */
function handleWsProxy(request) {
  const pair = new WebSocketPair();
  const [server, client] = [pair[0], pair[1]];

  const url = new URL(request.url);
  const handler = new WSProxyHandler(server, url.pathname);
  handler.start();

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
