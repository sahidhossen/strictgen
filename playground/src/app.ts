/**
 * The playground page. It keeps the state, sends it to the worker, and shows what comes back.
 * Every piece of text from the user or the generator is set with `textContent`, as an input's
 * value or as a CodeMirror document, never as markup.
 */
import { entryNames } from "./decode.js";
import type { OutputFile } from "../../src/generate.js";
import type { Mark } from "./editor.js";
import { CodeView, languageOf } from "./editor.js";
import { errorSpan, locate, schemaSpan } from "./locate.js";
import { SAMPLE } from "./sample.js";
import type { Decoded, Output, Request, Response, SchemaAt } from "./session.js";
import type { SchemaText, State } from "./state.js";
import { decodeState, encodeState, PROFILES, SCHEMA_NAME, StateError } from "./state.js";

/** How long one generate and decode may take before the worker is stopped. */
const TIMEOUT_MS = 5000;
/** How long typing must pause before the page regenerates. */
const DEBOUNCE_MS = 250;

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the page has no #${id}`);
  return node as T;
}

/** An element with text content and classes, never markup. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

const ui = {
  banner: byId<HTMLParagraphElement>("banner"),
  share: byId<HTMLButtonElement>("share"),
  shareStatus: byId<HTMLSpanElement>("share-status"),
  tabs: byId<HTMLDivElement>("file-tabs"),
  addFile: byId<HTMLButtonElement>("add-file"),
  fileName: byId<HTMLInputElement>("file-name"),
  removeFile: byId<HTMLButtonElement>("remove-file"),
  fileError: byId<HTMLSpanElement>("file-error"),
  schema: byId<HTMLDivElement>("schema"),
  read: byId<HTMLSelectElement>("read"),
  cleanup: byId<HTMLInputElement>("cleanup"),
  serdeBridge: byId<HTMLInputElement>("serde-bridge"),
  idsFile: byId<HTMLInputElement>("ids-file"),
  idsSuffix: byId<HTMLInputElement>("ids-suffix"),
  genStatus: byId<HTMLParagraphElement>("gen-status"),
  type: byId<HTMLSelectElement>("type"),
  decoder: byId<HTMLSelectElement>("decoder"),
  entry: byId<HTMLSpanElement>("entry"),
  payload: byId<HTMLDivElement>("payload"),
  result: byId<HTMLDivElement>("result"),
  profiles: Object.fromEntries(PROFILES.map((p) => [p, byId<HTMLInputElement>(`profile-${p}`)])) as Record<
    string,
    HTMLInputElement
  >,
};

let state: State = SAMPLE;
let selected = 0;

const schemaView = new CodeView(ui.schema, {
  label: "Schema text",
  language: "json",
  editable: true,
  describedBy: "editor-keys",
  onChange: (text) => {
    const file = state.schemas[selected];
    if (file !== undefined) update(withFile(selected, { name: file.name, text }));
  },
});

const payloadView = new CodeView(ui.payload, {
  label: "Payload",
  language: "json",
  editable: true,
  describedBy: "editor-keys",
  onChange: (text) => update({ ...state, payload: text }),
});

/** The read-only view of each output panel, made when the panel first shows a file. */
const panelViews = new Map<Output, CodeView>();
/** The view of the encoded value in the result, replaced with each result. */
let resultView: CodeView | undefined;

/** Where the last generation failed, with the schema texts it read, to mark it in the schema editor. */
let schemaProblem: { readonly at: SchemaAt; readonly message: string; readonly schemas: Request["input"]["schemas"] } | null =
  null;

/** The worker, restarted when a request takes longer than {@link TIMEOUT_MS}. */
class Runner {
  private worker: Worker | undefined;
  private ready = false;
  private pending: { request: Request; timer: ReturnType<typeof setTimeout> } | undefined;
  private queued: Request | undefined;
  /** The last request sent, sent again by {@link retry}. */
  private last: Omit<Request, "id"> | undefined;
  private next = 1;

  constructor(
    private readonly onResponse: (r: Response, request: Request) => void,
    private readonly onProblem: (text: string, retry?: () => void) => void,
  ) {
    this.start();
  }

