/// <reference lib="es2021.weakref" />
import { h, markRaw, shallowReactive, type VNodeChild } from "vue";
import {
  createInspectorPropertyTreeBinding,
  createPropertyTree,
  resolveInspectorFieldPresentation,
  type InspectorFieldPresentationResolver,
  type InspectorPropertyFieldAction,
  type InspectorProperty,
  type InspectorPropertyCommit,
  type InspectorPropertyDrawerInput,
  type InspectorPropertySnapshot,
  type InspectorPropertyTreeBindingInput,
  type InspectorPropertyTreeOptions,
  type InspectorPropertyTreeSnapshotInput,
  type PropertyTree,
} from "../../services/propertyTree";
import type { UnitySerializedPropertyTarget, UnityPropertyDataChanges } from "../../services/unitySerializedProperty";
import { createUnityPropertyResources, type UnityPropertyResource } from "./unityPropertyResources";
import { isCoalesciblePropertyValue } from "../../services/propertyEditQueue";
import {
  resolveUnityPropertyTarget,
  unityPropertyObjectTarget,
  unityPropertyTargetWithPath,
  unityPropertyTargetKey,
  type UnityPropertyPathTargetKind,
} from "../../services/unityPropertyPath";
import PropertyField from "../property-field/PropertyField.vue";
import { propertyFieldAccess, type PropertyFieldAction } from "../property-field/propertyField";
import UnityPropertyEditor from "./UnityPropertyEditor.vue";
import UnitySerializedPropertyTree from "./UnitySerializedPropertyTree.vue";
import type { UnitySerializedPropertyCommitEvent } from "./unitySerializedValue";

export type UnityPropertyWriteMode = "commit" | "preview";
export type UnityPropertyPathInput = string | UnitySerializedPropertyTarget;
export type { UnityPropertyPathTargetKind };

export interface UnityBoundPropertyReadRequest {
  /** Explicit refresh bypasses the object value cache. */
  force?: boolean;
  arrayOffset?: number | null;
  bindingId?: string | null;
  target: UnitySerializedPropertyTarget;
  maxDepth?: number | null;
  maxArrayItems?: number | null;
}

export interface UnityBoundPropertyWriteRequest {
  bindingId?: string | null;
  target: UnitySerializedPropertyTarget;
  value: unknown;
  writeMode?: UnityPropertyWriteMode | null;
}

export interface UnityBoundPropertyApplyWrite {
  bindingId?: string | null;
  target: UnitySerializedPropertyTarget;
  value: unknown;
  writeMode?: UnityPropertyWriteMode | null;
}

export interface UnityBoundPropertyApplyRequest {
  writes: UnityBoundPropertyApplyWrite[];
}

export interface UnityBoundPropertyReadResult extends InspectorPropertySnapshot {
  dataVersion?: string;
  dependencyObjectIds?: string[];
  conservativeInvalidation?: boolean;
  /** Local adapter read overlapped a newer mutation; do not reconcile it. */
  stale?: boolean;
  ok?: boolean;
  bindingId?: string | null;
  message?: string;
  target?: UnitySerializedPropertyTarget | null;
  properties?: InspectorPropertySnapshot[];
}

export interface UnityBoundPropertyWriteResult extends UnityBoundPropertyReadResult {
  saved?: boolean;
  applied?: boolean;
  persisted?: boolean;
  /** Unity validation may have modified sibling fields. */
  refreshObject?: boolean;
}

export interface UnityBoundPropertyApplyResult {
  ok: boolean;
  message?: string;
  results: UnityBoundPropertyWriteResult[];
}

export interface UnityBoundPropertyWriteOptions {
  coalesce?: boolean;
  label?: string;
  undoable?: boolean;
  beforeSnapshot?: InspectorPropertySnapshot | null;
  refresh?: boolean;
  onApplied?: (result: UnityBoundPropertyWriteResult) => void | Promise<void>;
}

export interface UnityBoundPropertyApplyOptions {
  label?: string;
  undoable?: boolean;
  refresh?: boolean;
  onApplied?: (result: UnityBoundPropertyApplyResult) => void | Promise<void>;
}

export interface UnityBoundPropertyRuntimeAdapter {
  invalidate?(target?: UnitySerializedPropertyTarget): void;
  read(request: UnityBoundPropertyReadRequest): Promise<UnityBoundPropertyReadResult>;
  write(
    request: UnityBoundPropertyWriteRequest,
    options?: UnityBoundPropertyWriteOptions,
  ): Promise<UnityBoundPropertyWriteResult>;
  apply(
    request: UnityBoundPropertyApplyRequest,
    options?: UnityBoundPropertyApplyOptions,
  ): Promise<UnityBoundPropertyApplyResult>;
  undo?: () => unknown | Promise<unknown>;
  redo?: () => unknown | Promise<unknown>;
}

