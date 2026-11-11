/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Emit specialized `exportJSON`, `updateFromJSON` and `afterCloneFrom`
 * implementations for the node classes in {@link MANIFEST}, from the same
 * serialization schema those classes declare, using `@lexical/compiler`'s
 * SchemaJsonCodegen pass.
 *
 * Both schema-driven paths walk a compiled table per node: a loop, an indirect
 * call per property, and a keyed store whose key changes every iteration.
 * Everything they decide — which accessor to use, what the node's type string
 * is, what each property's domain admits — is fixed once the schema is written,
 * so it can be decided here instead and emitted as straight-line code. That is
 * what the hand-written methods this schema replaced used to be, recovered
 * without hand-writing them.
 *
 * Each package gets its own generated module beside its nodes, and each class
 * passes its own generated code to `$config`, so the association is carried by
 * the class rather than derived from its type string; a subclass whose
 * accessor tables compile the same way inherits it, which is why `type` is
 * read off the node rather than emitted as a literal. The compact form
 * compares each property against its default; a reference-typed default has no
 * literal a value could be `===`, so it gets the structural test the schema's
 * own equality reduces to where that can be stated (MarkNode's `ids`, an empty
 * array), and where it cannot be stated the property is simply written rather
 * than omitted — the omission is the optimization, and one property that
 * cannot justify it should not cost its siblings theirs.
 *
 * The import direction is the untrusted-JSON boundary and has to reproduce
 * each property's validation exactly, so every emitted parser is checked here
 * against the schema it was compiled from, over a corpus derived from that
 * schema plus a fixed set of hostile values. A property whose schema this
 * cannot compile — or compiles wrongly — takes the class out of the import
 * half rather than shipping a parser that disagrees with the walk.
 *
 * `afterCloneFrom` is the third direction, and the one whose fallback is not
 * the walk: a class that declares schema fields gets one synthesized at
 * registration whether or not it is generated here, because a field is where a
 * property is stored and a clone that drops it loses the value silently. What
 * is emitted is that same field list as straight-line assignments, so a class
 * generated here pays no loop for it.
 *
 * Reading a schema needs no editor and constructs no node: `$config()` is a
 * plain method on the prototype, so this runs as an ordinary build step.
 *
 * This module is the generation itself. `scripts/generate-node-json.mjs` runs
 * it (`pnpm run generate-node-json`) after a stub phase that keeps the imports
 * loadable, and `LexicalGeneratedJSON.test.ts` runs it in-process into a
 * temporary directory and fails if any checked-in output is stale or
 * disagrees with the schema-driven path.
 */

import {
  compileDiffersFromDefault,
  compileParse,
  NotCompilable,
  NUM_CLAMP_HELPER_SOURCE,
  NUM_HELPER_SOURCE,
  NUM_RANGE_HELPER_SOURCE,
  verificationCorpus,
  verifyCompiledParse,
  verifyTableCoversDomain,
} from '@lexical/compiler/SchemaJsonCodegen';
// The synchronous wrapper rather than `prettier` itself, for the same reason
// the test utilities use it: under vitest, `prettier` resolves to its browser
// build (the config resolves with the `browser` condition), which has no
// `resolveConfig`, while this runs the real one in a worker wherever it is
// loaded. Generation is not a hot path.
import prettier from '@prettier/sync';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

import {
  HEADER,
  INTERFACE_SOURCE,
  MANIFEST,
} from './generateNodeJSONManifest.mjs';

/** @typedef {import('lexical').LexicalNode} LexicalNode */
/** @typedef {import('lexical').Klass<LexicalNode>} NodeClass */
/** @typedef {import('lexical').AnySerializationSchema} AnySchema */

const REPO = join(import.meta.dirname, '..', '..');

// Bare specifiers rather than paths to the sources: tsconfig's `paths` maps
// each to its package's src for both tsx and the type checker, and a specifier
// ending in `.ts` is a type error under this repo's settings.
const {
  aliasTableOf,
  ElementNode,
  isSchemaField,
  LineBreakNode,
  ParagraphNode,
  TabNode,
  TextNode,
} = await import('lexical');
// The first two are `@internal` — how a class composes its schema and which accessor a
// field stands in for are this codegen's concern and the walk's, not a public
// API to be frozen by the backwards-compatibility rule — so they are reached
// through the module that declares them rather than the package entry point.
// `paths` maps `lexical/src/*` the same way it maps `lexical`, so this is the
// same module instance the editor uses, not a second copy.
//
// Resolved together: `lexical` above is what the rest transitively need
// registered, and these do not depend on one another, so awaiting them in
// series made this preamble cost the sum of their TypeScript transforms rather
// than the longest.
const [
  {
    declaresOwnAfterCloneFrom,
    getComposedSchema,
    ownSchemaFields,
    resolveGetterAccessor,
    resolveSetterAccessor,
  },
  {declaredAccepts},
  {HeadingNode, QuoteNode},
  {AutoLinkNode, LinkNode},
  {MarkNode},
  {ListItemNode, ListNode},
  {TableCellNode, TableNode, TableRowNode},
  {CodeHighlightNode, CodeNode},
  {DecoratorBlockNode},
] = await Promise.all([
  import('lexical/src/LexicalUtils'),
  import('lexical/src/LexicalSchema'),
  import('@lexical/rich-text'),
  import('@lexical/link'),
  import('@lexical/mark'),
  import('@lexical/list'),
  import('@lexical/table'),
  import('@lexical/code-core'),
  import('@lexical/react/LexicalDecoratorBlockNode'),
]);

/**
 * The classes each generated module serializes, in the order their code is
 * emitted, with the module each type import comes from. The list is what to
 * extend to specialize another class; everything else is derived from its
 * schema.
 *
 * @type {readonly {
 *   file: string,
 *   home?: boolean,
 *   targets: readonly {
 *     klass: NodeClass,
 *     module: string,
 *   }[],
 * }[]}
 */
const PACKAGES = [
  {
    file: 'packages/lexical/src/LexicalGeneratedJSON.ts',
    home: true,
    targets: [
      {klass: ElementNode, module: './nodes/LexicalElementNode'},
      {klass: TextNode, module: './nodes/LexicalTextNode'},
      {klass: ParagraphNode, module: './nodes/LexicalParagraphNode'},
      {klass: LineBreakNode, module: './nodes/LexicalLineBreakNode'},
      {klass: TabNode, module: './nodes/LexicalTabNode'},
    ],
  },
  {
    file: 'packages/lexical-rich-text/src/LexicalRichTextGeneratedJSON.ts',
    targets: [
      {klass: HeadingNode, module: './index'},
      {klass: QuoteNode, module: './index'},
    ],
  },
  {
    file: 'packages/lexical-link/src/LexicalLinkGeneratedJSON.ts',
    targets: [
      {klass: LinkNode, module: './LexicalLinkNode'},
      {klass: AutoLinkNode, module: './LexicalLinkNode'},
    ],
  },
  {
    file: 'packages/lexical-mark/src/LexicalMarkGeneratedJSON.ts',
    targets: [{klass: MarkNode, module: './MarkNode'}],
  },
  {
    file: 'packages/lexical-list/src/LexicalListGeneratedJSON.ts',
    targets: [
      {klass: ListNode, module: './LexicalListNode'},
      {klass: ListItemNode, module: './LexicalListItemNode'},
    ],
  },
  {
    file: 'packages/lexical-table/src/LexicalTableGeneratedJSON.ts',
    targets: [
      {klass: TableNode, module: './LexicalTableNode'},
      {klass: TableRowNode, module: './LexicalTableRowNode'},
      {klass: TableCellNode, module: './LexicalTableCellNode'},
    ],
  },
  {
    file: 'packages/lexical-code-core/src/LexicalCodeCoreGeneratedJSON.ts',
    targets: [
      {klass: CodeNode, module: './CodeNode'},
      {klass: CodeHighlightNode, module: './CodeHighlightNode'},
    ],
  },
  {
    file: 'packages/lexical-react/src/shared/LexicalReactGeneratedJSON.ts',
    targets: [
      {klass: DecoratorBlockNode, module: '../LexicalDecoratorBlockNode'},
    ],
  },
];

/**
 * Whether `source` *code* mentions `name` as an identifier of its own, rather
 * than as part of a longer one or inside a string.
 *
 * This decides what a generated module declares at its top level — which
 * lookup tables, which numeric helpers — so both ways of being wrong about it
 * break the build. Claiming a reference that is not one declares something
 * nothing uses, which `noUnusedLocals` rejects; missing one drops a
 * declaration the code below still reads, which is a `ReferenceError`.
 *
 * A scan rather than a regexp: a table's name is derived from a schema key, so
 * it may contain `$`, which a pattern would read as an anchor. The name was
 * interpolated unescaped, and `DOLLAR_$MODE_GETTER` then matched nothing — so
 * the declaration was dropped as unreferenced while the code that reads it was
 * kept. Nothing here is a pattern, so nothing in a name can be read as one.
 *
 * String literals are not code, and a schema's values reach the output as
 * string literals: a `stringValue('numC(')` default put `numC(` in the module
 * without calling anything. They are masked out before the scan.
 *
 * @param {string} source
 * @param {string} name
 * @returns {boolean}
 */