  private start(): void {
    this.ready = false;
    let worker: Worker;
    try {
      worker = new Worker(new URL("./worker.js", import.meta.url), { type: "classic" });
    } catch {
      this.failedToLoad();
      return;
    }
    worker.onmessage = (event: MessageEvent<unknown>) => this.message(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      // Before its first message the script itself didn't load or run, like a failed download.
      if (!this.ready) this.failedToLoad();
      else this.onProblem(`The worker failed: ${event.message}`);
    };
    this.worker = worker;
  }

  private failedToLoad(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.onProblem(
      "The playground's worker (worker.js), which generates and decodes, didn't load. Check the connection, then retry.",
      () => this.retry(),
    );
  }

  /** Starts a new worker and sends the last request again. */
  retry(): void {
    if (this.queued === undefined && this.last !== undefined) this.queued = { ...this.last, id: this.next++ };
    this.start();
  }

  private message(data: unknown): void {
    if (typeof data !== "object" || data === null) return;
    if ("ready" in data) {
      this.ready = true;
      this.flush();
      return;
    }
    const id = (data as { id?: unknown }).id;
    const pending = this.pending;
    if (pending === undefined || id !== pending.request.id) return;
    clearTimeout(pending.timer);
    this.pending = undefined;
    if ("failure" in data) this.onProblem(`The playground failed: ${String((data as { failure: unknown }).failure)}`);
    else this.onResponse(data as Response, pending.request);
    this.flush();
  }

  /** Sends `request` now, or after the request in flight, replacing any other that waits. */
  send(request: Omit<Request, "id">): void {
    this.last = request;
    this.queued = { ...request, id: this.next++ };
    this.flush();
  }

  private flush(): void {
    if (!this.ready || this.pending !== undefined || this.queued === undefined || this.worker === undefined) return;
    const request = this.queued;
    this.queued = undefined;
    this.pending = { request, timer: setTimeout(() => this.timeout(), TIMEOUT_MS) };
    this.worker.postMessage(request);
  }

  private timeout(): void {
    this.worker?.terminate();
    this.pending = undefined;
    this.onProblem(
      `Stopped after ${String(TIMEOUT_MS / 1000)} seconds without an answer. A pattern that backtracks a lot on this ` +
        "payload can do that; the worker was restarted.",
    );
    this.start();
  }
}

// Rendering --------------------------------------------------------------------------------------

function renderFiles(): void {
  ui.tabs.replaceChildren(
    ...state.schemas.map((file, i) => {
      const tab = el("button", file.name);
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(i === selected));
      tab.addEventListener("click", () => {
        selected = i;
        renderFiles();
      });
      return tab;
    }),
  );
  const file = state.schemas[selected];
  ui.fileName.value = file?.name ?? "";
  schemaView.setText(file?.text ?? "");
  ui.removeFile.disabled = state.schemas.length < 2;
  ui.fileError.textContent = "";
  markSchema();
}

/**
 * Marks where generation failed in the schema editor, when the file shown is the one at fault
 * and its text is the text that failed.
 */
function markSchema(): void {
  const file = state.schemas[selected];
  const problem = schemaProblem;
  const text = schemaView.text;
  const failed = problem?.schemas.find((f) => f.name === file?.name)?.text;
  if (file === undefined || problem === null || problem.at.file !== file.name || failed !== text) {
    schemaView.mark([]);
    return;
  }
  const span = schemaSpan(text, problem.at.pointer);
  schemaView.mark(span === null ? [] : [{ ...span, kind: "problem", title: problem.message }]);
}

function renderSettings(): void {
  ui.read.value = state.read;
  for (const p of PROFILES) {
    const box = ui.profiles[p];
    if (box !== undefined) box.checked = state.profiles.includes(p);
  }
  ui.cleanup.checked = state.cleanup;
  ui.cleanup.disabled = state.profiles.length === 0;
  ui.serdeBridge.checked = state.serdeBridge;
  ui.idsFile.value = state.ids?.file ?? "";
  ui.idsSuffix.value = state.ids?.suffix ?? "";
  ui.decoder.value = state.decoder;
  payloadView.setText(state.payload);
}

/** The outputs, in the order the page shows them, as `session.ts` lists them. */
const OUTPUTS: readonly Output[] = ["typescript", "rust", "go", "llm"];

