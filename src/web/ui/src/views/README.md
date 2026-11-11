# Views

One health model, drawn by interchangeable views. The toolbar's view switch picks one; `?view=` and localStorage remember it.

- **Add a view:** (1) add `{ id, label, description }` to `VIEWS` in `model/views.ts`, in A to F order (ids are fixed in `VIEW_IDS`); (2) add its component to `PARTS` in `views/registry.ts` (the type fails until you do).
- **Props:** a view is a `ComponentType<ViewProps>` (`views/types.ts`): entities, relationships, selection, highlight, Explain chain names, diff badges, `onActivate`. Read anything else with atomic `useStore` selectors.
- **Pure first:** layout, routing and sizing are functions in `src/model` with `it.each` tests; the component only draws. No React or store in `model/`.
- **Must support:** click or Enter picks the entity (`onActivate`): its details open above the timeline, which opens on its row; `selectedName` and `highlightedName` rings; search focus (`focusSeq`/`focusNames`: bring those entities into view); chain marks numbered from the last chain name; the Health filter (`visibleGraph`); keyboard reach; light and dark; reduced motion; no layout work on stream events (select nothing you do not draw).
- **Shared:** palette, shapes, impact and diff marks in `model/palette.ts` (never a literal colour); `StateGlyph`, `HealthBadge`, `Legend` (view notes via `legendNotes`) in `components/`; `routeSteps` and `StepEdge` for routed lines.
- **View-only controls:** `Controls` in the definition shows in the toolbar only while the view is selected.
- **Compare:** the selected view draws a diff itself. Say how in `compareMode`: `split` is drawn twice, Base and Proposed, each with its own entities and `badges`, arranged on `compare.basis` (everything either side has, this side's versions) so an entity keeps its place; lanes and the like come from `compare.union`, the same for both; `merged` is drawn once over the union with every mark. Draw `badges` as a mark and `marked` (ticked changes) as a ring; `onActivate` already ticks changes there. Helpers: `model/compare.ts`.
- **Fixtures:** `tests/viewModels.ts` exports `incidentModel`, `calmModel`, `denseIncidentModel`, `diffViewModel`; vitest and Playwright import the same ones.
- **Specs:** `openView(page, id)` from `tests/views.ts` opens a view by address; a spec for one view opens that view explicitly.
- **Do not edit** the foundation (`palette.ts`, `views.ts`, `registry.ts` beyond your own line, `Legend`, `StateGlyph`, `stepRouter.ts`, `StepEdge`, `viewModels.ts`) without asking.
