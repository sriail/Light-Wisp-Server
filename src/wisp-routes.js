// wisp-routes.js
// HTTP request routing — determines whether to handle a Wisp or wsproxy
// connection based on the URL path structure.

import { WispServer } from "./wisp-server.js";
import { WSProxyHandler } from "./ws-proxy.js";
import { serverOptions, logging } from "./wisp-config.js";

/**
 * Main request handler. Routes WebSocket upgrades to Wisp or wsproxy handlers.
 * @param {Request} request - Incoming HTTP request
 * @param {Record<string, unknown>} env - Environment variables/bindings
 * @param {ExecutionContext} ctx - Execution context (for waitUntil, etc.)
 */
export function handleRequest(request, env, ctx) {
  // Allow wrangler.toml env vars to override default options
  if (env.PORT_WHITELIST) {
    try { serverOptions.port_whitelist = JSON.parse(env.PORT_WHITELIST); } catch(e) {}
  }
  if (env.ALLOW_PRIVATE_IPS) serverOptions.allow_private_ips = env.ALLOW_PRIVATE_IPS === "true";
  if (env.ALLOW_LOOPBACK_IPS) serverOptions.allow_loopback_ips = env.ALLOW_LOOPBACK_IPS === "true";
  if (env.WISP_MOTD) serverOptions.wisp_motd = env.WISP_MOTD;
  if (env.WISP_VERSION) serverOptions.wisp_version = parseInt(env.WISP_VERSION, 10);

  const url = new URL(request.url);
  const upgradeHeader = request.headers.get("Upgrade");

  if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
    // Wisp endpoints end with "/", wsproxy endpoints have host:port at the end
    if (url.pathname.endsWith("/")) {
      return handleWisp(request, ctx);
    } else {
      return handleWsProxy(request, ctx);
    }
  }

  // Non-WebSocket requests get a simple status response
  return new Response(
    JSON.stringify(
      {
        service: "wisp-worker",
        protocol: "wisp v2.1 / v1",
        transports: ["tcp"],
        endpoints: {
          wisp: "wss://<host>/<path>/  (trailing slash)",
          wsproxy: "wss://<host>/<path>/<hostname>:<port>",
        },
      },
      null,
      2
    ),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Handle a Wisp WebSocket upgrade.
 */
function handleWisp(request, ctx) {
  const pair = new WebSocketPair();
  const [server, client] = [pair[0], pair[1]];

  // Determine Wisp version
  const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
  let isV2 = protocolHeader !== null;
  
  // Allow forced version via config
  if (serverOptions.wisp_version === 1) isV2 = false;
  if (serverOptions.wisp_version === 2) isV2 = true;
  
  const wispVersion = isV2 ? 2 : 1;

  const url = new URL(request.url);
  const wispServer = new WispServer(server, url.pathname, wispVersion, ctx);
  wispServer.start();

  const responseHeaders = {};
  if (isV2 && protocolHeader) {
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
function handleWsProxy(request, ctx) {
  const pair = new WebSocketPair();
  const [server, client] = [pair[0], pair[1]];

  const url = new URL(request.url);
  const handler = new WSProxyHandler(server, url.pathname, ctx);
  handler.start();

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
