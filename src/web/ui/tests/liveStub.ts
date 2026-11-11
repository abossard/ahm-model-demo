import type { Page } from "@playwright/test";
import type { LiveDelta } from "../src/model/live";
import type { Entity, HealthModel } from "../src/model/types";
import { healthModel } from "./fixture";

export const EPOCH = "aaaaaaaa";

export function frame(event: string, data: unknown, id?: string): string {
  return `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const snapshot = (model: HealthModel, seq = 0): string => frame("snapshot", model, `${EPOCH}-${seq}`);
export const delta = (body: LiveDelta, seq: number): string => frame("delta", body, `${EPOCH}-${seq}`);

export function withState(name: string, state: Entity["healthState"], model: HealthModel = healthModel): Entity {
  return { ...(model.entities.find((item) => item.name === name) as Entity), healthState: state };
}

export interface StreamRequest {
  readonly lastEventId: string | null;
  readonly at: number;
}

export interface LiveStub {
  readonly requests: StreamRequest[];
  /** Hands text to the open connection: it is sent and the connection ends, as a stream that drops would. */
  readonly push: (...frames: string[]) => void;
}

interface Waiter {
  resolve: (text: string) => void;
}

/**
 * A stand-in for GET /api/health-model/stream. The browser's route API cannot write a response in pieces, so each
 * connection waits for text, gets it as a whole response and ends; the client's reconnect (with Last-Event-ID) is the
 * next connection. That is the contract's resume path, so the stub exercises it on every event.
 */
export async function installStream(page: Page, options: { first?: string; refuse?: { status: number; body: unknown } } = {}): Promise<LiveStub> {
  const requests: StreamRequest[] = [];
  const queue: string[] = options.first === undefined ? [snapshot(healthModel)] : [options.first];
  const waiters = new Map<string, Waiter>();
  let counter = 0;

  const deliver = (): void => {
    for (const [key, waiter] of waiters) {
      if (queue.length === 0) return;
      waiters.delete(key);
      waiter.resolve(queue.splice(0).join(""));
    }
  };

  await page.route("**/api/health-model/stream**", async (route) => {
    const request = route.request();
    requests.push({ lastEventId: request.headers()["last-event-id"] ?? null, at: Date.now() });
    if (options.refuse) {
      await route.fulfill({ status: options.refuse.status, contentType: "application/json", body: JSON.stringify(options.refuse.body) });
      return;
    }
    const key = `${request.url()}${(counter += 1)}`;
    const waiter: Waiter = { resolve: () => undefined };
    const text = new Promise<string>((resolve) => {
      waiter.resolve = resolve;
    });
    waiters.set(key, waiter);
    deliver();
    const gone = new Promise<null>((resolve) => {
      const check = setInterval(() => {
        if (page.isClosed()) {
          clearInterval(check);
          resolve(null);
        }
      }, 200);
      void text.finally(() => clearInterval(check));
    });
    const body = await Promise.race([text, gone]);
    if (body === null) return;
    try {
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body: `retry: 100\n\n${body}` });
    } catch {
      // The page dropped the request (a pause, a model change). What was handed to it goes back, as the hub's ring would replay it.
      queue.unshift(body.replace(/^retry: 100\n\n/, ""));
      deliver();
    }
  });

  return {
    requests,
    push: (...frames) => {
      queue.push(...frames);
      deliver();
    },
  };
}
