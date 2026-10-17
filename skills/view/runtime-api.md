# View Runtime API Quick Reference

Use this when building a Locus View package. Prefer `@locus/view-runtime` for services, Unity editing, drawers, drag/drop, graph/canvas helpers, session, LLM, storage, and logs. Import visual components from `@locus/components`.

## Imports

- `vue`: the native Vue runtime. New entries export a component; legacy `createApp(...).mount(...)` retains plugin/provide/component registrations in the View subtree.
- `@locus/view-runtime`: main service and helper SDK.
- `@locus/components`: native component module.
- `@locus/frontend`: exports `locus`, the shared Workbench, UI and View SDK.
- GPU output: `locus.unity.renderer` with `UnityRenderSurface` from `@locus/components`; see [Unity GPU output](unity-renderer.md). Rendering and animation stay in your C# script.
- `pinia`: the native Pinia runtime; the View inherits the host instance.
- `node:fs/promises`, `fs/promises`: Promise-based filesystem APIs.
- `node:fs`, `fs`: filesystem APIs with `promises` and common callback forms.
- `node:path`, `path`: common path helpers.
- Relative package modules: `.ts`, `.vue`, `.js`, `.css`, plus extension-qualified files that the runtime compiler can execute.
- Shared View package modules: `@locus/project-view` and `@project-view`.

## Main SDK Values

`@locus/view-runtime` currently exposes these runtime values:

- `view`: `manifest`, `summary`, `reload`, `callScript`, `assets.search`, `logs.read/latest/open`, `session`, `llm`, `storage`, `documents`, `fs`, `path`, `unity`, `files`, `undo`, `propertyDrawer`, `unityObjectDrawer`, `objectReferencePicker`, `openLog`, `onUpdate`.
- `documents`: `workspace`, `knowledge`, `list`, `read`, `update`, `setProperties`, `removeProperties`, `writeBody`, `onChanged`. Markdown references, typed YAML properties and body edits with required `expectedRevision`; see `frontend-sdk.md` → Markdown documents. Also exposed as `view.documents` and `locus.documents`. Use this instead of raw filesystem writes for document-backed editors.
- `session`: `create`, `show`, `display`, `load`, `activeRun`, `events`, `queueInput`, `chat`, `send`, `wait`, `onEvent`, `fork`, `forkFromMessage`, `list`, `listArchived`, `rename`, `archive`, `unarchive`, `delete`, `undo`, `rollback`.
- `llm`: `call`.
- `storage`: `get`, `set`, `remove`.
- `fs`: `readFile`, `writeFile`, `appendFile`, `mkdir`, `readdir`, `stat`, `lstat`, `access`, `unlink`, `rm`, `rename`, `copyFile`, `constants`.
- `path`: `join`, `resolve`, `normalize`, `dirname`, `basename`, `extname`, `relative`, `parse`, `format`, `isAbsolute`, `sep`, `delimiter`, `posix`, `win32`.
- `unity`: `callScript`, `checkConnection`, `connectionStatus`, `normalizeReference`, `sceneObjectTarget`, `selectAsset`, `inspectAsset`, `openAssetInspector`, `selectSceneObject`, `inspectSceneObject`, `openSceneObjectInspector`, `select`, `inspect`, `drag.start/arm/commitDrop/onDrop/onState`, `onDrop`, `onDragState`, `objectDrawer`, `objectReferencePicker`.
- `files`: `drag.start/arm/onDrop/onState`, `onDrop`, `onDragState`.
- `undo`: `state`, `record`, `undo`, `redo`, `clear`, `handleKeydown`, `isRunning`.
- `property`: `bind`, `invalidate`, `parsePath`, `objectTarget`, `write`, `apply`, `readTree`, `fromPath`, `readProperty`, `property`. Host-managed lifecycle: `observeDataVersion`, `setActive`, `dispose`.
- `propertyDrawer`: `library`, `projectLibrary`, `register`, `registerValue`, `registerField`, `registerAttribute`, `registerPropertyPath`, `define`, `normalize`, `createLibrary`.
- `unityObjectDrawer`: `library`, `projectLibrary`, `register`, `define`, `normalize`, `createLibrary`, `resolve`.
- `objectReferencePicker`: `roots`, `searchQuery`, `filterResults`, `isResult`, `typeHint`, `typeKey`, `typeRule`, `normalizePath`, `extension`.
- Helpers: `defineView`, `useViewContext`, `useViewState(initial, stableKey?)`, `useViewScript`, `onEditorUpdate`, `useUnityReferenceDrag`, `useUnityAssetDropTarget`, `useLocusFileDrag`, `useLocusFileDropTarget`.
- Graph helpers: `GraphViewController`, `defineGraphView`, `layoutGraphDocument`.
- Serialized table helpers: `resolveSerializedTableSources`, `serializedTableSourcesFromAssets`, `normalizeSerializedTableSource`, `dedupeSerializedTableSources` (feed `SerializedTableView` from manual sources plus scripted providers).

