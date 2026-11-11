import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import {
  Dialog,
  DialogSurface,
  type DialogSurfaceProps,
  Input,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { Search20Regular } from "@fluentui/react-icons";
import type { Entity, Relationship } from "../model/types";
import { GROUP_LABELS, searchGraph, type SearchGroup, type SearchHit } from "../model/search";
import { ancestorsToExpand, healthBucket } from "../model/collapse";
import { actions, useStore } from "../store/store";

interface SearchOverlayProps {
  readonly entities: readonly Entity[];
  readonly relationships: readonly Relationship[];
}

const LISTBOX_ID = "graph-search-listbox";
const BACKDROP = { "data-testid": "search-backdrop" } as NonNullable<DialogSurfaceProps["backdrop"]>;
const GROUP_ORDER: readonly SearchGroup[] = ["entities", "relationships", "signals"];

/** The time the graph needs to fit the room a timeline that opens leaves it. */
const TIMELINE_FIT_MS = 150;

const useStyles = makeStyles({
  surface: {
    width: "min(560px, calc(100% - 32px))",
    maxWidth: "560px",
    margin: "64px auto auto",
    padding: 0,
    overflow: "hidden",
  },
  input: { width: "100%", padding: tokens.spacingVerticalXS },
  results: { maxHeight: "320px", overflowY: "auto" },
  groupLabel: {
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} ${tokens.spacingVerticalXXS}`,
    fontSize: tokens.fontSizeBase100,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: tokens.colorNeutralForeground2,
  },
  option: {
    display: "flex",
    alignItems: "baseline",
    columnGap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`,
    cursor: "pointer",
  },
  active: { backgroundColor: tokens.colorSubtleBackgroundHover },
  label: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground1 },
  detail: {
    marginLeft: "auto",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  mark: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
    padding: 0,
  },
  empty: { margin: 0, padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalL}` },
});

const Marked = memo(function Marked({ hit }: { readonly hit: SearchHit }): JSX.Element {
  const styles = useStyles();
  if (hit.matchLength === 0) return <>{hit.label}</>;
  const end = hit.matchStart + hit.matchLength;
  return (
    <>
      {hit.label.slice(0, hit.matchStart)}
      <mark className={styles.mark}>{hit.label.slice(hit.matchStart, end)}</mark>
      {hit.label.slice(end)}
    </>
  );
});

export function SearchOverlay({ entities, relationships }: SearchOverlayProps): JSX.Element {
  const styles = useStyles();
  const open = useStore((state) => state.searchOpen);
  const collapsed = useStore((state) => state.collapsed);
  const selectedHealth = useStore((state) => state.selectedHealth);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      actions.openSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The store notifies before React renders, while the opener still holds focus, for every entry path.
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (!state.searchOpen || previous.searchOpen) return;
        const current = document.activeElement;
        returnFocusTo.current =
          current instanceof HTMLElement && current !== document.body ? current : null;
      }),
    [],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  const hits = useMemo(
    () => searchGraph(query, entities, relationships),
    [query, entities, relationships],
  );

  const dismiss = (): void => {
    actions.closeSearch();
    const opener = returnFocusTo.current;
    returnFocusTo.current = null;
    opener?.focus();
  };

  const choose = (hit: SearchHit | undefined): void => {
    if (!hit) return;
    const byName = new Map(entities.map((item) => [item.name, item] as const));
    const required = new Set(selectedHealth);
    for (const name of hit.focusEntities) {
      const state = byName.get(name)?.healthState;
      if (!state) continue;
      const bucket = healthBucket(state);
      if (bucket !== "Deleted") required.add(bucket);
    }
    if (required.size !== selectedHealth.length) {
      actions.setSelectedHealth([...required]);
    }
    const blocked = new Set<string>();
    for (const name of hit.focusEntities) {
      for (const ancestor of ancestorsToExpand(name, entities, relationships, new Set(collapsed))) {
        blocked.add(ancestor);
      }
    }
    if (blocked.size > 0) actions.expandMany([...blocked]);
    const focus = (): void => actions.focusEntities({ highlight: hit.focusEntity, names: hit.focusEntities });
    // A timeline that opens takes room from the graph, which then fits its new size: bring the result into view after that.
    if (useStore.getState().timelineOpen) focus();
    else window.setTimeout(focus, TIMELINE_FIT_MS);
    actions.showInTimeline(hit.focusEntity);
    actions.announce(`Showing ${hit.label}: ${hit.detail}.`);
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
    <Dialog open={open} onOpenChange={(_, data) => (data.open ? undefined : dismiss())}>
      <DialogSurface
        className={styles.surface}
        aria-label="Search this model"
        data-testid="search-overlay"
        backdrop={BACKDROP}
      >
        <Input
          input={{ ref: inputRef }}
          className={styles.input}
          appearance="filled-lighter"
          contentBefore={<Search20Regular />}
          data-testid="search-input"
          type="text"
          role="combobox"
          autoComplete="off"
          placeholder="Search entities, relationships and signals"
          aria-label="Search this model"
          aria-expanded={hits.length > 0}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          {...(activeHit ? { "aria-activedescendant": activeHit.id } : {})}
          value={query}
          onChange={(_, data) => {
            setQuery(data.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className={styles.results} id={LISTBOX_ID} role="listbox" aria-label="Results">
          {GROUP_ORDER.filter((group) => hits.some((hit) => hit.group === group)).map((group) => (
            <div role="group" aria-label={GROUP_LABELS[group]} key={group}>
              <div className={styles.groupLabel} aria-hidden="true">
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
                    className={mergeClasses(styles.option, hit.id === activeHit?.id && styles.active)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(hit);
                    }}
                  >
                    <span className={styles.label}>
                      <Marked hit={hit} />
                    </span>
                    <span className={styles.detail}>{hit.detail}</span>
                  </div>
                ))}
            </div>
          ))}
        </div>
        {query.trim().length > 0 && hits.length === 0 ? (
          <Text as="p" className={styles.empty} data-testid="search-empty">
            No matches for “{query}”
          </Text>
        ) : null}
      </DialogSurface>
    </Dialog>
  );
}
