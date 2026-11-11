import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localAuth, setAuth } from "../auth";
import type { HealthModel, ModelRef } from "../model/types";
import * as api from "./api";

const SELECTION = { name: "hm", resourceGroup: "rg", subscriptionId: "11111111-1111-1111-1111-111111111111" };
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockImplementation(() => Promise.resolve(new Response("{}", { status: 200 })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  setAuth(localAuth);
});

describe("reading the model fresh", () => {
  it.each([
    { name: "by default from what the app keeps warm", selection: SELECTION, fresh: undefined, url: "/api/health-model?model=hm&resourceGroup=rg&subscription=11111111-1111-1111-1111-111111111111" },
    { name: "from Azure when asked", selection: SELECTION, fresh: true, url: "/api/health-model?model=hm&resourceGroup=rg&subscription=11111111-1111-1111-1111-111111111111&refresh=1" },
    { name: "without a selected model", selection: null, fresh: true, url: "/api/health-model?refresh=1" },
  ])("asks $name", async ({ selection, fresh, url }) => {
    await (fresh === undefined ? api.fetchHealthModel(selection) : api.fetchHealthModel(selection, fresh));

    expect(fetchMock.mock.calls[0]?.[0]).toBe(url);
  });
});

describe("the Refresh button's load", () => {
  it("asks fresh, and the other loads do not", async () => {
    vi.resetModules();
    vi.doMock("./api");
    const apiMock = await import("./api");
    const { useStore, actions } = await import("./store");
    vi.mocked(apiMock.fetchHealthModel).mockResolvedValue({ observedAt: "t" } as HealthModel);
    useStore.setState({ selected: { id: "/a", ...SELECTION, location: null, provisioningState: null } as ModelRef });

    await actions.loadHealthModel();
    await actions.loadHealthModel({ fresh: true });

    expect(vi.mocked(apiMock.fetchHealthModel).mock.calls.map((call) => call[1])).toEqual([undefined, true]);
    vi.doUnmock("./api");
  });
});
