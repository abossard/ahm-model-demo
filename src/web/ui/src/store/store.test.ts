import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApiError,
  EntityDetail,
  HealthModel,
  HealthReportResult,
  ModelCatalog,
  ModelRef,
} from "../model/types";
import * as api from "./api";
import { IDLE, LOADING } from "./asyncState";
import { actions, useStore } from "./store";

vi.mock("./api");

const MODEL_A: ModelRef = {
  id: "/a",
  name: "hm-a",
  resourceGroup: "rg-a",
  subscriptionId: "sub-a",
  location: null,
  provisioningState: null,
};
const MODEL_B: ModelRef = { ...MODEL_A, id: "/b", name: "hm-b", subscriptionId: "sub-b" };
const CATALOG: ModelCatalog = {
  models: [MODEL_A, MODEL_B],
  default: { name: "hm-a", resourceGroup: "rg-a", subscriptionId: "sub-a" },
};
const HEALTH_MODEL = { observedAt: "2026-07-30T16:05:00Z" } as HealthModel;
const DETAIL = { entity: { name: "svc-a" } } as EntityDetail;
const REPORT = { reportId: "rpt-1" } as HealthReportResult;
const API_ERROR: ApiError = {
  code: "http_error",
  message: "Request failed with status 503.",
  retryable: true,
  operationId: null,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetAllMocks();
  useStore.setState(useStore.getInitialState(), true);
});

describe("loadModelCatalog", () => {
  it.each([
    {
      search: "",
      selected: MODEL_A,
      unavailable: null,
    },
    {
      search: "?model=hm-b&resourceGroup=rg-a&subscription=sub-b",
      selected: MODEL_B,
      unavailable: null,
    },
    {
      search: "?model=hm-b&resourceGroup=rg-a&subscription=sub-a",
      selected: MODEL_A,
      unavailable: { name: "hm-b", resourceGroup: "rg-a", subscriptionId: "sub-a" },
    },
  ])("resolves $search and loads that model", async ({ search, selected, unavailable }) => {
    vi.mocked(api.fetchModelCatalog).mockResolvedValue(CATALOG);
    vi.mocked(api.fetchHealthModel).mockResolvedValue(HEALTH_MODEL);

    await actions.loadModelCatalog(search);
    await flush();

    const state = useStore.getState();
    expect([state.selected, state.unavailableSelection]).toEqual([selected, unavailable]);
    expect(api.fetchHealthModel).toHaveBeenCalledWith(selected);
    expect(state.model).toEqual({ kind: "success", value: HEALTH_MODEL });
  });

  it.each([
    { name: "an API error", rejection: API_ERROR, expected: API_ERROR },
    {
      name: "an unexpected exception",
      rejection: new Error("boom"),
      expected: { code: "unknown", message: "boom", retryable: true, operationId: null },
    },
  ])("keeps $name as a failure state", async ({ rejection, expected }) => {
    vi.mocked(api.fetchModelCatalog).mockRejectedValue(rejection);

    await actions.loadModelCatalog("");

    expect(useStore.getState().catalog).toEqual({ kind: "failure", error: expected });
    expect(api.fetchHealthModel).not.toHaveBeenCalled();
  });
});

describe("chooseModel", () => {
  it("clears everything that belonged to the previous model and loads the new one", async () => {
    vi.mocked(api.fetchHealthModel).mockReturnValue(new Promise(() => {}));
    useStore.setState({
      selected: MODEL_A,
      unavailableSelection: { name: "x", resourceGroup: "y", subscriptionId: "z" },
      model: { kind: "success", value: HEALTH_MODEL },
      selectedName: "svc-a",
      detail: { kind: "success", value: DETAIL },
      report: { kind: "success", value: REPORT },
      collapsed: ["svc-a"],
      highlightedName: "svc-a",
      focusNames: ["svc-a"],
      focusSeq: 4,
      layoutId: "dagre-lr",
    });

    actions.chooseModel(MODEL_B);

    const state = useStore.getState();
    expect({
      selected: state.selected,
      unavailableSelection: state.unavailableSelection,
      model: state.model,
      selectedName: state.selectedName,
      detail: state.detail,
      report: state.report,
      collapsed: state.collapsed,
      highlightedName: state.highlightedName,
      focusNames: state.focusNames,
      focusSeq: state.focusSeq,
      layoutId: state.layoutId,
    }).toEqual({
      selected: MODEL_B,
      unavailableSelection: null,
      model: LOADING,
      selectedName: null,
      detail: IDLE,
      report: IDLE,
      collapsed: [],
      highlightedName: null,
      focusNames: [],
      focusSeq: 0,
      layoutId: "dagre-lr",
    });
    expect(api.fetchHealthModel).toHaveBeenCalledWith(MODEL_B);
  });

  it.each([
    { name: "another model returns the page to now", before: MODEL_A, chosen: MODEL_B, pinned: null },
    { name: "the same model keeps the moment", before: MODEL_A, chosen: { ...MODEL_A }, pinned: 1_000 },
    { name: "the first model, before any was selected, keeps the moment a link named", before: null, chosen: MODEL_A, pinned: 1_000 },
  ])("choosing $name", ({ before, chosen, pinned }) => {
    vi.mocked(api.fetchHealthModel).mockReturnValue(new Promise(() => {}));
    useStore.setState({ selected: before, timelinePinned: 1_000 });

    actions.chooseModel(chosen);

    expect(useStore.getState().timelinePinned).toBe(pinned);
  });
});

