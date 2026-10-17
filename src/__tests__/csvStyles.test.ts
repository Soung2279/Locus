// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/csvViewContract.json";
import { editCsvCells, insertCsvRow, parseCsvDocument } from "../document/csv/csvDocument";
import { defaultCsvView, parseCsvView, reconcileCsvView, serializeCsvView } from "../document/csv/csvView";
import { adjustCsvStyleRows, applyCsvCellStyle, migrateCsvViewToV2, reconcileCsvStyles, resolveCsvCellStyle, type CsvStyleRule } from "../document/csv/csvStyles";

function table() {
  const document = parseCsvDocument("id,status,value\nA,待确认,12\nB,完成,3\n");
  const view = migrateCsvViewToV2(reconcileCsvView(defaultCsvView(), document));
  return { document, view, ids: view.columnOrder };
}

describe("CSV sparse styles", () => {
  it("shares dialect, header and serialization fixtures with the Rust SDK service", () => {
    for (const item of fixtures.documents) {
      const document = parseCsvDocument(item.source);
      expect({ rows: document.records.length, columns: document.columnCount, delimiter: document.delimiter }, item.name).toEqual(item.shape);
    }
    expect(serializeCsvView(parseCsvView(fixtures.viewYaml))).toBe(fixtures.viewYaml);
  });

  it("migrates v1 idempotently without losing layout or accepting future schemas", () => {
    const old = reconcileCsvView(defaultCsvView(), parseCsvDocument("a,b\n1,2"));
    const migrated = migrateCsvViewToV2(old);
    expect(old.schema).toBe("locus.csv-view.v1");
    expect(migrated).toEqual({ ...old, schema: "locus.csv-view.v2" });
    expect(migrateCsvViewToV2(migrated)).toEqual(migrated);
    expect(parseCsvView(serializeCsvView(migrated))).toEqual(JSON.parse(JSON.stringify(migrated)));
    expect(() => parseCsvView(serializeCsvView(migrated).replace("v2", "v999"))).toThrow();
  });

  it("keeps whole-row and range formatting compact regardless of table width", () => {
    const { view } = table();
    view.styles = [{ id: "rows", rows: [1, 10000], style: { font: "sans", size: 15, bold: true, background: "subtle" } }];
    const raw = serializeCsvView(view);
    expect(raw.match(/"id":"rows"/g)).toHaveLength(1);
    expect(raw.split("styles:\n")[1]!.split("\n")).toHaveLength(2);
    expect(raw.split("styles:\n")[1]).not.toContain("columns");
    expect(raw.split("styles:\n")[1]!.length).toBeLessThan(160);
    expect(parseCsvView(raw).styles).toEqual(view.styles);
  });

  it("layers table, row, cell and conditional styles without losing independent properties", () => {
    const { document, view, ids } = table();
    view.styles = [
      { id: "base", style: { font: "mono", size: 14, border: { color: "border", width: 1 } } },
      { id: "row", rows: [1, 1], style: { bold: true, background: "subtle" } },
      { id: "pending", when: { columnId: ids[1]!, op: "contains", value: "待确认" }, style: { background: "warning-soft", color: "warning" } },
      { id: "cell", rows: [1, 1], columns: [ids[2]!], style: { bold: false, color: "#123456", border: { width: 2, color: "accent", edges: ["bottom"] } } },
    ];
    expect(resolveCsvCellStyle(document, view, 1, ids[2]!)).toEqual({ font: "mono", size: 14, bold: false,
      color: "#123456", background: "warning-soft", borders: { top: "1px solid var(--border-color)",
        left: "1px solid var(--border-color)", right: "1px solid var(--border-color)", bottom: "2px solid var(--accent-color)" } });
    expect(resolveCsvCellStyle(document, view, 1, ids[0]!)).toMatchObject({ bold: true, color: "warning" });
    expect(resolveCsvCellStyle(document, view, 2, ids[2]!)).not.toHaveProperty("background");
    view.columnOrder.reverse();
    expect(resolveCsvCellStyle(document, view, 1, ids[0]!)).toMatchObject({ color: "#123456" });
  });

  it("evaluates live numeric and empty conditions while keeping source row coordinates", () => {
    const { document, view, ids } = table();
    view.styles = [{ id: "numeric", when: { columnId: ids[2]!, op: "gte", value: 10 }, style: { bold: true } }];
    expect(resolveCsvCellStyle(document, view, 1, ids[0]!)).toEqual({ bold: true });
    expect(resolveCsvCellStyle(document, view, 2, ids[0]!)).toEqual({});
    const changed = parseCsvDocument("id,status,value\nA,待确认,2\nB,完成,30\n");
    expect(resolveCsvCellStyle(changed, view, 1, ids[0]!)).toEqual({});
    expect(resolveCsvCellStyle(changed, view, 2, ids[0]!)).toEqual({ bold: true });
    view.styles = [{ id: "empty", when: { columnId: ids[2]!, op: "empty" }, style: { color: "error" } }];
    expect(resolveCsvCellStyle(parseCsvDocument("id,status,value\nA,,"), view, 1, ids[0]!)).toEqual({ color: "error" });
    expect(resolveCsvCellStyle(document, view, 999, ids[0]!)).toEqual({});
  });

  it("clears recycled cell properties and uses shared font/theme tokens", () => {
    const cell = document.createElement("div");
    applyCsvCellStyle(cell, { font: "sans", size: 18, bold: true, background: "success-soft", color: "error", borders: { bottom: "2px solid red" } });
    expect(cell.style.fontFamily).toBe("var(--font-stack-sans)");
    expect(cell.style.fontSize).toBe("18px");
    expect(cell.style.fontWeight).toBe("700");
    expect(cell.style.getPropertyValue("--csv-cell-bg")).toBe("var(--status-good-bg)");
    expect(cell.style.getPropertyValue("--csv-cell-color")).toBe("var(--status-danger-fg)");
    expect(cell.style.borderBottomWidth).toBe("2px");
    applyCsvCellStyle(cell, {});
    expect(cell.getAttribute("style")).toBe("");
  });

  it("moves row ranges on insertion/deletion and removes only fully deleted targets", () => {
    const rules: CsvStyleRule[] = [{ id: "range", rows: [2, 5], style: { bold: true } },
      { id: "cell", rows: [3, 3], columns: ["a"], style: { color: "accent" } },
      { id: "all", style: { size: 14 } }];
    expect(adjustCsvStyleRows(rules, 1)![0]!.rows).toEqual([3, 6]);
    expect(adjustCsvStyleRows(rules, 4)![0]!.rows).toEqual([2, 6]);
    expect(adjustCsvStyleRows(rules, null, [0, 3, 4])!.map((r) => [r.id, r.rows])).toEqual([["range", [1, 2]], ["all", undefined]]);
    expect(rules[0]!.rows).toEqual([2, 5]);
  });

  it("does not broaden a cell rule to the whole row when its columns disappear", () => {
    const { view, ids } = table();
    const rules: CsvStyleRule[] = [{ id: "cell", columns: [ids[1]!], style: { bold: true } },
      { id: "condition", when: { columnId: ids[1]!, op: "empty" }, style: { color: "error" } },
      { id: "row", rows: [1, 1], style: { size: 15 } }];
    const columns = { [ids[0]!]: view.columns[ids[0]!]! };
    expect(reconcileCsvStyles(rules, columns)).toEqual([rules[2]]);
  });

  it.each([1, 2])("inherits the adjacent source row %i at a formatting boundary without adding rules", (source) => {
    const { document, view, ids } = table();
    view.styles = [
      { id: "base", style: { font: "mono", border: { color: "border" } } },
      { id: "upper", rows: [1, 1], style: { background: "subtle", bold: true } },
      { id: "lower", rows: [2, 2], style: { background: "accent-soft", size: 16 } },
      { id: "cell", rows: [source, source], columns: [ids[2]!], style: { bold: false, border: { edges: ["bottom"], width: 2 }, excel: { numberFormat: "0.00" } } },
    ];
    view.schema = "locus.csv-view.v4";
    const original = serializeCsvView(view);
    const inserted = parseCsvDocument(insertCsvRow(document, 2));
    const next = { ...view, styles: adjustCsvStyleRows(view.styles, 2, [], source) };
    for (const id of ids) {
      expect(resolveCsvCellStyle(inserted, next, 2, id)).toEqual(resolveCsvCellStyle(document, view, source, id));
      for (let row = 0; row < document.records.length; row++) {
        expect(resolveCsvCellStyle(inserted, next, row < 2 ? row : row + 1, id)).toEqual(resolveCsvCellStyle(document, view, row, id));
      }
    }
    expect(next.styles).toHaveLength(view.styles.length);
    expect(parseCsvView(serializeCsvView(next)).styles).toEqual(next.styles);
    expect(serializeCsvView(view)).toBe(original);
  });

  it("inherits conditional rules while evaluating the new row's own values", () => {
    const { document, view, ids } = table();
    view.styles = [
      { id: "row", rows: [1, 1], style: { background: "subtle" } },
      { id: "pending", rows: [1, 1], when: { columnId: ids[1]!, op: "eq", value: "待确认" }, style: { color: "warning" } },
    ];
    const inserted = parseCsvDocument(insertCsvRow(document, 1));
    const next = { ...view, styles: adjustCsvStyleRows(view.styles, 1, [], 1) };
    expect(resolveCsvCellStyle(inserted, next, 1, ids[0]!)).toEqual({ background: "subtle" });
    expect(resolveCsvCellStyle(inserted, next, 2, ids[0]!)).toEqual({ background: "subtle", color: "warning" });
    const edited = parseCsvDocument(editCsvCells(inserted, [{ row: 1, column: 1, value: "待确认" }]));
    expect(resolveCsvCellStyle(edited, next, 1, ids[0]!)).toEqual({ background: "subtle", color: "warning" });
  });

  it("rejects invalid style fields, CSS values, coordinates and dangling references", () => {
    const { view, ids } = table();
    for (const rule of [
      { id: "x", style: { size: 0 } }, { id: "x", style: { font: "x;display:none" } },
      { id: "x", style: { color: "url(http://invalid)" } }, { id: "x", style: { border: { width: 10 } } },
      { id: "x", rows: [2, 1], style: { bold: true } }, { id: "x", columns: ["missing"], style: { bold: true } },
      { id: "x", when: { columnId: ids[0], op: "eval", value: "alert()" }, style: { bold: true } },
    ]) {
      expect(() => parseCsvView(serializeCsvView({ ...view, styles: [rule as CsvStyleRule] }))).toThrow();
    }
    expect(() => parseCsvView(serializeCsvView({ ...view, schema: "locus.csv-view.v1", styles: [{ id: "x", style: { bold: true } }] }))).toThrow();
  });
});