export interface UnityBoundPropertyRuntimeOptions {
  idPrefix?: string;
  maxDepth?: number;
  maxArrayItems?: number;
  treeOptions?: Omit<InspectorPropertyTreeOptions, "id" | "targetId">;
}

export interface UnityBoundPropertyDrawOptions {
  fieldPresentation?: InspectorFieldPresentationResolver;
  onFieldAction?: (event: InspectorPropertyFieldAction) => void;
  propertyDrawers?: InspectorPropertyDrawerInput;
  disabled?: boolean;
  readonly?: boolean;
  compact?: boolean;
  showLabel?: boolean;
  writeMode?: UnityPropertyWriteMode;
  onCommit?: (event: UnitySerializedPropertyCommitEvent) => void;
  onPreview?: (event: UnitySerializedPropertyCommitEvent) => void;
}

function normalizeBindingId(target: UnitySerializedPropertyTarget, prefix = "unity-property"): string {
  // Tag every field (including file ids) so distinct targets can never share a binding id,
  // e.g. {path: "X"} vs {scenePath: "X"} or two sub-objects differing only by fileId.
  const parts = [
    `id=${target.globalObjectId ?? ""}`,
    `k=${target.kind}`,
    `g=${target.guid ?? ""}`,
    `p=${target.path ?? ""}`,
    `s=${target.scenePath ?? ""}`,
    `o=${target.objectPath ?? ""}`,
    `of=${target.objectFileId ?? 0}`,
    `tf=${target.targetFileId ?? 0}`,
    `c=${target.componentType ?? ""}`,
    `ci=${target.componentIndex ?? 0}`,
  ]
    .join(":")
    .replace(/\s+/g, " ")
    .trim();
  return `${prefix}:${parts}`;
}

function warnUnityPropertyWriteFailure(error: unknown) {
  console.warn("[unityPropertyBinding] serialized property write failed:", error);
}

function snapshotList(
  input: InspectorPropertyTreeSnapshotInput | null | undefined,
): InspectorPropertySnapshot[] {
  if (!input) return [];
  return Array.isArray(input) ? input : [input];
}

function snapshotsFromReadResult(result: UnityBoundPropertyReadResult): InspectorPropertyTreeSnapshotInput {
  return Array.isArray(result.properties) && result.properties.length
    ? result.properties
    : result;
}

function snapshotTarget(snapshot: InspectorPropertySnapshot): UnitySerializedPropertyTarget | null {
  return (snapshot.bindingTarget ?? snapshot.target ?? null) as UnitySerializedPropertyTarget | null;
}

function eventFromCommit(
  commit: InspectorPropertyCommit,
  target: UnitySerializedPropertyTarget,
): UnitySerializedPropertyCommitEvent {
  return {
    propertyPath: commit.propertyPath,
    value: commit.value,
    property: commit.snapshot as UnitySerializedPropertyCommitEvent["property"],
    target,
    writeMode: "commit",
  };
}

function propertyType(property: InspectorProperty): string {
  return property.valueType || property.type || "String";
}

function writeOptionsFromDrawOptions(_options: UnityBoundPropertyDrawOptions): UnityBoundPropertyWriteOptions {
  return {};
}

export class UnityBoundProperty {
  readonly tree: UnityBoundPropertyTree;
  private readonly initialProperty: InspectorProperty;

  get raw(): InspectorProperty {
    return this.tree.resolveProperty(this.initialProperty) ?? this.initialProperty;
  }

  constructor(tree: UnityBoundPropertyTree, raw: InspectorProperty) {
    this.tree = tree;
    this.initialProperty = raw;
  }

  get propertyPath(): string {
    return this.raw.propertyPath;
  }

  get value(): unknown {
    return this.raw.value;
  }

  get target(): UnitySerializedPropertyTarget {
    return this.tree.targetForProperty(this.raw);
  }

  createCommit(value: unknown): InspectorPropertyCommit {
    return this.raw.createCommit(value);
  }

  async write(value: unknown, options: UnityBoundPropertyWriteOptions = {}) {
    const result = await this.tree.writeProperty(this.raw, value, options);
    return result;
  }

  async preview(value: unknown, options: Omit<UnityBoundPropertyWriteOptions, "refresh"> = {}) {
    return this.tree.writeProperty(this.raw, value, {
      ...options,
      refresh: false,
      undoable: false,
    }, "preview");
  }