/** The file a panel shows first: the one of the first schema, or for the LLM schemas the decoded type's. */
function firstShown(output: Output, names: readonly string[]): string {
  const base = (state.schemas[0]?.name ?? "").replace(/\.json$/, "");
  const wanted =
    output === "llm"
      ? names.find((n) => n.endsWith(`/${state.type}.json`))
      : names.find((n) => n.startsWith(`${base}.`) || n.startsWith(`${base.replaceAll("-", "_")}.`));
  return wanted ?? names[0] ?? "";
}

/** Fills a panel's file list and shows the chosen file, keeping the choice across runs. */
function renderPanel(output: Output, files: readonly OutputFile[], stale: boolean): void {
  const panel = byId<HTMLElement>(`panel-${output}`);
  const select = panel.querySelector("select");
  const code = panel.querySelector<HTMLElement>(".code");
  if (select === null || code === null) return;
  let view = panelViews.get(output);
  if (view === undefined) {
    const heading = panel.querySelector("h2")?.textContent ?? output;
    view = new CodeView(code, { label: `${heading} code, read only`, language: "text", editable: false });
    panelViews.set(output, view);
  }
  const shown = view;
  panel.classList.toggle("stale", stale);
  if (stale) return;
  const names = files.map((f) => f.path);
  const before = select.value;
  select.replaceChildren(...names.map((n) => el("option", n)));
  select.value = names.includes(before) ? before : firstShown(output, names);
  const show = (): void => {
    const path = select.value;
    shown.setLanguage(languageOf(path));
    shown.setText(files.find((f) => f.path === path)?.contents ?? "");
  };
  select.onchange = show;
  show();
  if (files.length === 0) {
    shown.setLanguage("text");
    shown.setText(output === "llm" ? "Pick an LLM profile to get the LLM schemas." : "");
  }
}

function renderGenerated(response: Response): void {
  const g = response.generated;
  const stale = !g.ok;
  ui.genStatus.className = g.ok ? "status" : "status error";
  ui.genStatus.textContent = g.ok
    ? `Generated ${String(g.count)} files.`
    : `${g.error}\nThe code below is from the last schemas that generated.`;
  for (const output of OUTPUTS) renderPanel(output, g.ok ? g.outputs[output] : [], stale);
  markSchema();
  if (!g.ok) return;
  const types = state.decoder === "llm" ? g.llmTypes : g.types;
  ui.type.replaceChildren(...types.map((t) => el("option", t)));
  ui.type.disabled = types.length === 0;
  if (types.includes(response.type)) {
    ui.type.value = response.type;
    if (state.type !== response.type) {
      state = { ...state, type: response.type };
      saveSoon();
    }
  }
}

function row(table: HTMLTableElement, name: string, value: string | null): void {
  const tr = el("tr");
  tr.append(el("th", name), el("td", value ?? "(none)"));
  table.append(tr);
}

/**
 * Marks the payload editor: the place of a rejected payload's error, and in report mode the
 * unknown keys dropped. Only when the editor still holds the payload that was decoded, since
 * the places are in that text.
 */
function markPayload(decoded: Decoded | null, request: Request): void {
  const text = payloadView.text;
  if (decoded === null || text !== request.payload) {
    payloadView.mark([]);
    return;
  }
  const list: Mark[] = [];
  if (decoded.kind === "rejected") {
    // The LLM decoder may clean the text up before reading it, so only a path the text has is marked.
    const span = errorSpan(text, decoded.error, request.decoder === "normal");
    if (span !== null) list.push({ ...span, kind: "problem", title: decoded.error.message });
  } else if (decoded.kind === "accepted" && decoded.unknown.length > 0) {
    const located = locate(text);
    for (const path of decoded.unknown) {
      const key = located.ok ? located.places.get(path)?.key : undefined;
      if (key !== undefined && key !== null) {
        list.push({ ...key, kind: "unknown-key", title: `${path}: an unknown key, reported and dropped` });
      }
    }
  }
  payloadView.mark(list);
}

