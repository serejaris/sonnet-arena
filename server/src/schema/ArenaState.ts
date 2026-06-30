import { Schema, type, MapSchema } from "@colyseus/schema";

export class Player extends Schema {
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") z = 0;
  @type("number") rotY = 0;
  @type("number") hp = 100;
  @type("number") kills = 0;
  @type("number") deaths = 0;
  @type("string") name = "";
  @type("boolean") alive = true;
}

export class ArenaState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}
