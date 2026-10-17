# Composing a View

Build a View by importing native components from `@locus/components`. `await locus.views.components()` lists the available names. For ordinary Unity forms, bind displayed components inside `UnityPropertyScope`: Locus owns requests, batching, shared data and editing. The View owns layout, target selection and domain rules, not a second loading/cache implementation.

| Need | Reuse |
| --- | --- |
| Actions, choices and flags | `BaseButton`, `BaseDropdown`, `BaseSegmented`, `BaseCheckbox`, `BaseSwitch` |
| Movable custom blocks and field boards | `CanvasView` with an `item` slot |
| Nodes, ports, connections and graph layout | `GraphView` and `defineGraphView` |
| Source-to-target mappings | `LinkBoard` |
| Serialized property tables | `SerializedTableView` |
| A Unity object or inspector | `UnityObjectPreview`, `UnitySerializedPropertyTree`, or a bound tree's `drawDefaultEditor()` |
| Unity fields without page-owned requests | `UnityPropertyScope` + `UnityPropertyField`; `useUnityPropertyBinding` for custom controls |
| Individual properties and custom drawers | `UnityPropertyDraw`, `UnityPropertyEditor`, `UnityNumberField`, `UnityObjectReferenceField` and the other Unity field components |
| Field ownership, template inheritance and override actions | `PropertyField` around an existing editor |
| Unity reference drag/drop | `UnityReferenceChip`, `UnityDropZone` |
| A View-owned Unity render texture and native interaction | `UnityRenderSurface` + `locus.unity.renderer` ([contract](unity-renderer.md)) |

Keep the View source small. Compose existing controls before writing another canvas, table, property editor or button style. Use `BaseCheckbox` for configuration flags and `BaseSwitch` for immediate state changes. Put saving, status, toolbars and additional panels in the View only when that tool needs them.

## Component-driven Unity data

```vue
<script setup lang="ts">
import { UnityPropertyScope, UnityPropertyField } from "@locus/components";
const props = defineProps<{ motionTarget: { kind: string; path: string }; readonly: boolean }>();
</script>
<template>
  <UnityPropertyScope :target="motionTarget" :readonly="readonly">
    <section>
      <h2>Navigation</h2>
      <UnityPropertyField path="navigation.waypointTolerance" />
      <UnityPropertyField path="navigation.repathDistance" />
    </section>
  </UnityPropertyScope>
</template>
```

Each displayed field registers its own demand. Do not repeat paths in a loading manifest or write `onMounted` requests for these fields. The owning View shares a bounded **object-value cache**, static Schema and compact Live snapshots: fields project their values from an object, and opening another page can reuse the same object without another request. Scalar acknowledgements patch the cache while local drafts remain editable. Arrays stay bounded; insufficient coverage, complex objects and older bridges use the authoritative legacy reader automatically. Components release demand on unmount or KeepAlive deactivation. Editor change tokens invalidate affected objects, with conservative recovery after missed events/domain changes; hidden Views revalidate on activation without discarding mounted values. `property.bind(target)` supplies the same lazy resource when a target cannot inherit a scope.

A `UnityPropertyField` default slot receives `{ binding, value, loading, error, readonly, disabled, write, refresh }` for custom controls. Forward scope read-only state; do not disable a whole form while a write is pending. Outside an injected View, pass a `UnityPropertyRuntime` explicitly as the scope's `runtime` prop. Business queries and semantic guards remain project-owned. This does not infer dependencies from arbitrary TypeScript or mount unopened pages to discover them.

## Template and instance fields

Use `PropertyField` for row-level ownership chrome, not a private CSS marker on every input. Keep the editing context visible once in the page; do not repeat source badges on each row.

```vue
<script setup lang="ts">
import { PropertyField, UnityNumberField } from "@locus/components";
import type { PropertyFieldPresentation, PropertyFieldAction } from "@locus/view-runtime";
const props = defineProps<{ value: number; field: PropertyFieldPresentation }>();
const emit = defineEmits<{ commit: [value: unknown]; action: [action: PropertyFieldAction] }>();
</script>
<template>
  <PropertyField v-bind="field" label="Health" field-key="actor:health" @action="emit('action', $event)">
    <template #default="{ readonly, disabled }">
      <UnityNumberField :model-value="value" :readonly="readonly" :disabled="disabled"
        aria-label="Health" @commit="emit('commit', $event)" />
    </template>
  </PropertyField>
</template>
```

Scope (`template-only`, `instance-only`, `template-and-instance`) is separate from provenance (`local`, `inherited`, `overridden`). Only an explicit override gets a strong left bar; inheriting does not imply read-only. Always forward the slot's `readonly` and `disabled` to custom editors. Actions are capability descriptors, not executable callbacks or automatic writes. The owner performs validation, confirmation, Undo, save and refresh. See `runtime-api.md` → Field presentation for the complete contract, including tree/custom drawer integration.

