export interface RenderRect { x: number; y: number; width: number; height: number; }
export interface RenderLayout { rect: RenderRect; clip: RenderRect; occluders: RenderRect[]; visible: boolean; }
function intersect(a: RenderRect, b: RenderRect): RenderRect {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}
function bounds(element: Element): RenderRect {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}
/** Native surfaces use physical coordinates relative to the WebView client.
 * Common DOM overlays cut holes in the native region, so their visuals and
 * input remain in the WebView rather than behind an HWND. */
export function measureRenderLayout(element: HTMLElement, active = true): RenderLayout {
  const document = element.ownerDocument, owner = document.defaultView!;
  const scale = owner.devicePixelRatio || 1;
  const rect = bounds(element);
  let clip = intersect(rect, { x: 0, y: 0, width: owner.innerWidth, height: owner.innerHeight });
  let visible = active && element.isConnected && document.visibilityState !== "hidden" && rect.width > 0 && rect.height > 0;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = owner.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") visible = false;
    // Axis-aligned HWNDs cannot faithfully follow CSS rotation/skew.
    if (style.transform && style.transform !== "none" && owner.DOMMatrix) {
      const matrix = new owner.DOMMatrix(style.transform);
      if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) visible = false;
    }
    if (node !== element && /(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
      const box = bounds(node), sx = node.offsetWidth ? box.width / node.offsetWidth : 1, sy = node.offsetHeight ? box.height / node.offsetHeight : 1;
      const inner = { x: box.x + node.clientLeft * sx, y: box.y + node.clientTop * sy, width: node.clientWidth * sx, height: node.clientHeight * sy };
      const cut = intersect(clip, inner);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { clip.x = cut.x; clip.width = cut.width; }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { clip.y = cut.y; clip.height = cut.height; }
    }
  }
  const overlays = new Set<Element>();
  const selectors = '[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [data-native-surface-occluder], .base-context-menu-backdrop, .base-dropdown-menu, .modal-overlay';
  for (const candidate of document.querySelectorAll(selectors)) {
    if (candidate === element || candidate.contains(element)) continue;
    const style = owner.getComputedStyle(candidate);
    if (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0") overlays.add(candidate);
  }
  // Catch custom View overlays without requiring a particular component library.
  if (visible && document.elementsFromPoint) {
    const columns = Math.min(8, Math.max(1, Math.ceil(clip.width / 80)));
    const rows = Math.min(8, Math.max(1, Math.ceil(clip.height / 80)));
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
      let top = document.elementsFromPoint(clip.x + (x + 0.5) * clip.width / columns, clip.y + (y + 0.5) * clip.height / rows)[0];
      if (!top || top === element || top.contains(element)) continue;
      while (top.parentElement && top.parentElement !== element && !top.parentElement.contains(element)) top = top.parentElement;
      overlays.add(top);
    }
  }
  const physical = (r: RenderRect): RenderRect => {
    const x = Math.round(r.x * scale), y = Math.round(r.y * scale);
    return { x, y, width: Math.max(0, Math.round((r.x + r.width) * scale) - x), height: Math.max(0, Math.round((r.y + r.height) * scale) - y) };
  };
  const occluders = [...overlays].map((overlay) => intersect(clip, bounds(overlay))).filter((r) => r.width > 0 && r.height > 0);
  // Fail closed if an unusually complex overlay cannot fit the bounded region.
  if (occluders.length > 64) visible = false;
  return { rect: physical(rect), clip: physical(clip), occluders: occluders.slice(0, 64).map(physical), visible: visible && clip.width > 0 && clip.height > 0 };
}
