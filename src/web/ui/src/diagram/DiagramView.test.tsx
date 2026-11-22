import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { incidentModel } from "../../tests/viewModels";
import type { HealthModelSnapshot } from "../model/types";
import { diagramData } from "./data";
import { DiagramView } from "./DiagramView";

const incident = incidentModel();
const storage = incident.entities.find(entity => entity.name === "session-storage")!;
const store = incident.entities.find(entity => entity.name === "system-session-store")!;
const link = incident.relationships.find(relationship => relationship.parentEntityName === store.name && relationship.childEntityName === storage.name)!;
const pair = {entities: [store, storage], relationships: [link, link, {...link, childEntityName: store.name}, {...link, childEntityName: "missing"}]};

function rendered(model: HealthModelSnapshot, entity?: string) {
  const diagram = diagramData(model, entity, "Model at 11 Nov 14:05");
  return new DOMParser().parseFromString(renderToStaticMarkup(<DiagramView diagram={diagram} />), "text/html");
}

describe("selected-moment dependency map", () => {
  it.each([
    {name: "a parent", entity: store.name, top: store.displayName, bottom: storage.displayName, text: `${store.displayName} depends on 1 entity.`},
    {name: "a leaf", entity: storage.name, top: store.displayName, bottom: storage.displayName, text: `1 entity depends on ${storage.displayName}.`},
  ])("follows only existing edges for $name", ({entity, top, bottom, text}) => {
    const doc = rendered(pair, entity);
    const nodes = [...doc.querySelectorAll("button[aria-pressed]")];
    expect(nodes.map(button => button.getAttribute("title"))).toEqual([top, bottom]);
    expect(doc.querySelector("figcaption")?.textContent).toContain("Model at 11 Nov 14:05");
    expect(doc.body.textContent).toContain(text);
  });

  it.each([
    {model: {entities: [], relationships: []}, entity: undefined, expected: "There are no entities"},
    {model: pair, entity: "removed", expected: "There are no entities"},
    {model: {entities: [storage], relationships: []}, entity: storage.name, expected: `${storage.displayName} has no connections`},
  ])("shows sparse information for $entity", ({model, entity, expected}) => {
    expect(rendered(model, entity).body.textContent).toContain(expected);
  });

  it("sends bounded readable data for large models", () => {
    const signals = Array.from({length: 30}, (_, index) => ({...storage.signals[0]!, name: `signal-${index}`, value: 0}));
    const children = Array.from({length: 8}, (_, index) => ({...storage, name: `child-${index}`, signals}));
    const map = diagramData({entities: [store, ...children], relationships: children.map(child => ({...link, childEntityName: child.name}))}, store.name);
    expect(map.neighborCount).toBe(8);
    expect(map.neighbors).toHaveLength(6);
    expect(map.neighbors[0]?.signalCount).toBe(30);
    expect(map.neighbors[0]?.signals).toHaveLength(24);
    expect(map.neighbors[0]?.signals[0]?.value).toBe(0);
    expect(map.neighbors[0]).not.toHaveProperty("report");
  });
});