  async undo() {
    await this.tree.undo();
  }

  async redo() {
    await this.tree.redo();
  }

  drawDefaultEditor(options: UnityBoundPropertyDrawOptions = {}): VNodeChild {
    return this.tree.drawPropertyEditor(this.raw, options);
  }

  draw(options: UnityBoundPropertyDrawOptions = {}): VNodeChild {
    return this.raw.draw({
      drawers: options.propertyDrawers,
      fieldPresentation: options.fieldPresentation,
      onFieldAction: options.onFieldAction,
      disabled: options.disabled,
      readonly: options.readonly,
      compact: options.compact,
      showLabel: options.showLabel,
      onCommit: (commit) => {
        const target = this.tree.targetForProperty(commit.property);
        const event = eventFromCommit(commit, target);
        if (options.writeMode === "preview") {
          event.writeMode = "preview";
          options.onPreview?.(event);
          void this.preview(commit.value).catch(warnUnityPropertyWriteFailure);
          return;
        }
        options.onCommit?.(event);
        void this.tree.writeCommit(commit, writeOptionsFromDrawOptions(options))
          .catch(warnUnityPropertyWriteFailure);
      },
    });
  }
}

export class UnityBoundPropertyTree {
  readonly adapter: UnityBoundPropertyRuntimeAdapter;
  readonly bindingId: string;
  readonly target: UnitySerializedPropertyTarget;
  private readonly readTarget: UnitySerializedPropertyTarget;
  readonly options: UnityBoundPropertyRuntimeOptions;
  dataVersion?: string;
  dependencyObjectIds: string[] = [];
  conservativeInvalidation = false;
  private readonly state: { snapshots: InspectorPropertyTreeSnapshotInput | null; raw: PropertyTree; pending: number; error: string };
  private editSequence = 0;
  private readSequence = 0;
  private readonly appliedSequences = new Map<string, number>();
  private readonly drafts = new Map<string, { sequence: number; target: UnitySerializedPropertyTarget; snapshot: InspectorPropertySnapshot }>();
  get pending() { return this.state.pending; }
  get error() { return this.state.error; }
  get snapshots() { return this.state.snapshots; }
  get raw() { return this.state.raw; }

  constructor(
    adapter: UnityBoundPropertyRuntimeAdapter,
    target: UnitySerializedPropertyTarget,
    snapshots: InspectorPropertyTreeSnapshotInput | null,
    options: UnityBoundPropertyRuntimeOptions = {},
  ) {
    this.adapter = adapter;
    this.readTarget = { ...target };
    this.target = unityPropertyObjectTarget(target);
    this.bindingId = normalizeBindingId(this.target, options.idPrefix);
    this.options = options;
    this.state = shallowReactive({ snapshots, raw: this.createTree(snapshots), pending: 0, error: "" });
    markRaw(this);
  }

  dependsOn(objectIds: Set<string>) {
    return this.conservativeInvalidation || this.dependencyObjectIds.some(id => objectIds.has(id)) ||
      this.raw.properties.some(property => {
        const snapshot = property.snapshot;
        return !!snapshot.referenceTarget?.globalObjectId && objectIds.has(snapshot.referenceTarget.globalObjectId) ||
          snapshot.attributes?.some(attribute => /(?:ShowIf|HideIf|ListDrawerSettings)Attribute$/.test(attribute.type ?? ""));
      });
  }

  resolveProperty(property: InspectorProperty): InspectorProperty | null {
    const target = unityPropertyTargetKey(this.targetForProperty(property));
    return this.raw.properties.find((candidate) => candidate.propertyPath === property.propertyPath
      && unityPropertyTargetKey(this.targetForProperty(candidate)) === target) ?? null;
  }

  get root(): UnityBoundProperty | null {
    return this.raw.rootProperty ? new UnityBoundProperty(this, this.raw.rootProperty) : null;
  }

  get properties(): UnityBoundProperty[] {
    return this.raw.properties.map((property) => new UnityBoundProperty(this, property));
  }

  require(propertyPath: string): UnityBoundProperty {
    return new UnityBoundProperty(this, this.raw.requireProperty(propertyPath));
  }

  get(propertyPath: string): UnityBoundProperty | null {
    const property = this.raw.getProperty(propertyPath);
    return property ? new UnityBoundProperty(this, property) : null;
  }

  targetForProperty(property: InspectorProperty): UnitySerializedPropertyTarget {
    const target = snapshotTarget(property.snapshot)
      ?? snapshotTarget(property.root.snapshot)
      ?? this.target;
    return unityPropertyTargetWithPath(target, property.propertyPath);
  }

