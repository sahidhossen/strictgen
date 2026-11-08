# Playground

A static page to try strictgen in the browser. Paste one or more schemas and see the Rust, Go, TypeScript and LLM output side by side. Paste a payload, pick a type, and see whether the generated TypeScript decoder accepts it, the error it gives, or the unknown keys it reports. Everything runs in the page. There is no server, and nothing you type is sent anywhere.

```bash
pnpm install
pnpm playground:build    # bundles the page into playground/dist
pnpm playground:serve    # serves it at http://127.0.0.1:4173/
```

Browsers don't start workers from a `file://` page, so open it through the server, or any static file server. `--port <port>` picks another port.

## What it runs

- **The real generator.** The page bundles `src/` as it is. `generateInMemory` in `src/memory.ts` takes schema texts and settings instead of a folder and a config file, and gives the same files `strictgen generate` writes, byte for byte, before formatting. A test holds it to the CLI on `examples/basic`, `examples/report` and `examples/llm`. The build fails when a module it pulls in from the repository imports one of Node's built in modules, or uses a Node global like `process` or `Buffer`, so the browser never gets a stand-in that behaves differently.
- **Unformatted Rust and Go.** The page doesn't run rustfmt or gofmt, so Rust and Go are shown as generated. `strictgen generate` formats them by default, which changes their layout. TypeScript and the LLM schemas are written as shown.
- **The generated TypeScript decoders.** The TypeScript compiler, bundled into the page, removes the types from the generated files with the target the conformance runner uses (ES2023), and the page links them as modules. The strict JSON reader in `helpers.ts` is the one the CLI writes. A test runs every conformance case and the shared LLM vectors of `examples/llm` through this path and checks the results the suite expects.
- **Defaults.** Every target is on, with the defaults a config file gives: decoders on, Rust's default lint allowances, Go's default package, no fixture registries. The settings pick the read mode, the built in LLM profiles, the cleanup step, the Rust serde bridge and the ID rule. Schema file names are lowercase letters, digits and dashes, ending in `.json`, as `$ref` can name them.

The decoders are `decodeXFromJson` in strict mode, `reportXFromJson` in report mode, and `decodeXFromLlm` for LLM output. An accepted value is encoded again with `encodeXToJson`. A rejected one shows the shared error, `path`, `code`, `expected`, `found` and the message, and its compact form. The conformance suite holds the Rust and Go decoders to the same results.

## Editors

The schema and payload editors and the four output panes are [CodeMirror 6](https://codemirror.net/) views, bundled into `app.js` (about 580 KiB minified; nothing is loaded from elsewhere). They colour JSON, Rust, Go and TypeScript, and have line numbers, bracket matching, folding and search (Ctrl-F, or Cmd-F on macOS). The output panes and the encoded value are read only, but can be focused, selected and searched. The colours follow the system's light or dark setting.

- **Keyboard.** In the schema and payload editors, Tab indents. Press Escape, then Tab, to move on to the next control, or Ctrl-M (Shift-Alt-M on macOS) to make Tab move focus until pressed again. The read-only panes don't take Tab at all.
- **Marks.** When a payload is rejected, the place its error's `path` names is underlined in the payload: the value, or the key for an unknown or duplicate key, or for a missing key the object it is missing from. A JSON syntax error marks the character where reading stopped. In report mode the unknown keys that were dropped are marked too. The place is found by `playground/src/locate.ts`, which reads the text with the grammar of the generated strict reader, so places stay right after escapes and astral characters (positions are in UTF-16 units, as the editor counts them). A test holds it to the generated reader on a set of valid and broken texts: it accepts the same ones, finds the same value at each place, and stops at the same offset. Through the LLM decoder, whose cleanup step can change the text first, only an error at a path the text has is marked. A generation error is underlined in the schema at its pointer, by the key that names the schema or keyword at fault, with the grammar `JSON.parse` reads schemas with. A schema nested more than 512 arrays and objects deep gets no mark. A mark's title holds the error message. Marks are only a hint: if finding one fails, the page shows none and renders the rest as usual.
- **Undo.** Each schema file has its own undo history: switching files, or opening a link, starts it again, so undo never brings back another file's text.

## Safety

- Generation and decoding run in a Web Worker. A request that takes more than 5 seconds, like a pattern that backtracks a lot on a payload, stops the worker, and a new one starts.
- The page sets every piece of text with `textContent`, as an input's value or as a CodeMirror document, never as markup. A CodeMirror document is text: the editors build their lines from text nodes, and the marks set their title as an attribute. The build test bans a fixed list of markup calls, by name: `app.js` as bundled, CodeMirror included, may not contain `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `createContextualFragment`, and the page's own sources may not contain the first four or `setAttribute("style"`. That is a list of known names, not a proof that nothing else can make markup.
- The page loads only its own four files. Its content security policy (a `meta` tag) allows scripts, styles and the worker from the same origin only, and no network requests.
- **Styles and the nonce.** CodeMirror adds one `<style>` element at run time with its base styles, which `style-src 'self'` alone would block. The policy allows it by a nonce, `style-src 'self' 'nonce-...'`, which `editor.ts` passes to CodeMirror (`EditorView.cspNonce`) and the build test checks against the page. Every other inline `<style>` element and `style` attribute stays blocked. The page is static, so the nonce is the same for everyone and anyone can read it: it doesn't stop someone who can already add markup to the page, so it is defence in depth only, not a secret. The page has no way to add markup from user text in the first place. Scripts, the worker and network requests are as strict as before. A worker gets the policy its own response carries, not the page's, so the worker can run the code it compiles; GitHub Pages sends no policy. So each generated module also runs with `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `self` and `globalThis` undefined in its scope.
- When the worker script doesn't load, the page says so and offers a Retry button.

## Sharing

The page keeps its state in the URL fragment, after the `#`, which browsers don't send to the server: the schemas, the settings, the payload, the type and the decoder, as JSON compressed with deflate and written as base64url after `v1.`. The address bar holds the state after each change, and Copy link copies it. A link longer than 400,000 characters, or one that decompresses past 2,000,000 bytes, isn't read, and neither is one with a field that isn't valid. The page then says why and shows the example.

## Build output

`playground/dist` isn't committed: git ignores it like every `dist/` folder. CI builds and tests the page on every pull request, and the deploy workflow builds it again from the commit it deploys. The worker is about 4 MB, most of it the TypeScript compiler. `app.js` is about 580 KiB, most of it CodeMirror, and the build test fails when it passes 700 KiB.

## Deploying

`.github/workflows/playground.yml` deploys the page to GitHub Pages. It runs only by hand (`workflow_dispatch`), and only when the repository is public: the jobs are skipped for a private repository, and the build job checks the visibility again through the API before it uploads anything. It doesn't turn Pages on. Pages must be set to deploy from GitHub Actions in the repository settings first.
