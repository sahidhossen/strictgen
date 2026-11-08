/**
 * The code views of the page, made with CodeMirror: the schema and payload editors, and the
 * read-only views of the generated code and the encoded value. A CodeMirror document is text,
 * never markup, and nothing here builds markup from it: marks and their titles are set as
 * attributes.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { go } from "@codemirror/lang-go";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { rust } from "@codemirror/lang-rust";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import type { Extension, Range } from "@codemirror/state";
import { Annotation, Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

import type { Span } from "./locate.js";

/**
 * The nonce CodeMirror puts on the style element it adds, which the page's content security
 * policy names. The page is static, so the nonce is the same for everyone: it doesn't stop
 * someone who can add markup to the page (they can read it), it only keeps every other inline
 * style out. index.html must carry the same value; the build test checks it.
 */
export const STYLE_NONCE = "L_shkAhPkBB2hh1kxtdhtA";

/** The languages the views colour. */
export type Language = "json" | "rust" | "go" | "typescript" | "text";

/** The language of a generated file, by its extension. */
export function languageOf(path: string): Language {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".ts")) return "typescript";
  return "text";
}

function languageSupport(language: Language): Extension {
  switch (language) {
    case "json":
      return json();
    case "rust":
      return rust();
    case "go":
      return go();
    case "typescript":
      return javascript({ typescript: true });
    case "text":
      return [];
  }
}

/** Token colours, from the page's colour variables, so light and dark follow the page. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier, t.self], color: "var(--tok-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: "var(--tok-string)" },
  { tag: [t.number, t.integer, t.float], color: "var(--tok-number)" },
  { tag: [t.bool, t.null, t.atom, t.constant(t.name)], color: "var(--tok-literal)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--tok-comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: "var(--tok-type)" },
  { tag: [t.propertyName, t.definition(t.propertyName), t.labelName], color: "var(--tok-property)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: "var(--tok-function)" },
  { tag: [t.macroName, t.meta, t.annotation, t.attributeName, t.processingInstruction], color: "var(--tok-meta)" },
  { tag: [t.escape], color: "var(--tok-escape)" },
  { tag: t.invalid, color: "var(--bad)" },
]);

/** The look of every view, from the page's colour variables. */
const look = EditorView.theme({
  "&": {
    color: "var(--fg)",
    backgroundColor: "var(--code-bg)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    fontSize: "13px",
  },
  "&.cm-focused": { outline: "2px solid var(--accent)", outlineOffset: "1px" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", lineHeight: "1.5" },
  ".cm-content": { caretColor: "var(--fg)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  ".cm-gutters": { backgroundColor: "var(--code-bg)", color: "var(--muted)", borderRight: "1px solid var(--border)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--active-line)", color: "var(--fg)" },
  "& .cm-selectionBackground, &.cm-focused .cm-selectionBackground, & .cm-content ::selection": {
    backgroundColor: "var(--selection) !important",
  },
  "& .cm-selectionMatch": { backgroundColor: "var(--search-match)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--bracket)", outline: "1px solid var(--accent)" },
  "&.cm-focused .cm-nonmatchingBracket": { color: "var(--bad)" },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)", outline: "1px solid var(--warn)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--selection)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--panel)", color: "var(--muted)", border: "1px solid var(--border)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel input, .cm-panel button, .cm-panel label": { fontSize: "13px" },
  ".cm-textfield": { backgroundColor: "var(--bg)", color: "var(--fg)", border: "1px solid var(--border)" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--panel)", color: "var(--fg)", border: "1px solid var(--border)" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", color: "var(--fg)", border: "1px solid var(--border)" },
  ".cm-problem": { textDecoration: "underline wavy var(--bad)", textDecorationSkipInk: "none", backgroundColor: "var(--problem-bg)" },
  ".cm-unknown-key": { textDecoration: "underline dotted var(--warn)", textDecorationSkipInk: "none" },
});

