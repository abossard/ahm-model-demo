import type { HealthModel } from "../model/types";
import type { ShowMeAction } from "../showMe";

export type StopId = "overview" | "dependency" | "signal" | "readings" | "entity" | "timeline" | "coverage" | "builder" | "history";

export interface TourStop {
  readonly id: StopId;
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly action: ShowMeAction;
  readonly entityName?: string;
  readonly next: readonly StopId[];
}

/** Bind the route to real objects once. Subsequent readings still come from the page's selected moment. */
export function tourStops(model: HealthModel, selectedName: string | null, created = false): TourStop[] {
  const byName = new Map(model.entities.map(entity => [entity.name, entity]));
  const selected = selectedName ? byName.get(selectedName) : undefined;
  const readable = model.entities.filter(entity => entity.healthState !== "Deleted");
  const edges = model.relationships.filter(edge => byName.has(edge.parentEntityName) && byName.has(edge.childEntityName));
  const edge = edges.find(item => item.parentEntityName === selectedName || item.childEntityName === selectedName) ?? edges[0];
  const parent = edge ? byName.get(edge.parentEntityName) : undefined;
  const child = edge ? byName.get(edge.childEntityName) : undefined;
  const entity = selected ?? child ?? readable[0] ?? model.entities[0];
  const measured = [selected, child, parent, ...readable].find(item => item?.signals.length);
  const signal = measured?.signals.find(item => item.healthState === "Unhealthy" || item.healthState === "Degraded") ?? measured?.signals[0];

  const stops: TourStop[] = [{
    id: "overview", label: "See the whole model", title: "Meet your model",
    description: model.entities.length
      ? `Welcome aboard ${model.model.name}! Each card is one part of the model. Follow a connection to see what it depends on, or peek at the signals behind its health.`
      : `${model.model.name} is a blank canvas. Let’s look around while there’s elbow room. You can explore the timeline or see where a new model begins.`,
    action: { handle: "graph", id: "view/zoom" }, next: ["dependency", "signal", "timeline", "entity", "builder", "coverage"],
  }];
  if (edge && parent && child) stops.push({
    id: "dependency", label: "Trace a dependency", title: "Follow that thread",
    description: `${parent.displayName} depends on ${child.displayName}. The highlighted line joins the two. A change in the child can help explain what you see higher up.`,
    entityName: parent.name, action: { handle: "graph", id: `connection/${edge.name}`, highlight: { color: "violet" } },
    next: ["entity", "signal", "coverage"],
  });
  if (measured && signal) stops.push({
    id: "signal", label: "Read a signal", title: "A little signal sleuthing",
    description: `Meet ${signal.displayName || signal.name}, a signal on ${measured.displayName}. Its lane shows when readings arrived and how their state changed. Pick a moment to see what the rest of the model looked like then.`,
    entityName: measured.name, action: { handle: "timeline", id: `signal/${measured.name}/${signal.name}`, highlight: { color: "amber" } },
    next: ["timeline", "entity", "history"],
  });
  if (entity) stops.push({
    id: "entity", label: "Inspect an entity", title: "Put one card under the lens",
    description: `Here’s ${entity.displayName}. Its details show its state and impact. The question above the timeline lets you ask the assistant how it got there.`,
    entityName: entity.name, action: { handle: "panel", id: `entity/${entity.name}` }, next: ["signal", "dependency", "history"],
  });
  stops.push({
    id: "timeline", label: "Explore the timeline", title: "Turn back the clock",
    description: model.entities.length
      ? "The timeline gives each entity a row. Pick a moment on the plot and the graph follows you back in time. Back to now brings you home."
      : "This is where the timeline will draw a row for each entity. Once your model has readings, you can pick a moment here and rewind the graph with it.",
    action: { handle: "timeline", id: "overview" }, next: ["signal", "entity", "coverage", "history", "overview"],
  }, {
    id: "coverage", label: "Check model coverage", title: "Where are the quiet spots?",
    description: model.entities.length
      ? "Coverage lays out the model in bands. Wide parts have more leaf entities underneath them. Double-click a part with children to zoom in and see who’s keeping it company."
      : "Coverage will show how the parts of your model fit together. This model has no entities yet, so there are no bands to draw.",
    action: { handle: "graph", id: "view/coverage" }, next: ["dependency", "builder", "overview"],
  }, {
    id: "builder", label: "Find the model builder", title: "Build your own map",
    description: "Create model opens the builder. Choose Azure resources there, explore the designs the assistant proposes, and preview the one you like before you approve creation.",
    action: { handle: "workspace", id: "builder" }, next: ["coverage", "history", "overview"],
  }, {
    id: "history", label: "Find earlier questions", title: "Pick up the trail",
    description: "History keeps the questions you’ve asked. Reopen a topic to see the assistant’s answer, follow its Show me buttons, or review its proposed changes.",
    action: { handle: "workspace", id: "history" }, next: ["overview", "timeline", "builder"],
  });
  if (created) {
    const overview = stops[0]!;
    stops[0] = { ...overview, title: "Meet your new model",
      description: `Here’s ${model.model.name}, the model you created in Azure. Let’s see which signals have checked in${edge ? ", then follow a dependency through the graph" : ""}.`,
      next: ["readings", "dependency", "entity", "timeline"] };
    const signals: TourStop = {
      id: "readings", label: "Check signal readings", title: "First signal readings",
      description: "Select a signal to find its lane on the timeline. As readings arrive, you can watch them here.",
      action: { handle: "timeline", id: "overview" }, next: ["dependency", "entity", "overview", "coverage"],
    };
    return [stops[0]!, signals, ...stops.slice(1).filter(stop => stop.id !== "signal" && stop.id !== "builder" && stop.id !== "history")
      .map(stop => ({ ...stop, next: ["readings" as const, ...stop.next] }))];
  }
  return stops;
}

export function nextStops(stop: TourStop, available: readonly TourStop[]): TourStop[] {
  const destinations = new Map(available.map(item => [item.id, item]));
  return [...new Set([...stop.next, ...destinations.keys()])]
    .filter(id => id !== stop.id)
    .flatMap(id => destinations.get(id) ?? [])
    .slice(0, 3);
}