Legacy `window.locus.view` and `window.locus.unity` resolve through an instance-local compatibility proxy. They do not overwrite the native window's globals. New code imports services and `locus` explicitly.

Some visual components are still available from `@locus/view-runtime` for compatibility. New View code should import them from `@locus/components`.

## Filesystem

Filesystem calls run through the Locus desktop bridge. Absolute paths are used directly. Relative paths resolve from the current Unity project root, matching the normal Node idea of a working directory.

```ts
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const shaderPath = path.join("Assets", "Shaders", "MyShader.shader");
const source = await readFile(shaderPath, "utf8");
await writeFile(shaderPath, source.replace("_Color", "_Tint"), "utf8");
```

`readFile(path, "utf8")` returns a string. `readFile(path)` returns a `Uint8Array` with `toString("utf8")` support. `readdir(path, { withFileTypes: true })` returns Dirent-like objects with `isFile()`, `isDirectory()`, and `isSymbolicLink()`.

## Property Paths

Use `property` for normal Unity `SerializedProperty` work:

```ts
const tree = await property.fromPath("asset/Assets/Data/Config.asset/property/m_Name");
const name = await property.readProperty("selection/property/m_Name");
await property.write("guid/<asset-guid>/property/m_Name", "Player");
await property.apply([
  { target: { kind: "asset", path: "Assets/Data/Config.asset", propertyPath: "m_Name" }, value: "Player" },
]);
```

Common string path forms:

- `selection/property/<propertyPath>`
- `asset/<assetPath>/property/<propertyPath>`
- `guid/<assetGuid>/property/<propertyPath>`
- `scene/<scenePath>/object/<objectPath>/property/<propertyPath>`
- `scene/<scenePath>/object/<objectPath>/component/<type>/<index>/property/<propertyPath>`
- `prefab/<prefabPath>/object/<objectPath>/component/<type>/<index>/property/<propertyPath>`

Bound property objects expose `write`, `preview`, `undo`, `redo`, `draw`, and `drawDefaultEditor`. Bound trees expose `root`, `properties`, `get`, `require`, `refresh`, `writeProperty`, `writeCommit`, `apply`, `undo`, `redo`, `drawDefaultEditor`, and `drawPropertyEditor`.

Bound trees also expose `loadChildren(property)` for truncated nodes. Array continuations use `arrayOffset` and a bounded page size, including arrays larger than 1024 elements. Resolved targets retain `globalObjectId`; preserve it when deriving another property path. `Long` and `UnsignedLong` values use exact decimal strings. Write responses provide authoritative `beforeSnapshot` and opaque `restoreState` data for history; do not reconstruct undo values from display text or truncated children. Native property editors embedded in a View share its editing workspace and undo history.

## Expanded Helper Exports

These are also available from `@locus/view-runtime` for custom renderers and advanced editors:

- Property tree: `InspectorProperty`, `PropertyTree`, `createPropertyTree`, `createInspectorPropertyTreeBinding`, `resolveInspectorDrawer`, `resolveManagedReferenceTypeOption`, `searchManagedReferenceTypeOptions`, `defineInspectorPropertyDrawers`, `createInspectorPropertyDrawerLibrary`, `publicInspectorPropertyDrawerLibrary`, `projectInspectorPropertyDrawerLibrary`, `normalizeInspectorPropertyDrawers`, `registerInspectorPropertyDrawer`, `registerInspectorValueDrawer`, `registerInspectorFieldDrawer`, `registerInspectorAttributeDrawer`, `registerInspectorPropertyPathDrawer`, `propertyTreeService`.
- Field presentation: `propertyFieldAccess`, `propertyFieldActions`, `propertyFieldActionDisabled`, `propertyFieldActionMutates`, `resolveInspectorFieldPresentation`. Types: `PropertyFieldPresentation`, `PropertyFieldScope`, `PropertyFieldContext`, `PropertyFieldValueState`, `PropertyFieldProvenance`, `PropertyFieldAction`, `PropertyFieldActionKind`, `InspectorFieldPresentationResolver`, `InspectorPropertyFieldAction`.
- Unity property binding: `UnityBoundProperty`, `UnityBoundPropertyTree`, `createUnityPropertyRuntime`, `unityBoundPropertySnapshots`.
- Unity value formatting: `normalizeUnityPropertyType`, `isUnityIntegerPropertyType`, `isUnityNumberPropertyType`, `isUnityVectorPropertyType`, `isUnityQuaternionPropertyType`, `unityVectorKeysForType`, `normalizeUnityOptions`, `unitySerializedValueToEditText`, `tryParseUnitySerializedEditValue`, `parseUnitySerializedEditValue`, `constrainUnityNumberValue`, `formatUnityNumberValue`, `formatUnityEnumValue`, `unityEnumIndexValue`, `unityEnumNumericValue`, `parseUnityVectorValue`, `formatUnityVectorValue`, `parseUnityQuaternionEulerValue`, `formatUnityQuaternionEulerValue`, `parseUnityColorValue`, `formatUnityColorValue`, `unityColorTextToRgbHex`, `applyUnityRgbHexToColorText`.
- Unity property target paths: `parseUnityPropertyPath`, `resolveUnityPropertyTarget`, `unityPropertyObjectTarget`, `unityPropertyTargetWithPath`, `unityPropertyTargetKey`.
- Object drawers: `defineUnityObjectDrawers`, `createUnityObjectDrawerLibrary`, `publicUnityObjectDrawerLibrary`, `projectUnityObjectDrawerLibrary`, `normalizeUnityObjectDrawers`, `resolveUnityObjectDrawer`, `registerUnityObjectDrawer`, `unityObjectDrawerService`.
- Object reference picker: `UNITY_OBJECT_REFERENCE_SEARCH_ROOTS`, `normalizeUnityObjectReferenceType`, `unityObjectReferenceTypeKey`, `unityObjectReferenceTypeHint`, `getUnityObjectReferenceTypeRule`, `unityObjectReferenceSearchQuery`, `normalizeUnityObjectReferencePath`, `unityObjectReferenceDisplayParts`, `unityObjectReferenceAssetKey`, `unityObjectReferenceValueForSearchResult`, `unityObjectReferenceExtension`, `isUnityObjectReferenceSearchResult`, `filterUnityObjectReferenceSearchResults`.

## Component Module

`@locus/components` exposes:

- `BaseButton`, `BaseCheckbox`, `BaseDropdown`, `BaseSegmented`, `BaseSwitch`.
- `PropertyField`: reusable field row with scope, inheritance/override chrome and capability-driven context menu.
- `CanvasView`, `GraphView`, `LinkBoard`, `SerializedTableView`.
- `UnityBoolField`, `UnityBoundsField`, `UnityColorField`, `UnityColorHdrField`, `UnityCurveField`, `UnityEnumField`, `UnityFlagsField`, `UnityGradientField`, `UnityLayerMaskField`, `UnityNumberField`, `UnityObjectReferenceField`, `UnityPropertyDraw`, `UnityPropertyEditor`, `UnitySerializedPropertyTree`, `UnityVectorField`.
- `UnityPropertyScope`, `UnityPropertyField`: component-driven object/value bindings with native editing.
- `UnityObjectPreview`, `UnityReferenceChip`, `UnityDropZone`.

`SerializedTableView` renders rows of Unity serialized cells with resizable columns, a progress/status bar, and per-cell editors. Props: `columns`, `rows`, `loading`, `status`, `error`, `progress`, `savingCellKey`, `sourceCount`, `columnWidths` (v-model). Events: `commit` (`SerializedTableCommitEvent`), `update:columnWidths`. The caller supplies data loading, commit handling and optional persistence.

`LinkBoard` renders source-to-target connections. Props: `sources`, `targets`, `modelValue` (v-model), optional `sourceTitle`, `targetTitle`, `readonly`, `multiple`. Endpoints are `{ id, label, disabled? }`; connections are `{ source, target }`. It handles selection, connection lines, resize and unlinking; the caller owns data and persistence. `components.md` contains composition examples for this and the existing editors. `locus.views.components()` lists the available native components.

`UnityCurveField` and `UnityGradientField` render AnimationCurve / Gradient previews; when given `editable` plus a `bindingTarget` (the property tree passes both automatically), clicking them opens the floating Locus value editor window, which owns its own preview/commit write-back and broadcasts `locus-value-editor:committed` on apply.

## Input units

`UnityNumberField`, `UnityVectorField`, `UnityBoundsField` and `UnityPropertyEditor` accept optional `unit?: string` (default empty):

```vue
<UnityNumberField :model-value="speed" unit="米/秒" aria-label="移动速度" @commit="saveSpeed" />
<UnityPropertyEditor :model-value="seconds" property-type="Float" unit="秒" @commit="saveSeconds" />
```