export function references(source, name) {
  if (name === '') {
    // No name is empty — every one is a table name or a helper name — and the
    // scan below would not terminate for one, since `indexOf('', n)` never
    // runs off the end.
    return false;
  }
  const code = maskStringLiterals(source);
  const identifier = /[A-Za-z0-9_$]/;
  for (
    let at = code.indexOf(name);
    at !== -1;
    at = code.indexOf(name, at + 1)
  ) {
    const before = at === 0 ? '' : code[at - 1];
    const after = code[at + name.length] || '';
    if (!identifier.test(before) && !identifier.test(after)) {
      return true;
    }
  }
  return false;
}

/**
 * `source` with the contents of every string literal replaced by spaces, so a
 * scan over it finds only code and still reports the offsets `source` has.
 *
 * Double quotes alone, which is every string the generator writes: the values
 * go through `JSON.stringify`, and the emitted names and keys are quoted the
 * same way. Prettier rewrites them to single quotes, but that runs on the
 * finished module, after everything this answers for. A `'` in the output is
 * therefore prose — `"ListNode's serialization schema"` — and masking from one
 * would swallow the rest of the module.
 *
 * @param {string} source
 * @returns {string}
 */
function maskStringLiterals(source) {
  let masked = '';
  let at = 0;
  while (at < source.length) {
    const open = source.indexOf('"', at);
    if (open === -1) {
      return masked + source.slice(at);
    }
    masked += source.slice(at, open + 1);
    let end = open + 1;
    while (end < source.length && source[end] !== '"') {
      // A backslash escapes whatever follows it, including a quote and
      // including another backslash — so `"a\\"` ends at the third quote and
      // `"a\""` does not end at the second.
      end += source[end] === '\\' ? 2 : 1;
    }
    // An unterminated literal would mean the generator emitted something that
    // does not parse, which `parseAsModule` is what catches; masking to the
    // end is the reading that cannot invent a reference.
    const close = Math.min(end, source.length);
    masked += ' '.repeat(close - open - 1);
    masked += close < source.length ? '"' : '';
    at = close + 1;
  }
  return masked;
}

/**
 * `expression` with its one mention of `v` replaced by the property's read, or
 * `null` where `v` is mentioned any other number of times.
 *
 * A parse that reads the property once needs no variable to hold it:
 * `num(json.indent, 0)` says what `v = json.indent; num(v, 0)` said. One that
 * reads it twice — every `typeof v === 'string' ? v : ''` — still binds, or
 * the read would happen twice.
 *
 * The read is a member expression, so it binds tighter than anything it can be
 * substituted into and needs no parentheses. String literals are masked for
 * the scan, as everywhere else here: a `stringValue('v')` default is not a
 * mention of the variable.
 *
 * @param {string} expression
 * @param {string} read
 * @param {string} name the local the expression reads the value from
 * @returns {null | string}
 */
function inlineSingleUse(expression, read, name) {
  const code = maskStringLiterals(expression);
  const identifier = /[A-Za-z0-9_$.]/;
  /** @type {number[]} */
  const at = [];
  for (
    let i = code.indexOf(name);
    i !== -1;
    i = code.indexOf(name, i + name.length)
  ) {
    // `.` counts as part of a name here so a property called `v` — `json.v`,
    // which is what `ownRead` emits for a key of that name — is not read as
    // the variable.
    const before = i === 0 ? '' : code[i - 1];
    const after = code[i + name.length] || '';
    if (!identifier.test(before) && !identifier.test(after)) {
      at.push(i);
    }
  }
  return at.length === 1
    ? `${expression.slice(0, at[0])}${read}${expression.slice(
        at[0] + name.length,
      )}`
    : null;
}

/** `MarkNode` → `GENERATED_MARK`. */
const constName = (/** @type {NodeClass} */ klass) =>
  `GENERATED_${klass.name.replace(/Node$/, '').toUpperCase()}`;

/**
 * The lookup tables the class being generated reads, by the local name its
 * code refers to each by, each mapped to the declaration that binds it: a
 * read off the class's composed schema, which the factory emitted for the
 * class is handed when its code is attached. Reset per class by
 * {@link generatePackage}.
 *
 * Nothing about a table's contents is written into the module: the table the
 * generated code reads is the schema's own object, so the two cannot differ,
 * and a value JSON has no spelling for — `undefined`, `Infinity` — is no
 * concern of the generator's. What the module states is the table's *type*,
 * so the field a value is assigned to is checked as it would be for a
 * hand-written table.
 *
 * Every table is null-prototype, because every table can be reached by a key
 * it does not have: without it a `'toString'` would resolve to
 * Object.prototype's method rather than missing, and be stored (import) or
 * serialized (export) as the property's value. The helper each local is
 * bound through hands back a null-prototype copy of the schema's object, so
 * the `in` tests the compiled expressions use ask the same question the
 * walk's `hasOwnKey` asks of the original.
 *
 * @type {Map<string, string>}
 */
const tableLocals = new Map();

/**
 * Bind a lookup table to a local name in the class being generated, refusing
 * to bind two different declarations to one name.
 *
 * Names are derived by upper-casing the class and property, which is not
 * injective — `textFormat` and `textformat` produce the same name. Without
 * this the second binding would replace the first under a name the class's
 * emitted code is already reading, which no amount of verification downstream
 * would catch: the class compiles, and one property silently decodes through
 * the other's table.
 *
 * Exported for `generateNodeJSON.test.ts`, which is the only place the
 * collision can be provoked: the checked-in manifest has none.
 *
 * @param {string} name
 * @param {string} declaration the expression the local is bound to
 * @returns {string} `name`
 */
export function declareTable(name, declaration) {
  const existing = tableLocals.get(name);
  if (existing !== undefined && existing !== declaration) {
    throw new Error(
      `generate-node-json: two different lookup tables both want the name ${name}; rename one of the properties it was derived from`,
    );
  }
  tableLocals.set(name, declaration);
  return name;
}

/**
 * The locals the forms generated since the last class began have bound, as
 * `[name, declaration]` pairs — what {@link generatePackage} reads after a
 * class's four forms. Exported for `generateNodeJSON.test.ts`, which
 * assembles one class's factory body the same way to run its parser.
 *
 * @returns {[string, string][]}
 */
export function tableDeclarations() {
  return [...tableLocals];
}

/**
 * How many locals the parsers generated since the last class began have bound.
 * A collapsing wrapper names its parse rather than writing it twice (see
 * `CompiledExpression.statements`), and every property of a class is applied
 * in one function, so the numbering runs across the class.
 */
let parseBindings = 0;

/**
 * The numeric helpers the parses compiled since the last class began call, as
 * `compileParse` reported them. Recorded rather than read back off the
 * emitted text: a scan cannot tell a call from a property of that name, and a
 * schema may name one (`json.num` for a property called `num`, and `num:` in
 * the exporter beside it) — which declared a helper nothing called, and
 * `noUnusedLocals` then failed the build over what a property was called.
 *
 * @type {Set<string>}
 */
const parseHelpers = new Set();

/**
 * The helpers {@link parseHelpers} has collected for the class in progress.
 *
 * Read by {@link generatePackage} after a class's forms, and only kept when
 * that class ends up with a parser: a class that turned out not to be
 * compilable reported its helpers on the way to being refused, exactly as it
 * declared its tables.
 *
 * @returns {string[]}
 */
function parseHelpersUsed() {
  return [...parseHelpers];
}

/**
 * A fresh local for one compiled parse to bind, which is what
 * {@link compileParse} is handed.
 *
 * @returns {string}
 */
function parseBinding() {
  return `p${parseBindings++}`;
}

/**
 * Begin a class: forget the locals the previous one bound. What
 * {@link generatePackage} does before each class's four forms; exported for
 * the test that assembles a factory body by hand, since the forms it calls
 * bind into the same registry as every class generated before them.
 */
export function resetTableLocals() {
  tableLocals.clear();
  parseHelpers.clear();
  parseBindings = 0;
}

/**
 * The declaration that binds one of a property's lookup tables: a read off
 * the composed schema through the `lexical` helper for its kind, asserted to
 * the union of the table's literal values, since the helper can only say
 * `unknown` and the field the value is assigned to is narrower.
 *
 * Exported for `generateNodeJSON.test.ts`: which tables the checked-in
 * modules bind is decided by the manifest classes, so a value shape none of
 * them uses can only be driven through here.
 *
 * `setterDefault` is the one value read rather than a table: the stored form
 * of the schema's default, which the parser stores for a key the setterTable
 * table does not map, asserted to the same union as the table's values since
 * it is one of them.
 *
 * @param {'getter' | 'setter' | 'alias' | 'setterDefault'} kind
 * @param {string} key the schema property
 * @param {{readonly [key: string]: unknown}} table
 * @param {number} [index] which alias table, outermost first
 * @returns {string}
 */
export function tableDeclaration(kind, key, table, index) {
  const args = [JSON.stringify(key), ...(index === undefined ? [] : [index])];
  const type = tableValueType(table);
  return kind === 'setterDefault'
    ? `setterDefaultOf(fields, ${args.join(', ')}) as ${type}`
    : `${kind}TableOf(fields, ${args.join(', ')}) as {readonly [key: string]: ${type}}`;
}

/** @param {NodeClass} klass @param {string} key @param {string} suffix */
function tableName(klass, key, suffix) {
  return `${klass.name.replace(/Node$/, '').toUpperCase()}_${key.toUpperCase()}_${suffix}`;
}

