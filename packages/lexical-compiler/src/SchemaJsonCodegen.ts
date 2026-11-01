/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Compiling a serialization schema's domain to straight-line JavaScript, and
 * proving the result agrees with the schema it was compiled from — the
 * `@lexical/compiler/SchemaJsonCodegen` entry point.
 * `scripts/generate-node-json.mjs` is its in-tree consumer, generating the
 * core node classes' serializers; a build generating serializers for its own
 * node classes uses the same functions.
 *
 * It is typed against `lexical`'s own `SerializationSchemaMeta` and
 * `SerializationSchema` — a type-only dependency, erased from the emitted
 * module — rather than a structural copy of them, so a kind added to the meta
 * is a type error here rather than a silent fall-through. The generator's
 * first phase loads this file under plain Node, which strips the types
 * itself: that is why the import below is a type-only statement, which Node
 * erases whole, and why nothing in here is more than erasable syntax.
 *
 * It knows about a schema's introspectable `meta` and nothing about node
 * classes, and holds no module state — everything a compiled expression needs
 * comes back with it — which is what makes it testable against any schema.
 *
 * The import direction is the untrusted-JSON boundary, so
 * {@link verifyCompiledParse} is not optional politeness: a schema whose meta
 * does not fully determine its parse compiles to something plausible and wrong
 * (see {@link compileParse}), and only running the two against each other
 * catches it.
 */

import type {AnySerializationSchema, SerializationSchemaMeta} from 'lexical';

/** A lookup table a compiled expression refers to by name. */
export interface SchemaJsonTable {
  name: string;
  table: {readonly [key: string]: unknown};
}

/** An expression, with whatever has to be bound before it is evaluated. */
export interface CompiledExpression {
  /** A JavaScript expression over `v` that parses exactly as the schema does. */
  expression: string;
  /**
   * Statements the caller emits before the expression, in the same scope.
   *
   * A collapsing wrapper (`optional({omitDefault})`,
   * `nullable({defaultAsNull})`) compares the parsed value against the inner
   * default and then returns it, so it names the parse once here rather than
   * writing it into the expression twice. Empty for every other kind, which is
   * why the emitted code is otherwise unchanged.
   */
  statements: string[];
}

export interface CompileParseResult extends CompiledExpression {
  /**
   * The lookup tables the expression refers to. The caller decides where they
   * live; a table an untrusted key reaches must be given a null prototype.
   */
  tables: SchemaJsonTable[];
  /**
   * The numeric helpers the expression calls, by name, sorted — a subset of
   * `num`, `numC` and `numK`, whose sources are {@link NUM_HELPER_SOURCE},
   * {@link NUM_RANGE_HELPER_SOURCE} and {@link NUM_CLAMP_HELPER_SOURCE}. The
   * caller emits their definitions, so it has to know which ones to emit, and
   * only what compiled the expression knows for certain: reading the answer
   * back off the emitted text cannot tell a call from a property named `num`
   * (`json.num`, or `{num: ...}` in the exporter beside it).
   *
   * `numC` and `numK` call `num`, which is a fact about the sources rather
   * than about this expression: what is listed here is what the expression
   * itself calls.
   */
  helpers: string[];
}

export interface VerifyCompiledParseOptions {
  /** The real schema, called for the expected value. */
  schema: AnySerializationSchema;
  /** A compiled expression over `v`, usually from {@link compileParse}. */
  expression: string;
  /**
   * The statements that expression was compiled with, which are run before it
   * here exactly as the generated code runs them. Omitting them where the
   * compile produced some would evaluate an unbound name, so this is not a
   * check that can quietly pass against the wrong thing.
   */
  statements?: readonly string[];
  /** The tables the expression refers to. */
  tables: readonly SchemaJsonTable[];
  /**
   * Which of the tables an untrusted key can reach, and so must not inherit
   * from `Object.prototype`. Verified by running the hostile keys in
   * {@link verificationCorpus} through the expression.
   */
  nullPrototypeTables?: readonly string[];
  /**
   * The variable the expression reads the serialized value from — whatever was
   * passed to {@link compileParse} as `valueName`, `v` by default. It is the
   * parameter the expression is evaluated with here, so an expression compiled
   * against another name reads an unbound one without it.
   */
  valueName?: string;
}

/**
 * A schema whose domain cannot be expressed as straight-line code, or a
 * compiled expression that turned out to disagree with it.
 */
export class NotCompilable extends Error {}

/**
 * The JSON number grammar, anchored, as source text — matching `numberValue`'s
 * treatment of a stringified number. Kept as one string so an emitted module
 * and the verification here are the same regexp rather than two copies that
 * could drift.
 */
export const JSON_NUMBER_SOURCE =
  '/^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?$/';

