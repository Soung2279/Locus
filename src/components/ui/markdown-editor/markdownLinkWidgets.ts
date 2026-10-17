import { ViewPlugin, WidgetType } from "@codemirror/view";
import { createElement } from "lucide";
import { normalizeExternalMarkdownHref } from "../../../composables/markdownExternalLinks";
import {
  unityAssetIconKindForPath,
  unityAssetIconNodeForKind,
  type UnityAssetIconKind,
} from "../../icons/unityAssetIcons";
import type { MarkdownLivePreviewOptions } from "./markdownComplexWidgets";

/** A focused link must use native Tab navigation, not the editor's indent keymap. */
export function markdownLinkKeyboard(options: MarkdownLivePreviewOptions) {
  return ViewPlugin.define(view => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest(".cm-live-link");
      if (!link) return;
      if (event.key === "Tab") event.stopPropagation();
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      const href = link.getAttribute("href");
      if (href) options.onLinkOpen?.(href);
    };
    view.contentDOM.addEventListener("keydown", onKeyDown, true);
    return { destroy() { view.contentDOM.removeEventListener("keydown", onKeyDown, true); } };
  });
}

export function markdownLinkHref(url: string): string | null {
  const href = url.trim();
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return null;
  const external = normalizeExternalMarkdownHref(href);
  if (external) return external;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return null;
  return href;
}

export function markdownLinkIconKind(href: string): UnityAssetIconKind | null {
  if (href.startsWith("#") || normalizeExternalMarkdownHref(href)) return null;
  let path = href.split(/[?#]/, 1)[0] ?? "";
  try { path = decodeURIComponent(path); } catch { /* A literal percent is also a valid filename. */ }
  return path ? unityAssetIconKindForPath(path, { isFolder: path.endsWith("/") }) : null;
}

export class MarkdownLinkIconWidget extends WidgetType {
  constructor(private readonly kind: UnityAssetIconKind) { super(); }

  eq(other: MarkdownLinkIconWidget): boolean { return other.kind === this.kind; }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-live-link-icon";
    span.setAttribute("aria-hidden", "true");
    span.dataset.iconKind = this.kind;
    span.append(createElement(unityAssetIconNodeForKind(this.kind), {
      width: "14", height: "14", "aria-hidden": "true", focusable: "false",
    }));
    return span;
  }

  ignoreEvent(): boolean { return false; }
}

export class MarkdownLinkEntityWidget extends WidgetType {
  constructor(private readonly source: string) { super(); }

  eq(other: MarkdownLinkEntityWidget): boolean { return other.source === this.source; }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    // Lezer supplies one Entity token, never arbitrary label HTML.
    const decoder = document.createElement("textarea");
    decoder.innerHTML = this.source;
    span.textContent = decoder.value;
    return span;
  }

  ignoreEvent(): boolean { return false; }
}