// A plain JavaScript identifier, which is what every name below is interpolated
// into the output as — `node.<field>`, `const <key>`, `{<key>: ...}`. Anything
// else is either a syntax error the formatter would report against generated
// code rather than against the schema that caused it, or — for a name that
// happens to parse — code that reads something other than what was declared.
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Names a generated local may not take, though a serialized property may be
 * called any of them and every one passes a check of the name's *shape*. A
 * property named for one of these keeps its name everywhere it is a property
 * (`json.default`, `node.__default`) and is bound under a renamed local; see
 * {@link localFor}.
 *
 * Three groups, and every one of them is silent:
 *
 * A reserved word cannot be bound at all, so `const default = json.default;`
 * is a SyntaxError in a module that otherwise looks fine — as are `arguments`
 * and `eval`, which strict mode rules out and every emitted module is strict.
 *
 * The globals the ECMAScript grammar puts on the global object, which the
 * emitted code reads as free variables, so binding one shadows it.
 * `const undefined = node.__label;` makes the omission test
 * `undefined !== undefined`, which is false for every value, and the compact
 * form drops the property it was meant to write. `const Array = node.__tags;`
 * shadows the `Array.isArray` an empty-array default compares through.
 *
 * The whole set is listed rather than the handful the templates read today.
 * Which scope reads which global is a property of the emit templates and
 * changes when they do, so a list of "the ones we use" is one a template can
 * silently outgrow; the language's own set is closed, and a name in it is
 * never a name generated code should bind whether or not anything reads it
 * yet. Runtime globals are deliberately not consulted (`name in globalThis`
 * would make the output depend on the Node version that produced it).
 */
const RESERVED_NAMES = new Set(
  `await break case catch class const continue debugger default delete do else
   enum export extends false finally for function if implements import in
   instanceof interface let new null package private protected public return
   static super switch this throw true try typeof var void while with yield
   arguments eval

   globalThis Infinity NaN undefined isFinite isNaN parseFloat parseInt
   decodeURI decodeURIComponent encodeURI encodeURIComponent AggregateError
   Array ArrayBuffer Atomics BigInt BigInt64Array BigUint64Array Boolean
   DataView Date Error EvalError FinalizationRegistry Float16Array Float32Array
   Float64Array Function Int8Array Int16Array Int32Array Intl JSON Map Math
   Number Object Promise Proxy RangeError ReferenceError Reflect RegExp Set
   SharedArrayBuffer String Symbol SyntaxError TypeError Uint8Array
   Uint8ClampedArray Uint16Array Uint32Array URIError WeakMap WeakRef
   WeakSet`.split(/\s+/),
);

/**
 * The local a generated form binds for a schema key or predicate.
 *
 * The name itself wherever it can be bound, which is every name in the
 * checked-in output, so nothing about the generated modules changes. For one
 * that cannot, an underscore is appended until the result is free among the
 * names already spoken for in that scope, so the rename cannot collide with a
 * sibling property that happens to be spelled that way.
 *
 * @param {string} name
 * @param {Set<string>} taken the names bound in the same scope
 * @returns {string}
 */
function localFor(name, taken) {
  return boundElsewhere(name) ? freeName(`${name}_`, taken) : name;
}

/**
 * `candidate`, or the first name after it that nothing in the same scope
 * binds, by appending underscores.
 *
 * The one place the escape is spelled, because the two callers have to agree
 * on it: a local renamed one way and a derived local renamed another collide
 * again, which is the whole failure this exists to prevent.
 *
 * @param {string} candidate
 * @param {Set<string>} taken the names bound in the same scope
 * @returns {string}
 */
function freeName(candidate, taken) {
  let name = candidate;
  while (taken.has(name) || boundElsewhere(name)) {
    name = `${name}_`;
  }
  return name;
}

/**
 * Whether `name` is spoken for wherever a generated form binds a local, and so
 * has to be renamed to be bound at all.
 *
 * Distinct names never rename to the same local: the rename only ever appends
 * underscores, and it appends past a name already `taken` in the scope.
 *
 * @param {string} name
 * @returns {boolean}
 */
function boundElsewhere(name) {
  return (
    RESERVED_NAMES.has(name) ||
    EMITTED_LOCALS.has(name) ||
    // The locals `parseBinding` hands out for a nested parse.
    /^p\d+$/.test(name)
  );
}

/**
 * {@link localFor}, bound to the names one class's forms bind: the emitted
 * locals, every schema key, and every `when` predicate.
 *
 * Every schema key, not only the ones `reads` mentions. A property declared
 * import-only (`getter: null`) has no read, so the exporter never names it —
 * but the parser binds a local for it like any other, and a rename that could
 * not see it landed straight on top of one: `default` beside a sibling really
 * called `default_` bound that name twice.
 *
 * @param {NodeClass} klass
 * @param {readonly {when?: string}[]} reads for the predicate names, which
 *   only a property the exporter reads has
 * @returns {(name: string) => string}
 */
function localsFor(klass, reads) {
  const taken = new Set([
    ...EMITTED_LOCALS,
    ...schemaKeysOf(klass),
    ...reads.flatMap(read => (read.when === undefined ? [] : [read.when])),
  ]);
  return name => localFor(name, taken);
}

/**
 * The parameter a compact exporter takes its run-time comparisons through; see
 * {@link generateCompactExport}.
 */
const COMPACT_DEFAULT_PARAM = 'isCompactDefault';

// The names the emitted functions bind themselves — parameters and the two
// scratch locals. A property named for one of these is bound under a renamed
// local, like a reserved word or a global; see {@link localFor}.
const EMITTED_LOCALS = new Set([
  COMPACT_DEFAULT_PARAM,
  'json',
  'node',
  'num',
  'numC',
  'numK',
  'prevNode',
  'v',
]);

/**
 * Check a name before it is interpolated into the output as an identifier.
 *
 * The *shape* is all this can decide for a name in a property position
 * (`json.<key>`, `node.<field>`), which is most of them; a name that also gets
 * a local is renamed rather than refused, so nothing here has to know what
 * generated code binds. The one thing left to refuse is two names in the same
 * scope that are the same name — a `when` predicate spelled like a schema key
 * — since the rename gives distinct names distinct locals but cannot invent a
 * difference between a name and itself.
 *
 * Exported for `generateNodeJSON.test.ts`: every name in the checked-in
 * manifest passes, so the refusals have no other way to be exercised.
 *
 * @param {string} name
 * @param {string} what how the name is used, for the message
 * @param {Set<string>} [alsoBound] further names the generated code binds in
 *   the same scope — a class's schema keys, for a `when` predicate
 * @returns {string} the name, so this can wrap an interpolation
 */
export function emittable(name, what, alsoBound) {
  if (!IDENTIFIER.test(name)) {
    throw new NotCompilable(
      `${what} ${JSON.stringify(name)} is not a plain identifier`,
    );
  }
  if (alsoBound !== undefined && alsoBound.has(name)) {
    throw new NotCompilable(
      `${what} ${JSON.stringify(name)} collides with a name the generated code binds`,
    );
  }
  return name;
}

/**
 * Refuse a class whose lookup tables and generated locals share a name.
 *
 * A table is bound in the class's factory and read from inside the forms it
 * encloses, so a local named for one shadows it — and a read before that
 * local's own declaration is a `ReferenceError` rather than a wrong value. It
 * takes a property whose name is another property's table
 * (`NAMEDTABLE_MODE_GETTER` beside a `mode` with a `getterTable`), which no
 * enumeration of possible table names would decide as exactly as the tables
 * themselves do, so it is checked once both sets of names exist.
 *
 * Exported for `generateNodeJSON.test.ts`: no manifest class has such a
 * property.
 *
 * @param {NodeClass} klass
 * @param {readonly string[]} tableNames
 */
export function checkTableLocals(klass, tableNames) {
  const bound = localNamesOf(klass);
  for (const name of tableNames) {
    if (bound.has(name)) {
      throw new NotCompilable(
        `lookup table ${name} collides with a local the generated code binds for a property of that name`,
      );
    }
  }
}

/**
 * Every local the generated forms bind for `klass`: one per schema key, one
 * per `when` predicate, each under the name {@link localFor} gives it.
 *
 * Over every schema key rather than every read, for the reason {@link
 * localsFor} states: the parser binds a local for an import-only property
 * that the exporter never reads, and a caller asking what is bound has to be
 * told about it.
 *
 * @param {NodeClass} klass
 * @returns {Set<string>}
 */
function localNamesOf(klass) {
  const reads = schemaReads(klass);
  const localOf = localsFor(klass, reads);
  const names = new Set();
  for (const key of schemaKeysOf(klass)) {
    names.add(localOf(key));
  }
  for (const read of reads) {
    if (read.when !== undefined) {
      names.add(localOf(read.when));
    }
  }
  return names;
}

/**
 * Every schema key of `klass`, which the compact exporter binds as a local.
 *
 * @param {NodeClass} klass
 * @returns {Set<string>}
 */
function schemaKeysOf(klass) {
  return new Set(getComposedSchema(klass).fieldsBaseFirst.map(([key]) => key));
}

/**
 * How one property is read off `node`, or `null` for a property the walk does
 * not write. `when` names the predicate that gates it, for the caller to
 * hoist; see {@link hoistGatedReads}.
 *
 * @param {NodeClass} klass
 * @param {AnySchema} schema
 * @param {string} key
 * @returns {null | {expression: string, when?: string}}
 */