/**
 * The body of the `num` helper a compiled expression calls, with no type
 * annotations so that the same text can be emitted into TypeScript (wrapped by
 * {@link NUM_HELPER_SOURCE}) and evaluated for verification. Two spellings of
 * this logic is exactly the drift the verification exists to prevent, so there
 * is only one.
 *
 * @internal
 */
export const NUM_BODY = `  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : d;
  }
  if (typeof v !== 'string' || !JSON_NUMBER.test(v)) {
    return d;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : d;`;

/**
 * The constrained mirror of {@link NUM_BODY}, for `numberValue`'s `min`/`max`/
 * `integer` options. Applied to what `num` returned rather than to the input,
 * exactly as `numberValue` tests its coerced value — and falling back to `d`
 * either way, which is what `numberValue` does when the domain rejects it,
 * including for a default that is itself out of range.
 *
 * @internal
 */
export const NUM_RANGE_BODY = `  const n = num(v, d);
  return n >= min && n <= max && (!integer || Number.isInteger(n)) ? n : d;`;

/**
 * The `clamp` mirror of {@link NUM_RANGE_BODY}. With `clamp`, a value outside
 * the bounds is the nearest bound rather than the default, so the range no
 * longer decides membership and only the numeric part can fall back — which is
 * why this coerces against `NaN` and tests that, instead of coercing against
 * `d` and being unable to tell a rejected value from one that really is `d`.
 *
 * @internal
 */
export const NUM_CLAMP_BODY = `  const n = num(v, NaN);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) {
    return d;
  }
  return n < min ? min : n > max ? max : n;`;

/**
 * The `num` helper as TypeScript source, for a module that emits a compiled
 * parse. The verification evaluates the same body, so the emitted helper and
 * the checked one cannot be different functions.
 */
export const NUM_HELPER_SOURCE = numHelperSource();

/** The `numC` helper, emitted alongside `num` when a domain is constrained. */
export const NUM_RANGE_HELPER_SOURCE = numRangeHelperSource();

/** The `numK` helper, emitted alongside `num` when a domain clamps. */
export const NUM_CLAMP_HELPER_SOURCE = numClampHelperSource();

/**
 * Assembled in a function rather than written as a module-scope template
 * literal, which esbuild retains: an interpolation can call user code through
 * `ToPrimitive`, so it is a side effect to a bundler that cannot see the
 * operand is a string, and one retained constant pins every constant it reads.
 * Behind a call declared side-effect free, a consumer that imports nothing
 * from this module keeps none of it.
 *
 * @__NO_SIDE_EFFECTS__
 */
function numHelperSource(): string {
  return `const JSON_NUMBER = ${JSON_NUMBER_SOURCE};

function num(v: unknown, d: number): number {
${NUM_BODY}
}`;
}

/** @__NO_SIDE_EFFECTS__ */
function numRangeHelperSource(): string {
  return `function numC(
  v: unknown,
  d: number,
  min: number,
  max: number,
  integer: boolean,
): number {
${NUM_RANGE_BODY}
}`;
}

/** @__NO_SIDE_EFFECTS__ */
function numClampHelperSource(): string {
  return `function numK(
  v: unknown,
  d: number,
  min: number,
  max: number,
  integer: boolean,
): number {
${NUM_CLAMP_BODY}
}`;
}

/**
 * A JavaScript literal denoting `value`, or the token `undefined`. Faithful
 * only for the primitives JSON round-trips — which is exactly what a caller
 * emitting a comparison against it must check first.
 */