describe("loadHealthModel", () => {
  it("keeps the model on screen while it refreshes", async () => {
    const pending = deferred<HealthModel>();
    vi.mocked(api.fetchHealthModel).mockReturnValue(pending.promise);
    useStore.setState({ selected: MODEL_A, model: { kind: "success", value: HEALTH_MODEL } });

    const refresh = actions.loadHealthModel();
    expect(useStore.getState()).toMatchObject({
      refreshing: true,
      model: { kind: "success", value: HEALTH_MODEL },
    });

    pending.resolve({ observedAt: "later" } as HealthModel);
    await refresh;
    expect(useStore.getState()).toMatchObject({ refreshing: false, lastObservedAt: "later" });
  });

  it("shows a failure and remembers the last successful observation", async () => {
    vi.mocked(api.fetchHealthModel).mockRejectedValue(API_ERROR);
    useStore.setState({ selected: MODEL_A, lastObservedAt: "earlier" });

    await actions.loadHealthModel();

    expect(useStore.getState()).toMatchObject({
      refreshing: false,
      lastObservedAt: "earlier",
      model: { kind: "failure", error: API_ERROR },
    });
  });

  it("keeps the last observation on screen when a reload fails, and drops the error once one succeeds", async () => {
    const shown = { kind: "success", value: HEALTH_MODEL } as const;
    vi.mocked(api.fetchHealthModel).mockRejectedValueOnce(API_ERROR).mockResolvedValueOnce({ observedAt: "later" } as HealthModel);
    useStore.setState({ selected: MODEL_A, model: shown, lastObservedAt: "earlier" });

    await actions.loadHealthModel();
    expect(useStore.getState()).toMatchObject({ refreshing: false, lastObservedAt: "earlier", model: shown, refreshError: API_ERROR });

    await actions.loadHealthModel();
    expect(useStore.getState()).toMatchObject({ lastObservedAt: "later", refreshError: null });
  });

  it("drops a response for a model that is no longer selected", async () => {
    const slow = deferred<HealthModel>();
    vi.mocked(api.fetchHealthModel).mockReturnValueOnce(slow.promise);
    useStore.setState({ selected: MODEL_A });
    const stale = actions.loadHealthModel();

    vi.mocked(api.fetchHealthModel).mockReturnValue(new Promise(() => {}));
    actions.chooseModel(MODEL_B);
    slow.resolve(HEALTH_MODEL);
    await stale;

    expect(useStore.getState().model).toEqual(LOADING);
  });
});

describe("selectEntity", () => {
  it("opens the panel on the entity, loads it with the selected model and resets the report", async () => {
    vi.mocked(api.fetchEntityDetail).mockResolvedValue(DETAIL);
    useStore.setState({ selected: MODEL_B, report: { kind: "success", value: REPORT } });

    const loading = actions.selectEntity("svc-a");
    expect(useStore.getState()).toMatchObject({ selectedName: "svc-a", detail: LOADING, report: IDLE });
    await loading;

    expect(api.fetchEntityDetail).toHaveBeenCalledWith("svc-a", MODEL_B);
    expect(useStore.getState().detail).toEqual({ kind: "success", value: DETAIL });
  });

  it("drops a detail that arrives after another entity was selected", async () => {
    const slow = deferred<EntityDetail>();
    vi.mocked(api.fetchEntityDetail).mockReturnValueOnce(slow.promise);
    const first = actions.selectEntity("svc-a");
    vi.mocked(api.fetchEntityDetail).mockReturnValue(new Promise(() => {}));
    void actions.selectEntity("svc-b");

    slow.resolve(DETAIL);
    await first;

    expect(useStore.getState()).toMatchObject({ selectedName: "svc-b", detail: LOADING });
  });

  it("clearEntity closes the panel and forgets its detail and report", () => {
    useStore.setState({
      selectedName: "svc-a",
      detail: { kind: "success", value: DETAIL },
      report: { kind: "success", value: REPORT },
    });
    actions.clearEntity();
    expect(useStore.getState()).toMatchObject({ selectedName: null, detail: IDLE, report: IDLE });
  });
});

describe("submitHealthReport", () => {
  const body = {
    signalName: "web-ui-health-report",
    healthState: "Degraded",
    value: 0.5,
    expiresInMinutes: 15,
    reasonPreset: "demo-test",
  } as const;

  it("posts with the selected model and starts the refresh countdown once accepted", async () => {
    vi.mocked(api.postHealthReport).mockResolvedValue(REPORT);
    useStore.setState({ selected: MODEL_B });

    await actions.submitHealthReport("svc-a", body);

    expect(api.postHealthReport).toHaveBeenCalledWith("svc-a", body, MODEL_B);
    expect(useStore.getState()).toMatchObject({
      report: { kind: "success", value: REPORT },
      refreshCountdown: 10,
    });
  });

  it("starts no countdown when the report is rejected", async () => {
    vi.mocked(api.postHealthReport).mockRejectedValue(API_ERROR);

    await actions.submitHealthReport("svc-a", body);

    expect(useStore.getState()).toMatchObject({
      report: { kind: "failure", error: API_ERROR },
      refreshCountdown: 0,
    });
  });

  it("refreshes the model when the countdown reaches zero", async () => {
    vi.mocked(api.fetchHealthModel).mockResolvedValue(HEALTH_MODEL);
    useStore.setState({ refreshCountdown: 2 });

    actions.tickRefreshCountdown();
    expect(api.fetchHealthModel).not.toHaveBeenCalled();
    actions.tickRefreshCountdown();
    await flush();

    expect(api.fetchHealthModel).toHaveBeenCalledTimes(1);
  });
});