The unit is a muted suffix **inside the input border**, right-aligned and separate from editable text. Do not repeat it in a parenthesized label, a second line or a private overlay. Prefer short units (`m`, `m/s`, `°`, `s`, `帧`); explanatory text such as a 60 Hz timeline convention belongs in the tooltip. Long suffixes truncate in narrow controls, retain their full tooltip/accessibility description, and do not cover the value. Clicking the suffix focuses its input. Empty/whitespace-only units retain the plain input. Range fields decorate the numeric input, not the slider; vectors and bounds decorate each numeric component.

Units are **display-only**. They are not parsed, copied with the input value or sent as part of `commit`/`preview` values; precision, Long/UnsignedLong decimal strings, clamping, read-only state and Escape cancellation are unchanged. `unit="%"` does not multiply a ratio by 100; perform any desired conversion explicitly in the adapter. The single-line text fallback also supports units; Boolean, enum/flags, references, color/curve/gradient, Character and multiline text controls do not use them.

Property adapters can supply `unit` on `UnitySerializedPropertySnapshot` / `InspectorPropertySnapshot`. It is normalized onto `InspectorProperty.unit`, forwarded as `unit` to custom drawers, and used by the default tree and bound property editors. Units do not implicitly propagate from a generic parent object to unrelated children. `SerializedTableCell.unit` supplies the same suffix for table cells. No label parsing or Unity attribute inference is performed; an adapter maps its own domain units to the desired display string. The shared internal implementation is `src/components/ui/InputUnit.vue`.

## Field presentation

`PropertyField` (also available from `@locus/view-runtime`) decorates an existing editor without owning its value or writes. Props:

- `label`, optional `fieldKey` (stable owner + logical field identity), `showLabel` (default true), `tooltip`.
- `scope?: 'template-only' | 'instance-only' | 'template-and-instance'`; `context?: 'template' | 'instance'`.
- `provenance?: { state: 'local' | 'inherited' | 'overridden'; sourceLabel?: string; inheritedDisplayValue?: string; hasOverriddenChildren?: boolean }`.
- `actions?: PropertyFieldAction[]`; independent `readonly`, `disabled`, `busy`.

`template-only` is read-only in instance context; `instance-only` is hidden in template context. Missing scope/context preserves normal editing. Provenance never derives from value equality, dirty state or presence of an instance field: an equal-valued explicit override remains overridden. Template variants may also override their direct source. `overridden` gets a 2px bar; child-only summaries get a weaker bar. Source and inherited value live in the tooltip, accessible description and menu, not persistent badges. Theme knobs: `--property-override-color` (defaults to accent) and `--property-field-label-width`.

Slots: default receives `{ readonly, disabled }` (forward both to the editor), `label` customizes the label, `children` puts nested content below the marked row. `showLabel=false` lets a tree/custom drawer supply its own layout. Do not double-wrap editors already drawn by `UnitySerializedPropertyTree` or `UnityPropertyDraw`.

Actions are `{ id, kind, label, tooltip?, disabled?, disabledReason?, group?, quick?, mutates? }`. Kinds:

- `create-override`: only dual-scope inherited fields.
- `revert`, `apply-to-template`: only dual-scope overridden fields.
- `reset-default`: only include when the owner has a well-defined initial default.
- `inspect-source`: non-mutating, available in read-only mode.
- `custom`: mutating by default; `mutates:false` allows read-only inspection actions.

Actions from different `group` values are separated. At most the first `quick:true` action gets a hover/focus shortcut; the menu button reserves its width to avoid layout shifts. The context menu supports right-click, Shift+F10 / Menu key, arrow keys, Home/End and Escape. Menus use the owning document in popout/Unity-embedded windows. Read-only disables mutations, disabled/busy disables all actions; unsupported inheritance operations are omitted. Changing `fieldKey` closes a stale menu.

Standalone `@action` emits the current `PropertyFieldAction`. It **does not** write, confirm, apply, revert or reset anything. The owner must validate actual target identity/permissions again, set busy while executing, preserve Undo and errors, then refresh provenance. UI scope checks are not backend authorization. Distinguish these operations:

- Revert removes the explicit override and restores inheritance; copying the source value is not equivalent.
- Reset writes a defined initial default, potentially creating an override.
- Apply names its exact destination in `label`, confirms shared impact, and updates that source plus removes the current override as one undoable operation. Never clear an override before the source write succeeds; preserve other instances' overrides.
- Program/shared-asset overrides and native Prefab overrides are separate adapters. Do not choose a Prefab operation merely because a field is styled as overridden.

### Unity trees and drawers

The default list editor keeps scalar/reference values inline and renders complex elements as collapsible summary rows. It includes paging (10 items by default), loaded-item search, keyboard/pointer ordering, insert/duplicate menus, and an explicit item-count form. Filtering and paging retain original array indices. Expansion/page state is scoped to the target and property path in the current window; property refreshes retain it. Use the shared editor instead of rebuilding list controls in each View.