export function literal(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

/**
 * A JavaScript expression over `v` that parses exactly as `meta`'s schema does,
 * with any lookup tables it needs.
 *
 * Only the kinds whose meta fully determines the parse are compiled; the rest
 * throw {@link NotCompilable}. A `transformValue` post-processes what its meta
 * describes and keeps the function to itself, so its meta is indistinguishable
 * from its inner schema's — compiling one yields an expression that stores the
 * un-transformed value, and no inspection of the meta can tell. That is what
 * {@link verifyCompiledParse} is for: compiling is not trusting.
 *
 * Any lookup table the expression needs is returned with it rather than
 * registered somewhere: the caller decides where tables live, and a compile
 * that throws leaves nothing behind.
 *
 * @param meta the schema's introspectable description
 * @param defaultValue the schema's own default, i.e. `schema(undefined)`
 * @param tableBaseName how to name a lookup table the expression needs: a
 *   prefix, or a callback given the table and its index. The callback is what
 *   lets a caller share one emitted table between the schemas that use the
 *   same object — the name has to be settled before it is written into the
 *   expression, so this cannot be done afterwards.
 * @param bindingName how to name a local the expression binds; see
 *   {@link BindingNaming}.
 * @param valueName the variable the expression reads the serialized value
 *   from, `v` by default. A caller emitting one parse per property of a node
 *   names it for the property, so the emitted code reads like the exporter
 *   beside it rather than reassigning one scratch variable per property.
 */
export function compileParse(
  meta: SerializationSchemaMeta,
  defaultValue: unknown,
  tableBaseName: TableNaming,
  bindingName?: BindingNaming,
  valueName = 'v',
): CompileParseResult {
  const tables: SchemaJsonTable[] = [];
  const helpers = new Set<string>();
  let bound = 0;
  const {expression, statements} = compile(
    meta,
    defaultValue,
    tableBaseName,
    tables,
    bindingName ?? (() => `p${bound++}`),
    helpers,
    valueName,
  );
  return {expression, helpers: [...helpers].sort(), statements, tables};
}

/** How {@link compileParse} names the tables an expression reads. */
export type TableNaming =
  | string
  | ((table: {readonly [key: string]: unknown}, index: number) => string);

/**
 * How {@link compileParse} names a local it binds; see
 * {@link CompiledExpression.statements}.
 *
 * A callback rather than a prefix, because the scope these are emitted into is
 * the caller's: a generated parser applies every property of a class in one
 * function, so two properties that each bind one need two names, and only the
 * caller knows how many have gone before. The default numbers them from zero,
 * which suits a caller compiling one expression on its own.
 */
export type BindingNaming = () => string;

/**
 * Whether evaluating `meta`'s compiled expression a second time costs nothing
 * worth avoiding, which is what decides between repeating it and binding it to
 * a local; see the `nullable`/`optional` case below.
 *
 * True for the kinds that compile to a test over `v` and nothing else. A
 * number's helper call is here too: it allocates nothing, and the duplicate
 * call is one V8 was measured folding away, where the binding is not.
 *
 * False for the kinds that allocate (`array`) or read a table (`aliased`), and
 * for a wrapper over one of those, since the cost is the inner parse's.
 */
function repeatable(meta: SerializationSchemaMeta): boolean {
  switch (meta.kind) {
    case 'string':
    case 'boolean':
    case 'enum':
    case 'number':
      return true;
    case 'nullable':
    case 'optional':
      return repeatable(meta.inner.meta);
    default:
      return false;
  }
}

/**
 * The domain test of a kind whose parse is exactly `<test> ? v : <default>`,
 * or `null` for one that is anything else.
 *
 * Three kinds are that shape, and knowing it is what lets a collapsing
 * `nullable`/`optional` ask one question instead of parsing twice: where the
 * test holds the parse *is* `v`, so "the parse equals the default" is
 * "`v` is out of domain, or it is the default".
 *
 * Derived from the metadata rather than read back off the compiled string,
 * which cannot be done safely — an `aliased` string ends in the same
 * `? v : ""` its inner does, and taking that suffix apart would split the
 * wrong ternary. Drift between this and the cases below is caught by
 * {@link verifyCompiledParse}, which runs what is emitted against the schema.
 */
function domainTest(meta: SerializationSchemaMeta, v: string): string | null {
  switch (meta.kind) {
    case 'string':
      return `typeof ${v} === 'string'`;
    case 'boolean':
      return `typeof ${v} === 'boolean'`;
    case 'enum': {
      // The same comparisons the case below emits, and `undefined` dropped
      // for the same reason.
      const tests = meta.values
        .filter(value => value !== undefined)
        .map(value => `${v} === ${literal(value)}`);
      return tests.length === 0
        ? null
        : tests.length === 1
          ? tests[0]
          : `(${tests.join(' || ')})`;
    }
    default:
      return null;
  }
}

function compile(
  meta: SerializationSchemaMeta,
  defaultValue: unknown,
  base: TableNaming,
  tables: SchemaJsonTable[],
  bind: BindingNaming,
  // Collected the way `tables` is: what the expression needs, reported by
  // whatever compiled it rather than read back off the result.
  helpers: Set<string>,
  // The expression reads one variable, `v` at the top level. An array's item
  // parse runs inside a callback over its own binding, so it compiles against
  // that name instead, and the depth keeps nested ones apart.
  v = 'v',
  depth = 0,
): CompiledExpression {
  const fallback = literal(defaultValue);
  /** A kind that needs no binding of its own, which is most of them. */
  const only = (expression: string): CompiledExpression => ({
    expression,
    statements: [],
  });
  switch (meta.kind) {
    case 'string':
      return only(`typeof ${v} === 'string' ? ${v} : ${fallback}`);
    case 'boolean':
      return only(`typeof ${v} === 'boolean' ? ${v} : ${fallback}`);
    case 'enum': {
      // `undefined` is checked before membership by enumValue, so a member
      // spelled undefined can never be matched here — dropping it from the
      // comparisons reproduces that exactly.
      const tests = meta.values
        .filter(value => value !== undefined)
        .map(value => `${v} === ${literal(value)}`);
      return only(
        tests.length === 0
          ? fallback
          : `${tests.join(' || ')} ? ${v} : ${fallback}`,
      );
    }
    case 'number': {
      if (meta.min !== undefined || meta.max !== undefined || meta.integer) {
        // The bounds are emitted as source rather than through `literal`,
        // which renders a non-finite number as `null`: an absent bound is
        // exactly ±Infinity, and JSON.stringify cannot say so.
        const min = meta.min === undefined ? '-Infinity' : String(meta.min);
        const max = meta.max === undefined ? 'Infinity' : String(meta.max);
        const helper = meta.clamp ? 'numK' : 'numC';
        helpers.add(helper);
        return only(
          `${helper}(${v}, ${fallback}, ${min}, ${max}, ${Boolean(meta.integer)})`,
        );
      }
      helpers.add('num');
      return only(`num(${v}, ${fallback})`);
    }
    case 'aliased': {
      // `__proto__` in an object literal sets the prototype instead of
      // defining a key, and the emitted table is an object literal — so the
      // alias would be silently absent from the generated parser while the
      // schema, whose table was built with a computed key, still has it.
      // Refused rather than emitted, the way `objectValue` refuses the same
      // name as a field.
      if (Object.prototype.hasOwnProperty.call(meta.aliases, '__proto__')) {
        throw new NotCompilable(
          'declares a "__proto__" alias, which an emitted object literal cannot carry',
        );
      }
      // Suffixed after the first, so nesting cannot collide.
      const name =
        typeof base === 'function'
          ? base(meta.aliases, tables.length)
          : tables.length === 0
            ? base
            : `${base}_${tables.length + 1}`;
      tables.push({name, table: meta.aliases});
      const inner = compile(
        meta.inner.meta,
        defaultValue,
        base,
        tables,
        bind,
        helpers,
        v,
        depth,
      );
      // `in` rather than a bare lookup, and whoever emits this table has to
      // give it a null prototype: the key comes straight out of untrusted
      // JSON, so `'toString'` would otherwise resolve to Object.prototype's
      // method and be stored as this property's value. Naming the table in
      // `nullPrototypeTables` is what makes verifyCompiledParse check it.
      return {
        expression: `typeof ${v} === 'string' && ${v} in ${name} ? ${name}[${v}] : ${inner.expression}`,
        statements: inner.statements,
      };
    }
    case 'nullable':
    case 'optional': {
      // The wrapper answers for its own nil and defers the rest to its inner
      // schema, exactly as the runtime does. `nullable` treats `undefined` as
      // `null` too, which is why it tests `== null` where `optional` tests
      // only `undefined`.
      // `optional(nullable(x))` asks for each nil separately and returns the
      // one it found — but by the time the inner wrapper asks, the outer one
      // has ruled `undefined` out, so both branches return the value that was
      // tested for. That is what `v == null ? v : …` says in one comparison.
      // Only where neither wrapper collapses a default into its nil: that adds
      // a second clause to the test, and the two are then not the same
      // question.
      const folds =
        meta.kind === 'optional' &&
        !meta.omitDefault &&
        meta.inner.meta.kind === 'nullable' &&
        !meta.inner.meta.defaultAsNull
          ? meta.inner.meta.inner
          : undefined;
      if (folds !== undefined) {
        const folded = compile(
          folds.meta,
          folds.defaultValue,
          base,
          tables,
          bind,
          helpers,
          v,
          depth,
        );
        return {
          expression: `${v} == null ? ${v} : ${folded.expression}`,
          statements: folded.statements,
        };
      }
      const nil = meta.kind === 'nullable' ? 'null' : 'undefined';
      const test =
        meta.kind === 'nullable' ? `${v} == null` : `${v} === undefined`;
      const inner = compile(
        meta.inner.meta,
        meta.inner.defaultValue,
        base,
        tables,
        bind,
        helpers,
        v,
        depth,
      );
      const collapses =
        meta.kind === 'nullable' ? meta.defaultAsNull : meta.omitDefault;
      if (!collapses) {
        return {
          expression: `${test} ? ${nil} : ${inner.expression}`,
          statements: inner.statements,
        };
      }
      // With the flag, a parse that lands on the inner default is the nil
      // instead. The test is the one `compileDiffersFromDefault` states,
      // negated, so an inner default it cannot state refuses the whole
      // property. It is applied to the *parsed* value, which the wrapper then
      // also returns, so the parse appears twice: once compared, once
      // returned.
      //
      // Which of the two spellings is better depends on what the inner parse
      // costs, and both directions were measured. Binding it to a local is
      // 3x faster for an array, whose expression allocates on every
      // evaluation and whose default comparison names it twice more
      // (1790 -> 596 ns per property over 1000 nodes), and ~40% faster for an
      // aliased value, which reads a table (41 -> 25 ns). For an inline test
      // over `v` it is *slower* — a string's `typeof v === 'string' ? v : ''`
      // costs about 2 ns per property more bound than repeated, since
      // re-evaluating it is free and the binding is not — so those are still
      // written twice.
      // A kind whose parse is `<test> ? v : <default>` answers both questions
      // at once: where the test holds the parse is `v` itself, so it collapses
      // exactly when `v` is out of domain or equal to the default. That is one
      // test and one comparison, in place of the parse written twice —
      // `nullable(stringValue(), {defaultAsNull: true})` was
      // `v == null || (typeof v === 'string' ? v : '') === '' ? null :
      // typeof v === 'string' ? v : ''`, and is now
      // `typeof v === 'string' && v !== '' ? v : null`. The wrapper's own nil
      // test drops out with it: a nil is out of the inner domain, so it
      // reaches the same branch.
      const domain = domainTest(meta.inner.meta, v);
      if (domain !== null) {
        let differs;
        try {
          differs = compileDefaultComparison(meta.inner, v, false);
        } catch (error) {
          if (!(error instanceof NotCompilable)) {
            throw error;
          }
          differs = null;
        }
        if (differs !== null) {
          return only(`${domain} && ${differs} ? ${v} : ${nil}`);
        }
      }
      if (!repeatable(meta.inner.meta)) {
        const name = bind();
        return {
          expression: `${test} || ${compileDefaultComparison(
            meta.inner,
            name,
            true,
          )} ? ${nil} : ${name}`,
          statements: [
            ...inner.statements,
            `const ${name} = ${inner.expression};`,
          ],
        };
      }
      return {
        expression: `${test} || ${compileDefaultComparison(
          meta.inner,
          `(${inner.expression})`,
          true,
        )} ? ${nil} : ${inner.expression}`,
        statements: inner.statements,
      };
    }
    case 'array': {
      // `Array.from` rather than `.map`, which skips holes: the runtime reads
      // every index, so a hole parses as `undefined` and lands on the item's
      // default. The callback binds its own name so the item's parse cannot
      // read the array it came from.
      const item = `e${depth}`;
      const inner = compile(
        meta.item.meta,
        meta.item.defaultValue,
        base,
        tables,
        bind,
        helpers,
        item,
        depth + 1,
      );
      // A concise arrow unless the item's parse needs statements of its own,
      // which belong inside the callback: they read the element, which exists
      // nowhere else.
      const body =
        inner.statements.length === 0
          ? inner.expression
          : `{ ${inner.statements.join(' ')} return ${inner.expression}; }`;
      return only(
        `Array.isArray(${v}) ? Array.from(${v}, ${item} => ${body}) : []`,
      );
    }
    default:
      throw new NotCompilable(`a ${meta.kind} schema`);
  }
}

/**
 * The values a compiled parse is checked against: whatever the schema itself
 * names — every enum member, both sides of every alias — plus the shapes
 * untrusted JSON actually arrives in, `Object.prototype` member names
 * included. Fixed rather than sampled, so a generator using it produces
 * byte-reproducible output.
 */
export function verificationCorpus(meta: SerializationSchemaMeta): unknown[] {
  const values: unknown[] = [
    undefined,
    null,
    true,
    false,
    0,
    1,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    '',
    ' ',
    '0',
    '1',
    '-1',
    '1.5',
    '1e3',
    // Well-formed JSON numbers that coerce out of the finite domain, so a
    // compiled parse that stops at the grammar disagrees with numberValue.
    '1e999',
    '-1e999',
    '0x10',
    '007',
    '+1',
    'Infinity',
    'NaN',
    // The edges of the JSON number grammar itself, each one a place the
    // emitted regexp and numberValue's could be edited apart: a bare
    // fraction, a trailing point, a signed zero, an exponent with no digits,
    // an uppercase or signed exponent, and surrounding whitespace.
    '.5',
    '5.',
    '-0',
    '1e',
    '1E5',
    '1.5e3',
    '1e+3',
    '1e-3',
    ' 1',
    '1 ',
    '1_000',
    '--1',
    'banana',
    'toString',
    'constructor',
    '__proto__',
    'hasOwnProperty',
    'valueOf',
    {},
    [],
    [1],
    {a: 1},
  ];
  const walk = (m: SerializationSchemaMeta): void => {
    if (m.kind === 'enum') {
      values.push(...m.values);
    } else if (m.kind === 'aliased') {
      values.push(...Object.keys(m.aliases), ...Object.values(m.aliases));
      walk(m.inner.meta);
    } else if (
      m.kind === 'transform' ||
      m.kind === 'nullable' ||
      m.kind === 'optional'
    ) {
      // Every wrapper, not just `transform`: the comment here promised that
      // `optional(transformValue(enumValue([...]), f))` was still checked over
      // the enum's values, and it was not — `optional` fell off the end of the
      // chain and the corpus contained none of them. A transform is opaque but
      // its input domain is not, and a wrapper's is its inner schema's.
      walk(m.inner.meta);
    } else if (m.kind === 'array') {
      walk(m.item.meta);
      // The item's whole corpus as one array, so every value the element
      // parse has to agree about is actually run through it — the scalars
      // `walk` contributes are only ever seen by the array parse as
      // *non*-arrays, which it rejects wholesale. Plus a sparse array, where
      // the runtime's index loop and an emitted `Array.from` both have to read
      // the hole as `undefined` rather than skip it.
      values.push(verificationCorpus(m.item.meta), new Array(2));
    } else if (m.kind === 'union') {
      for (const member of m.members) {
        walk(member.meta);
      }
    } else if (m.kind === 'object') {
      for (const field of Object.values(m.fields)) {
        walk(field.meta);
      }
    }
  };
  walk(meta);
  return values;
}

/**
 * Run a compiled expression against the schema it claims to reproduce, over
 * {@link verificationCorpus}, and throw {@link NotCompilable} naming the first
 * value they disagree on. This is the step that keeps a generated parser from
 * shipping with different behavior than the schema it was compiled from.
 *
 * A caller that applies a table *after* parsing — an `encode` turning a
 * serialized name into its stored form — verifies that separately with
 * {@link verifyTableCoversDomain}, which proves the table total rather than
 * sampling it. Keeping the two apart is what lets this check the expression the
 * generated code actually contains, rather than a closure wrapped around it for
 * the occasion.
 */
/**
 * Whether two parses are the same result. `Object.is`, so `NaN` matches `NaN`
 * and `0` does not match `-0` — except through an array, where every parse
 * returns a fresh one and identity would report every array schema as broken.
 * Its own comparison rather than the schema's `isEqual`: a comparator is the
 * schema's opinion about its domain, and this is checking the schema.
 */
function sameParse(want: unknown, got: unknown): boolean {
  if (Array.isArray(want) || Array.isArray(got)) {
    if (!Array.isArray(want) || !Array.isArray(got)) {
      return false;
    }
    if (want.length !== got.length) {
      return false;
    }
    // An index loop rather than `every`, which skips holes: a parse that left
    // one where the other filled it is exactly a disagreement to report.
    for (let i = 0; i < want.length; i++) {
      if (!sameParse(want[i], got[i])) {
        return false;
      }
    }
    return true;
  }
  return Object.is(want, got);
}

export function verifyCompiledParse({
  expression,
  nullPrototypeTables = [],
  schema,
  statements = [],
  tables,
  valueName = 'v',
}: VerifyCompiledParseOptions): void {
  const names = tables.map(({name}) => name);
  const nullProto = new Set(nullPrototypeTables);
  // This is the point of the exercise: the expression that is about to be
  // written into a generated module is compiled and run here, against the
  // schema it claims to reproduce, so a disagreement is a build failure rather
  // than a parser that silently stores the wrong value. Build-time only, over a
  // fixed corpus, with nothing untrusted in scope. A `Function` built from
  // source has no static type, hence the casts to what each body takes.
  //
  // The body binds the helpers and the tables beside the value, so `valueName`
  // has to be free of all of them. A name that is not is refused here rather
  // than left to `new Function`: a `const` redeclaring a parameter is a
  // SyntaxError, which is not a NotCompilable, so a caller that re-throws
  // anything else — which both of this repo's do — loses the build over a name
  // instead of naming the property. It is genuinely not compilable either way:
  // in a generated module the helpers are module scope and the tables are the
  // factory's, so a local of one of these names shadows what the expression
  // reads, which is what the generator's own `EMITTED_LOCALS` and
  // `checkTableLocals` refuse on its side.
  const bound = ['num', 'numC', 'numK', ...names];
  if (bound.includes(valueName)) {
    throw new NotCompilable(
      `compiles against a value named ${valueName}, which is also a helper or lookup table the expression reads`,
    );
  }
  // The scope parameter is the one name this chooses, so it is allocated past
  // all of them rather than spelled `SCOPE` outright. A property named `SCOPE`
  // compiles to an expression reading `SCOPE`, and two parameters of one name
  // is legal in a body that is not strict — the second simply wins, so the
  // expression read the bag of helpers instead of the value and disagreed with
  // its schema about every input.
  const taken = new Set([valueName, ...bound]);
  let scopeName = 'SCOPE';
  while (taken.has(scopeName)) {
    scopeName += '_';
  }
  // eslint-disable-next-line no-new-func
  const compiled = new Function(
    valueName,
    scopeName,
    `const {${bound.join(
      ', ',
    )}} = ${scopeName}; ${statements.join(' ')} return (${expression});`,
  ) as (v: unknown, scope: {readonly [key: string]: unknown}) => unknown;
  // eslint-disable-next-line no-new-func
  const num = new Function('v', 'd', 'JSON_NUMBER', NUM_BODY) as (
    value: unknown,
    fallback: number,
    jsonNumber: RegExp,
  ) => number;
  // eslint-disable-next-line no-new-func
  const numC = new Function(
    'v',
    'd',
    'min',
    'max',
    'integer',
    'num',
    NUM_RANGE_BODY,
  ) as (
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    integer: boolean,
    parse: (raw: unknown, ifInvalid: number) => number,
  ) => number;
  const jsonNumber = new RegExp(
    JSON_NUMBER_SOURCE.slice(1, JSON_NUMBER_SOURCE.lastIndexOf('/')),
  );
  const boundNum = (v: unknown, d: number): number => num(v, d, jsonNumber);
  // eslint-disable-next-line no-new-func
  const numK = new Function(
    'v',
    'd',
    'min',
    'max',
    'integer',
    'num',
    NUM_CLAMP_BODY,
  ) as (
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    integer: boolean,
    parse: (raw: unknown, ifInvalid: number) => number,
  ) => number;
  const scope: {[key: string]: unknown} = {
    num: boundNum,
    numC: (v: unknown, d: number, min: number, max: number, integer: boolean) =>
      numC(v, d, min, max, integer, boundNum),
    numK: (v: unknown, d: number, min: number, max: number, integer: boolean) =>
      numK(v, d, min, max, integer, boundNum),
  };
  for (const {name, table} of tables) {
    scope[name] = nullProto.has(name)
      ? Object.assign(Object.create(null), table)
      : {...table};
  }
  for (const value of verificationCorpus(schema.meta)) {
    const want = schema(value);
    const got = compiled(value, scope);
    if (!sameParse(want, got)) {
      throw new NotCompilable(
        `disagrees with its schema on ${literal(value)}: schema says ${literal(
          want,
        )}, generated says ${literal(got)}`,
      );
    }
  }
}

/**
 * Prove a lookup table maps every value `schema` can produce, and — for an
 * enum, where the domain is decidable — nothing else.
 *
 * A generated parse that ends in a table lookup emits a fallback for the key
 * that is not there, because the emitted TypeScript needs one. That fallback is
 * only ever *right* if it is unreachable: a domain member missing from the
 * table would otherwise be stored as whatever the default encodes to, silently
 * turning one value into another. So the table has to be total, and this is
 * where that is established rather than assumed.
 */
export function verifyTableCoversDomain({
  schema,
  table,
}: {
  schema: AnySerializationSchema;
  table: {readonly [key: string]: unknown};
}): void {
  const {meta} = schema;
  const produced = new Set(
    verificationCorpus(meta).map(value => schema(value)),
  );
  if (meta.kind === 'enum') {
    // Every member, whether or not the corpus happened to reach it.
    for (const value of meta.values) {
      produced.add(schema(value));
    }
  }
  for (const value of produced) {
    // Compared as the property key the lookup would use.
    if (!Object.prototype.hasOwnProperty.call(table, String(value))) {
      throw new NotCompilable(
        `has no table entry for ${literal(value)}, which its schema produces`,
      );
    }
  }
  if (meta.kind === 'enum') {
    // The converse, which only an enum makes decidable: a key the schema can
    // never produce is a member the table's author knows about and the enum
    // does not — one list was extended and the other was not — and import
    // would coerce that value to the default without anything noticing.
    const domain = new Set(meta.values.map(String));
    for (const key of Object.keys(table)) {
      if (!domain.has(key)) {
        throw new NotCompilable(
          `has a table entry for ${literal(key)} that its enum cannot produce`,
        );
      }
    }
  }
}

/**
 * Whether `literal(value)` evaluates back to a value that is `===` this one,
 * which is what an emitted comparison against it needs in order to mean what
 * the walk's `value === defaultValue` means.
 *
 * True for the primitives JSON round-trips. False for an object or array — a
 * literal allocates a fresh one, never `===` the default the walk holds — and
 * for a non-finite number, which `JSON.stringify` renders as `null`. `-0` is
 * rendered as `0`, which is fine: `-0 !== 0` is false either way.
 */
function hasFaithfulLiteral(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return (
    value === undefined ||
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  );
}

/**
 * A JavaScript expression over the variable `name`, true exactly when a value
 * of `schema` is *not* its default — the negation of the walk's
 * `value === defaultValue || isEqual(value, defaultValue)`, which is what the
 * compact form tests before writing a property, and what a property gated by a
 * predicate tests before calling it.
 *
 * A primitive default compares against its literal. A reference-typed default
 * has no literal a value could be `===`; the walk compares those through the
 * schema's own equality, and the one such equality this can restate from the
 * default alone is `arrayValue`'s against an empty array, which reduces to a
 * length test. Anything else — an object, a non-empty array, a non-finite
 * number — throws {@link NotCompilable}. Like a compiled parse, the result is
 * a claim about the schema, not a fact about it: run it through
 * {@link verifyDiffersFromDefault} before emitting it.
 *
 * @param schema the property's schema
 * @param name the variable holding the value
 */
export function compileDiffersFromDefault(
  schema: AnySerializationSchema,
  name: string,
): string {
  return compileDefaultComparison(schema, name, false);
}

/**
 * {@link compileDiffersFromDefault} and its negation, which `nullable`'s
 * `defaultAsNull` and `optional`'s `omitDefault` want the other way round.
 * Stated once so the two forms cannot answer differently, and so that neither
 * is the other wrapped in a `!(…)` — a generated parser reads better, and is
 * shorter, saying `x === ''` than `!(x !== '')`.
 */
function compileDefaultComparison(
  schema: AnySerializationSchema,
  name: string,
  equals: boolean,
): string {
  const {defaultValue} = schema;
  if (hasFaithfulLiteral(defaultValue)) {
    // `!==` is the whole of the walk's rule only while there is no second
    // clause. A comparator is an opaque closure, so nothing here can establish
    // that it never widens `===` — and a sampled check cannot either: an
    // equality modulo 360 agrees with `!== 0` on every value a corpus would
    // think to try, and disagrees on the first rotation a document actually
    // carries. `transformValue` refuses a comparator over a primitive domain
    // outright, so reaching this means one was lifted from an inner schema
    // whose own domain is reference-typed; that is coherent, but it is not
    // something this can compile.
    if (schema.isEqual !== undefined) {
      throw new NotCompilable(
        `compares against its default (${literal(
          defaultValue,
        )}) with an equality of its own`,
      );
    }
    return `${name} ${equals ? '===' : '!=='} ${literal(defaultValue)}`;
  }
  if (
    schema.meta.kind === 'array' &&
    schema.isEqual !== undefined &&
    Array.isArray(defaultValue) &&
    defaultValue.length === 0
  ) {
    const empty = `Array.isArray(${name}) && ${name}.length === 0`;
    return equals ? `(${empty})` : `!(${empty})`;
  }
  throw new NotCompilable(
    `has a default with no faithful literal (${literal(defaultValue)})`,
  );
}

/**
 * Run a {@link compileDiffersFromDefault} expression against the schema's own
 * rule — `value === defaultValue || isEqual(value, defaultValue)`, negated —
 * and throw {@link NotCompilable} naming the first value they disagree on.
 *
 * The values are {@link verificationCorpus} plus the default itself, a copy of
 * it (which is `===` to nothing the schema holds), and the array and object
 * shapes a structural comparison could confuse.
 *
 * This samples; it does not prove. It catches an expression that is wrong about
 * a value the schema itself names — an enum member, an alias, the default's own
 * shape — which is what a mistake in the emitted comparison looks like. It
 * cannot catch an expression that is wrong only about values nobody listed,
 * which is what an arbitrary `isEqual` produces, so
 * {@link compileDiffersFromDefault} refuses to emit against one rather than
 * bring it here.
 */
export function verifyDiffersFromDefault({
  expression,
  name,
  schema,
}: {
  expression: string;
  name: string;
  schema: AnySerializationSchema;
}): void {
  const {defaultValue, isEqual} = schema;
  // Build-time only, over a fixed corpus, with nothing untrusted in scope.
  // eslint-disable-next-line no-new-func
  const compiled = new Function(name, `return (${expression});`) as (
    value: unknown,
  ) => unknown;
  const copy = Array.isArray(defaultValue)
    ? [...defaultValue]
    : defaultValue !== null && typeof defaultValue === 'object'
      ? {...defaultValue}
      : defaultValue;
  const values: unknown[] = [
    ...verificationCorpus(schema.meta),
    defaultValue,
    copy,
    [],
    [0],
    ['a'],
    [undefined],
    new Array(1),
    {},
    {length: 0},
  ];
  for (const value of values) {
    const want = !(
      value === defaultValue ||
      (isEqual !== undefined && isEqual(value, defaultValue))
    );
    const got = Boolean(compiled(value));
    if (want !== got) {
      throw new NotCompilable(
        `disagrees with its schema on whether ${literal(
          value,
        )} is the default: schema says ${want ? 'no' : 'yes'}, generated says ${
          got ? 'no' : 'yes'
        }`,
      );
    }
  }
}