function readExpression(klass, schema, key) {
  const getter = resolveGetterAccessor(klass, key, schema);
  if (getter === null) {
    // Declared import-only, like the walk's compiled getters skip it.
    return null;
  }
  // The key names a local in the compact form and an object key in the legacy
  // one, so it has to survive both.
  emittable(key, 'schema key');
  if (isSchemaField(getter)) {
    const field = emittable(getter.field, 'getter field');
    const read =
      getter.getterTable === undefined
        ? `node.${field}`
        : // Read through the local the factory binds to the schema's own
          // table; see `tableLocals`.
          `${declareTable(
            tableName(klass, key, 'GETTER'),
            tableDeclaration('getter', key, getter.getterTable),
          )}[node.${field}]`;
    if (getter.when === undefined) {
      return {expression: read};
    }
    // A conditionally-persisted property. The walk tests the default first
    // and then calls the predicate; here the value is already in a local, and
    // the predicate is hoisted so properties that share one call it once.
    return {
      expression: read,
      // Checked against the schema's own keys as well as the fixed locals: the
      // compact exporter binds `const <key>` for every property and
      // `hoistGatedReads` binds `const <predicate>` in the same scope, so a
      // predicate sharing a sibling's name emits two `const`s and a module
      // that does not parse — reported against generated code rather than
      // against the schema that caused it, which is the failure `EMITTED_LOCALS`
      // and `claimTableName` exist to prevent for the other name spaces.
      when: emittable(getter.when, 'when predicate', schemaKeysOf(klass)),
    };
  }
  return {expression: `node.${emittable(getter, 'getter method')}()`};
}

/**
 * The properties one class's generated exporter reads, in the order the walk
 * writes them.
 *
 * The source is {@link getComposedSchema}'s `fieldsDerivedFirst`, which is what
 * the walk's own table compiles from — not `getComposedSchemaFields`, which
 * also folds in flat NodeState. NodeState is written by `node.__state.toJSON()`
 * and appended by the dispatch, so a state key here would emit a read of an
 * accessor that does not exist.
 *
 * @param {NodeClass} klass
 * @returns {{expression: string, key: string, schema: AnySchema, when?: string}[]}
 */
function schemaReads(klass) {
  const reads = [];
  for (const [key, schema] of getComposedSchema(klass).fieldsDerivedFirst) {
    const read = readExpression(klass, schema, key);
    if (read !== null) {
      reads.push({...read, key, schema});
    }
  }
  return reads;
}

/**
 * The `const` lines a class's exporters open with: one per property whose
 * value a predicate gates (so the value is read once and compared twice), and
 * one per predicate, which is why a predicate shared by several properties is
 * called once rather than once each.
 *
 * The predicate is guarded by the same default comparisons the walk makes
 * before calling it, so an element with nothing to persist — every element
 * with a TextNode child — still never reaches it.
 *
 * That comparison is the one `compileDiffersFromDefault` states
 * for the property's default. A gated property whose default it cannot state
 * has no generated form: the compact form can leave such a property to the
 * walk, but the legacy form writes every property, so this refuses rather than
 * emitting a comparison that means something else. No such property exists;
 * the check is here so that declaring one fails the build instead of the
 * round trip.
 *
 * @param {{expression: string, key: string, schema: AnySchema, when?: string}[]} reads
 *   the gated properties to hoist, which may be fewer than the class has
 * @param {(name: string) => string} localOf names the locals, built from *all*
 *   of the class's reads rather than from `reads`: both exporters have to name
 *   a given property the same local, and a name is only renamed far enough to
 *   clear the ones bound beside it, so a shorter list can rename it
 *   differently. Passed in rather than defaulted for that reason.
 * @returns {{lines: string[], value: (read: {expression: string, key: string, schema: AnySchema, when?: string}) => string}}
 */
function hoistGatedReads(reads, localOf) {
  // Built by hand rather than filtered, so `when` is a string in what follows.
  /** @type {{differs: string, expression: string, key: string, when: string}[]} */
  const gated = [];
  for (const read of reads) {
    if (read.when !== undefined) {
      let differs;
      try {
        differs = compileDiffersFromDefault(read.schema, localOf(read.key));
      } catch (error) {
        if (!(error instanceof NotCompilable)) {
          throw error;
        }
        throw new Error(
          `generate-node-json: "${read.key}" is gated by ${read.when}() but ${error.message}`,
        );
      }
      gated.push({...read, differs, when: read.when});
    }
  }
  if (gated.length === 0) {
    return {lines: [], value: read => read.expression};
  }
  const lines = gated.map(
    read => `  const ${localOf(read.key)} = ${read.expression};`,
  );
  /** @type {Map<string, string>} */
  const differsByKey = new Map();
  /** @type {Map<string, string[]>} */
  const byPredicate = new Map();
  for (const read of gated) {
    differsByKey.set(read.key, read.differs);
    byPredicate.set(read.when, [
      ...(byPredicate.get(read.when) || []),
      read.differs,
    ]);
  }
  for (const [predicate, tests] of byPredicate) {
    // `node.${predicate}` is a member access, which any name may be; the
    // binding beside it is the one that has to be legal.
    lines.push(
      `  const ${localOf(predicate)} =\n    (${tests.join(' || ')}) && node.${predicate}();`,
    );
  }
  return {
    lines,
    value: read =>
      read.when === undefined
        ? read.expression
        : `${differsByKey.get(read.key)} && ${localOf(read.when)}\n      ? ${localOf(read.key)}\n      : undefined`,
  };
}

/**
 * The compact form of one class's export.
 *
 * The compact form omits a property whose value is the one parsing would
 * restore, a property the parser derives rather than reads, and `version`.
 * Which properties that turns out to be depends on the node's values, but the
 * *rule* does not: each is a comparison against a default the schema states,
 * which is as fixed as the accessor names are. So this generates the same way
 * the legacy form does, and the `compact` argument picks between two
 * straight-line functions rather than branching inside one.
 *
 * Each comparison is the one `compileDiffersFromDefault` states for the
 * property's default. A default it cannot state — an object, a
 * non-empty array, a non-finite number, or a literal the schema compares with
 * an equality of its own — gets `isCompactDefault(key, value)` instead, the
 * running class's own omission test, handed in by the dispatch. So the schema
 * still decides, at the one point where the schema and this code are both in
 * hand, and this form omits exactly what the walk omits.
 *
 * Passed in rather than reached for, which is the whole reason a schema was
 * ever thought unavailable here: looking one up would mean importing the node
 * class, and that is a cycle. Nothing about the schema needs importing when
 * the caller already holds it.
 *
 * The alternative was to drop the class from this form over one such property,
 * which cost every *other* property its generated code and read as a silent
 * fallback to the walk.
 *
 * Exported for `generateNodeJSON.test.ts`, like {@link emittable}: no manifest
 * class has such a property, so the checked-in output does not show what
 * happens for one.
 *
 * @param {NodeClass} klass
 * @param {boolean} [strict] fail rather than fall back, for the same reason
 *   {@link generateUpdate} takes it: a published node whose omission test is a
 *   call into the schema is one we meant to state as source and did not.
 * @returns {string}
 */
export function generateCompactExport(klass, strict = false) {
  const writes = [];
  // Whether any property ended up comparing through the parameter, recorded
  // where that is decided rather than read back off the emitted text: a schema
  // whose string default is spelled `isCompactDefault(` puts that text in the
  // body without calling anything, and the exporter grew a parameter nothing
  // used. Same lesson as the numeric helpers, which report themselves.
  let comparesAtRunTime = false;
  const reads = schemaReads(klass);
  // Every local this form binds is named for a schema key or a predicate, and
  // `localOf` is what makes those legal to bind; see {@link localFor}.
  const localOf = localsFor(klass, reads);
  // The same hoist the legacy form uses, so the two call a shared predicate
  // exactly once each and stay byte-identical about what they omit.
  const hoist = hoistGatedReads(
    reads.filter(read => read.schema.setter !== null),
    localOf,
  );
  for (const {expression, key, schema, when} of reads) {
    if (schema.setter === null) {
      // Derived on import, so nothing will read it back: the compact form does
      // not even call the getter to find out what it would have written.
      continue;
    }
    // The walk skips an undefined value before it ever looks at the default,
    // and so does this; for a default of `undefined` that is the whole test,
    // which is why the comparison is only reached when there is a default to
    // compare against.
    const local = localOf(key);
    const defined = `${local} !== undefined`;
    let test = defined;
    if (schema.defaultValue !== undefined) {
      let differs;
      try {
        differs = compileDiffersFromDefault(schema, local);
      } catch (error) {
        if (!(error instanceof NotCompilable)) {
          throw error;
        }
        if (strict) {
          throw new NotCompilable(
            `compact export compares "${key}" at run time, which ${error.message}`,
          );
        }
        // Not statable as source, so the schema answers at run time instead —
        // see this function's docblock. Reported because the output alone does
        // not say which properties took this route.
        process.stdout.write(
          `${klass.name}: compact export compares "${key}" at run time, which ${error.message}\n`,
        );
        comparesAtRunTime = true;
        differs = `!${COMPACT_DEFAULT_PARAM}(${JSON.stringify(key)}, ${local})`;
      }
      // A default of `null` is the one comparison the definedness test folds
      // into: `x !== undefined && x !== null` is what `x != null` means, and
      // `direction` gives every element node one of these.
      test =
        differs === `${local} !== null`
          ? `${local} != null`
          : `${defined} && ${differs}`;
    }
    writes.push(
      when === undefined
        ? `  const ${local} = ${expression};\n  if (${test}) {\n    json.${key} = ${local};\n  }`
        : // `${key}` and the predicate are already hoisted above, so this is
          // the same test the legacy form makes plus the compact form's own
          // `!== undefined`, written as a statement. The legacy form has no
          // need of that one: it writes `undefined` into the literal, which
          // stringify omits, where an omitted key is what compaction means.
          `  if (${test} && ${localOf(when)}) {\n    json.${key} = ${local};\n  }`,
    );
  }
  const isElement = isElementish(klass);
  const header = `/** Generated from ${klass.name}'s serialization schema. Do not edit by hand. */`;
  // The compact form leads with `type` — it is new, so it can read type-first
  // where the legacy form keeps `type` last — and an element's `children`
  // follows, so the object is allocated on its fixed keys and the rest are
  // added as they pass their comparisons. The walk writes the same order.
  const fixed = `{type: node.__type${isElement ? ', children: []' : ''}}`;
  if (writes.length === 0) {
    // Nothing to compare, so the literal is the whole function — as in
    // generateExport, and for the same reason: an object that lands on its
    // final shape in one allocation beats one built by assignment.
    return `${header}
function exportCompact${klass.name}(node: ${klass.name}): {[key: string]: unknown} {
  return ${fixed};
}`;
  }
  const body = writes.join('\n');
  // Declared only where a property compares through it, so an exporter whose
  // every comparison is source keeps the one-parameter shape it always had.
  const params = comparesAtRunTime
    ? `\n  node: ${klass.name},\n  ${COMPACT_DEFAULT_PARAM}: CompactDefaultTest,\n`
    : `node: ${klass.name}`;
  return `${header}
function exportCompact${klass.name}(${params}): {[key: string]: unknown} {
${hoist.lines.length === 0 ? '' : `${hoist.lines.join('\n')}\n`}  const json: {[key: string]: unknown} = ${fixed};
${body}
  return json;
}`;
}

