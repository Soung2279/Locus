/** Authoring policy, independent of where the effective value is stored. */
export type PropertyFieldScope = "template-only" | "instance-only" | "template-and-instance";
export type PropertyFieldContext = "template" | "instance";
export type PropertyFieldValueState = "local" | "inherited" | "overridden";

export interface PropertyFieldProvenance {
  /** Explicit ownership, never inferred by comparing values. */
  state: PropertyFieldValueState;
  sourceLabel?: string;
  inheritedDisplayValue?: string;
  /** Summary supplied by the adapter, including unloaded children when known. */
  hasOverriddenChildren?: boolean;
}

export type PropertyFieldActionKind =
  | "create-override"
  | "revert"
  | "apply-to-template"
  | "reset-default"
  | "inspect-source"
  | "custom";

/** Capabilities supplied by the owner. No action performs a write by itself. */
export interface PropertyFieldAction {
  id: string;
  kind: PropertyFieldActionKind;
  /** Include the destination name for apply-to-template actions. */
  label: string;
  tooltip?: string;
  disabled?: boolean;
  disabledReason?: string;
  group?: string;
  /** Expose at most one shortcut beside the menu on hover / keyboard focus. */
  quick?: boolean;
  /** Custom actions default to mutating; inspect-source is always non-mutating. */
  mutates?: boolean;
}

export interface PropertyFieldPresentation {
  /** Optional stable owner + logical field identity, especially for reordered array items. */
  fieldKey?: string;
  scope?: PropertyFieldScope;
  context?: PropertyFieldContext;
  provenance?: PropertyFieldProvenance;
  actions?: readonly PropertyFieldAction[];
  readonly?: boolean;
  disabled?: boolean;
  busy?: boolean;
}

export function propertyFieldAccess(field: PropertyFieldPresentation = {}) {
  return {
    visible: !(field.scope === "instance-only" && field.context === "template"),
    readonly: field.readonly === true || (field.scope === "template-only" && field.context === "instance"),
    disabled: field.disabled === true || field.busy === true,
  };
}

export function propertyFieldActionMutates(action: PropertyFieldAction): boolean {
  if (action.kind === "inspect-source") return false;
  return action.kind === "custom" ? action.mutates !== false : true;
}

export function propertyFieldActions(field: PropertyFieldPresentation = {}): PropertyFieldAction[] {
  if (!propertyFieldAccess(field).visible) return [];
  return (field.actions ?? []).filter((action) => {
    switch (action.kind) {
      case "create-override":
        return field.scope === "template-and-instance" && field.provenance?.state === "inherited";
      case "revert":
      case "apply-to-template":
        return field.scope === "template-and-instance" && field.provenance?.state === "overridden";
      default:
        return true;
    }
  });
}

export function propertyFieldActionDisabled(action: PropertyFieldAction, field: PropertyFieldPresentation = {}): boolean {
  const access = propertyFieldAccess(field);
  return !access.visible || action.disabled === true || access.disabled ||
    (access.readonly && propertyFieldActionMutates(action));
}