The live Unity bridge reads optional Odin `ListDrawerSettings` (paging, index/count visibility, structural read-only, add/remove visibility, default expansion, default insertion and copy-last), `ListElementLabelName` field/property getters, `FoldoutGroup`, and simple field/property `ShowIf`/`HideIf` conditions. Presentation travels in snapshot `attributes`; preserve these when localizing snapshots. Unknown expressions stay visible. Odin expression evaluation, IMGUI callbacks, and custom add/remove methods are not executed. YAML-only snapshots without live metadata retain the generic list editor and explicit creation-data requirements.

List commands preserve the existing commit/undo path. `duplicate` copies an authoritative backend element, including unloaded/hidden fields; managed-reference graphs require an explicit graph copy and are excluded from this shortcut. Live `insert` with `initialize: true` creates initial values instead of implicitly copying an adjacent element. Live object-reference lists offer the existing resource picker and accept batched asset drops via `insertReferences`; the backend checks all references before inserting any. Reuse `loadChildren` for partial lists rather than reconstructing array values from loaded children.

`UnitySerializedPropertyTree` and `UnityPropertyDraw` accept `fieldPresentation: (property: InspectorProperty) => PropertyFieldPresentation | null | undefined` and emit `fieldAction: { action, propertyPath, property, snapshot }`. The resolver runs for exact nodes, including nested arrays and custom drawers; use the snapshot/bound object's target identity, not a property path alone, when processing an action. Revalidate stable business IDs after array changes.

The same options are supported by raw `InspectorProperty.draw(...)` and bound `draw(...)`, `drawDefaultEditor(...)`, `drawPropertyEditor(...)` as `fieldPresentation` and `onFieldAction`. Example:

```ts
const editor = tree.drawDefaultEditor({
  fieldPresentation: resolveFieldPresentation, // supplied by this View's adapter
  onFieldAction: handleFieldAction,             // supplied by this View's owner
});
```

Snapshots may carry `fieldPresentation`. Precedence: resolver result > snapshot metadata > native `prefabOverride` / `isPrefabInstance` / `prefabSource` metadata. Resolver `undefined` falls back; `null` explicitly suppresses native decoration for that node. Existing native override flags automatically produce markers, **not** inferred mutation capabilities or destination targets. Missing native source metadata remains unknown, rather than guessed. Native summaries inspect loaded children only; an adapter should supply `hasOverriddenChildren` when it knows about unloaded descendants. Refresh metadata after writes, Undo/Redo, template changes and selection changes.

Low-level value controls (`UnityNumberField`, `UnityPropertyEditor`, etc.) remain provenance-agnostic. Direct programmatic `property.write(...)` remains an explicit owner operation; scope guards affect render/commit paths, not the underlying transport API. Exact exported contracts live under `app/view-runtime/src/components/property-field/` and `src/services/propertyTree.ts`.

## Plugin Drawer Packages

Locus plugins can ship `drawers/<drawer-id>/` packages that extend the in-app Inspector/property rendering (chat property fences, the Locus Inspector window, diff panes, and Views) in every Locus window — unlike per-View `propertyDrawers` props, these apply app-wide.

- Manifest: `drawer.json` with `{ "id", "entry" }`; `entry` defaults to `src/index.ts`. Declared in `locus.plugin.json` under `components.drawers` (or discovered from the `drawers/` directory).
- The entry runs once per window against `@locus/drawer-runtime`, a deliberately small runtime: `meta` (`pluginId`, `pluginName`, `drawerId`), `components` (same map as `@locus/components`), `propertyDrawer` (`register`, `registerValue`, `registerField`, `registerAttribute`, `registerPropertyPath`, `define`), `unityObjectDrawer` (`register`, `registerExtension`, `define`). No fs/session/llm surface.
- Allowed imports: `vue`, `@locus/components`, `@locus/drawer-runtime`, and relative `.ts`/`.js`/`.vue`/`.css`/`.json` files inside the package.
- Resolution priority: explicit `propertyDrawers` props > View/project registrations (`propertyDrawer.register*` from View code) > plugin drawer packages > built-in editors. A drawer that throws is isolated per property row and falls back to a raw value display.
- Limits: at most 64 files and 512 KB per file per package; registrations are removed automatically when the plugin is disabled or uninstalled.

## Agent Tools

The View skill grants the single `execute_typescript` TypeScript tool. It exposes the shared native frontend SDK; see `frontend-sdk.md`.

Debugging uses the same SDK and tool as authoring. `debug.md` contains the inspection workflow.

