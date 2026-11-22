import type { App } from "@modelcontextprotocol/ext-apps";
import { describe, expect, it, vi } from "vitest";
import { builderTools } from "./bridge";

describe("builder MCP turn descriptors", () => {
  it.each([undefined, "created"] as const)("opens the saved model with tour=%s", async tour => {
    const callServerTool = vi.fn().mockResolvedValue({structuredContent: {target: {}}});
    const client = builderTools({callServerTool} as unknown as App);
    await client.showModel("topic", 2, tour);
    expect(callServerTool.mock.calls[0]![0]).toEqual({
      name: "builder_open_model", arguments: tour ? {sessionId: "topic", proposalSeq: 2, tour} : {sessionId: "topic", proposalSeq: 2},
    });
  });
  it.each(["analyze", "revise", "propose"] as const)("sends the current %s destination vocabulary", async phase => {
    const callServerTool = vi.fn().mockResolvedValue({structuredContent: {sessionId: "session"}});
    const client = builderTools({callServerTool} as unknown as App);
    if (phase === "analyze") await client.analyze({groupIds: [], resourceIds: ["id"], modelName: "demo", destinationGroupId: "group"}, null);
    else if (phase === "revise") await client.revise("session", 1, [], "Check latency.");
    else await client.propose("session", 2, []);
    const request = callServerTool.mock.calls[0]![0];
    expect(request.name).toBe("builder_" + phase);
    expect(request.arguments.showMeHandles).toHaveLength(1);
    const [descriptor] = request.arguments.showMeHandles;
    expect(descriptor).toMatchObject({name: "builder", idDescription: expect.stringContaining("signal/Rn")});
    expect(descriptor.idDescription.includes("design/<id>")).toBe(phase === "propose");
    expect(descriptor.idDescription.length).toBeLessThanOrEqual(256);
  });
});
