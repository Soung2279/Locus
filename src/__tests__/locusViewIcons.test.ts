// @vitest-environment jsdom
import { createApp, h } from "vue";
import { icons, type IconNode } from "lucide";
import { afterEach, describe, expect, it } from "vitest";
import LucideIcon from "../components/icons/LucideIcon.vue";
import { LOCUS_VIEW_ICON_NAMES, resolveLocusViewIcon } from "../components/icons/locusViewIcons";
import { MAX_VIEW_SVG_ICON_BYTES } from "../components/icons/viewSvgIcon";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); document.body.replaceChildren(); });

function renderIcon(icon: string | IconNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(LucideIcon, {
    icon: typeof icon === "string" ? resolveLocusViewIcon(icon) : icon, size: 14,
  }) });
  app.mount(host);
  cleanups.push(() => app.unmount());
  return host;
}

describe("View icons", () => {
  it("resolves every installed Lucide icon and alias, including normalized names", () => {
    expect(LOCUS_VIEW_ICON_NAMES.length).toBeGreaterThan(1000);
    for (const [name, node] of Object.entries(icons)) {
      expect(resolveLocusViewIcon(name), name).toBe(node);
    }
    expect(resolveLocusViewIcon(" swords ")).toBe(icons.Swords);
    expect(resolveLocusViewIcon("alarm-clock")).toBe(icons.AlarmClock);
    expect(resolveLocusViewIcon("inspection_panel")).toBe(icons.InspectionPanel);
  });

  it("keeps the default for missing and unknown names without resolving object properties", () => {
    for (const value of [undefined, null, "", "missing-icon", "constructor", "__proto__"]) {
      expect(resolveLocusViewIcon(value)).toBe(icons.View);
    }
  });

  it("renders grouped SVG geometry with its viewBox, colors and the existing icon sizing", () => {
    const source = '<svg viewBox="0 0 48 32" fill="none" stroke="currentColor" stroke-width="3"><g transform="translate(2 2)"><path d="M0 0h40v24H0z"/><circle cx="20" cy="12" r="3" fill="#aabbcc"/></g></svg>';
    const host = renderIcon(source);
    expect(host.firstElementChild?.getAttribute("width")).toBe("14");
    expect(host.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    const svg = host.querySelector("svg svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 48 32");
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("3");
    expect(svg.querySelector("g")?.getAttribute("transform")).toBe("translate(2 2)");
    expect(svg.querySelector("circle")?.getAttribute("fill")).toBe("#aabbcc");
    expect(resolveLocusViewIcon(source)).toBe(resolveLocusViewIcon(source));
    expect(renderIcon(JSON.parse(JSON.stringify(resolveLocusViewIcon(source))))
      .querySelector("circle")?.getAttribute("r")).toBe("3");
  });

  it("uses SVG dimensions as a fallback viewBox and avoids inheriting Lucide strokes", () => {
    const svg = renderIcon('<svg width="32" height="16"><path d="M0 0h32v16H0z"/></svg>').querySelector("svg svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 32 16");
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("stroke")).toBe("none");
  });

  it("preserves local gradients, clips and use references without colliding between icons", () => {
    const source = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="paint"><stop stop-color="${color}"/></linearGradient><clipPath id="clip"><circle cx="12" cy="12" r="10"/></clipPath><path id="shape" d="M0 0h24v24H0z"/></defs><use href="#shape" fill="url(#paint)" clip-path="url(#clip)"/></svg>`;
    const first = renderIcon(source("red"));
    const second = renderIcon(source("blue"));
    const repeated = renderIcon(source("red"));
    for (const host of [first, second, repeated]) {
      const use = host.querySelector("use")!;
      const gradient = host.querySelector("linearGradient")!;
      expect(use.getAttribute("fill")).toBe(`url(#${gradient.id})`);
      expect(use.getAttribute("clip-path")).toBe(`url(#${host.querySelector("clipPath")!.id})`);
      expect(use.getAttribute("href")).toBe(`#${host.querySelector("path")!.id}`);
    }
    expect(first.querySelector("linearGradient")!.id).not.toBe(second.querySelector("linearGradient")!.id);
    expect(first.querySelector("linearGradient")!.id).not.toBe(repeated.querySelector("linearGradient")!.id);
  });

  it("removes executable markup, CSS and external references before rendering", () => {
    const host = renderIcon(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" style="position:fixed" class="danger"><script>alert(1)</script><style>body{display:none}</style><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">html</div></foreignObject><image href="https://example.com/image.svg"/><use href="https://example.com/icon.svg#shape"/><path d="M2 2h20v20H2z" onclick="alert(2)" fill="url(https://example.com/paint.svg#x)" style="fill:red"/><animate attributeName="href" values="javascript:alert(3)"/></svg>`);
    expect(host.querySelector("svg svg")).not.toBeNull();
    expect(host.querySelector("path")).not.toBeNull();
    expect(host.querySelector("script, style, foreignObject, image, animate, [onclick], [onload], [style], [class]")).toBeNull();
    expect(host.querySelector("use")?.hasAttribute("href")).toBe(false);
    expect(host.querySelector("path")?.hasAttribute("fill")).toBe(false);
    expect(host.innerHTML).not.toContain("example.com");
  });

  it("falls back for malformed, non-SVG, entity-bearing or oversized documents", () => {
    for (const source of ["<svg>", "<svg><path></svg>", "<div/>",
      '<svg xmlns="http://www.w3.org/1999/xhtml"><path/></svg>',
      '<!DOCTYPE svg [<!ENTITY x "test">]><svg>&x;</svg>',
      `<svg>${" ".repeat(MAX_VIEW_SVG_ICON_BYTES)}</svg>`,
      `<svg>${"中".repeat(12 * 1024)}</svg>`]) {
      expect(resolveLocusViewIcon(source)).toBe(icons.View);
    }
  });
});