## Link mappings

```vue
<script setup lang="ts">
import { ref } from "vue";
import { LinkBoard, BaseButton } from "@locus/components";
import { view } from "@locus/view-runtime";
const sources = [{ id: "color", label: "Color" }, { id: "normal", label: "Normal" }];
const targets = [{ id: "base-map", label: "Base Map" }, { id: "normal-map", label: "Normal Map" }];
const links = ref<Array<{ source: string; target: string }>>([]);
async function save() { await view.storage.set("mapping", links.value); }
</script>
<template>
  <LinkBoard v-model="links" :sources="sources" :targets="targets" />
  <BaseButton @click="save">Save</BaseButton>
</template>
```

Endpoint shape: `{ id, label, disabled? }`. Connection shape: `{ source, target }`. Select a source, then a target to connect; select the same pair again to unlink. With no selected source, clicking a linked target unlinks it. Escape cancels the pending source. Native button keyboard behavior supports Enter/Space.

Props: `sources`, `targets`, `modelValue`, optional `sourceTitle`, `targetTitle`, `readonly`, `multiple`. Default mapping is one-to-one; `multiple` allows several connections per endpoint. The `update:modelValue` event returns a new array and does not modify input data. `source` and `target` slots receive `{ item, linked }`; the source slot also receives `selected`. Parent data changes and element resizing update the connection lines. No storage key, data provider or business rule is built in.

## Freeform boards

```vue
<script setup lang="ts">
import { ref } from "vue";
import { CanvasView } from "@locus/components";
const blocks = ref([{ id: "details", x: 40, y: 40, width: 240, height: 120, title: "Details" }]);
const selected = ref<string[]>([]);
</script>
<template>
  <CanvasView :items="blocks" v-model:selected-item-ids="selected">
    <template #item="{ item }"><section>{{ item.title }}</section></template>
  </CanvasView>
</template>
```

`CanvasView` supplies pan/zoom, moving, selection and hit testing. Its `editBehavior` prop controls permissions; `copySelection`, `pasteSelection`, `deleteSelection` and `contextMenu` events let the View implement its document rules. Compose `UnityPropertyDraw` or other native controls in the item slot for field boards. Give the canvas a container with a defined height. Read `app/view-runtime/src/components/canvas/canvasTypes.ts` for event shapes and the exposed `fitContent()` API.

## Node graphs

```ts
import { GraphView } from "@locus/components";
import { defineGraphView, view } from "@locus/view-runtime";
import type { GraphData } from "@locus/view-runtime";
const graph = defineGraphView({
  loadGraph: async (): Promise<GraphData> => (await view.storage.get("graph") as GraphData | null) ?? { schema: "locus.graph.v1", nodes: [], connections: [] },
  saveGraph: async (data: GraphData) => view.storage.set("graph", data),
});
// Render <GraphView :controller="graph" />.
```

Controllers can provide `createNode`, `validateConnection`, `applyGraph` and `onGraphChange`. Graph interaction and layout remain in the component. Use the actual `GraphData`/`GraphNode`/`GraphPort` types in `app/view-runtime/src/components/graph/graphTypes.ts` rather than inventing another graph format.

## Unity properties and tables

Use `property.fromPath(...)` to bind a Unity object or property. A bound tree's `drawDefaultEditor()` and an individual property's `draw()` already connect the editor to write-back; no wrapper C# script is required. `UnitySerializedPropertyTree` and `UnityPropertyDraw` also accept custom property drawers. `UnityObjectPreview` takes a `model` and can show an object, its identity, preview and inspector.

`SerializedTableView` takes `columns`, `rows`, `loading`, `error`, `status`, `progress`, `savingCellKey` and `columnWidths`. Handle `commit` to write and refresh a cell; bind `columnWidths` with `v-model` if the View should retain column sizing. Use `resolveSerializedTableSources` and the source helpers from `@locus/view-runtime` when aggregating asset sources. Data adapters can use the shared asset/property APIs; UI rendering does not require a generated C# script or a particular source provider.

For numeric units, pass `unit="米/秒"` / `unit="秒"` / `unit="帧"` to `UnityNumberField` or `UnityPropertyEditor`. The built-in control places a muted suffix inside its right edge; do not append units to the label or put them on another line. Vector/bounds controls support the same prop per coordinate. A snapshot's `unit` is carried through the property tree, bound editors and custom drawer props; it never changes the stored value or performs conversions. See `runtime-api.md` → Input units.

For exact props and data shapes, read the relevant exported component source under `app/view-runtime/src/components/`. More services and field components are described in `runtime-api.md`.
