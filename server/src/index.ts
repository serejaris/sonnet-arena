import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Application } from "express";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ArenaRoom, getPlayerCount } from "./rooms/ArenaRoom.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// NOTE on Colyseus 0.17 boot order (deviates from a naive "create app, wrap in
// http.createServer(app), then httpServer.listen()" sketch — verified against
// the installed version, see final report):
//
// - Colyseus's matchmaking/WS routes are bound lazily inside `gameServer.listen()`
//   (Server.bindRoutes()), not in the Server constructor. Calling httpServer.listen()
//   directly skips that step entirely and the room becomes unreachable (404 on
//   matchmake requests).
// - WebSocketTransport, when given `{ server }`, lazily creates its OWN internal
//   Express app and attaches it as an additional "request" listener on that same
//   http.Server (see WebSocketTransport.getExpressApp()). If we also pass our own
//   pre-built Express app straight into http.createServer(app), our app becomes the
//   *first* "request" listener and unconditionally finishes every unmatched request
//   with a 404 before Colyseus's own internal app — registered second — ever gets a
//   chance to handle `/matchmake/...`.
//
// The supported way to add custom HTTP routes (our /healthz + static client bundle)
// without shadowing matchmaking is the `express` option callback: Colyseus hands us
// the *same* internal Express app it registers matchmaking routes on, so everything
// lives on one app / one listener.
const httpServer = http.createServer();

const configureRoutes = (app: Application) => {
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", players: getPlayerCount() });
  });

  // In production, serve the built client bundle from the same origin/port
  // per the deployment contract — no CORS to configure.
  if (process.env.NODE_ENV === "production") {
    const clientDist = path.join(__dirname, "../../client/dist");
    app.use(express.static(clientDist));
  }
};

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
  express: configureRoutes,
});

gameServer.define("arena", ArenaRoom);

const port = Number(process.env.PORT) || 2567;

gameServer.listen(port).then(() => {
  console.log(`sonnet-arena server listening on :${port}`);
});