## Usage Guidance

### Component-driven data requirements

Import `UnityPropertyScope` and `UnityPropertyField` from `@locus/components`. A scope inherits the owning View's Live runtime, or accepts an explicit `runtime`; `target` is a resolved property path/target (nested scopes inherit it), `readonly` is inherited, and `maxDepth`/`maxArrayItems` default to 4/8. Each field's `path` is relative to its scope target. Fields register only when mounted; no separate resource/field manifest is required.

`property.bind(target, options?)` returns a **lazy shared resource**, with `tree`, `property`, `value`, `loading`, `error`, `write(value, options?)`, `refresh()` and `retain()` (returns an idempotent release). `UnityPropertyField :binding="resource"` owns retain/release automatically. `useUnityPropertyBinding(() => path)` does the same for custom controls inside a scope and exposes computed value/loading/error/read-only state plus write/refresh. A field slot exposes plain `value/loading/error/readonly` and write/refresh functions. Do not fetch or clone a second editable value store.

Live display demands are grouped by object identity. The owning View keeps a bounded object-value cache (128 objects), while static field Schema is shared separately within that runtime. Ordinary ScriptableObject/component fields use compact value snapshots and revision-based deltas; Unity API access remains on the main thread, and only captured managed DTO encoding runs off-thread. The frontend projects each field's requested depth/array range from the shared object. Insufficient coverage, paged arrays, compound/specialized roots, managed-reference graphs, runtime objects and older bridges keep the existing authoritative reader; unsupported is not a reason to switch to YAML. No value cache crosses checkout, backend or View lifetime boundaries.

Declarative resources still retain at most 128 inactive binding candidates (active subscribers are never evicted). Contiguous Editor change notifications invalidate affected object identities; missing events, Undo/Redo, domain/structural/project changes conservatively invalidate the necessary wider scope. Hidden Views revalidate on return without clearing mounted values. Custom setters that bypass Unity change notifications must call `property.invalidate(target)`. Unresolved `selection` cannot be retained; resolve its identity first. Runtime Play Mode values require explicit refresh; pass persistent-edit read-only rules through the scope.

`property.invalidate(target?)` refreshes matching active resources after a custom domain command; `property.observeDataVersion(version, changes?)`, `property.setActive(active)` and `property.dispose()` are lifecycle services normally managed by the host. Do not invoke them per render. View-runtime `readTree/fromPath/readProperty` also reuse eligible object snapshots; use `tree.refresh()` or a resource's `refresh()` for an authoritative reread. Agent-side `locus.unity.property.read()` remains a fresh explicit operation. This does not pre-mount unopened pages, infer arbitrary TypeScript dependencies, or switch a Live scope silently to disk YAML.

### Continuous property editing

Use bound `property.fromPath()` / `readTree()` editors for interactive forms. A scalar commit updates the local draft immediately and merges the backend's actual value on acknowledgement; it does not reread unrelated fields or remount the page. Field validation (`refreshObject`), structural commands, or an explicit `{refresh:true}` retain a conservative refresh. `{refresh:false}` prevents the follow-up read, not receipt reconciliation. `tree.pending` and `tree.error` expose status without disabling input. Failed scalar drafts remain available for correction; do not silently discard them on an earlier failed response.

View writes serialize with Undo/Redo. Live previews share this queue with the final commit: previews may coalesce with adjacent previews, but never with a commit, and do not add Undo records. Adjacent queued scalar assignments to the same target may supersede one another; all callers receive the last assignment's receipt. In-flight work is never cancelled, different targets and structural/history operations are ordering barriers, and `{coalesce:false}` preserves every intermediate assignment when required. Undo uses the authoritative `beforeSnapshot` captured by the backend, not an extra pre-read. Bound YAML trees serialize their revision advancement; after a failed/uncertain write they require an explicit fresh root read before another write.

Do not disable a form while saving, use an early `if (saving) return` to drop input, increment Vue keys after a commit, or unconditionally `await tree.refresh()` after every scalar edit. Custom project side effects should report their own status and explicitly invalidate affected objects. Persistence and derived Unity/Baking completion are not the same as accepting user input.

Ordinary committed scalar writes return a compact incremental receipt, patch the owning object cache and retain the authoritative `beforeSnapshot` for Undo. Preview, structural, validation-dependent and unsupported writes keep their existing safe path. No timeout or uncertain mutation is replayed through a fallback. New Live commit receipts distinguish `applied:true` from `persisted:false`: they changed Unity memory but did not save the asset. `saved` remains a legacy acknowledgement flag, not proof of disk persistence. Do not add per-field Save/Import calls to make the input responsive.

