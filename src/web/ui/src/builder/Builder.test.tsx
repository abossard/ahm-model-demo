import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Builder } from "./Builder";
import { builderDestination } from "./builderDestinations";
import type { BuilderState, BuilderTools, Preview } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const target = { name: "hm-orders-001", subscriptionId: "sub", resourceGroup: "orders", location: "westus" };
const rows = ["api", "db"].map((name) => ({
  resourceId: "/subscriptions/sub/resourceGroups/orders/providers/Microsoft.Web/sites/" + name,
  displayName: name,
  purpose: "Accept orders",
  impact: "Standard" as const,
}));
const analysis = {
  seq: 1,
  status: "done" as const,
  builder: { phase: "analyze" },
  result: { kind: "builderAnalysis" as const, summary: "Orders API and its database.", rows },
};
const designs = ["Orders flow", "Infrastructure"].map((title, index) => ({
  id: "design-" + index,
  title,
  summary: "Track orders",
  tradeoff: "Depends on component state",
  groups: [{ name: "Orders", purpose: "Accept orders", resourceIds: rows.map((r) => r.resourceId) }],
}));
const proposal = {
  seq: 2,
  status: "done" as const,
  builder: { phase: "propose", rows },
  result: { kind: "builderProposals" as const, proposals: designs },
};
const proposed: BuilderState = { sessionId: "topic", analysis, proposal, target };
const preview: Preview = {
  ...designs[0]!,
  entities: [{ name: "api", displayName: "Orders API", x: 400, y: 100, impact: "Standard" }],
  relationships: [],
  monitoringScopes: [],
  diff: { findings: [], verification: [] },
  plan: "# Plan",
  modelspec: "# Modelspec",
};
const created: BuilderState = {
  ...proposed,
  creation: { status: "created", proposalId: "design-0", target, written: ["api"] },
};
function tools(): BuilderTools {
  return {
    groups: vi.fn(),
    resources: vi.fn(),
    analyze: vi.fn(),
    revise: vi.fn(),
    open: vi.fn().mockResolvedValue(proposed),
    propose: vi.fn().mockResolvedValue(proposed),
    preview: vi.fn().mockResolvedValue(preview),
    create: vi.fn().mockResolvedValue(created),
    grantMonitoring: vi.fn(),
    showModel: vi.fn(),
    download: vi.fn(),
  };
}

