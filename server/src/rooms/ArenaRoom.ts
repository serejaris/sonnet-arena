import { Room, Client } from "colyseus";
import { ArenaState, Player } from "../schema/ArenaState.js";

// Backs getPlayerCount() for /healthz — simple module-level counter,
// no event-emitter abstraction needed for one number.
let playerCount = 0;

// Colyseus 0.17's Room<T> generic takes an options shape ({ state, metadata, client }),
// not the bare state class directly (that was the pre-0.17 API). `this.state` is still
// typed as ArenaState via this shape.
export class ArenaRoom extends Room<{ state: ArenaState }> {
  maxClients = 40; // generous, per PLAN.md "stream viewer count ~40"

  onCreate(_options: any) {
    this.setState(new ArenaState());

    // Placeholder handlers — movement/combat logic implemented in M1-M3.
    this.onMessage("input", (_client, _message) => {
      // implemented in M1-M3
    });

    this.onMessage("shoot", (_client, _message) => {
      // implemented in M1-M3
    });

    this.onMessage("respawn", (_client, _message) => {
      // implemented in M1-M3
    });
  }

  onJoin(client: Client, options: any) {
    const player = new Player();
    // Stub spawn point — real spawn-point logic arrives in M1-M3.
    player.x = 0;
    player.y = 0;
    player.z = 0;
    player.name = options?.name ?? "Player";

    this.state.players.set(client.sessionId, player);
    playerCount++;

    client.send("welcome", {
      sessionId: client.sessionId,
      spawnPoint: { x: 0, y: 0, z: 0 },
    });
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    playerCount--;
  }
}

export function getPlayerCount(): number {
  return playerCount;
}
