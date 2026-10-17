import DOMPurify from "dompurify";
import type { IconNode } from "lucide";

export const MAX_VIEW_SVG_ICON_BYTES = 32 * 1024;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const svgIcons = new Map<string, IconNode | null>();
let nextSvgId = 0;

// A static vector subset: no scripts, CSS, animation, HTML or external resources.
const SVG_TAGS = [
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "use",
];
const SVG_ATTRIBUTES = [
  "xmlns", "viewBox", "preserveAspectRatio", "width", "height", "x", "y", "x1", "x2", "y1", "y2",
  "cx", "cy", "r", "rx", "ry", "d", "points", "transform", "opacity", "fill", "fill-opacity",
  "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "vector-effect", "clip-path",
  "clip-rule", "clipPathUnits", "mask", "maskUnits", "maskContentUnits", "id", "href", "xlink:href",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod",
  "fx", "fy", "fr", "color",
];

function parseSvg(source: string): Element | null {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) return null;
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = doc.documentElement;
  if (doc.doctype || doc.querySelector("parsererror") || root.localName !== "svg"
    || (root.namespaceURI && root.namespaceURI !== SVG_NAMESPACE)) return null;
  return root;
}

function compileSvg(source: string): IconNode | null {
  if (!parseSvg(source)) return null;
  const clean = DOMPurify.sanitize(source, {
    ALLOWED_TAGS: SVG_TAGS,
    ALLOWED_ATTR: SVG_ATTRIBUTES,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: false,
  });
  const root = parseSvg(clean);
  if (!root) return null;

  // Namespace local paint/clip/use references so unrelated icons can reuse ids.
  const elements = [root, ...root.querySelectorAll("*")];
  const ids = new Map<string, string>();
  const prefix = `locus-view-svg-${++nextSvgId}-`;
  for (const element of elements) {
    const id = element.getAttribute("id");
    if (id) {
      if (!ids.has(id)) ids.set(id, `${prefix}${ids.size}`);
      element.setAttribute("id", ids.get(id)!);
    }
  }
  for (const element of elements) {
    for (const attribute of [...element.attributes]) {
      const value = attribute.value.trim();
      if (attribute.localName === "href") {
        const id = value.startsWith("#") ? ids.get(value.slice(1)) : undefined;
        if (id) element.setAttribute(attribute.name, `#${id}`);
        else element.removeAttributeNode(attribute);
      } else if (/url\s*\(/i.test(value)) {
        const match = /^url\(\s*['"]?#([^\s'"()]+)['"]?\s*\)$/i.exec(value);
        const id = match ? ids.get(match[1]!) : undefined;
        if (id) element.setAttribute(attribute.name, `url(#${id})`);
        else element.removeAttributeNode(attribute);
      } else if (/[\\]|(?:https?:|data:|javascript:)/i.test(value) && attribute.name !== "xmlns") {
        element.removeAttributeNode(attribute);
      }
    }
  }

  // Keep the author's coordinate system inside the shared 24px Lucide canvas.
  // Explicit defaults prevent the outer Lucide stroke/fill from altering SVGs.
  const attrs: Record<string, string | number> = {
    fill: "currentColor", stroke: "none", "stroke-width": "1",
    "stroke-linecap": "butt", "stroke-linejoin": "miter",
  };
  for (const attribute of [...root.attributes]) attrs[attribute.name] = attribute.value;
  if (!attrs.viewBox) {
    const width = Number(root.getAttribute("width"));
    const height = Number(root.getAttribute("height"));
    attrs.viewBox = width > 0 && height > 0 ? `0 0 ${width} ${height}` : "0 0 24 24";
  }
  attrs.x = 0;
  attrs.y = 0;
  attrs.width = 24;
  attrs.height = 24;
  attrs.innerHTML = root.innerHTML;
  return [["svg", attrs]];
}

/** Returns only sanitized, serializable nodes for the shared LucideIcon renderer. */
export function resolveViewSvgIcon(source: string): IconNode | null {
  if (source.length > MAX_VIEW_SVG_ICON_BYTES
    || new TextEncoder().encode(source).length > MAX_VIEW_SVG_ICON_BYTES) return null;
  if (svgIcons.has(source)) return svgIcons.get(source)!;
  const icon = compileSvg(source);
  if (svgIcons.size >= 128) svgIcons.delete(svgIcons.keys().next().value!);
  svgIcons.set(source, icon);
  return icon;
}
