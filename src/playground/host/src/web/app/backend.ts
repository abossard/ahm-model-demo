import type { Player } from "@playground/contracts";
import * as wireCore from "../wire";
import type { McpClient, Wire, WireCore } from "./wireApi";

// What the page needs from the outside: the wire, one MCP client and the calls that go through them.
export interface Backend {
  fixture: boolean;
  wire: Wire;
  player: Player;
  connect(): Promise<McpClient>;
  core: Pick<WireCore, "callTool" | "mountView">;
}

// The wire core. Written against the contract in app/wireApi.ts, so a type error here means the two drifted.
const realCore: WireCore = wireCore;

export function wantsFixture(search: string): boolean {
  return new URLSearchParams(search).has("fixture");
}

export async function createBackend(search: string): Promise<Backend> {
  if (!wantsFixture(search)) {
    const wire = realCore.createWire();
    return { fixture: false, wire, player: realCore.getPlayer(), connect: () => realCore.connect(wire), core: realCore };
  }
  const { createFixtureBackend } = await import("./fixtureBackend");
  return createFixtureBackend();
}