Identical legacy in-flight reads still share a request and distinct same-turn requests use bounded batches; this fallback coordinator does not cache values. The separate object-value store owns freshness. Use returned stable object targets for queued edits.

### Property backend and deferred writes

Select the backend once in View code, using the shared SDK. Controls and bound
trees inherit that selection; do not add mode selectors to individual controls.
Existing `property` calls continue to use Unity's main-thread API.

```ts
import { locus } from "@locus/frontend";

const properties = locus.unity.property.backend("yaml"); // "live" = Unity API (default)
const target = { kind: "asset", path: "Assets/Data.asset", targetFileId: "11400000" };
const tree = await properties.readTree(target);
// tree.drawDefaultEditor() reuses the existing Property Tree controls.
// Numeric drag preview stays local; committing a field persists its YAML.

const before = await properties.read({ target });
const batch = properties.batch();
batch.enqueue({ target: { ...before.target, propertyPath: "amount" }, value: 42,
  expectedRevision: before.revision });
batch.enqueue({ target: { ...before.target, propertyPath: "note" }, value: "updated",
  expectedRevision: before.revision });
await batch.flush();
await tree.refresh();
```

- `backend()` returns an independent instance; it does not switch existing trees
  or batches. Requests and controls have no backend parameter. `read`, `write`,
  `apply`, `readTree` and `batch` retain the instance's workspace and lifetime.
- YAML reads project persisted serialized values into Property Tree snapshots.
  They do not reproduce Editor-only attributes, enum choices, specialized
  Editor floating Curve/Gradient editors or all synthetic headers. Text Prefab
  effective values are resolved recursively through the shared dependency graph.
  Reference slots are displayed read-only; existing managed-reference children can
  be read and written through logical paths such as `node.next.amount`. Shared/cyclic
  objects retain host-scoped identity. Explicit API writes accept serialized
  `{fileID, guid, type}` / `{rid}` values. `property.discover({target,query})` returns
  effective matches with exact `target` IDs, including virtual Prefab objects.
  Raw serialized discovery remains available on `locus.assets.backend("yaml")`.
- YAML targets require an `Assets/` path and exact persisted `targetFileId` for
  multi-object assets. Use the returned `bindingTarget`; selection, runtime IDs,
  and hierarchy/component locators require `live`.
- YAML direct writes require `expectedRevision` from a YAML read. A bound tree
  manages its own revision. Prefab reads also return `dependencies` and `prefabLayers`;
  direct writes must include `expectedDependencies: read.dependencies`. Trees track
  source revisions automatically. Stale data is rejected; refresh before retrying.
  `writeMode` remains `commit/preview` for the live API and is independent of backend.
  YAML direct writes support `commit`; bound numeric previews do not issue IPC.
- Enqueueing performs no IO. `flush()` submits one `apply_properties` request; Rust
  resolves the logical paths against the evolving graph and compiles ordered
  operations into one existing asset transaction. The frontend does not parse YAML.
  While Unity is connected, that transaction performs one main-thread preflight
  and coordinated import pass. It does not use `SerializedProperty` setters for
  YAML editing. With Unity closed, it writes offline without starting Unity.
  This is not a guarantee that importing/OnValidate has no main-thread cost.
- A batch supports up to 256 files / 10,000 edits. Repeated flush calls share the
  in-flight promise. A failed batch cannot replay automatically: inspect its outcome,
  `clear()`, reread and rebuild. `live` apply may report partial success; it is not
  the same rollback contract as the YAML transaction.
- YAML schema/reference discovery uses the checkout's existing asset database (GUID/path, duplicate GUIDs and script class candidates). A bounded four-checkout cache shares immutable discovery maps; database/WAL identity and generation changes invalidate it. It keeps no SQLite connection open across requests, and resolves only consumed Prefab GUIDs on the property hot path. This is not an asset-value cache or proof that the filesystem watcher has finished indexing a new file. Current source/meta bytes still determine types and dependency revisions. Consumed metadata that no longer matches its indexed GUID fails with `property.stale_asset_index`; refresh the asset database rather than bypassing the conflict. Missing/unusable databases retain the standalone filesystem scan fallback. Neither path uses the asset index as a substitute for dirty checks or current serialized values.
- For read profiling, use `yaml.read({target, profile:true})`. Its optional `profile` includes `totalMs`, `indexSource`, `indexLoadMs`, `fullProjectScans` and projection counters. The indexed hot path does not walk Assets/Packages or read all meta files.
- For profiling, use `yaml.apply({writes, profile:true})`. The optional response
  `profile` contains `prepareMs`, `commitMs`, `projectionMs`, `totalMs`, `indexSource`, `indexLoadMs`, `fullProjectScans`,
  `effectiveBuilds`, `treeBuilds`, `overrideValidationPasses`, `materializedCompilePasses`, `readProjections`
  and byte-changing `changedFiles`. When connected, `profile.editor` separates
  Unity `preflightMs`, `writeMs`, `importMs` and `changedFiles`; offline it is null.
  Timings exclude frontend IPC serialization. No UI or global setting is required.
  For bulk scripts that do not need per-write snapshots, use
  `yaml.apply({writes, resultMode:"summary", profile:true})`. This returns
  `{ok,message,writesApplied,transactionId,assets:[{path,revision,dependencies}],profile?}`
  and skips Tree/beforeSnapshot projection while retaining identical validation and
  transaction guards. Use each asset's returned revision/dependencies for later writes.
  The default full response and `batch().flush()` are unchanged; live rejects summary.
  Materialized writes and inherited scalar runs share phase snapshots and validation; commands
  such as Revert/Apply/creation are ordering barriers. Always retain every returned
  dependency, including source `.cs` and `.cs.meta` evidence.
