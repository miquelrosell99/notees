Here’s a **complete, structured Claude/Opus prompt** to implement the NodeCollection system, all view modes, editable toggles, recursion, and graph integration including the main graph view. It’s written to be **clear, actionable, and self-contained** for implementation:

---

## **Claude / Opus Prompt**

**Objective:** Refactor and implement a unified `NodeCollection` system in the Notees app to handle all collection display modes (list, document, card, table, gantt, graph) with editable defaults, recursive children, and reusable visualization components. Include the Main Graph View for all pages.

---

### **Tasks**

#### 1. **NodeCollection Component**

* Create `NodeCollection` as the universal node collection component.
* Props:

  ```ts
  interface NodeCollectionProps {
    nodes: Node[];               // Main nodes to display
    viewMode: 'list' | 'document' | 'card' | 'table' | 'gantt' | 'graph';
    editable?: boolean;          // default true
    renderNode?: (node: Node) => JSX.Element; // optional custom renderer
  }
  ```
* Behavior:

  1. Dispatches to the correct view component based on `viewMode`.
  2. `editable` flows to all children recursively.
  3. Recursive children: only main nodes passed in; children handled per node.
  4. Editable nodes render `<Block>`; read-only nodes render `<BlockPreview>`.

---

#### 2. **View Mode Components**

* **List / Outline** → `NodeList`

  * Recursive bullet list with indentation.
* **Document** → `NodeListFlat`

  * Recursive, no bullets, no indentation.
* **Card** → `NodeCardGrid` / `NodeCard`

  * Main node title in card, children inside card body (recursive).
* **Table** → `NodeTable`

  * Rows for main nodes, optional expandable rows for children.
* **Gantt** → `NodeGantt`

  * Timeline view of main nodes, children optional.
* **Graph** → `NodeGraph`

  * Only accepts nodes with `is_page = true`.
  * Passes nodes to reusable `GraphRenderer`.
  * Editable flag controls node interactions (drag/drop, rename, select).

---

#### 3. **GraphView / GraphRenderer**

* `GraphView`:

  * Receives filtered nodes from NodeCollection (`nodes.filter(n => n.is_page)`).
  * Handles editable interactions.
  * Passes nodes to `GraphRenderer`.
* `GraphRenderer`:

  * Pure visualization component: renders nodes, edges, labels.
  * Stateless and reusable, no filtering or collection logic.

---

#### 4. **Main Graph View**

* Component: `MainGraphView`
* Purpose: show all pages in the system.
* Uses NodeCollection in graph mode:

  ```tsx
  const MainGraphView = ({ allPages }: { allPages: Node[] }) => {
    const pages = allPages.filter(n => n.is_page);
    return <NodeCollection nodes={pages} viewMode="graph" editable={true} />;
  };
  ```

---

#### 5. **Editable / Read-Only Contexts**

| Context               | NodeCollection props | Behavior                                |
| --------------------- | -------------------- | --------------------------------------- |
| Page / default        | editable=true        | Full editing capabilities               |
| Linked references     | editable=true        | Editable unless node is system-locked   |
| Favorites             | editable=false       | Read-only, optionally reorderable       |
| Recents               | editable=false       | Read-only display only                  |
| Graph / MainGraphView | editable=false       | Read-only display only                  |

* The `editable` prop propagates recursively to all children.

---

#### 6. **Additional Notes**

* Recursive rendering only applies to views that support hierarchy (list, document, card).
* NodeCollection should be the **only interface** used for collections of nodes.
* GraphView should **always filter nodes** to pages (`is_page = true`).
* Editable toggle determines whether `<Block>` or `<BlockPreview>` is used.
* Existing components like `Block`, `BlockPreview`, `NodeCard`, `NodeTable`, and `NodeGantt` should be reused.
* Future view modes should integrate by adding a new case in NodeCollection.

---

#### 7. **Component Hierarchy Diagram (Textual)**

```
NodeCollection
├─ NodeList (list)
│   └─ recursive nodes → Block / BlockPreview
├─ NodeListFlat (document)
│   └─ recursive nodes → Block / BlockPreview
├─ NodeCardGrid (card)
│   └─ NodeCard
│       └─ recursive children → Block / BlockPreview
├─ NodeTable (table)
│   └─ rows → Block / BlockPreview
├─ NodeGantt (gantt)
│   └─ timeline nodes → Block / BlockPreview
└─ NodeGraph (graph)
    └─ GraphRenderer → nodes only with is_page = true
```

---
Here’s the **second, complementary prompt** for Claude/Opus to **refactor your existing NodeSet, page views, favorites, recents, and linked references** to use the new `NodeCollection` system. You can append it to the first prompt so Claude has both the implementation and refactor instructions in one task.

---

**Objective:** Refactor all existing components and views that display collections of nodes to use the new `NodeCollection` system. Ensure consistent editable behavior, view modes, and recursive child handling.

---

### **Tasks**

#### 1. **NodeSet Refactor**

* Replace the current NodeSet component with `NodeCollection`.
* Preserve all existing view modes (list, table, card).
* Behavior:

  * `NodeCollection` should handle the selection of view mode.
  * Recursive children should be displayed in hierarchical views (list / card / document).
  * Editable nodes render `<Block>`, read-only nodes render `<BlockPreview>`.
* Keep NodeSet’s extra props (filters, grouping) as configuration for NodeCollection:

  ```tsx
  <NodeCollection
    nodes={nodeSetNodes}
    viewMode={selectedViewMode}
    editable={true}
    groupBy={groupBy} // if applicable
  />
  ```

---

#### 2. **Page Views Refactor**

* For all page content components (normal/outliner, document, cardview):

  1. Replace manual recursive rendering with NodeCollection.
  2. Pass the page’s main children as `nodes`.
  3. Pass `viewMode` according to the current page mode:

     * Normal / outline → list
     * Document → document
     * Cardview → card
  4. `editable` defaults to `true`.

---

#### 3. **Favorites and Recents Sections**

* **Favorites:**

  * Use `NodeCollection` with `editable=false`.
  * Use `SelectionSortable` as the container if reordering is needed.
  * Each node displayed via `<BlockPreview>`.

* **Recents:**

  * Use `NodeCollection` with `editable=false`.
  * Read-only display using `<BlockPreview>` for each item.
  * No reordering.

---

#### 4. **Linked References / Backlinks**

* Replace current `Backlinks` / `ReferencesView` components with `NodeCollection`.
* Behavior:

  * Pass only the relevant linked nodes for that reference.
  * Recursive children are loaded as usual (if needed).
  * `editable` defaults to `true`, unless a specific linked reference is meant to be read-only.
  * list / Graph / table / card view modes available

---

#### 5. **Graph View Refactor**

* Replace any existing page-level graph rendering with:

  ```tsx
  <NodeCollection
    nodes={allPages.filter(n => n.is_page)}
    viewMode="graph"
    editable={true}
  />
  ```
* The `GraphView` component should remain the renderer, but NodeCollection handles node filtering and editable toggling.

---

#### 6. **Consistency Requirements**

* All previous node collection displays (NodeSet, page children, favorites, recents, linked references) **must now use NodeCollection**.
* Editable vs read-only rendering must consistently toggle `<Block>` vs `<BlockPreview>`.
* Recursive children handling must be centralized in NodeCollection and propagated to all views that need it.
* Existing view-specific logic (list, document, card, table, graph, gantt) should be removed from individual components and handled by NodeCollection and the corresponding view mode component.

---