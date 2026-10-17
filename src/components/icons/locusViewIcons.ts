import { icons, type IconNode } from "lucide";
import { resolveViewSvgIcon } from "./viewSvgIcon";

export const DEFAULT_LOCUS_VIEW_ICON = "View";

// Use the installed library, including aliases, instead of a curated subset.
export const LOCUS_VIEW_ICON_LIBRARY = icons;

export type LocusViewIconName = keyof typeof LOCUS_VIEW_ICON_LIBRARY;

export const LOCUS_VIEW_ICON_NAMES = Object.keys(
  LOCUS_VIEW_ICON_LIBRARY,
) as LocusViewIconName[];

const normalizedIcons = new Map(
  LOCUS_VIEW_ICON_NAMES.map((name) => [normalizeIconName(name), LOCUS_VIEW_ICON_LIBRARY[name]]),
);

function normalizeIconName(name: string): string {
  return name.replace(/[-_]/g, "").toLowerCase();
}

export function resolveLocusViewIcon(icon?: string | null): IconNode {
  const value = icon?.trim();
  const fallback = LOCUS_VIEW_ICON_LIBRARY[DEFAULT_LOCUS_VIEW_ICON];
  if (!value) return fallback;
  if (value.startsWith("<")) return resolveViewSvgIcon(value) ?? fallback;
  return normalizedIcons.get(normalizeIconName(value)) ?? fallback;
}