- YAML array commands support `resize`, `insert`, `delete`, `move`; growing and
  inserting need an explicit fill `value`. Whole-array values are also accepted.
  These commands also support inherited arrays and nested inline object lists.
  Existing size overrides on empty source arrays require a source-proven element
  schema. The batch compiles ordered edits into final size/leaf overrides.
  Unity's implicit element construction/type creation and restore commands are
  not emulated. Use `live` for those Inspector interactions.
- YAML authoring commands are values sent through the same `write/apply/batch` API:
  `{action:"revert"}` removes the current property override subtree, including array sizes/elements;
  `{action:"applyToSource",level:1}` applies to the next source layer and clears
  crossed overrides. `prefabLayers.length` applies to the materialized base.
  Whole-array Apply is supported when it needs no non-null local object/rid remapping.
  For a nested array whose containing element does not exist at the destination,
  apply an outer array that exists there. Existing inherited managed leaves use
  host-scoped registry identity, including aliases such as `node.next.amount`.
  `{action:"createManaged",template:{rootRid,entries:[{rid,type:{class,ns,asm},data}]}}`
  creates/replaces a materialized host slot using complete explicit data. Template
  rid labels are remapped, cycles preserved and old aliases retained. Missing,
  ambiguous, non-Serializable, abstract, generic or incompatible types are rejected.
  Use the exact Unity registry identity: nested classes use `Outer/Inner`, not `Outer.Inner`
  or CLR `Outer+Inner`. Property writes require source or supported built-in type evidence;
  partial, conditional or unavailable schemas fail with `property.schema_unverified`.
  The raw asset API remains a structural API with diagnostics, not an equivalent type guarantee.
  `{action:"editObjects",add:[{id,classId,rootType,data}],remove:[id],updates:[{objectId,propertyPath,value}]}`
  edits materialized object topology as one validated candidate. IDs must be exact
  strings; supported templates are GameObject, Transform, RectTransform and MonoBehaviour.
- Curves/gradients accept the standard live value payload in programmatic YAML
  writes. Their default YAML Tree previews remain read-only because the floating
  editor owns a live writer. Existing Prefab added/removed components and children
  are projected with ownership and instance identity, so their fields can be edited.
  Authoring topology on inherited objects, inherited managed creation/array structure,
  cross-layer reference Apply and nonfinite curve tangents remain unsupported.
  No implicit fallback, constructor or business-callback execution is provided;
  implement view-specific validation/derived values in the View.
- Bulk operations already expressed as raw asset operations can use
  `const batch = locus.assets.backend("yaml").batch()`, then
  `batch.enqueue(path, operations, {expected_revision})` and `await batch.flush()`.
  This bypasses logical Property Tree resolution. Keep draft UI state local and
  flush on explicit Apply, input commit or the end of a bulk job.

Start with `view`, `unity`, `property`, and components from `@locus/components`. Reach for the expanded helper exports only when custom rendering or value parsing requires them.

`session` covers the full session lifecycle: alongside `create`/`chat`/`wait`, it exposes `fork`/`forkFromMessage`, `list`/`listArchived`, `rename`, `archive`/`unarchive`, `delete`, and conversation-history `undo`/`rollback`. These operate on any session id in the current workspace — there is no per-View ownership scoping, so a View can manage sessions it did not create. `delete`, `undo`, and `rollback` are destructive and irreversible; confirm intent (and prefer `archive` for cleanup) before calling.

`useViewContext()` provides the editor-bound workspace, active ref, lifetime signal and onDispose(). `useViewState(initial, stableKey)` retains editor state across source updates. Hot-updating CSS preserves the component instance; script/template updates remount the affected View.