/** CodeMirror's own defaults for light or dark, picked like the page's colours. */
const darkMode = new Compartment();
const darkQuery = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
const views = new Set<EditorView>();
darkQuery?.addEventListener("change", () => {
  for (const view of views) view.dispatch({ effects: darkMode.reconfigure(EditorView.darkTheme.of(darkQuery.matches)) });
});

/** A mark in a view: an error's place, or a key report mode dropped. */
export interface Mark extends Span {
  readonly kind: "problem" | "unknown-key";
  /** Shown as the mark's title, as plain text. */
  readonly title: string;
}

const setMarks = StateEffect.define<readonly Mark[]>();

const marks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setMarks)) continue;
      const length = tr.state.doc.length;
      const ranges: Range<Decoration>[] = effect.value
        .filter((m) => m.from >= 0 && m.to <= length && m.from < m.to)
        .map((m) => Decoration.mark({ class: `cm-${m.kind}`, attributes: { title: m.title } }).range(m.from, m.to));
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Marks a change the page makes itself, which isn't reported as an edit. */
const fromPage = Annotation.define<boolean>();

export interface EditorOptions {
  /** The accessible name of the text area. */
  readonly label: string;
  readonly language: Language;
  readonly editable: boolean;
  readonly text?: string;
  /** The id of an element that describes the view, like its keys. */
  readonly describedBy?: string;
  /** Wraps long lines instead of scrolling, for a short value. */
  readonly wrap?: boolean;
  /** Called with the text after each edit the user makes. */
  readonly onChange?: (text: string) => void;
}

/** One code view. */
export class CodeView {
  readonly view: EditorView;
  private readonly language = new Compartment();

  constructor(parent: HTMLElement, options: EditorOptions) {
    const onChange = options.onChange;
    const extensions: Extension[] = [
      EditorView.cspNonce.of(STYLE_NONCE),
      lineNumbers(),
      foldGutter(),
      highlightSpecialChars(),
      drawSelection(),
      bracketMatching(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(highlight),
      indentUnit.of("  "),
      EditorState.tabSize.of(2),
      look,
      darkMode.of(EditorView.darkTheme.of(darkQuery?.matches === true)),
      this.language.of(languageSupport(options.language)),
      marks,
      EditorView.contentAttributes.of({
        "aria-label": options.label,
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
        ...(options.describedBy === undefined ? {} : { "aria-describedby": options.describedBy }),
        ...(options.editable ? {} : { "aria-readonly": "true" }),
      }),
    ];
    if (options.wrap === true) extensions.push(EditorView.lineWrapping);
    if (options.editable) {
      // Tab indents. Escape, then Tab, moves on to the next control (CodeMirror's tab focus mode),
      // as does Ctrl-M (Shift-Alt-M on macOS), which turns that mode on until pressed again.
      extensions.push(
        history(),
        indentOnInput(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
      );
    } else {
      // Read only, but still focusable, so the keyboard can select, search and fold. Tab isn't bound.
      extensions.push(EditorState.readOnly.of(true), keymap.of([...defaultKeymap, ...searchKeymap, ...foldKeymap]));
    }
    if (onChange !== undefined) {
      extensions.push(
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromPage) === true)) {
            onChange(update.state.doc.toString());
          }
        }),
      );
    }
    this.view = new EditorView({ parent, state: EditorState.create({ doc: options.text ?? "", extensions }) });
    views.add(this.view);
  }

  get text(): string {
    return this.view.state.doc.toString();
  }

  /** Replaces the text, unless it is the same, without reporting it as an edit. Clears the marks. */
  setText(text: string, top = false): void {
    if (text === this.text) return;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor: 0 },
      effects: setMarks.of([]),
      annotations: fromPage.of(true),
      ...(top ? { scrollIntoView: true } : {}),
    });
  }

  setLanguage(language: Language): void {
    this.view.dispatch({ effects: this.language.reconfigure(languageSupport(language)) });
  }

  /** Shows these marks instead of the ones before. */
  mark(list: readonly Mark[]): void {
    this.view.dispatch({ effects: setMarks.of(list) });
  }

  destroy(): void {
    views.delete(this.view);
    this.view.destroy();
  }
}