/**
 * The legacy form of one class's export: a single unconditional literal.
 *
 * `undefined` is allowed in the value position — a getter with nothing to say
 * (ParagraphNode's `getSerializedTextFormat` on a default paragraph) puts
 * `undefined` there rather than omitting the key. JSON.stringify omits an
 * undefined-valued property, so the serialized bytes are identical, and the
 * object shape is the one the hand-written exporters always had: main's
 * ListItemNode writes `checked: this.getChecked()` on every non-checklist
 * item, and TableNode writes `colWidths: undefined` by explicit ternary. One
 * literal also means one object shape per class, and no guarded fast path
 * with an incremental fallback to keep in agreement with it. The walk writes
 * unconditionally too, so the two stay key-for-key identical.
 *
 * @param {NodeClass} klass
 * @returns {string}
 */
function generateExport(klass) {
  const reads = schemaReads(klass);
  // An element's JSON leads with `children`, which is structural rather than
  // schema-declared: the key order below is byte-identical to the walk's.
  const isElement = isElementish(klass);
  const hoist = hoistGatedReads(reads, localsFor(klass, reads));
  // `type` is read off the node rather than baked in as the literal the class
  // registered under: the same code serves a subclass whose accessor tables
  // compile the same way, and its type is not this one's.
  const entries = [
    ...(isElement ? ['children: []'] : []),
    ...reads.map(read => `${read.key}: ${hoist.value(read)}`),
    'type: node.__type',
    'version: 1',
  ];
  return `/** Generated from ${klass.name}'s serialization schema. Do not edit by hand. */
function export${klass.name}(node: ${klass.name}): {[key: string]: unknown} {
${hoist.lines.length === 0 ? '' : `${hoist.lines.join('\n')}\n`}  return {
    ${entries.join(',\n    ')},
  };
}`;
}

/**
 * The copy half of one class's `afterCloneFrom`, or `null` for a class whose
 * own `$config` declares no field to copy.
 *
 * Only the fields this class carries: the synthesized method delegates the rest
 * to its superclass, the way a hand-written one delegates through `super`, so
 * what is emitted here is one class's own storage and nothing above it. A field
 * an ancestor declares too belongs to the ancestor, whose `afterCloneFrom` has
 * already assigned it by the time this runs — which is why TabNode, whose
 * `text`/`detail`/`mode` restate TextNode's, gets no function at all.
 *
 * `ownSchemaFields` reads the declared field rather than the accessor
 * {@link resolveGetterAccessor} would resolve to. A clone carries storage
 * rather than serializing it, so an override that sends the export through a
 * method changes nothing about where the value lives, and a property declared
 * through accessor methods on both sides names no storage at all and is left
 * to the class. No node in the tree is in that position: a value held in a
 * field says so with `setter: {field, method}` and stays derived, which is how
 * MarkNode declares the `ids` it serializes through `getIDs`/`setIDs`.
 *
 * @param {NodeClass} klass
 * @returns {null | string}
 */
function generateAfterCloneFrom(klass) {
  // The same list the synthesized method walks, from the same function, so the
  // generated form cannot copy a different set than the fallback would.
  const fields = ownSchemaFields(klass);
  if (fields.length === 0) {
    return null;
  }
  // Emitted at module scope and exported, rather than inside the class's
  // factory, because it needs nothing the factory holds: a clone copies
  // storage, so this is field assignments and no table reads. A class that
  // wrote its own `afterCloneFrom` is skipped by registration and so never
  // receives this through `$config` — it imports and calls it instead, and
  // writes only the part no schema describes. ElementNode and CodeNode both do.
  return `/**
 * ${klass.name}'s schema-declared fields, for a clone. Generated from that
 * schema; do not edit by hand.
 *
 * @internal
 */
export function afterClone${klass.name}(node: ${klass.name}, prevNode: ${klass.name}): void {
${fields
  .map(field => {
    const name = emittable(field, 'schema field');
    return `  node.${name} = prevNode.${name};`;
  })
  .join('\n')}
}`;
}

/**
 * Whether a class extends ElementNode, and so leads its JSON with `children`.
 *
 * By name rather than by `instanceof` the imported class, so this stays a plain
 * walk of the constructor chain with nothing else to keep in sync.
 *
 * @param {unknown} klass
 * @returns {boolean}
 */
function isElementish(klass) {
  // `prototype instanceof`, not a walk comparing `name`: a minified or
  // duplicated class answers to a different name, and any class a user happens
  // to call `ElementNode` answered to that one.
  return (
    klass === ElementNode ||
    /** @type {{prototype: object}} */ (klass).prototype instanceof ElementNode
  );
}

// -- the import direction ----------------------------------------------------

/**
 * The first schema in `schema`'s tree whose author installed a membership
 * predicate, or `null` where none does.
 *
 * The whole tree, not just the outermost schema: `compileParse` recurses
 * through the metadata — `aliasedValue` compiles by compiling its inner schema
 * — and a wrapper derives its own predicate, so asking only the top let
 * `aliasedValue(narrowed, {...})` through and compiled the inner *combinator's*
 * parse. The emitted parser then kept a value the schema itself declines, and
 * `verifyCompiledParse` agreed, because its corpus is derived from the same
 * metadata that cannot see the narrowing.
 *
 * @param {AnySchema} schema
 * @returns {null | AnySchema}
 */
