// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { CodeView, languageOf, STYLE_NONCE } from "./editor.js";

const HOSTILE = '<img src=x onerror="throw 1"><script>throw 2</script><b>bold</b>';

function mount(options: ConstructorParameters<typeof CodeView>[1]): { view: CodeView; parent: HTMLElement } {
  const parent = document.createElement("div");
  document.body.append(parent);
  return { view: new CodeView(parent, options), parent };
}

describe("the code views", () => {
  it("mount an editable view with its label, and report the user's edits only", () => {
    const edits: string[] = [];
    const { view, parent } = mount({ label: "Payload", language: "json", editable: true, describedBy: "keys", onChange: (t) => edits.push(t) });
    const content = parent.querySelector(".cm-content");
    expect(content?.getAttribute("aria-label")).toBe("Payload");
    expect(content?.getAttribute("aria-describedby")).toBe("keys");
    expect(content?.getAttribute("contenteditable")).toBe("true");
    expect(content?.hasAttribute("aria-readonly")).toBe(false);
    view.setText('{"a": 1}');
    expect(view.text).toBe('{"a": 1}');
    expect(edits).toEqual([]);
    view.view.dispatch({ changes: { from: 8, insert: " " }, userEvent: "input" });
    expect(edits).toEqual(['{"a": 1} ']);
    view.destroy();
  });

  it("mount a read-only view that keeps its text and is still focusable", () => {
    const { view, parent } = mount({ label: "Rust code, read only", language: "rust", editable: false, text: "fn main() {}" });
    const content = parent.querySelector(".cm-content");
    expect(content?.getAttribute("aria-readonly")).toBe("true");
    expect(view.view.state.readOnly).toBe(true);
    expect(parent.querySelector(".cm-lineNumbers")).not.toBeNull();
    expect(parent.querySelector(".cm-foldGutter")).not.toBeNull();
    view.destroy();
  });

  it("show text that looks like markup as text, in the document and in a mark's title", () => {
    const { view, parent } = mount({ label: "Schema text", language: "json", editable: true, text: `{"title": "${HOSTILE.replaceAll('"', "'")}"}` });
    view.mark([{ from: 1, to: 8, kind: "problem", title: HOSTILE }]);
    expect(parent.querySelector("img, script, b")).toBeNull();
    const mark = parent.querySelector(".cm-problem");
    expect(mark?.textContent).toBe('"title"');
    expect(mark?.getAttribute("title")).toBe(HOSTILE);
    expect(parent.querySelector(".cm-content")?.textContent).toContain("<img src=x");
    view.destroy();
  });

  it("replace their marks, map them through edits and clear them with new text", () => {
    const { view, parent } = mount({ label: "Payload", language: "json", editable: true, text: '{"a": 0}' });
    view.mark([{ from: 6, to: 7, kind: "problem", title: "too small" }, { from: 1, to: 4, kind: "unknown-key", title: "unknown" }]);
    expect([...parent.querySelectorAll(".cm-problem, .cm-unknown-key")].map((m) => m.textContent)).toEqual(['"a"', "0"]);
    view.view.dispatch({ changes: { from: 0, insert: "  " } });
    expect(parent.querySelector(".cm-problem")?.textContent).toBe("0");
    // Marks outside the text are dropped rather than thrown.
    view.mark([{ from: 5, to: 500, kind: "problem", title: "out" }]);
    expect(parent.querySelector(".cm-problem")).toBeNull();
    view.mark([{ from: 8, to: 9, kind: "problem", title: "x" }]);
    view.setText("{}");
    expect(parent.querySelector(".cm-problem")).toBeNull();
    view.destroy();
  });

  it("add their style element with the nonce the page's policy names", () => {
    const { view } = mount({ label: "x", language: "text", editable: false });
    const styles = [...document.querySelectorAll("style")];
    expect(styles.length).toBeGreaterThan(0);
    for (const style of styles) expect(style.getAttribute("nonce")).toBe(STYLE_NONCE);
    view.destroy();
  });
});

describe("languageOf", () => {
  it("picks a language by extension, and plain text for the rest", () => {
    expect(["a.json", "b.rs", "c.go", "d.ts", "go.mod", "Cargo.toml"].map(languageOf)).toEqual([
      "json",
      "rust",
      "go",
      "typescript",
      "text",
      "text",
    ]);
  });
});
