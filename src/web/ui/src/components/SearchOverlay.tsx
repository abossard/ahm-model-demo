import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { Entity, Relationship } from "../model/types";
import { GROUP_LABELS, searchGraph, type SearchGroup, type SearchHit } from "../model/search";
import { ancestorsToExpand } from "../model/collapse";
import { useAppDispatch, useAppSelector } from "../store/store";
import { selectCollapsed, selectSearchOpen } from "../store/selectors";
import { announce, closeSearch, expandMany, focusEntities, openSearch } from "../store/uiSlice";

interface SearchOverlayProps {
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
}

const LISTBOX_ID = "graph-search-listbox";
const GROUP_ORDER: readonly SearchGroup[] = ["entities", "relationships", "signals"];

function Marked({ hit }: { readonly hit: SearchHit }): JSX.Element {
  if (hit.matchLength === 0) return <>{hit.label}</>;
  const end = hit.matchStart + hit.matchLength;
  return (
    <>
      {hit.label.slice(0, hit.matchStart)}
      <mark>{hit.label.slice(hit.matchStart, end)}</mark>
      {hit.label.slice(end)}
    </>
  );
}

export function SearchOverlay({ entities, relationships }: SearchOverlayProps): JSX.Element | null {
  const dispatch = useAppDispatch();
  const open = useAppSelector(selectSearchOpen);
  const collapsed = useAppSelector(selectCollapsed);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      returnFocusTo.current = document.activeElement as HTMLElement | null;
      dispatch(openSearch());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch]);

  useEffect(() => {
    if (!open) return;
    // Remember the opener for every entry path, not just the keyboard shortcut.
    if (!returnFocusTo.current || returnFocusTo.current === document.body) {
      const current = document.activeElement as HTMLElement | null;
      returnFocusTo.current = current && current !== document.body ? current : null;
    }
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  const hits = useMemo(
    () => searchGraph(query, entities, relationships),
    [query, entities, relationships],
  );

  if (!open) return null;

  const dismiss = (): void => {
    dispatch(closeSearch());
    const opener = returnFocusTo.current;
    returnFocusTo.current = null;
    opener?.focus();
  };

  const choose = (hit: SearchHit | undefined): void => {
    if (!hit) return;
    const blocked = new Set<string>();
    for (const name of hit.focusEntities) {
      for (const ancestor of ancestorsToExpand(name, entities, relationships, new Set(collapsed))) {
        blocked.add(ancestor);
      }
    }
    if (blocked.size > 0) dispatch(expandMany([...blocked]));
    dispatch(focusEntities({ highlight: hit.focusEntity, names: hit.focusEntities }));
    dispatch(announce(`Showing ${hit.label} — ${hit.detail}.`));
    dismiss();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (hits.length === 0 ? 0 : (current + 1) % hits.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (hits.length === 0 ? 0 : (current - 1 + hits.length) % hits.length));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      choose(hits[active]);
    }
  };

  const activeHit = hits[active];

  return (
    <div className="search-overlay" data-testid="search-overlay">
      <div
        className="search-overlay__backdrop"
        onClick={dismiss}
        role="presentation"
        data-testid="search-backdrop"
      />
      <div className="search-overlay__panel">
        <input
          ref={inputRef}
          className="search-overlay__input"
          data-testid="search-input"
          type="text"
          role="combobox"
          autoComplete="off"
          placeholder="Search entities, relationships and signals"
          aria-label="Search the topology"
          aria-expanded={hits.length > 0}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          {...(activeHit ? { "aria-activedescendant": activeHit.id } : {})}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="search-overlay__results" id={LISTBOX_ID} role="listbox" aria-label="Results">
          {GROUP_ORDER.filter((group) => hits.some((hit) => hit.group === group)).map((group) => (
            <div className="search-overlay__group" role="group" aria-label={GROUP_LABELS[group]} key={group}>
              <div className="search-overlay__group-label" aria-hidden="true">
                {GROUP_LABELS[group]}
              </div>
              {hits
                .filter((hit) => hit.group === group)
                .map((hit) => (
                  <div
                    key={hit.id}
                    id={hit.id}
                    role="option"
                    aria-selected={hit.id === activeHit?.id}
                    className={`search-overlay__option${hit.id === activeHit?.id ? " is-active" : ""}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(hit);
                    }}
                  >
                    <span className="search-overlay__option-label">
                      <Marked hit={hit} />
                    </span>
                    <span className="search-overlay__option-detail">{hit.detail}</span>
                  </div>
                ))}
            </div>
          ))}
        </div>
        {query.trim().length > 0 && hits.length === 0 ? (
          <p className="search-overlay__empty" data-testid="search-empty">
            No matches for “{query}”
          </p>
        ) : null}
      </div>
    </div>
  );
}