function renderDecoded(decoded: Decoded | null, type: string): void {
  const names = entryNames(type, state.read, state.decoder);
  ui.entry.textContent = type === "" ? "" : `${names.decode}(text)`;
  resultView?.destroy();
  resultView = undefined;
  if (decoded === null) {
    ui.result.replaceChildren(el("p", "Paste a payload to decode it.", "verdict"));
    return;
  }
  switch (decoded.kind) {
    case "accepted": {
      const parts: HTMLElement[] = [el("p", "Accepted", "verdict accepted")];
      if (state.read === "report" && state.decoder === "normal") {
        parts.push(
          el(
            "p",
            decoded.unknown.length === 0
              ? "No unknown keys."
              : `Unknown keys, reported and dropped: ${decoded.unknown.join(", ")}`,
          ),
        );
      }
      parts.push(el("p", `Encoded again with ${names.encode}:`));
      if (decoded.encoded === null) {
        parts.push(el("pre", `The encoder refused it: ${decoded.encodeError ?? ""}`));
        ui.result.replaceChildren(...parts);
        return;
      }
      const holder = el("div", undefined, "encoded");
      parts.push(holder);
      ui.result.replaceChildren(...parts);
      resultView = new CodeView(holder, {
        label: `The value encoded again with ${names.encode}, read only`,
        language: "json",
        editable: false,
        wrap: true,
        text: decoded.encoded,
      });
      return;
    }
    case "rejected": {
      const table = el("table");
      row(table, "path", decoded.error.path === "" ? '"" (the whole input)' : decoded.error.path);
      row(table, "code", decoded.error.code);
      row(table, "expected", decoded.error.expected);
      row(table, "found", decoded.error.found);
      row(table, "message", decoded.error.message);
      row(table, "compact", decoded.error.compact);
      ui.result.replaceChildren(el("p", "Rejected", "verdict rejected"), table);
      return;
    }
    case "crash":
      ui.result.replaceChildren(
        el("p", "The decoder threw something other than a DecodeError. That is a bug in strictgen.", "verdict crash"),
        el("pre", decoded.message),
      );
      return;
    case "unavailable":
      ui.result.replaceChildren(el("p", `Nothing to decode with: ${decoded.reason}.`, "verdict unavailable"));
      return;
  }
}

function problem(text: string, retry?: () => void): void {
  const parts: HTMLElement[] = [el("p", text, "verdict crash")];
  if (retry !== undefined) {
    const button = el("button", "Retry");
    button.type = "button";
    button.addEventListener("click", () => {
      ui.result.replaceChildren(el("p", "Loading the worker again...", "verdict"));
      retry();
    });
    parts.push(button);
    ui.genStatus.className = "status error";
    ui.genStatus.textContent = "Nothing is generated until the worker loads.";
  }
  ui.result.replaceChildren(...parts);
}

const runner = new Runner(
  (r, request) => {
    schemaProblem =
      !r.generated.ok && r.generated.at !== null
        ? { at: r.generated.at, message: r.generated.error, schemas: request.input.schemas }
        : null;
    renderGenerated(r);
    const decoded: Decoded | null = r.generated.ok ? r.decoded : { kind: "unavailable", reason: "the schemas don't generate" };
    renderDecoded(decoded, r.type);
    markPayload(decoded, request);
  },
  problem,
);

// State changes ----------------------------------------------------------------------------------

let runTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function runNow(): void {
  runner.send({
    input: { schemas: state.schemas, read: state.read, profiles: state.profiles, cleanup: state.cleanup, serdeBridge: state.serdeBridge, ids: state.ids },
    type: state.type,
    decoder: state.decoder,
    payload: state.payload,
  });
}

function runSoon(): void {
  clearTimeout(runTimer);
  runTimer = setTimeout(runNow, DEBOUNCE_MS);
}

/** Writes the state into the fragment, replacing the history entry, so the address bar is always a working link. */
async function save(): Promise<void> {
  try {
    const fragment = await encodeState(state);
    history.replaceState(null, "", `#${fragment}`);
  } catch (error) {
    ui.shareStatus.textContent = error instanceof Error ? error.message : String(error);
  }
}

function saveSoon(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 500);
}

function update(next: State, rerun = true): void {
  state = next;
  saveSoon();
  if (rerun) runSoon();
}

