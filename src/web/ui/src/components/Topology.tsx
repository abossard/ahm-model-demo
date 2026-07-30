import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { renderSwimlane } from "../diagrammo";
import type { SwimlaneCard } from "../diagrammo";
import { encodeSnapshot } from "../model/encode";
import type { Entity, Relationship } from "../model/types";
import { useAppDispatch, useAppSelector } from "../store/store";
import { selectSelectedName } from "../store/selectors";
import { selectEntity } from "../store/entitySlice";
import { openPanel } from "../store/uiSlice";

interface TopologyProps {
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
}

const ENTITY_CARD_ID = /^e(\d+)$/;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function overlayMarkup(
  cards: readonly SwimlaneCard[],
  entities: readonly Entity[],
): string {
  const groups: string[] = [];
  for (const card of cards) {
    const match = ENTITY_CARD_ID.exec(card.id);
    if (!match) continue;
    const index = Number(match[1]);
    const entity = entities[index];
    if (!entity) continue;
    const label = escapeAttr(`${entity.displayName || entity.name} — ${entity.healthState}`);
    groups.push(
      `<g data-entity="${escapeAttr(entity.name)}" data-lane="${card.lane}" ` +
        `class="hit-target" role="button" tabindex="0" aria-label="${label}">` +
        `<rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" ` +
        `rx="10" fill="transparent" pointer-events="all"></rect></g>`,
    );
  }
  return `<g class="hit-layer">${groups.join("")}</g>`;
}

export function Topology({ entities, relationships }: TopologyProps): JSX.Element {
  const dispatch = useAppDispatch();
  const selectedName = useAppSelector(selectSelectedName);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver((entriesList) => {
      const entry = entriesList[0];
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || width === 0) return;
    const code = encodeSnapshot({ entities, relationships });
    const result = renderSwimlane(code, { theme: "portal", maxWidth: width });
    const overlay = overlayMarkup(result.debug.cards, entities);
    node.innerHTML = result.svg.replace(/<\/svg>\s*$/, `${overlay}</svg>`);

    const entityCards = result.debug.cards.filter((card) => ENTITY_CARD_ID.test(card.id));
    const rects = node.querySelectorAll<SVGRectElement>('rect[stroke-width="2"]');
    entityCards.forEach((card, cardIndex) => {
      const rect = rects[cardIndex];
      const match = ENTITY_CARD_ID.exec(card.id);
      const entity = match ? entities[Number(match[1])] : undefined;
      if (rect && entity) rect.setAttribute("data-entity-card", entity.name);
    });
  }, [entities, relationships, width]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    node
      .querySelectorAll(".hit-target.is-selected")
      .forEach((element) => element.classList.remove("is-selected"));
    if (selectedName) {
      node
        .querySelector(`.hit-target[data-entity="${CSS.escape(selectedName)}"]`)
        ?.classList.add("is-selected");
    }
  }, [selectedName, width, entities]);

  const activateFrom = (target: EventTarget | null): void => {
    if (!(target instanceof Element)) return;
    const group = target.closest<Element>(".hit-target[data-entity]");
    const name = group?.getAttribute("data-entity");
    if (!name) return;
    dispatch(selectEntity(name));
    dispatch(openPanel());
  };

  return (
    <div
      id="topology"
      className="topology"
      ref={containerRef}
      onClick={(event) => activateFrom(event.target)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activateFrom(event.target);
        }
      }}
    />
  );
}
