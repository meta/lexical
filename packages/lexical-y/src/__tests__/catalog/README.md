# Input-space catalogs

The tests of `@lexical/y` (and of block ids, handles and marks) draw their
inputs from three catalogs here, so that they cover what the types and the
apps allow rather than the cases someone thought of:

- `nodes.ts`: one entry (`NodeShape`) per node shape: every `TextNode`
  subclass and mode (token, segmented, tab, code highlight, hashtag, mention,
  emoji, keyword, ruby, ...), inline elements that refuse text at their edges
  (link, autolink, mark), inline and block decorators (with and without text,
  with nested editors, with NodeState fields), named-slot hosts (declared and
  undeclared slots, including a downstream-style component whose slots hold
  shadow roots of blocks), lists of every type with custom `start` and
  nesting, tables with merged cells and lists in cells, quotes, headings, code,
  collapsibles, layouts and pages. `downstream.ts` holds stand-ins for node
  shapes that apps register and no package has.
- `ids.ts`: every block id format: random, positional, `@lexical/y` derived
  ids (`y<client>_<clock>` with its suffixes), duplicates awaiting repair,
  UUIDv7, counters, legacy `b` + base 36, and mixed documents.
- `configs.ts`: every configuration dimension (BlockIdExtension enabled,
  disabled or absent; bind mode; headless or jsdom; `createYDoc` or a plain
  `Y.Doc`; schema versions; read-only causes; mark flavors; IME; batched
  updates; `onError`), and `configProduct` to run a contract over the product
  of the dimensions that apply, sampled but holding every value.
- `bind.ts`: the app extension that registers every catalog node, seeding a
  state with shapes, binding a fresh editor to it the ways an app does, and
  snapshots to compare (JSON, derived fields, list numbering).
- `peers.ts`: the binding dimension. Peers bound with `@lexical/y`,
  `@lexical/yjs` v1 or v2 on their own documents, a queue of their updates
  delivered one at a time in any order (channels keep theirs), and app
  behaviours that run after remote changes (a follow-up update, a repair of
  the table rows a peer created).
- `ops.ts`: edits from the core packages (text, formats, marks, paragraphs,
  table rows and columns, list type and start) that multi-peer tests and soak
  generators draw from.

## Rules

- `unit/matrix/NodeCatalog.test.ts` fails when `lexical`, a `@lexical/*`
  package or the playground exports or declares a node class that no shape
  builds. Add a shape for it (or, for an abstract or internal class, an entry
  in `NODE_EXCLUSIONS` with the reason).
- A new id format goes in `ID_FORMATS`; a new option or mode that changes
  behaviour goes in `CONFIG_DIMENSIONS`.
- A new node class, option, id format or public export lands together with
  its catalog entry and the contract that covers it; a change to how an
  existing one behaves updates both.
- Every new or changed public export ships with a matrix test in
  `unit/matrix/` that runs its contract over the catalogs that apply: every
  node shape, id format and configuration at least once. The standing
  contracts: a bound editor shows what a fresh `readYState` of its document
  shows (C1), documented input never throws (C2), untrusted input is refused
  rather than thrown on (C3), handles stay short and typo safe for every id
  format (C4), and cost stays linear with every extension enabled and
  disabled (C5).
- A cell that fails because of a known bug is `test.fails`, selected exactly
  and with a comment naming the pull request or issue that fixes it, so it
  must pass once the fix lands.
- The default run samples the product so it stays fast, and is what CI
  runs; `MATRIX_FULL=1` runs all of it, to explore. Cells only the full run
  reaches are not marked, so it can fail on open issues (for example more
  seeds of #9581, #9583, or the row repair races of #9582).

## Not covered yet

- The read-only cause where a read throws and the binding stops reading
  (`readOnly: 'frozen'`).
- Editors made with `createEditor` and a node list instead of extensions
  (`editor: 'nodes'`); the package's own tests bind those.
- Contracts for open pull requests' new exports live with those pull
  requests until they merge.