function withFile(i: number, file: SchemaText): State {
  return { ...state, schemas: state.schemas.map((f, j) => (j === i ? file : f)) };
}

ui.fileName.addEventListener("change", () => {
  const name = ui.fileName.value.trim();
  const file = state.schemas[selected];
  if (file === undefined || name === file.name) return;
  if (!SCHEMA_NAME.test(name)) {
    ui.fileError.textContent = "Use lowercase letters, digits and dashes, ending in .json, like order.json";
    return;
  }
  if (state.schemas.some((f) => f.name === name)) {
    ui.fileError.textContent = `There is a ${name} already`;
    return;
  }
  update(withFile(selected, { name, text: file.text }));
  renderFiles();
});

ui.addFile.addEventListener("click", () => {
  let n = 1;
  while (state.schemas.some((f) => f.name === `schema-${String(n)}.json`)) n++;
  const name = `schema-${String(n)}.json`;
  const text = `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: idFor(name),
      $defs: {},
    },
    null,
    2,
  )}\n`;
  update({ ...state, schemas: [...state.schemas, { name, text }] });
  selected = state.schemas.length - 1;
  renderFiles();
});

/** An `$id` for a new file, with the base of the first schema's `$id` when it has one. */
function idFor(name: string): string {
  try {
    const first = JSON.parse(state.schemas[0]?.text ?? "") as { $id?: unknown };
    const id = first.$id;
    if (typeof id === "string" && /[/#]/.test(id)) return id.slice(0, Math.max(id.lastIndexOf("/"), id.lastIndexOf("#")) + 1) + name;
  } catch {
    // Not JSON yet: fall back to the example's base.
  }
  return `https://example.com/schemas/${name}`;
}

ui.removeFile.addEventListener("click", () => {
  if (state.schemas.length < 2) return;
  update({ ...state, schemas: state.schemas.filter((_, i) => i !== selected) });
  selected = Math.max(0, selected - 1);
  renderFiles();
});

ui.read.addEventListener("change", () => update({ ...state, read: ui.read.value === "report" ? "report" : "strict" }));

for (const p of PROFILES) {
  ui.profiles[p]?.addEventListener("change", () => {
    const profiles = PROFILES.filter((q) => ui.profiles[q]?.checked === true);
    update({ ...state, profiles, cleanup: profiles.length === 0 ? false : state.cleanup });
    renderSettings();
  });
}

ui.cleanup.addEventListener("change", () => update({ ...state, cleanup: ui.cleanup.checked }));
ui.serdeBridge.addEventListener("change", () => update({ ...state, serdeBridge: ui.serdeBridge.checked }));

function readIds(): void {
  const file = ui.idsFile.value.trim();
  const suffix = ui.idsSuffix.value.trim();
  update({ ...state, ids: file === "" || suffix === "" ? null : { file, suffix } });
}
ui.idsFile.addEventListener("change", readIds);
ui.idsSuffix.addEventListener("change", readIds);

ui.type.addEventListener("change", () => update({ ...state, type: ui.type.value }));
ui.decoder.addEventListener("change", () => update({ ...state, decoder: ui.decoder.value === "llm" ? "llm" : "normal" }));

ui.share.addEventListener("click", () => {
  void (async () => {
    clearTimeout(saveTimer);
    await save();
    try {
      await navigator.clipboard.writeText(location.href);
      ui.shareStatus.textContent = "Copied. The link holds everything; nothing is stored anywhere else.";
    } catch {
      ui.shareStatus.textContent = "Copy the address bar: it holds the link.";
    }
  })();
});

// Loading ----------------------------------------------------------------------------------------

async function load(): Promise<void> {
  const fragment = location.hash.slice(1);
  ui.banner.hidden = true;
  if (fragment !== "") {
    try {
      state = await decodeState(fragment);
    } catch (error) {
      state = SAMPLE;
      ui.banner.textContent = `Couldn't read the link: ${error instanceof StateError ? error.message : "it is broken"}. Showing the example instead.`;
      ui.banner.hidden = false;
    }
  } else {
    state = SAMPLE;
  }
  selected = 0;
  renderFiles();
  renderSettings();
  runNow();
}

window.addEventListener("hashchange", () => void load());
void load();