  /** Merge one authoritative field without rereading unrelated objects. Object
   * identity is part of the key: two components may have identical field paths. */
  private patch(target: UnitySerializedPropertyTarget, value: InspectorPropertySnapshot): boolean {
    const key = unityPropertyTargetKey(target);
    let found = false;
    const replace = (snapshot: InspectorPropertySnapshot, owner = this.target): InspectorPropertySnapshot => {
      const current = snapshotTarget(snapshot) ?? owner;
      if (unityPropertyTargetKey(unityPropertyTargetWithPath(current, snapshot.propertyPath)) === key) {
        found = true;
        return { ...snapshot, ...value, propertyPath: snapshot.propertyPath,
          bindingTarget: snapshot.bindingTarget ?? value.bindingTarget };
      }
      if (!snapshot.children?.length) return snapshot;
      const children = snapshot.children.map(child => replace(child, current));
      return children.some((child, index) => child !== snapshot.children![index]) ? { ...snapshot, children } : snapshot;
    };
    const snapshots = Array.isArray(this.snapshots) ? this.snapshots.map(root => replace(root))
      : this.snapshots ? replace(this.snapshots) : null;
    if (found) { this.state.snapshots = snapshots; this.state.raw = this.createTree(snapshots); }
    return found;
  }

  private restoreDrafts() {
    for (const draft of this.drafts.values()) this.patch(draft.target, draft.snapshot);
  }

  /** Reconcile a sibling binding's receipt without losing this tree's drafts. */
  reconcileReceipt(result: UnityBoundPropertyWriteResult) {
    if (!result.target || result.ok === false) return;
    if (this.patch(result.target, result)) {
      ++this.editSequence;
      this.restoreDrafts();
    }
  }

  async refresh() {
    const read = ++this.readSequence;
    const edit = this.editSequence;
    // Revalidation must not collapse an already expanded array back to its
    // initial eight-item page (and unmount a field being edited).
    const initialBudget = this.options.maxArrayItems ?? 64;
    let visibleBudget = initialBudget;
    for (const property of this.raw.properties) if (property.isArray)
      visibleBudget = Math.max(visibleBudget, Math.min(1024, property.children.length));
    const result = await this.adapter.read({
      bindingId: this.bindingId,
      target: this.readTarget,
      force: true,
      maxDepth: this.options.maxDepth,
      maxArrayItems: visibleBudget > initialBudget ? visibleBudget : this.options.maxArrayItems,
    });
    if (result.ok === false) throw new Error(result.message || "Failed to read Unity properties.");
    // A read dispatched before a newer edit must not revert that edit.
    if (result.stale || read !== this.readSequence || edit !== this.editSequence) return this;
    this.state.snapshots = snapshotsFromReadResult(result);
    this.dataVersion = result.dataVersion;
    this.dependencyObjectIds = result.dependencyObjectIds ?? [];
    this.conservativeInvalidation = result.conservativeInvalidation ?? false;
    this.state.raw = this.createTree(this.snapshots);
    this.restoreDrafts();
    return this;
  }

  async loadChildren(property: InspectorProperty) {
    const edit = this.editSequence;
    const target = this.targetForProperty(property);
    const arrayOffset = property.isArray ? property.children.length : 0;
    const result = await this.adapter.read({
      bindingId: this.bindingId, target,
      maxDepth: Math.min(16, Math.max(4, (this.options.maxDepth ?? 4) * 2)),
      maxArrayItems: Math.min(1024, Math.max(128, property.children.length * 2)),
      arrayOffset,
    });
    if (result.ok === false) throw new Error(result.message || "Failed to read Unity properties.");
    if (result.stale || edit !== this.editSequence) return;
    if (property.isArray && result.arraySize !== property.arraySize) { await this.refresh(); return; }
    const loaded = arrayOffset ? { ...result, children: [...property.children.map((child) => child.snapshot), ...(result.children ?? [])], visibleChildCount: property.children.length + (result.children?.length ?? 0) } : result;
    const key = unityPropertyTargetKey(target);
    const replace = (snapshot: InspectorPropertySnapshot, owner = this.target): InspectorPropertySnapshot => {
      const current = snapshotTarget(snapshot) ?? owner;
      if (unityPropertyTargetKey(unityPropertyTargetWithPath(current, snapshot.propertyPath)) === key) return loaded;
      return { ...snapshot, children: snapshot.children?.map((child) => replace(child, current)) };
    };
    this.state.snapshots = Array.isArray(this.snapshots) ? this.snapshots.map((root) => replace(root)) : this.snapshots ? replace(this.snapshots) : null;
    this.state.raw = this.createTree(this.snapshots);
  }

