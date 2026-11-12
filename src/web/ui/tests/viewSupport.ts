import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import type { EntityDetail, ExplainResult, HealthModel } from "../src/model/types";

/** What the entity panel loads for any entity of `model`, with two transitions, so selecting an entity works on any fixture. */
export async function stubEntityDetails(page: Page, model: HealthModel): Promise<void> {
  await page.route("**/api/entities/*", async (route) => {
    const request = route.request();
    const name = decodeURIComponent(new URL(request.url()).pathname.split("/").pop() ?? "");
    const entity = model.entities.find((item) => item.name === name);
    if (request.method() !== "GET" || !entity) {
      await route.fallback();
      return;
    }
    const detail: EntityDetail = {
      entity,
      observedAt: "2026-07-30T16:05:00Z",
      transitions: [
        { previousState: "Healthy", healthState: entity.healthState, occurredAt: "2026-07-30T15:42:00Z" },
        { previousState: "Degraded", healthState: "Healthy", occurredAt: "2026-07-29T09:10:00Z" },
      ],
      canonicalSignal: { name: "web-ui-health-report", current: null, history: [] },
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(detail) });
  });
}

/** An Explain result on the incident model: why the root is Degraded, down to the failing leaf. */
export function incidentExplain(): ExplainResult {
  return {
    kind: "explain",
    entity: "hm-contosodemo",
    state: "Degraded",
    summary: "The root is Degraded because Session Storage is Unhealthy and the rollup takes the worst child.",
    causes: [
      { entity: "flow-run-agent-tasks", signal: null, state: "Degraded", threshold: null, value: null, rollup: "Worst of its inputs", note: "The flow rolls up its systems." },
      { entity: "system-session-store", signal: null, state: "Unhealthy", threshold: null, value: null, rollup: "Limited impact caps it at Degraded", note: "Session Store is Limited." },
      { entity: "session-storage", signal: "availability", state: "Unhealthy", threshold: "below 95", value: 91.4, rollup: null, note: "Availability is 91.4 percent." },
    ],
  };
}

const POLICY_SOURCE = readFileSync(fileURLToPath(new URL("./graph-ux.spec.ts", import.meta.url)), "utf8");

/** The Content-Security-Policy the server sends, as `graph-ux.spec.ts` states it. */
export function servedPolicy(): string {
  const declaration = /const SERVED_CSP\s*=\s*((?:"[^"]*"\s*\+?\s*)+);/.exec(POLICY_SOURCE);
  if (!declaration) throw new Error("SERVED_CSP is no longer a plain string expression in graph-ux.spec.ts");
  return [...declaration[1]!.matchAll(/"([^"]*)"/g)].map((piece) => piece[1]).join("");
}

/** Serves the app's page with the server's policy, and collects what the browser refuses. */
export async function underServedPolicy(page: Page, origin: string): Promise<string[]> {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) violations.push(message.text());
  });
  page.on("pageerror", (error) => violations.push(error.message));
  await page.route((url) => url.origin === origin && !url.pathname.startsWith("/api/"), async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    if ((headers["content-type"] ?? "").includes("text/html")) headers["content-security-policy"] = servedPolicy();
    await route.fulfill({ response, headers });
  });
  return violations;
}

interface Pair {
  readonly color: string;
  readonly background: string;
}

/** The ratio between an element's text colour and the colour behind it, from what the browser computed. */
export async function contrastOf(locator: Locator): Promise<number> {
  const pair: Pair = await locator.evaluate((element) => {
    const behind = (start: Element): string => {
      for (let current: Element | null = start; current; current = current.parentElement) {
        const color = getComputedStyle(current).backgroundColor;
        if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
      }
      return "rgb(255, 255, 255)";
    };
    return { color: getComputedStyle(element).color, background: behind(element) };
  });
  // A mixed colour reads back as `color(srgb 0.1 0.2 0.3)`, with channels from 0 to 1.
  const channels = (text: string): number[] => {
    const inner = /\(([^)]+)\)/.exec(text)?.[1] ?? "";
    return text.startsWith("color(srgb")
      ? inner.replace("srgb", "").split("/")[0]!.trim().split(/\s+/).map((part) => Number(part) * 255)
      : inner.split(",").slice(0, 3).map((part) => Number(part));
  };
  const luminance = (rgb: number[]): number => {
    const [r, g, b] = rgb.map((value) => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(channels(pair.color)), luminance(channels(pair.background))].sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}