describe("Builder review and approval", () => {
  let host: HTMLDivElement, root: Root, client: BuilderTools;
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    window.scrollTo = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    client = tools();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  async function show(initial: BuilderState) {
    await act(async () => root.render(<Builder initial={initial} tools={client} />));
  }
  async function click(name: string) {
    const button = [...host.querySelectorAll("button")].find(
      (item) => (item.getAttribute("aria-label") ?? item.textContent) === name,
    );
    expect(button, name).toBeDefined();
    await act(async () => button!.click());
  }
  async function fill(box: HTMLTextAreaElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  it.each(["edit", "retry"] as const)("submits the prompt and reviewed inputs from a saved plan (%s)", async mode => {
    const plan = {objective: "Accept orders", flows: [], gaps: []};
    const edited = {...rows[0]!, purpose: "Validates checkout requests", impact: "Limited" as const};
    const failed = {seq: 3, status: "failed" as const, error: {message: "Foundry was unavailable."},
      builder: {phase: "analyze", revision: {analysisSeq: 1, prompt: "Prioritize checkout"}, rows: [edited]}};
    const saved = {sessionId: "topic", target, analysis: {...analysis, result: {...analysis.result, plan}}};
    await show(mode === "retry" ? {...saved, failedRevision: failed} : saved);
    const prompt = host.querySelector<HTMLTextAreaElement>(".plan-revision-form textarea")!;
    await click("Request a change");
    expect(document.activeElement).toBe(prompt);
    if (mode === "edit") {
      await click("Revise plan");
      expect(client.revise).not.toHaveBeenCalled();
      await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="Include db"]')!.click());
      await fill(host.querySelector<HTMLTextAreaElement>('[aria-label="Workload role of api"]')!, edited.purpose);
      await act(async () => {
        const impact = host.querySelector<HTMLSelectElement>('[aria-label="Impact of api"]')!;
        impact.value = edited.impact;
        impact.dispatchEvent(new Event("change", {bubbles:true}));
      });
    } else {
      expect(prompt.value).toBe("Prioritize checkout");
      expect(host.querySelector<HTMLInputElement>('input[aria-label="Include db"]')!.checked).toBe(false);
      expect(host.textContent).toContain("Foundry was unavailable.");
    }
    const instruction = "Track failed checkout attempts";
    await fill(prompt, instruction);
    client.revise = vi.fn().mockResolvedValue({...saved, analysis: {seq: 4, status: "running",
      builder: {phase: "analyze", revision: {analysisSeq: 1, prompt: instruction}}}});
    await click("Revise plan");
    expect(client.revise).toHaveBeenCalledWith("topic", 1, [edited], instruction);
    expect(host.textContent).toContain("Revising the workload plan");
    expect(host.textContent).toContain(instruction);
    expect(client.propose).not.toHaveBeenCalled();
  });
  it("shows the request and changed plan items when a revised session reopens", async () => {
    const oldPlan = {objective: "Accept orders", flows: [], gaps: []};
    const newPlan = {...oldPlan, objective: "Accept and fulfill orders"};
    const instruction = "Include fulfillment";
    await show({sessionId: "topic", target, analysis: {...analysis, seq: 4, builder: {phase: "analyze",
      previousPlan: oldPlan, revision: {analysisSeq: 1, prompt: instruction}}, result: {...analysis.result, plan: newPlan}}});
    const receipt = host.querySelector('[aria-label="Latest plan revision"]')!;
    expect(receipt.textContent).toContain(instruction);
    expect(receipt.querySelector('tbody tr th')?.textContent).toBe("Workload objective");
    expect([...receipt.querySelectorAll('tbody tr td')].map(cell => cell.textContent)).toEqual([oldPlan.objective, newPlan.objective]);
    expect(host.querySelector<HTMLTextAreaElement>(".plan-revision-form textarea")!.value).toBe("");
    expect(client.revise).not.toHaveBeenCalled();
  });
  it("submits the user-confirmed resource rows from a restored analysis", async () => {
    await show({ sessionId: "topic", target, analysis });
    const skip = host.querySelector<HTMLInputElement>('input[aria-label="Include db"]')!;
    await act(async () => skip.click());
    await click("Confirm and suggest models");
    expect(client.propose).toHaveBeenCalledWith("topic", 1, [rows[0]]);
    expect(host.textContent).toContain("Compare model designs");
  });
  it("regenerates a saved inventory-only analysis in its original session and scope", async () => {
    const scope = { groupIds: [], resourceIds: [rows[0]!.resourceId], modelName: "orders", destinationGroupId: "/groups/orders" };
    await show({sessionId: "topic", target, analysis: {...analysis, builder: {phase: "analyze", ...scope}}});
    client.analyze = vi.fn().mockResolvedValue(proposed);
    await click("Generate model plan");
    expect(client.analyze).toHaveBeenCalledWith(scope, "topic");
  });
  it.each([[0, "Healthy"], [81, "Unhealthy"]] as const)("shows the planned flow and prediction for a measured %s", async (sample, state) => {
    const id = rows[0]!.resourceId;
    const metric = { resourceId: id, metricName: "CpuPercentage", metricNamespace: "Microsoft.Web/sites",
      aggregation: "Average", operator: "GreaterThan" as const, threshold: 80, sample };
    await show({sessionId: "topic", target, analysis: {...analysis,
      builder: {...analysis.builder, observedMetrics: [{...metric, observedAt: "2026-11-19T10:00:00Z", unit: "Percent", count: 288}]},
      result: {...analysis.result,
      metrics: [metric], plan: { objective: "Customers can submit an order.", gaps: ["No end-to-end order timing."],
        flows: [{ name: "Submit an order", objective: "Persist the request.",
          components: [{ name: "Checkout service", resourceIds: [id], signal: "Watch failed requests." }],
          failureScenario: "Checkout fails when the API stops responding." }]}}}});
    const plan = host.querySelector('[aria-label="Proposed health model"]')!;
    expect(plan.textContent).toContain("Submit an order");
    expect(plan.textContent).toContain("Checkout service");
    expect(plan.innerHTML).toContain("CpuPercentage");
    expect(plan.textContent).toContain("Predicted state for this sample: " + state);
    expect(plan.textContent).toContain("288 five-minute readings");
    expect(host.textContent).not.toContain(analysis.result.summary);
    await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="Include api"]')!.click());
    expect(plan.textContent).not.toContain("Checkout service");
    expect(plan.textContent).not.toContain("CpuPercentage");
  });
  it("previews and exports the selected design before separate approval", async () => {
    await show(proposed);
    await click("Preview selected model");
    expect(client.preview).toHaveBeenCalledWith("topic", 2, "design-0");
    expect(host.querySelector<HTMLElement>('.react-flow__node[data-id="api"]')?.style.transform).toBe("translate(400px,100px)");
    await click("Download plan.md");
    expect(client.download).toHaveBeenCalledWith("plan.md", "# Plan");
    await click("Create health model");
    await click("Cancel");
    expect(client.create).not.toHaveBeenCalled();
    await click("Create health model");
    await click("Confirm creation in Azure");
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.create).toHaveBeenCalledWith("topic", 2, "design-0");
    await click("Open health model");
    expect(client.showModel).toHaveBeenCalledWith("topic", 2);
  });
  it.each(["resource", "signal"] as const)("opens the saved Task's %s evidence and returns focus to its sentence", async kind => {
    const resources = [rows[1]!, rows[0]!].map(row => ({id: row.resourceId, name: row.displayName, type: "Microsoft.Web/sites", location: "westus"}));
    const id = kind + "/R1";
    const result = {...analysis.result, summary: "Inspect the database [[show:1]] before revising its role.",
      showMe: {"1": {handle: "builder", id, highlight: {label: "Database evidence"}}}};
    await show({sessionId: "topic", analysis: {...analysis, result, showMeHandles: [builderDestination("analyze")],
      builder: {...analysis.builder, resources, observedMetrics: [{resourceId: resources[0]!.id, metricName: "CpuPercentage",
        metricNamespace: "Microsoft.Web/sites", aggregation: "Average", sample: 0, unit: "Percent", observedAt: "2026-11-21T10:00:00Z"}]}}});
    expect(host.querySelector("[data-builder-target]")).toBeNull();
    await click("Show me – Database evidence");
    const panel = host.querySelector(`[data-builder-id="${id}"]`);
    expect(panel?.textContent).toContain(kind === "resource" ? rows[1]!.resourceId : "CpuPercentage · Average 0 Percent");
    expect(panel?.getAttribute("data-show-me-highlight")).toBe("blue");
    expect(host.querySelector(".builder-answer-source")?.textContent).toContain("before revising its role.");
    expect(client.preview).not.toHaveBeenCalled();
    await click("Close details");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Show me – Database evidence");
    expect(host.querySelector("[data-show-me-highlight]")).toBeNull();
  });

  it.each(["resource/R9", "signal/R1", "design/design-0"] as const)("reports a stale destination %s in place", async id => {
    const resource = {id: rows[0]!.resourceId, name: "api", type: "t", location: "westus"};
    await show({sessionId: "topic", analysis: {...analysis, showMeHandles: [builderDestination("analyze")],
      builder: {...analysis.builder, resources: [resource]}, result: {...analysis.result, summary: "Inspect [[show:1]].",
        showMe: {"1": { handle: "builder", id }}}}});
    await click("Show me – " + id);
    expect(host.textContent).toContain("This destination is no longer available");
    expect(host.querySelector("[data-builder-target]")).toBeNull();
    expect(client.preview).not.toHaveBeenCalled();
  });

  it.each(["legacy", "offered", "unoffered"] as const)("links saved decision evidence once for a %s answer", async mode => {
    const source = rows[0]!;
    const hasMarker = mode !== "legacy";
    const reason = "The API accepts orders." + (hasMarker ? " [[show:1]]" : "");
    const plan = {objective: "Accept orders", flows: [], gaps: [], decisions: [
      {choice: "Track the API", reason, basis: "measurement" as const, resourceIds: [source.resourceId]},
    ]};
    const observed = {resourceId: source.resourceId, metricName: "CpuPercentage", metricNamespace: "Microsoft.Web/sites",
      aggregation: "Average", sample: 0, unit: "Percent", observedAt: "2026-11-21T10:00:00Z"};
    await show({sessionId: "topic", analysis: {...analysis,
      ...(mode === "offered" ? {showMeHandles: [builderDestination("analyze")]} : {}),
      builder: {...analysis.builder, observedMetrics: [observed], resources: [
        {id: source.resourceId, name: source.displayName, type: "Microsoft.Web/sites", location: "westus"},
      ]},
      result: {...analysis.result, plan, ...(hasMarker ? {showMe: {"1": {handle: "builder", id: "signal/R1", highlight: {label: "Agent link"}}}} : {})},
    }});
    const buttons = host.querySelectorAll<HTMLButtonElement>(".plan-decisions [data-show-me-handle]");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Show me – " + (mode === "offered" ? "Agent link" : "api · CpuPercentage 0 Percent"));
    await act(async () => buttons[0]!.click());
    expect(host.querySelector('[data-builder-id="signal/R1"]')?.textContent).toContain("Average 0 Percent");
    expect(client.create).not.toHaveBeenCalled();
  });

  it("inspects an alternative without selecting it, and ignores a preview that arrives in a different Session", async () => {
    const alternative = designs[1]!;
    const marked = {...alternative, tradeoff: "Compare the layout [[show:1]]."};
    const saved = {...proposed, proposal: {...proposal, showMeHandles: [builderDestination("propose")], result: {
      ...proposal.result, proposals: [designs[0]!, marked],
      showMe: {"1": {handle: "builder", id: "design/" + alternative.id, highlight: {label: "Other layout"}}},
    }}};
    client.preview = vi.fn().mockResolvedValue({...preview, id: alternative.id});
    await show(saved);
    await click("Show me – Other layout");
    expect(client.preview).toHaveBeenCalledWith("topic", 2, alternative.id);
    expect(host.querySelector('[aria-label="Show me details"] figcaption')?.textContent).toContain("Design preview");
    expect(host.querySelector<HTMLInputElement>('input[name="proposal"]:checked')?.value).toBe(designs[0]!.id);
    expect(client.create).not.toHaveBeenCalled();
    await click("Close details");
    let finish!: (data: Preview) => void;
    client.preview = vi.fn().mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await click("Show me – Other layout");
    expect(host.textContent).toContain("Opening design preview");
    await show({...saved, sessionId: "different-topic"});
    await act(async () => finish({...preview, id: alternative.id}));
    expect(host.querySelector("[data-builder-target]")).toBeNull();
    expect(client.grantMonitoring).not.toHaveBeenCalled();
  });

  it("resolves R1 against the next Task when the reader moves from an analysis to designs", async () => {
    const resources = rows.map(row => ({id: row.resourceId, name: row.displayName, type: "Microsoft.Web/sites", location: "westus"}));
    const showMe = {"1": {handle: "builder", id: "resource/R1", highlight: {label: "Reviewed resource"}}};
    const current = {...analysis, showMeHandles: [builderDestination("analyze")], builder: {...analysis.builder, resources},
      result: {...analysis.result, summary: "Reviewed [[show:1]].", showMe}};
    await show({sessionId: "topic", analysis: current});
    await click("Show me – Reviewed resource");
    expect(host.querySelector('[data-builder-target="resource"] h3')?.textContent).toBe("api");
    client.propose = vi.fn().mockResolvedValue({...proposed, analysis: current, proposal: {...proposal,
      showMeHandles: [builderDestination("propose")], builder: {...proposal.builder, resources: [...resources].reverse()},
      result: {...proposal.result, proposals: [{...designs[0]!, summary: "Start here [[show:1]]."}], showMe},
    }});
    await click("Confirm and suggest models");
    expect(host.querySelector("[data-builder-target]")).toBeNull();
    await click("Show me – Reviewed resource");
    expect(host.querySelector('[data-builder-target="resource"] h3')?.textContent).toBe("db");
    expect(client.preview).not.toHaveBeenCalled();
  });
  it.each(["created", "partial", "creating"] as const)(
    "reopens %s creation without repeating a write",
    async (status) => {
      await show({ ...created, creation: { ...created.creation!, status } });
      expect(host.textContent).toContain(target.name);
      expect(client.create).not.toHaveBeenCalled();
      expect(client.propose).not.toHaveBeenCalled();
      if (status === "partial") {
        await click("Review and resume creation");
        expect(client.preview).toHaveBeenCalledWith("topic", 2, "design-0");
        expect(client.create).not.toHaveBeenCalled();
      }
    },
  );
  it("reads a running Task to completion when the Session reopens", async () => {
    vi.useFakeTimers();
    await show({
      sessionId: "topic",
      target,
      analysis: { seq: 1, builder: { phase: "analyze" }, status: "running" },
    });
    expect(host.textContent).toContain("Waiting for the first recorded activity");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1800);
    });
    expect(client.open).toHaveBeenCalledWith("topic");
    expect(host.textContent).toContain("Compare model designs");
    expect(client.analyze).not.toHaveBeenCalled();
  });

  it.each(["analysis", "proposal"] as const)("restores a compact %s log with paired tools and reported usage", async phase => {
    const ts = "2026-11-19T14:46:00Z";
    const log = {
      createdAt: ts, finishedAt: "2026-11-19T14:46:12Z",
      usage: {inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0},
      activity: [
        {seq: 1, ts, kind: "tool_call" as const, summary: "List metric definitions", payload: {callId: "m", name: "monitor_metrics_definitions"}},
        {seq: 2, ts, kind: "tool_result" as const, summary: "List metric definitions: ok, 42 B",
          payload: {callId: "m", ok: true, detail: "CpuPercentage"}},
      ],
    };
    await show(phase === "analysis" ? {sessionId: "topic", analysis: {...analysis, ...log}, target}
      : {...proposed, proposal: {...proposal, ...log}});
    const details = host.querySelector<HTMLDetailsElement>(".run-activity")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain("1 tool call · 12 s · 120 tokens");
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    expect(details.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(details.querySelector('[aria-label="Reported token usage"]')?.textContent).toContain("Cached input0");
    await act(async () => details.querySelector<HTMLButtonElement>('button[aria-label*="technical details"]')!.click());
    expect(document.querySelector('[aria-label="Technical details"]')?.textContent).toContain("Result:\nCpuPercentage");
  });

  it("keeps the reader's disclosure choice while activity arrives and the plan becomes ready", async () => {
    const started = {seq: 1, ts: "2026-11-19T14:46:00Z", kind: "status" as const, summary: "Checking Azure Monitor signals on api", payload: {}};
    const complete = {...started, seq: 2, summary: "Result verified"};
    vi.useFakeTimers();
    client.open = vi.fn().mockResolvedValue({sessionId: "topic", target, analysis: {...analysis, activity: [started, complete]}});
    await show({sessionId: "topic", target, analysis: {seq: 1, status: "running", builder: {phase: "analyze"}, activity: [started]}});
    const details = host.querySelector<HTMLDetailsElement>(".run-activity")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain(started.summary);
    await act(async () => details.querySelector("summary")!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(1800); });
    expect(host.querySelector(".run-activity")).toBe(details);
    expect(details.open).toBe(true);
    expect(details.querySelector('[role="list"]')?.textContent).toContain(complete.summary);
  });
});
