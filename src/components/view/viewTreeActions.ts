import { t } from "../../i18n";
import type { ViewPackageSummary } from "../../services/view";

interface ViewTreeEntry {
  kind: "folder" | "view";
  label: string;
  view?: ViewPackageSummary;
  children: ViewTreeEntry[];
}

export function isPluginView(view: ViewPackageSummary | null | undefined): boolean {
  return !!view?.pluginId || !!view?.source?.startsWith("plugin");
}

export function nodeContainsPluginView(node: ViewTreeEntry): boolean {
  return node.kind === "view"
    ? isPluginView(node.view)
    : node.children.some(nodeContainsPluginView);
}

export function viewPluginAttribution(view: ViewPackageSummary | undefined): string {
  if (!isPluginView(view)) return "";
  const name = view?.pluginName?.trim() || view?.pluginId?.trim();
  return name ? t("view.tree.pluginProvidedBy", name) : t("view.tree.pluginProvided");
}