  async writeProperty(
    property: InspectorProperty,
    value: unknown,
    options: UnityBoundPropertyWriteOptions = {},
    mode: UnityPropertyWriteMode = "commit",
  ) {
    const commit = property.createCommit(value);
    return this.writeCommit(commit, options, mode);
  }

  async writeCommit(
    commit: InspectorPropertyCommit,
    options: UnityBoundPropertyWriteOptions = {},
    mode: UnityPropertyWriteMode = "commit",
  ) {
    const target = this.targetForProperty(commit.property);
    const key = unityPropertyTargetKey(target);
    const sequence = ++this.editSequence;
    const scalar = isCoalesciblePropertyValue(commit.value) && commit.property.isLeaf;
    if (scalar) {
      const draft = { ...commit.snapshot, value: commit.value, displayValue: String(commit.value ?? "") };
      this.drafts.set(key, { sequence, target, snapshot: draft });
      this.patch(target, draft);
    }
    this.state.pending++;
    this.state.error = "";
    let notified = false;
    const onApplied = async (applied: UnityBoundPropertyWriteResult) => {
      // History replays remain authoritative. Superseded queued callers share
      // the latest receipt but must not repeat its refresh/project callback.
      const replay = notified;
      notified = true;
      if (!replay && sequence < (this.appliedSequences.get(key) ?? 0)) return;
      if (applied.ok === false) throw new Error(applied.message || "Failed to write Unity property.");
      ++this.editSequence;
      this.appliedSequences.set(key, Math.max(sequence, this.appliedSequences.get(key) ?? 0));
      if (this.drafts.get(key)?.sequence === sequence) {
        this.drafts.delete(key);
        this.state.error = "";
      }
      const matches = applied.propertyPath === commit.propertyPath;
      const patched = matches && this.patch(target, applied);
      this.restoreDrafts();
      // Structural changes and validation side effects need an authoritative
      // refresh. Scalar receipts already contain their actual/clamped value.
      if (mode === "commit" && options.refresh !== false &&
          (options.refresh === true || !scalar || !patched || applied.refreshObject)) await this.refresh();
      await options.onApplied?.(applied);
    };
    try {
      const result = await this.adapter.write({
        bindingId: this.bindingId, target, value: commit.value, writeMode: mode,
      }, { ...options, beforeSnapshot: options.beforeSnapshot ?? commit.snapshot, onApplied });
      if (!notified) await onApplied(result);
      return result;
    } catch (error) {
      // Keep the newest draft available for correction/retry. Never roll it
      // back because an earlier request failed.
      this.state.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { this.state.pending--; }
  }

  async apply(
    writes: UnityBoundPropertyApplyWrite[],
    options: UnityBoundPropertyApplyOptions = {},
  ) {
    ++this.editSequence;
    this.state.pending++;
    let notified = false;
    const onApplied = async (result: UnityBoundPropertyApplyResult) => {
      ++this.editSequence;
      notified = true;
      let refresh = options.refresh === true || result.results.length !== writes.length;
      for (let i = 0; i < result.results.length; i++) {
        const receipt = result.results[i];
        const target = receipt.target ?? writes[i]?.target;
        if (!receipt.ok || !target || !this.patch(target, receipt)) refresh = true;
        if (receipt.refreshObject || !isCoalesciblePropertyValue(writes[i]?.value)) refresh = true;
      }
      this.restoreDrafts();
      if (refresh && options.refresh !== false) await this.refresh();
      await options.onApplied?.(result);
    };
    try {
      const result = await this.adapter.apply({ writes }, { ...options, onApplied });
      if (!notified) await onApplied(result);
      return result;
    } finally { this.state.pending--; }
  }

  async undo() {
    await this.adapter.undo?.();
  }

  async redo() {
    await this.adapter.redo?.();
  }

  drawDefaultEditor(options: UnityBoundPropertyDrawOptions = {}): VNodeChild {
    if (this.raw.rootProperties.length > 1) {
      return h("div", { class: "unity-property-tree-roots" }, this.raw.rootProperties.map((property) =>
        h(UnitySerializedPropertyTree, {
          source: this.bindingInput(property), node: property, propertyDrawers: options.propertyDrawers,
          fieldPresentation: options.fieldPresentation, onFieldAction: options.onFieldAction,
          disabled: options.disabled, readonly: options.readonly, compact: options.compact,
          onCommit: (event: UnitySerializedPropertyCommitEvent) => this.handleDrawEvent(event, options, "commit"),
          onPreview: (event: UnitySerializedPropertyCommitEvent) => this.handleDrawEvent(event, options, "preview"),
        })));
    }
    return h(UnitySerializedPropertyTree, {
      source: this.bindingInput(),
      fieldPresentation: options.fieldPresentation,
      onFieldAction: options.onFieldAction,
      propertyDrawers: options.propertyDrawers,
      disabled: options.disabled,
      readonly: options.readonly,
      compact: options.compact,
      onCommit: (event: UnitySerializedPropertyCommitEvent) => this.handleDrawEvent(event, options, "commit"),
      onPreview: (event: UnitySerializedPropertyCommitEvent) => this.handleDrawEvent(event, options, "preview"),
    });
  }

  drawPropertyEditor(property: InspectorProperty, options: UnityBoundPropertyDrawOptions = {}): VNodeChild {
    if (property.children.length || property.isArray || property.isManagedReference || property.drawer.container) {
      return h(UnitySerializedPropertyTree, {
        source: this.bindingInput(property),
        node: property,
        fieldPresentation: options.fieldPresentation,
        onFieldAction: options.onFieldAction,
        propertyDrawers: options.propertyDrawers,
        disabled: options.disabled,
        readonly: options.readonly,
        compact: options.compact,
        hideRootObjectHeader: options.showLabel === false,
        onCommit: (event: UnitySerializedPropertyCommitEvent) => this.handleDrawEvent(event, options, "commit"),
        onPreview: (event: UnitySerializedPropertyCommitEvent) => this.handleDrawEvent(event, options, "preview"),
      });
    }

    const field = resolveInspectorFieldPresentation(property, options.fieldPresentation);
    const access = propertyFieldAccess({ ...field,
      readonly: field.readonly || options.readonly || property.state.readonly,
      disabled: field.disabled || options.disabled || property.state.disabled });
    if (!access.visible) return null;
    const editor = h(UnityPropertyEditor, {
      modelValue: property.value,
      propertyType: propertyType(property),
      displayValue: property.displayValue,
      bindingTarget: this.targetForProperty(property),
      editable: property.editable,
      disabled: access.disabled,
      readonly: access.readonly,
      enumOptions: property.enumOptions,
      isFlagsEnum: property.isFlagsEnum,
      enumValueIndex: property.enumValueIndex,
      enumValueFlag: property.enumValueFlag,
      title: property.propertyPath,
      tooltip: property.tooltip,
      unit: property.unit,
      hasRange: property.hasRange,
      rangeMin: property.rangeMin,
      rangeMax: property.rangeMax,
      numberStep: property.numberStep,
      multiline: property.multiline,
      minLines: property.minLines,
      maxLines: property.maxLines,
      referenceTypeFullName: property.referenceTypeFullName,
      referenceTypeAssembly: property.referenceTypeAssembly,
      onCommit: (value: unknown) => {
        if (access.disabled || access.readonly) return;
        const commit = property.createCommit(value);
        const target = this.targetForProperty(property);
        options.onCommit?.(eventFromCommit(commit, target));
        void this.writeCommit(commit, writeOptionsFromDrawOptions(options))
          .catch(warnUnityPropertyWriteFailure);
      },
      onPreview: (value: unknown) => {
        if (access.disabled || access.readonly) return;
        const commit = property.createCommit(value);
        const target = this.targetForProperty(property);
        const event = eventFromCommit(commit, target);
        event.writeMode = "preview";
        options.onPreview?.(event);
        void this.writeCommit(commit, { refresh: false, undoable: false }, "preview")
          .catch(warnUnityPropertyWriteFailure);
      },
    });
    if (!Object.keys(field).length) return editor;
    return h(PropertyField, { ...field, label: property.label, fieldKey: field.fieldKey || `${this.bindingId}:${property.propertyPath}`,
      showLabel: options.showLabel !== false, tooltip: property.tooltip, disabled: access.disabled, readonly: access.readonly,
      onAction: (action: PropertyFieldAction) => options.onFieldAction?.({ action, property, propertyPath: property.propertyPath, snapshot: property.snapshot }),
    }, { default: () => editor });
  }

  private createTree(snapshots: InspectorPropertyTreeSnapshotInput | null | undefined): PropertyTree {
    return createPropertyTree(snapshots, {
      id: this.bindingId,
      targetId: this.bindingId,
      ...(this.options.treeOptions ?? {}),
    });
  }

  private bindingInput(property?: InspectorProperty): InspectorPropertyTreeBindingInput {
    return createInspectorPropertyTreeBinding({
      id: property ? `${this.bindingId}:${property.propertyPath}` : this.bindingId,
      targetId: this.bindingId,
      snapshots: property?.snapshot ?? this.snapshots,
      disabled: this.options.treeOptions?.disabled,
      readonly: this.options.treeOptions?.readonly,
      editable: this.options.treeOptions?.readonly === true ? false : undefined,
      loadChildren: (node) => this.loadChildren(node),
    });
  }

  private handleDrawEvent(
    event: UnitySerializedPropertyCommitEvent,
    options: UnityBoundPropertyDrawOptions,
    mode: UnityPropertyWriteMode,
  ) {
    // Never fall back to the root property: a stale event after refresh would
    // otherwise commit a child value onto the root target's propertyPath.
    const candidates = this.raw.properties.filter((candidate) => candidate.propertyPath === event.propertyPath);
    const eventTarget = event.target ?? snapshotTarget(event.property);
    const property = eventTarget ? candidates.find((candidate) =>
      unityPropertyTargetKey(this.targetForProperty(candidate)) === unityPropertyTargetKey(unityPropertyTargetWithPath(eventTarget, candidate.propertyPath)))
      : candidates.length === 1 ? candidates[0] : null;
    if (!property) {
      console.warn(
        `[unityPropertyBinding] dropped ${mode} for unknown property path: ${event.propertyPath}`,
      );
      return;
    }
    const field = resolveInspectorFieldPresentation(property, options.fieldPresentation);
    const access = propertyFieldAccess({ ...field,
      readonly: field.readonly || options.readonly || property.state.readonly,
      disabled: field.disabled || options.disabled || property.state.disabled });
    if (!access.visible || access.readonly || access.disabled) return;
    const commit = property.createCommit(event.value);
    if (mode === "preview") {
      options.onPreview?.({ ...event, writeMode: "preview" });
      void this.writeCommit(commit, { refresh: false, undoable: false }, "preview")
        .catch(warnUnityPropertyWriteFailure);
      return;
    }
    options.onCommit?.({ ...event, writeMode: "commit" });
    void this.writeCommit(commit, writeOptionsFromDrawOptions(options))
      .catch(warnUnityPropertyWriteFailure);
  }
}

export interface UnityPropertyRuntime {
  /** Lazy component demand; retain/release is normally owned by PropertyField. */
  bind(input: UnityPropertyPathInput, options?: UnityBoundPropertyRuntimeOptions): UnityPropertyResource;
  observeDataVersion(version?: string, changes?: UnityPropertyDataChanges): void;
  setActive(active: boolean): void;
  invalidate(target?: UnitySerializedPropertyTarget): void;
  dispose(): void;
  refreshTargets(target: UnitySerializedPropertyTarget): Promise<void>;
  parsePath(path: string): UnitySerializedPropertyTarget;
  objectTarget(input: UnityPropertyPathInput): UnitySerializedPropertyTarget;
  write(
    input: UnityPropertyPathInput,
    value: unknown,
    options?: UnityBoundPropertyWriteOptions & { writeMode?: UnityPropertyWriteMode },
  ): Promise<UnityBoundPropertyWriteResult>;
  apply(
    writes: UnityBoundPropertyApplyWrite[],
    options?: UnityBoundPropertyApplyOptions,
  ): Promise<UnityBoundPropertyApplyResult>;
  readTree(
    input: UnityPropertyPathInput,
    options?: UnityBoundPropertyRuntimeOptions,
  ): Promise<UnityBoundPropertyTree>;
  fromPath(
    input: UnityPropertyPathInput,
    options?: UnityBoundPropertyRuntimeOptions,
  ): Promise<UnityBoundPropertyTree>;
  readProperty(
    input: UnityPropertyPathInput,
    options?: UnityBoundPropertyRuntimeOptions,
  ): Promise<UnityBoundProperty>;
  property(
    input: UnityPropertyPathInput,
    options?: UnityBoundPropertyRuntimeOptions,
  ): Promise<UnityBoundProperty>;
}

export function createUnityPropertyRuntime(
  adapter: UnityBoundPropertyRuntimeAdapter,
): UnityPropertyRuntime {
  const trees = new Set<WeakRef<UnityBoundPropertyTree>>();
  let disposed = false, hostActive = true;
  function active() { if (disposed) throw new Error("Property runtime disposed."); }
  const transport = adapter;
  adapter = {
    ...transport,
    async write(request, options = {}) {
      active();
      let notified = false;
      const onApplied = async (result: UnityBoundPropertyWriteResult) => {
        notified = true; resources.reconcile(result); await options.onApplied?.(result);
      };
      const result = await transport.write(request, { ...options, onApplied });
      if (!notified) await onApplied(result);
      return result;
    },
    async apply(request, options = {}) {
      active();
      let notified = false;
      const onApplied = async (result: UnityBoundPropertyApplyResult) => {
        notified = true; result.results.forEach(receipt => resources.reconcile(receipt)); await options.onApplied?.(result);
      };
      const result = await transport.apply(request, { ...options, onApplied });
      if (!notified) await onApplied(result);
      return result;
    },
  };
  async function refreshTargets(target: UnitySerializedPropertyTarget) {
    adapter.invalidate?.(target);
    resources.invalidate(target);
    const jobs: Promise<unknown>[] = [];
    for (const reference of trees) {
      const tree = reference.deref();
      if (!tree) { trees.delete(reference); continue; }
      if (tree.raw.properties.some((property) => {
        const own = tree.targetForProperty(property);
        return own.globalObjectId && target.globalObjectId ? own.globalObjectId === target.globalObjectId
          : unityPropertyTargetKey(unityPropertyObjectTarget(own)) === unityPropertyTargetKey(unityPropertyObjectTarget(target));
      })) jobs.push(tree.refresh());
    }
    await Promise.all(jobs);
  }
  async function readTree(
    input: UnityPropertyPathInput,
    options: UnityBoundPropertyRuntimeOptions = {},
  ): Promise<UnityBoundPropertyTree> {
    active();
    const target = resolveUnityPropertyTarget(input);
    const result = await adapter.read({
      bindingId: normalizeBindingId(unityPropertyObjectTarget(target), options.idPrefix),
      target,
      maxDepth: options.maxDepth,
      maxArrayItems: options.maxArrayItems,
    });
    if (result.ok === false) throw new Error(result.message || "Failed to read Unity properties.");
    const tree = new UnityBoundPropertyTree(
      adapter,
      result.target ?? target,
      snapshotsFromReadResult(result),
      options,
    );
    tree.dataVersion = result.dataVersion;
    tree.dependencyObjectIds = result.dependencyObjectIds ?? [];
    tree.conservativeInvalidation = result.conservativeInvalidation ?? false;
    trees.add(new WeakRef(tree));
    return tree;
  }

  async function readProperty(
    input: UnityPropertyPathInput,
    options: UnityBoundPropertyRuntimeOptions = {},
  ): Promise<UnityBoundProperty> {
    const target = resolveUnityPropertyTarget(input);
    if (!target.propertyPath) {
      throw new Error("Unity property path target requires propertyPath.");
    }
    const tree = await readTree(target, options);
    const property = tree.get(target.propertyPath);
    if (!property) {
      throw new Error(`Unity property not found: ${target.propertyPath}`);
    }
    return property;
  }

  async function write(
    input: UnityPropertyPathInput,
    value: unknown,
    options: UnityBoundPropertyWriteOptions & { writeMode?: UnityPropertyWriteMode } = {},
  ) {
    const target = resolveUnityPropertyTarget(input);
    if (!target.propertyPath) {
      throw new Error("Unity property write target requires propertyPath.");
    }
    return adapter.write({
      bindingId: normalizeBindingId(unityPropertyObjectTarget(target)),
      target,
      value,
      writeMode: options.writeMode ?? "commit",
    }, options);
  }

  async function apply(
    writes: UnityBoundPropertyApplyWrite[],
    options: UnityBoundPropertyApplyOptions = {},
  ) {
    return adapter.apply({ writes }, options);
  }

  const runtime: UnityPropertyRuntime = {
    bind: (input, options) => resources.bind(input, options),
    observeDataVersion: (version, changes) => resources.observeVersion(version, changes),
    setActive: active => {
      if (hostActive !== active) { hostActive = active; adapter.invalidate?.(); }
      resources.setActive(active);
    },
    invalidate: target => { adapter.invalidate?.(target); resources.invalidate(target); },
    dispose: () => { disposed = true; trees.clear(); resources.dispose(); },
    refreshTargets,
    parsePath: resolveUnityPropertyTarget,
    objectTarget: unityPropertyObjectTarget,
    write,
    apply,
    readTree,
    fromPath: readTree,
    readProperty,
    property: readProperty,
  };
  const resources = createUnityPropertyResources(runtime);
  return runtime;
}

export function unityBoundPropertySnapshots(
  tree: UnityBoundPropertyTree | null | undefined,
): InspectorPropertySnapshot[] {
  return snapshotList(tree?.snapshots ?? null);
}