function narrowedSchema(schema) {
  if (declaredAccepts(schema) !== undefined) {
    return schema;
  }
  const meta = schema.meta;
  if (meta == null) {
    return null;
  }
  const nested = [
    ...('inner' in meta && meta.inner ? [meta.inner] : []),
    ...('item' in meta && meta.item ? [meta.item] : []),
    ...(('members' in meta && meta.members) || []),
    ...('fields' in meta && meta.fields ? Object.values(meta.fields) : []),
  ];
  for (const inner of nested) {
    const found = narrowedSchema(inner);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

/**
 * The read of one serialized property: the same bare read the schema-driven
 * walk makes. An absent property is `undefined`, which is what every schema
 * maps to the property's default, so the only value an own-key test would
 * change is one the object *inherits* — and the one prototype a serialized
 * node has is `Object.prototype`, whose members `nodeSchema` refuses as
 * property names.
 *
 * It used to be `Object.prototype.hasOwnProperty.call(json, key) ? … :
 * undefined`. V8 does not inline that in this shape — a hoisted
 * `hasOwn.call` measures the same, so it is the call, not the lookup — and it
 * cost ~13 ns per property, about 105 ns for a TextNode against a bare read of
 * the same eight keys at ~5 ns. That is most of what a generated parser does.
 * `key in json` is not the cheaper spelling of it: `'k' in json ? json.k :
 * undefined` and `json.k` differ on nothing, since a key that is nowhere reads
 * `undefined` already, so the test buys nothing over dropping it and costs 2x
 * the read.
 *
 * Written at each site with the key a literal, rather than through a shared
 * `own(json, key)` helper: the helper's one `json[key]` served every key of
 * every node type and so could never stay monomorphic — measured at 5-12x the
 * cost of the bare read per node — while the read written out here keeps its
 * own inline cache, which is what this generator exists to produce.
 *
 * @param {string} key
 * @returns {string} an expression over `json`
 */
function ownRead(key) {
  // Dot access where the key allows it, which is every key today (the compact
  // exporter binds `const <key>`, so a key that is not an identifier is
  // refused before this); the element form is only for a key that is not.
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? `json.${key}`
    : `json[${JSON.stringify(key)}]`;
}

/**
 * Compile one property's parse, then prove it agrees with the schema.
 *
 * The proof runs the compiled expression rather than the emitted statements, so
 * what is verified is the expression the statements assign. The `setterTable` table
 * a property may end with is applied to the schema's own result instead, which
 * is what makes the two comparable without wrapping the expression in a closure
 * that the emitted code does not have.
 *
 * @param {NodeClass} klass
 * @param {AnySchema} schema
 * @param {string} key
 * @param {string} value the local the parse reads the serialized value from,
 *   named for the property as the exporter's locals are
 * @param {(base: string) => string} fresh names a further local this property
 *   needs, avoiding every name the class's forms already bind
 * @returns {null | {key: string, statements: string}} `null` for a property
 *   with nothing to apply, which is what an export-only one has.
 */
function writeExpression(klass, schema, key, value, fresh) {
  if (key in Object.prototype) {
    // The walk reads a property with hasOwn because its JSON came from
    // JSON.parse and so inherits Object.prototype; `json.toString` in
    // straight-line code would find the method rather than nothing. Refused
    // rather than guarded because no generated class has such a key, and the
    // verification compares values, so it would not notice.
    throw new NotCompilable(`"${key}" is also an Object.prototype member`);
  }
  emittable(key, 'schema key');
  const setter = resolveSetterAccessor(klass, key, schema);
  if (setter === null) {
    // Declared export-only: the value is derived from other properties on the
    // way in (ListNode's `tag` follows from `listType`). `compileSetters`
    // skips such a property, so the generated parser has nothing to emit for
    // it and `null` says so. Throwing `NotCompilable` here said the *class*
    // could not be compiled, which cost TabNode its parser over `detail`,
    // `mode` and `text` while the `format` and `style` it inherits compile
    // fine — and would cost the same to any node with a derived property.
    return null;
  }
  if (narrowedSchema(schema) !== null) {
    // The compiler reads `meta` alone, and a predicate the schema's author
    // installed describes a domain no metadata records — so what it would emit
    // is the combinator's parse, not this schema's. `verifyCompiledParse`
    // samples a fixed corpus and would pass whenever the narrowing rejects
    // nothing the corpus happens to contain, so this refuses outright rather
    // than relying on it.
    throw new NotCompilable(
      `"${key}" declares a membership predicate of its own, which the metadata does not describe`,
    );
  }
  // Each alias table the parse reads is bound to a local of the class's
  // factory, numbered outermost first — the order `compileParse` meets them,
  // which is the order `aliasTableOf` counts.
  const {
    expression,
    helpers,
    statements: bindings,
    tables: parseTables,
  } = compileParse(
    schema.meta,
    schema.defaultValue,
    (table, index) =>
      declareTable(
        tableName(klass, key, index === 0 ? 'ALIAS' : `ALIAS_${index + 1}`),
        tableDeclaration('alias', key, table, index),
      ),
    // Numbered across the whole class, not per property: every property is
    // applied in one function, so two that each bind a local would otherwise
    // both declare `p0`.
    parseBinding,
    value,
  );
  for (const helper of helpers) {
    parseHelpers.add(helper);
  }
  // Emitted between the read of the property and the write of the parsed
  // value, which is the scope they were compiled against.
  const bound = bindings.map(statement => `  ${statement}\n`).join('');
  // The emitted declaration is `aliasTableOf(fields, key, index)`, resolved
  // when the class is registered — so the numbering above is only right if
  // that walk descends the same schemas the compiler did. The two live in
  // different packages and are edited apart, and the failure is a registration
  // that throws in an application rather than anything a test of either side
  // alone would see, so it is checked here against the schema itself: same
  // index, same object.
  parseTables.forEach(({table}, index) => {
    let resolved;
    try {
      resolved = aliasTableOf(new Map([[key, schema]]), key, index);
    } catch (error) {
      throw new NotCompilable(
        `"${key}" compiles to an alias table ${index} that aliasTableOf cannot resolve: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    for (const name of new Set([
      ...Object.keys(table),
      ...Object.keys(resolved),
    ])) {
      if (!Object.is(table[name], resolved[name])) {
        throw new NotCompilable(
          `"${key}" compiles to an alias table ${index} that aliasTableOf resolves to a different table`,
        );
      }
    }
  });
  const nullPrototypeTables = parseTables.map(({name}) => name);
  if (!isSchemaField(setter)) {
    // Applied through a method, and the return is dropped — the rule
    // $applyJSONSetters uses. The node this parser is handed is writable, so a
    // setter's own getWritable() hands back that same node.
    try {
      verifyCompiledParse({
        expression,
        nullPrototypeTables,
        schema,
        statements: bindings,
        tables: parseTables,
        valueName: value,
      });
    } catch (error) {
      throw error instanceof NotCompilable
        ? new NotCompilable(`"${key}" ${error.message}`)
        : error;
    }
    const call = `node.${emittable(setter, 'setter method')}`;
    const once =
      bound === '' ? inlineSingleUse(expression, ownRead(key), value) : null;
    return {
      key,
      statements:
        once === null
          ? `  const ${value} = ${ownRead(key)};\n${bound}  ${call}(${expression});`
          : `  ${call}(${once});`,
    };
  }
  const {setterTable} = setter;
  // Two statements rather than one expression when a table has to be applied
  // after parsing: folding them together needs an IIFE, and a closure per
  // property per node is most of what generating this was meant to remove.
  const setterField = emittable(setter.field, 'setter field');
  let statements;
  if (setterTable === undefined) {
    const inlined =
      bound === '' ? inlineSingleUse(expression, ownRead(key), value) : null;
    statements =
      inlined === null
        ? `  const ${value} = ${ownRead(key)};\n${bound}  node.${setterField} = ${expression};`
        : `  node.${setterField} = ${inlined};`;
  } else {
    const name = declareTable(
      tableName(klass, key, 'SETTER'),
      tableDeclaration('setter', key, setterTable),
    );
    // Not added to `nullPrototypeTables`: that list is the alias tables the
    // compiled *expression* reads, checked by running the expression over the
    // corpus, and this table is applied after it rather than inside it. The
    // collapsed branch below does index it with a raw serialized value, so a
    // hostile key does reach it — its null prototype comes from
    // `setterTableOf`, which wraps every setter table in one at attach time,
    // rather than from anything decided here.
    //
    // The schema already reduced the value to its own domain, and
    // `verifyTableCoversDomain` below checks the table against it — but only
    // an enum's domain is enumerable; a bounded numeric one is sampled, and a
    // member the corpus did not reach can miss the table at run time. The
    // walk stores the encoded default for such a miss, so the parser does
    // too: the stored form of the schema's default, read off the schema when
    // the code is attached like the table itself, never written into the
    // module — read bare, the parser stored `undefined` where the walk stored
    // the default.
    const fallback = declareTable(
      tableName(klass, key, 'SETTER_DEFAULT'),
      tableDeclaration('setterDefault', key, setterTable),
    );
    if (tableDecidesMembership(schema, setterTable, key)) {
      // The parse and the lookup ask the same question, so the lookup is the
      // whole of it: a member is a key of the table and everything else falls
      // back to the stored default, which is what parsing to the schema's
      // default and looking *that* up produces. `ElementNode`'s `format` was
      // seven string comparisons and then a hash lookup that could only hit.
      // Nothing holds the parsed value, so this branch asks for no local of
      // its own — every manifest class takes it, which is why none of the
      // checked-in modules has one.
      statements = `  const ${value} = ${ownRead(key)};\n  node.${setterField} = typeof ${value} === 'string' && ${value} in ${name} ? ${name}[${value}] : ${fallback};`;
    } else {
      // Through the allocator, not `${value}Parsed` spelled directly: a
      // sibling property really called `modeParsed` binds that name too, and
      // two `const`s of one name is a module that does not parse.
      const parsed = fresh(`${value}Parsed`);
      // `unknown`, so the key assertion below is a widening of something that
      // has no type rather than a conversion of one that does. An enum over
      // numbers parses to `0 | 1`, which `as string` is a `TS2352` about — the
      // lookup is right either way, since a numeric key and its decimal string
      // are the same property, but the annotation is what lets it be spelled.
      const lookup = `(${parsed} as string) in ${name} ? ${name}[${parsed} as string] : ${fallback}`;
      statements = `  const ${value} = ${ownRead(key)};\n${bound}  const ${parsed}: unknown = ${expression};\n  node.${setterField} = ${lookup};`;
    }
  }
  try {
    verifyCompiledParse({
      expression,
      nullPrototypeTables,
      schema,
      statements: bindings,
      tables: parseTables,
      valueName: value,
    });
    if (setterTable !== undefined) {
      // The lookup above falls back for a key that is missing, so the table has
      // to have none: proving it total is what makes that fallback dead code
      // rather than a silent remapping.
      verifyTableCoversDomain({schema, table: setterTable});
    }
  } catch (error) {
    throw error instanceof NotCompilable
      ? new NotCompilable(`"${key}" ${error.message}`)
      : error;
  }
  return {key, statements};
}

/**
 * Whether the lookup a parsed value ends in decides membership by itself, so
 * that the parse in front of it is redundant.
 *
 * True for an enum of strings whose members are exactly the table's keys. The
 * emitted test is then `typeof v === 'string' && v in TABLE`, which agrees
 * with the parse on every input rather than only on JSON: a non-string reaches
 * the fallback, where the parse would have reached the schema's default and
 * looked *that* up to the same thing, and `typeof` is what keeps an object
 * that stringifies to a member from being read as one.
 *
 * Sampled over the same corpus the rest of the verification uses, against the
 * claim itself — the table applied to `schema(v)`, for every `v` — rather than
 * argued from the shape alone.
 *
 * @param {AnySchema} schema
 * @param {{readonly [key: string]: unknown}} table
 * @param {string} key the property, for the message
 * @returns {boolean}
 */
function tableDecidesMembership(schema, table, key) {
  const {meta} = schema;
  if (meta.kind !== 'enum' || !meta.values.every(v => typeof v === 'string')) {
    return false;
  }
  const keys = Object.keys(table);
  const members = new Set(meta.values);
  if (keys.length !== members.size || !keys.every(k => members.has(k))) {
    return false;
  }
  // The schema's own values index the table, which is keyed by them — that is
  // what `verifyTableCoversDomain` establishes — but only at run time, so the
  // key is spelled for the checker here.
  const storedDefault = table[/** @type {string} */ (schema.defaultValue)];
  for (const value of verificationCorpus(meta)) {
    const viaParse = table[/** @type {string} */ (schema(value))];
    const direct =
      typeof value === 'string' && hasOwn(table, value)
        ? table[value]
        : storedDefault;
    if (!Object.is(viaParse, direct)) {
      throw new NotCompilable(
        `"${key}" would store ${JSON.stringify(direct)} for ${JSON.stringify(
          value,
        )} through its table where its schema stores ${JSON.stringify(viaParse)}`,
      );
    }
  }
  return true;
}

/**
 * `Object.prototype.hasOwnProperty.call`, for a table an untrusted key reaches.
 *
 * @param {{readonly [key: string]: unknown}} table
 * @param {string} key
 * @returns {boolean}
 */
function hasOwn(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key);
}

/**
 * The import direction of one class's schema, or `null` for a class the
 * generator cannot compile faithfully.
 *
 * Fields only. A flat NodeState the class carries is applied by
 * `$applyJSONSetters` before it hands the node to this parser — the mirror of
 * the export side, where the dispatch appends `__state.toJSON()` around the
 * generated literal — so what a node carries in state, which is not known when
 * this is generated, never has to be.
 *
 * Exported for `generateNodeJSON.test.ts`, like {@link emittable}: which
 * properties take a class out of this form is not visible in the checked-in
 * output, since a class that loses it silently falls back to the walk.
 *
 * @param {NodeClass} klass
 * @param {boolean} [strict] fail rather than fall back. Every class in the
 *   manifest is a class this repo publishes, and a published node that quietly
 *   takes the walk is a node whose parser we meant to ship and did not — so
 *   {@link generatePackage} passes this, and a schema that stops compiling
 *   fails the build that would have shipped it. The test calls this without
 *   it, since what a refusal *does* is the thing being tested.
 * @returns {null | string}
 */
export function generateUpdate(klass, strict = false) {
  const {fieldsBaseFirst} = getComposedSchema(klass);
  // The same names the exporter binds, from the same place, so a property is
  // called one thing in both directions and a name that cannot be bound is
  // renamed once. A parse binds `<local>` for the serialized value and, where
  // a lookup table follows, `<local>Parsed` for what the schema made of it.
  const localOf = localsFor(klass, schemaReads(klass));
  // Every name the parser binds: one per property in the composed schema —
  // which is the list below, so an import-only property counts exactly as
  // much as one the exporter also reads — plus any derived name a property
  // asks `fresh` for, so the second cannot land on the first.
  const taken = new Set(fieldsBaseFirst.map(([key]) => localOf(key)));
  /**
   * A local no other name in this parser takes.
   *
   * @param {string} base
   * @returns {string}
   */
  const fresh = base => {
    const name = freeName(base, taken);
    taken.add(name);
    return name;
  };
  const writes = [];
  for (const [key, schema] of fieldsBaseFirst) {
    try {
      const write = writeExpression(klass, schema, key, localOf(key), fresh);
      // `null` is "nothing to apply for this property", not "give up on the
      // class" — see `writeExpression`.
      if (write !== null) {
        writes.push(write);
      }
    } catch (error) {
      if (!(error instanceof NotCompilable)) {
        throw error;
      }
      if (strict) {
        throw new NotCompilable(`no generated parser, ${error.message}`);
      }
      process.stdout.write(
        `${klass.name}: no generated parser, ${error.message}\n`,
      );
      return null;
    }
  }
  if (writes.length === 0) {
    return null;
  }
  const body = writes.map(({statements}) => statements).join('\n');
  return `/** Generated from ${klass.name}'s serialization schema. Do not edit by hand. */
function update${klass.name}(
  node: ${klass.name},
  json: {readonly [key: string]: unknown},
): ${klass.name} {
${body}
  return node;
}`;
}

// -- emit --------------------------------------------------------------------

/**
 * The value type to give a lookup table: the union of its literal values,
 * however many there are.
 *
 * A `setterTable`'s value is assigned to the node's field, and a field is
 * often narrower than its primitive — TextNode's `__mode` is `0 | 1 | 2 | 3`
 * — so a table typed `number` is not assignable to it. Widening past a
 * readable size, as this once did, made the generated parser of a node with
 * nine modes fail to compile while the node and its schema type-checked; a
 * long union costs nothing but width in a file nobody edits.
 *
 * @param {{readonly [key: string]: unknown}} table
 * @returns {string}
 */
function tableValueType(table) {
  const values = [...new Set(Object.values(table))];
  // Finite numbers in numeric order, then `number` if any is not finite, then
  // everything else in text order, so a bitmask table reads `1 | 2 | 4 | 8`
  // rather than `1 | 16 | 2 | 4`. Deduplicated again as spellings: the values
  // `-0` and `0` are one type.
  const finite = values
    .filter(v => typeof v === 'number' && Number.isFinite(v))
    .map(Number)
    .sort((a, b) => a - b)
    .map(tableType);
  const wide = values.some(v => typeof v === 'number' && !Number.isFinite(v))
    ? ['number']
    : [];
  const rest = values
    .filter(v => typeof v !== 'number')
    .map(tableType)
    .sort();
  const members = [...new Set([...finite, ...wide, ...rest])];
  // An empty table — `aliasedValue(numberValue(), {})` is a valid schema —
  // has an empty union, which spelled as nothing left the module no type at
  // all: `never`, the union of no members, is the type that maps to nothing.
  return members.length === 0 ? 'never' : members.join(' | ');
}

/**
 * One table value as a type: its literal, with the two shapes JSON cannot
 * spell handled as types rather than values. A `getterTable` may map a stored
 * value to `undefined` — that is how a stored value whose serialized form is
 * the omitted default is spelled, `{0: undefined, 1: 'special'}` — which is
 * the type `undefined`; a number JSON cannot spell (`Infinity`, `NaN`) is no
 * literal type either and is `number`, and `-0` is the type `0`. The values
 * themselves are never written into a module: the generated code reads the
 * schema's own table.
 *
 * @param {unknown} value
 * @returns {string}
 */
function tableType(value) {
  if (value === undefined) {
    return 'undefined';
  }
  return typeof value === 'number' && !Number.isFinite(value)
    ? 'number'
    : JSON.stringify(value);
}

/**
 * One package's generated module.
 *
 * Exported for `generateNodeJSON.test.ts`: what a module declares at its top
 * level — the numeric helpers, the lookup tables — is decided here from what
 * the emitted code turned out to reference, and no manifest class exercises
 * the cases where that decision is hard.
 *
 * @param {(typeof PACKAGES)[number]} pkg
 * @returns {string}
 */
export function generatePackage(pkg) {
  // Every class is exportable: the base `exportJSON` writes exactly the
  // schema's properties plus type/version, and NodeState is appended by the
  // dispatch. A class that overrides `exportJSON` for output no schema
  // describes — ParagraphNode and its #7971 textFormat/textStyle back-fill —
  // still composes, because the override's `super.exportJSON(compact)` is what
  // reaches the generated literal.
  const generated = pkg.targets.map(({klass}) => {
    // The tables a class reads are bound in its own factory, so each class
    // starts from none and takes what its four forms declared.
    resetTableLocals();
    try {
      const afterCloneFrom = generateAfterCloneFrom(klass);
      const compact = generateCompactExport(klass, true);
      const exportJSON = generateExport(klass);
      const updateFromJSON = generateUpdate(klass, true);
      // After all three forms the factory encloses, since the parser declares
      // tables of its own — and only those a form kept: a parser that turned
      // out not to be compilable declared its tables on the way to being
      // refused, and a local nothing reads is an unused variable in the
      // emitted module. `afterCloneFrom` is not among them; it is emitted at
      // module scope, where a factory-scope table is not in scope to read.
      const emitted = [compact, exportJSON, updateFromJSON]
        .filter(source => source !== null)
        .join('\n');
      const tables = tableDeclarations().filter(([name]) =>
        references(emitted, name),
      );
      // Only the tables that survived that filter: one the output does not
      // declare cannot be shadowed by anything, so refusing the class over it
      // would be refusing it for a name nothing binds.
      checkTableLocals(
        klass,
        tables.map(([name]) => name),
      );
      return {
        afterCloneFrom,
        compact,
        exportJSON,
        // Only what the parser this class kept calls. A refused one reported
        // its helpers on the way to being refused, the way it declared its
        // tables, and a helper nothing calls is an unused declaration.
        helpers: updateFromJSON === null ? [] : parseHelpersUsed(),
        klass,
        tables,
        updateFromJSON,
      };
    } catch (error) {
      // The forms that have a fallback catch NotCompilable themselves and
      // return null; one that reaches here is from a form that has none — the
      // legacy export, or a name that cannot be written into the output at all
      // — so it fails the build, named for the class whose schema caused it.
      if (error instanceof NotCompilable) {
        throw new Error(`generate-node-json: ${klass.name}: ${error.message}`);
      }
      throw error;
    }
  });

  // Which helpers the parsers call, so a module declares only those: what
  // compiling each parse reported, not what a scan of the result can see.
  const called = new Set(generated.flatMap(g => g.helpers));
  // `numC` and `numK` call `num`, which is a fact about the helper sources
  // rather than about any expression, so it is applied here where they are
  // emitted rather than reported by the compiler.
  const needsNumC = called.has('numC');
  const needsNumK = called.has('numK');
  const needsNum = needsNumC || needsNumK || called.has('num');

  /** Class names by the module that declares them. @type {Map<string, Set<string>>} */
  const typeImports = new Map();
  for (const {klass, module} of pkg.targets) {
    const names = typeImports.get(module) || new Set();
    names.add(klass.name);
    typeImports.set(module, names);
  }
  // The node classes are imported as types only: a value import of them
  // would be a cycle — they import LexicalNode, which imports this — and
  // would evaluate a class before its base was initialized. The one runtime
  // import is the table helpers, from the schema module, which imports no
  // node class. This repo's simple-import-sort config keeps every type
  // import in one group ordered by specifier and value imports after them,
  // so these are emitted the same way: one line per module, sorted.
  //
  // The helpers each class's factory calls, so a module imports only those.
  const helpers = new Set(
    generated.flatMap(g =>
      g.tables.map(([, declaration]) => declaration.replace(/\(.*$/s, '')),
    ),
  );
  if (pkg.home) {
    typeImports.set('./LexicalNode', new Set(['LexicalNode']));
    // Always: this module declares `GeneratedJSON`, whose `exportCompactJSON`
    // names it, and `GeneratedJSONFactory`, which takes a
    // `ComposedSchemaFields`, whether or not any class here reads a table.
    typeImports.set('./LexicalSchema', new Set(['ComposedSchemaFields']));
    typeImports.set('./LexicalUtils', new Set(['CompactDefaultTest']));
  } else {
    const names = new Set(['GeneratedJSONFactory']);
    // Only where an exporter takes it. No built-in node has a property whose
    // comparison cannot be stated as source, so this appears in none of the
    // checked-in output.
    if (generated.some(g => g.compact.includes(`${COMPACT_DEFAULT_PARAM}:`))) {
      names.add('CompactDefaultTest');
    }
    typeImports.set('lexical', names);
  }
  const helperModule = pkg.home ? './LexicalSchema' : 'lexical';
  // A module that reads a table imports the helpers as values, in one
  // statement with that module's types; one that reads none keeps its
  // type-only import.
  if (helpers.size > 0) {
    const types = typeImports.get(helperModule) || new Set();
    typeImports.delete(helperModule);
    for (const type of types) {
      helpers.add(`type ${type}`);
    }
  }
  const importLines = [...typeImports]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([module, names]) =>
        `import type {${[...names].sort().join(', ')}} from '${module}';`,
    );
  if (helpers.size > 0) {
    // Sorted the way simple-import-sort sorts specifiers: by the name, case
    // ignored, with a `type` modifier ignored.
    const specifiers = [...helpers].sort((a, b) => {
      const x = a.replace(/^type /, '').toLowerCase();
      const y = b.replace(/^type /, '').toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    importLines.push(
      `\nimport {${specifiers.join(', ')}} from '${helperModule}';`,
    );
  }

  const pieces = [];
  for (const {
    afterCloneFrom,
    compact,
    exportJSON,
    klass,
    tables,
    updateFromJSON,
  } of generated) {
    // One factory per class: registration hands it the class's composed
    // schema, the tables the class reads are bound from that schema first,
    // and the four forms close over them. A class that reads no table takes
    // no parameter.
    // `afterCloneFrom` is module scope, not part of this body: it closes over
    // nothing the factory holds, and a class that wrote its own imports and
    // calls it.
    const installsClone =
      afterCloneFrom !== null && !declaresOwnAfterCloneFrom(klass);
    const body = [
      ...tables.map(
        ([name, declaration]) => `  const ${name} = ${declaration};`,
      ),
      exportJSON,
      // Always: every class that has a legacy form has a compact one, since a
      // property whose default cannot be compared is written rather than
      // omitted. `exportCompactJSON` stays optional on `GeneratedJSON` — the
      // dispatch still has to answer for a hand-written or older value — but
      // nothing this generates leaves it out.
      compact,
      ...(updateFromJSON === null ? [] : [updateFromJSON]),
      `  return {\n    exportJSON: export${klass.name},\n    exportCompactJSON: exportCompact${klass.name},${
        updateFromJSON === null
          ? ''
          : `\n    updateFromJSON: update${klass.name},`
      }${
        installsClone ? `\n    afterCloneFrom: afterClone${klass.name},` : ''
      }\n  };`,
    ];
    if (afterCloneFrom !== null) {
      pieces.push(afterCloneFrom);
    }
    pieces.push(
      `/** ${klass.name}'s generated implementations, for its \`$config\`. @internal */\nexport const ${constName(klass)}: GeneratedJSONFactory = ${
        tables.length === 0 ? '()' : 'fields'
      } => {\n${body.join('\n\n')}\n};`,
    );
  }

  // The module-scope pieces a package needs, in order, joined once: the
  // output is prettier-formatted before it is written, so the blank lines
  // between them are prettier's to place, not this template's.
  const prelude = [];
  if (pkg.home) {
    prelude.push(INTERFACE_SOURCE);
  }
  if (needsNum) {
    prelude.push(NUM_COMMENT + NUM_HELPER_SOURCE);
  }
  if (needsNumC) {
    prelude.push(NUM_RANGE_HELPER_SOURCE);
  }
  if (needsNumK) {
    prelude.push(NUM_CLAMP_HELPER_SOURCE);
  }

  return `${HEADER}
${importLines.join('\n')}

${[...prelude, ...pieces].join('\n\n')}
`;
}

// What the emitted helpers are for, as the generated module explains it. The
// helpers' source is `@lexical/compiler`'s, so an emitted module and the
// verification cannot be different functions; the reason to have one at all
// is stated here, once, where every generated module reproduces it.
const NUM_COMMENT = `// The JSON number grammar, anchored, matching numberValue: \`Number()\` alone
// reads '0x10' as 16 and '' as 0, and neither is a shape a JSON encoder
// produces. Emitted from the same source the codegen verified against, so the
// two cannot be different functions.
`;

/**
 * Generate every module in {@link MANIFEST}, in place under the repo, or —
 * given `outDir` — under it with the repo-relative layout preserved and a
 * `manifest.json` listing every file written, which is how the drift check
 * regenerates without touching the modules other test workers are importing.
 *
 * Each file is formatted with the repo's prettier config, named explicitly
 * rather than resolved from the output's directory so the output is the same
 * wherever it is written: the checked-in files are both prettier-clean and
 * exactly what a regeneration produces, and the drift check compares them byte
 * for byte.
 *
 * @param {null | string} outDir
 * @returns {{path: string, target: string}[]} what was written, as
 *   repo-relative paths and the files they went to
 */
export function generateNodeJSON(outDir) {
  /** @param {string} repoRelative @returns {string} */
  const outPath = repoRelative => {
    const target =
      outDir === null ? join(REPO, repoRelative) : join(outDir, repoRelative);
    mkdirSync(dirname(target), {recursive: true});
    return target;
  };
  // Generating exactly what the CLI's first phase stubbed, or a future edit to
  // one list silently ships a stub.
  if (PACKAGES.length !== MANIFEST.length) {
    throw new Error('generate-node-json: PACKAGES and MANIFEST disagree');
  }
  const configPath = join(REPO, '.prettierrc');
  const prettierConfig = prettier.resolveConfig(configPath, {
    config: configPath,
  });
  /** @type {{path: string, target: string}[]} */
  const written = [];
  for (let i = 0; i < PACKAGES.length; i++) {
    const pkg = PACKAGES[i];
    const manifest = MANIFEST[i];
    if (pkg.file !== manifest.file) {
      throw new Error(
        `generate-node-json: manifest order mismatch ${pkg.file}`,
      );
    }
    const source = generatePackage(pkg);
    const expected = [...manifest.entries].sort();
    const emitted = pkg.targets.map(({klass}) => constName(klass)).sort();
    if (JSON.stringify(expected) !== JSON.stringify(emitted)) {
      throw new Error(
        `generate-node-json: ${pkg.file} emits [${emitted}] but the manifest stubs [${expected}]; update MANIFEST (and the $config wiring) together`,
      );
    }
    // The copy helpers, the same way: a class only has one where its own
    // `$config` declares a schema field, which phase one cannot ask because it
    // cannot import anything — so the manifest states it and this holds the
    // statement to what was emitted.
    const expectedClones = [...manifest.afterClone].sort();
    const emittedClones = pkg.targets
      .filter(({klass}) => ownSchemaFields(klass).length > 0)
      .map(({klass}) => `afterClone${klass.name}`)
      .sort();
    if (JSON.stringify(expectedClones) !== JSON.stringify(emittedClones)) {
      throw new Error(
        `generate-node-json: ${pkg.file} exports clone helpers [${emittedClones}] but the manifest stubs [${expectedClones}]; update MANIFEST together with the schemas`,
      );
    }
    const target = outPath(pkg.file);
    writeFileSync(
      target,
      prettier.format(source, {...prettierConfig, filepath: target}),
    );
    written.push({path: pkg.file, target});
  }
  if (outDir !== null) {
    writeFileSync(
      join(outDir, 'manifest.json'),
      JSON.stringify(
        written.map(w => w.path),
        null,
        2,
      ),
    );
  }
  return written;
}
