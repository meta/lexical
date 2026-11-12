# Mdast Editor (dev example)

A WYSIWYG Markdown editor with an editable Markdown source pane
(synchronized in both directions, exercising import and export), built on
the unreleased
[`@lexical/mdast`](../../packages/lexical-mdast) package — the
micromark/mdast-based alternative to `@lexical/markdown`. It is a port of
[`examples/markdown-editor`](../../examples/markdown-editor), which is the
same app built on the legacy bespoke implementation; comparing the two shows
what the extension-first design removes.

```bash
pnpm run start:dev-example mdast-editor
```

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/meta/lexical/tree/main?file=dev-examples%2Fmdast-editor%2Fsrc%2FEditor.tsx&startScript=start:dev-example:mdast-editor)

Because this example depends on unreleased workspace packages, the
StackBlitz link opens the monorepo root and boots the example with the
`start:dev-example:mdast-editor` script.

Deployed builds of every dev example are served from the lexical
website at `/dev-examples/<name>/` (this one at
[/dev-examples/mdast-editor/](https://lexical.dev/dev-examples/mdast-editor/)),
including on every Cloudflare/Vercel deploy preview. To build them
locally: `pnpm run build && pnpm run build:dev-examples` at the
monorepo root, which outputs into
`packages/lexical-website/static/dev-examples/`. These are built from
the development artifacts on purpose — they are demos, and the
development builds keep Lexical's full error messages.

## Repro links

The document can be seeded from the URL hash (mirroring the playground's
`#doc=` convention), which makes bug reports reproducible with a plain
link. Two encodings, so a repro can use whichever fits:

- `#md=<encodeURIComponent(markdown)>` — the Markdown source, hand-editable
  directly in the URL:
  `/dev-examples/mdast-editor/#md=%23%20Repro%0A%0A*hello*`
- `#doc=<base64url(gzip(SerializedDocument))>` — the full editor state
  JSON (via `@lexical/file`), for node/state shapes Markdown can't
  express.

The **Share MD** / **Share JSON** buttons in the Markdown pane header put
the current document in the URL (and on the clipboard) in each encoding.
While a hash document is shown, localStorage persistence is suspended so a
repro link never clobbers locally persisted work; **Reset** drops the hash
and resumes normal persistence.

## What got simpler vs. `examples/markdown-editor`

The legacy example's `MarkdownExtension.ts` is ~240 lines; the equivalent
[`MdastEditorExtension.ts`](./src/extensions/MdastEditorExtension.ts) here is
example plumbing only (the preview signal and two toolbar commands), because
`@lexical/mdast` ships extension-ready:

- **No transformer list to curate.** Depending on `MdastCommonMarkExtension`
  and `MdastGfmExtension` pulls in their grammar and every node they need.
- **No `registerMarkdownShortcuts` call.** `MdastShortcutsExtension`
  registers the streaming shortcuts itself, driven by the same micromark
  grammar as document import.
- **No checklist workaround.** The legacy example needed a custom
  `text-match` transformer (`CHECK_LIST_ITEM`, ~50 lines) so `[ ] ` typed in
  an existing bullet item would convert; that behavior is built in.
- **No newline-handling configuration.** `shouldPreserveNewlines` /
  `mergeAdjacentNewlines` don't exist; micromark parses CommonMark as-is
  and the original syntax is preserved on the nodes via `NodeState`.

It also does more: blockquotes, links, strikethrough, thematic breaks, and
fenced code blocks round-trip out of the box (the legacy example's default
set covered headings, lists, and inline formatting); GFM tables are edited
with `TableExtension` and the toolbar's Table menu, and written as near as
GFM allows where a table holds more than it can (merged cells, say); and
the code blocks are syntax-highlighted by adding `CodeShikiExtension` —
highlighting composes with the Markdown machinery without any extra wiring.

## Bundle size

The flip side of parsing with micromark is bundle weight. Build the
production dist artifacts first, then run the comparison:

```bash
pnpm run build-prod   # at the monorepo root
npm run size          # in this directory
```

It builds functionally-equivalent headless bundles — editor + markdown
node set + typing shortcuts + import/export — one per implementation, from
the production dist artifacts, and prints their sizes. All include the
lexical core, so the deltas are the markdown machinery itself. Snapshot at
the time of writing:

| bundle                     | minified  | min+gzip |
| -------------------------- | --------- | -------- |
| legacy `@lexical/markdown` | 287.3 kB  | 77.3 kB  |
| `@lexical/mdast`           | 408.6 kB  | 103.6 kB |
| delta (full vs legacy)     | +121.4 kB | +26.3 kB |

The dist build keeps the micromark/mdast dependencies external, so the app
bundler resolves them with browser export conditions and tree-shakes what's
unused.
