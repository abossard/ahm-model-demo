import { describe, expect, it, vi } from "vitest";
import { accessibleDirectories, WorkspaceDenied } from "./workspaceAccess";

describe("directory access checks", () => {
  it("limits concurrent checks to three and retains display order when Azure replies out of order", async () => {
    const candidates = ["a", "b", "c", "d", "e"].map(tenantId => ({ tenantId, displayName: tenantId }));
    const waiting = new Map<string, () => void>();
    let peak = 0;
    const listing = accessibleDirectories(candidates, async ({ tenantId }) => {
      await new Promise<void>(resolve => {
        waiting.set(tenantId, () => { waiting.delete(tenantId); resolve(); });
        peak = Math.max(peak, waiting.size);
      });
      if (tenantId === "b") throw new WorkspaceDenied("Access denied.");
    }, new AbortController().signal);
    expect([...waiting.keys()]).toEqual(["a", "b", "c"]);
    waiting.get("c")!();
    await vi.waitFor(() => expect(waiting.has("d")).toBe(true));
    waiting.get("b")!();
    await vi.waitFor(() => expect(waiting.has("e")).toBe(true));
    for (const release of waiting.values()) release();
    await expect(listing).resolves.toEqual({ directories: candidates.filter(candidate => candidate.tenantId !== "b") });
    expect(peak).toBe(3);
  });
});
