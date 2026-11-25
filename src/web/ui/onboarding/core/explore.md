## Which part of CORE runs a Task?

- In **Health model**, search for `rg-anboahmdemo`. Choose `hm-anboahmdemo`.
- Start with **Cause path**. Read the status above the graph. Open a folded chip to see the entities behind its count.

![Finding the CORE health model by its Azure resource group in the model picker.](media/picker.png)

{{excerpt:cause}}

![Cause path with the CORE root, its health summary and entities revealed by opening a folded branch.](media/cause.png)

**How to read this** explains the state glyphs and impact rules beside the model.

![The graph legend shows how child health rolls up over standard, limited and suppressed relationships.](media/legend.png)

```mermaid
flowchart LR
    core["CORE"] --> task["Run a Task"]
    task --> storage["Session and Task storage"]
    storage --> blob["Blob Storage · sessions, Tasks"]
    blob --> availability["Blob availability"]
```

- Follow the arrows to find dependencies. Read back toward CORE to trace the impact of a state change.

### Six ways to read the same model

| Which question are you asking? | In the workspace |
| --- | --- |
| **Swimlanes** · Which flows, systems and resources share a layer? Use **Fit** to see the lanes together. | ![CORE arranged in horizontal lanes by workload layer.](media/swimlanes.png) |
| **Tidy arrange** · Which parts sit below each parent? Follow the branches from top to bottom. | ![CORE arranged as a tree, with flow and system tiles above resources.](media/tidy.png) |
| **Semantic zoom** · Where is my resource in the whole model? Zoom in for cards and signals, or out for names and dots. | ![The complete CORE card graph and its layout controls.](media/zoom.png) |
| **Outline** · Which entities deserve a closer look? Expand a row with **→**, collapse it with **←**, or jump down the list using the marks at the right. | ![The CORE outline with entity states in a keyboard-navigable list.](media/outline.png) |
| **Coverage** · Which branch contains the most leaf entities? Compare band widths, then zoom into one branch. | ![The width of each band in CORE reflects its dependent leaf entities.](media/coverage.png) |

<details>
<summary>Watch the CORE graph change views (GIF)</summary>

![Switching from Cause path through Swimlanes, Tidy arrange, Semantic zoom, Outline and Coverage.](media/view-gallery.gif)

</details>

### Follow the Task branch

- In **Coverage**, double-click **Run a Task**, or focus it and press **Shift+Enter**. Find **Session and Task storage** in the band below it. **Whole model** returns to the overview.

![Coverage zoomed into Run a Task, showing its systems and dependent resources.](media/task-coverage.png)

- In **Tidy arrange**, drag a card beside a sibling. With the keyboard, press **M**, an arrow key, then **Enter**. **Order** changes to **Custom**. **Reset custom order** restores the view’s ordering.

![CORE after moving a flow, with the Custom order and reset control visible.](media/personal-order.png)

- In **Semantic zoom**, the **Layout** chooser offers four hierarchy directions, ELK layered or radial, and static or live force-directed layouts. **Edge style** and **Connection points** control how the lines run.

| Hierarchy from left to right | ELK radial |
| --- | --- |
| ![CORE with its dependencies running left to right along right-angle edges.](media/left-to-right.png) | ![The same CORE graph rearranged by the ELK radial layout.](media/radial.png) |

<details>
<summary>Watch the card layout and edge routing change (GIF)</summary>

![The Layout and Edge style controls rearrange the real CORE entities.](media/arrange-core.gif)

</details>

- Use **Signals** to add readings and six-hour sparklines to the cards. In **Filter by state**, choose which states to inspect. **Gray dot** keeps excluded entities on the map.

![The graph’s state filter with Healthy unchecked and Gray dot selected.](media/filters.png)

- On a phone, the **View** dropdown replaces the desktop tabs. **Outline** keeps the entity names in a vertical list. The theme button switches between light and dark.

![The CORE Outline in dark mode at phone width.](media/mobile.png)

### Find the storage account behind the Task

- Open graph **Search…** with the button or **Ctrl/Cmd+K**. Search for `session-storage` and select the entity under **Entities**. The other groups let you jump to a relationship or signal.

![Entity and relationship matches for session-storage in the graph search.](media/search.png)

- The graph focuses the match. The timeline opens to that entity’s row, ready to inspect its readings.

![The storage entity in the CORE graph and the focused storage row in the timeline below.](media/storage-focus.png)

<details>
<summary>Watch search find the storage dependency (animated PNG)</summary>

![The graph search opens, the storage entity is selected, and its timeline comes into focus.](media/find-storage.apng)

</details>
