import type { InspectorProperty, InspectorPropertySnapshot } from "../../services/propertyTree";

export interface PropertyListSettings {
  pageSize: number;
  paging: boolean;
  draggable: boolean;
  showIndex: boolean;
  showCount: boolean;
  showFoldout: boolean;
  defaultExpanded?: boolean;
  readOnly: boolean;
  hideAdd: boolean;
  hideRemove: boolean;
  copyLast: boolean;
  alwaysDefault: boolean;
}

export function propertyAttribute(snapshot: InspectorPropertySnapshot, name: string): string | undefined {
  return snapshot.attributes?.find(attribute => attribute.type === name || attribute.type?.endsWith(`.${name}`))?.value;
}

export function propertyListSettings(snapshot: InspectorPropertySnapshot): PropertyListSettings {
  let options: Record<string, unknown> = {};
  try { options = JSON.parse(propertyAttribute(snapshot, "ListDrawerSettingsAttribute") || "{}"); } catch { /* Legacy attributes have no payload. */ }
  if (!options || typeof options !== "object") options = {};
  const pageSize = Number(options.NumberOfItemsPerPage);
  return {
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(100, Math.floor(pageSize)) : 10,
    paging: options.ShowPaging !== false,
    draggable: options.DraggableItems !== false,
    showIndex: options.ShowIndexLabels !== false,
    showCount: options.ShowItemCount !== false,
    showFoldout: options.ShowFoldout !== false,
    defaultExpanded: typeof options.DefaultExpandedState === "boolean" ? options.DefaultExpandedState : undefined,
    readOnly: options.IsReadOnly === true,
    hideAdd: options.HideAddButton === true,
    hideRemove: options.HideRemoveButton === true,
    copyLast: options.AddCopiesLastElement === true,
    alwaysDefault: options.AlwaysAddDefaultValue === true,
  };
}

export function propertyListElementType(snapshot: InspectorPropertySnapshot): { native?: boolean; reference?: boolean; fullName?: string; assembly?: string } {
  try {
    const value: unknown = JSON.parse(propertyAttribute(snapshot, "Locus.ListElementType") || "{}");
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

export function isComplexListItem(property: InspectorProperty): boolean {
  return property.isArray || property.isManagedReference || property.drawer.container;
}

export function propertyListItemSummary(property: InspectorProperty): string {
  const declared = propertyAttribute(property.snapshot, "Locus.ListElementLabel");
  if (declared?.trim()) return declared.trim();
  const label = property.label.trim();
  if (label && !/^(?:Element\s*\d+|\[\d+\]|第\s*\d+\s*项|data\[\d+\])$/i.test(label)) return label;
  const fields = property.children.filter(child => !child.drawer.container && propertyIsVisible(child));
  const values = fields.map(child => {
    let value = child.displayValue || (typeof child.value === "string" || typeof child.value === "number" ? String(child.value) : "");
    if (child.valueType === "ObjectReference") value = value.replace(/\\/g, "/").split("/").pop() || "";
    if (!value || value === "null" || value === "None") return "";
    return child.valueType === "String" || child.valueType === "Enum" || child.valueType === "ObjectReference" ? value : `${child.label}: ${value}`;
  }).filter(Boolean);
  return values.slice(0, 3).join(" · ") || property.managedReferenceDisplayName || property.fieldTypeFullName.split(/[.+]/).pop() || "";
}

export function propertyListItemMatches(property: InspectorProperty, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || [property, ...property.descendants()].some(item => propertyIsVisible(item) &&
    `${item.searchText} ${propertyListItemSummary(item)}`.toLocaleLowerCase().includes(needle));
}

export function propertyIsVisible(property: InspectorProperty): boolean {
  return propertyAttribute(property.snapshot, "Locus.PropertyVisibility") !== "false";
}

export function propertyFoldoutGroup(property: InspectorProperty): string {
  return propertyAttribute(property.snapshot, "FoldoutGroupAttribute") || "";
}

/** A partial snapshot must never be used as the source of a destructive whole-value write. */
export function canDuplicateListItem(property: InspectorProperty): boolean {
  return [property, ...property.descendants()].every(item => !item.isManagedReference);
}

export interface PropertyListViewState { collapsed: boolean; expanded: Set<number>; page: number; query: string; }

// Shared only within this window, bounded to avoid keeping every inspected target alive.
const listStates = new Map<string, PropertyListViewState>();
export function rememberPropertyList(key: string, state: PropertyListViewState): void {
  if (!key) return;
  listStates.delete(key);
  listStates.set(key, { ...state, expanded: new Set(state.expanded) });
  if (listStates.size > 200) listStates.delete(listStates.keys().next().value!);
}
export function recalledPropertyList(key: string): PropertyListViewState | undefined {
  const state = listStates.get(key);
  return state ? { ...state, expanded: new Set(state.expanded) } : undefined;
}
