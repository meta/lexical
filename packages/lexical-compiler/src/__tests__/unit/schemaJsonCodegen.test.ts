/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  aliasedValue,
  aliasTableOf,
  type AnySerializationSchema,
  arrayValue,
  booleanValue,
  enumValue,
  nullable,
  numberValue,
  objectValue,
  optional,
  rawValue,
  type SerializationSchema,
  type SerializationSchemaMeta,
  stringValue,
  transformValue,
  unionValue,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  compileDiffersFromDefault,
  compileParse,
  JSON_NUMBER_SOURCE,
  NotCompilable,
  NUM_BODY,
  NUM_CLAMP_BODY,
  NUM_HELPER_SOURCE,
  NUM_RANGE_BODY,
  verificationCorpus,
  verifyCompiledParse,
  verifyDiffersFromDefault,
  verifyTableCoversDomain,
} from '../../SchemaJsonCodegen';

/**
 * Build and run a compiled parse the way the generator's output does, so a
 * test asserts on behavior rather than on the expression text.
 */
function compiled(schema: AnySerializationSchema): (value: unknown) => unknown {
  const {expression, statements, tables} = compileParse(
    schema.meta,
    schema.defaultValue,
    'T',
  );
  const names = tables.map(({name}) => name);
  // The statements run before the expression here exactly as the generated
  // code runs them, which is what keeps this a test of what ships. `SCOPE_`
  // rather than `SCOPE` for the same reason `verifyCompiledParse` allocates
  // its own: the compiled expression may read a local of any name, and a
  // parameter this helper chooses must not be one of them. Nothing here
  // compiles against `SCOPE_`, so it is simply the name that is free.
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'v',
    'SCOPE_',
    `const {num, numC, numK, ${['_', ...names].join(
      ', ',
    )}} = SCOPE_; ${statements.join(' ')} return (${expression});`,
  );
  // Built from the same source text the generator emits and
  // verifyCompiledParse evaluates. Spelling it out here instead would be a
  // third copy of the number grammar, and a copy that silently kept passing
  // while the real helper changed is precisely what this checks against.
  // eslint-disable-next-line no-new-func
  const numFn = new Function('v', 'd', 'JSON_NUMBER', NUM_BODY);
  // eslint-disable-next-line no-new-func
  const numCFn = new Function(
    'v',
    'd',
    'min',
    'max',
    'integer',
    'num',
    NUM_RANGE_BODY,
  );
  // eslint-disable-next-line no-new-func
  const numKFn = new Function(
    'v',
    'd',
    'min',
    'max',
    'integer',
    'num',
    NUM_CLAMP_BODY,
  );
  const jsonNumber = new RegExp(
    JSON_NUMBER_SOURCE.slice(1, JSON_NUMBER_SOURCE.lastIndexOf('/')),
  );
  const num = (v: unknown, d: number) => numFn(v, d, jsonNumber);
  const scope: {[key: string]: unknown} = {
    _: undefined,
    num,
    numC: (v: unknown, d: number, min: number, max: number, integer: boolean) =>
      numCFn(v, d, min, max, integer, num),
    numK: (v: unknown, d: number, min: number, max: number, integer: boolean) =>
      numKFn(v, d, min, max, integer, num),
  };
  for (const {name, table} of tables) {
    scope[name] = Object.assign(Object.create(null), table);
  }
  return value => fn(value, scope);
}

/**
 * A schema no compiler can reproduce: the transform is an opaque closure, so
 * the meta describes its *input*. What every refusal below is built on.
 */
function transformed(): SerializationSchema<string, never, string> {
  return transformValue(stringValue(), value => value.toUpperCase());
}

/** `compileParse`'s arguments for one schema, since three tests need them. */
function schemaArgs(
  schema: AnySerializationSchema,
): [SerializationSchemaMeta, unknown, string] {
  return [schema.meta, schema.defaultValue, 'T'];
}

/** Every value the corpus covers has to agree, which is the real contract. */
function expectAgrees(schema: AnySerializationSchema): void {
  const run = compiled(schema);
  for (const value of verificationCorpus(schema.meta)) {
    expect({in: value, out: run(value)}).toEqual({
      in: value,
      out: schema(value),
    });
  }
}

describe('compileParse reproduces the schema it compiles', () => {
  test('stringValue', () => {
    expectAgrees(stringValue());
    expectAgrees(stringValue('fallback'));
  });

  test('booleanValue', () => {
    expectAgrees(booleanValue());
    expectAgrees(booleanValue(true));
  });

  test('numberValue', () => {
    expectAgrees(numberValue());
    expectAgrees(numberValue(7));
    // Including the stringified-number domain, which is the part a naive
    // `Number(v)` would get wrong for '0x10' and ''.
    const run = compiled(numberValue());
    expect(run('42')).toBe(42);
    expect(run('0x10')).toBe(0);
    expect(run('')).toBe(0);
    expect(run(' ')).toBe(0);
    expect(run('+1')).toBe(0);
    expect(run('Infinity')).toBe(0);
    expect(run(Infinity)).toBe(0);
    expect(run(NaN)).toBe(0);
    // Well-formed JSON numbers whose value is out of the finite domain:
    // matching the grammar is not enough, since numberValue tests
    // Number.isFinite on the *coerced* value. Stopping at the grammar stores
    // Infinity in a node field, which then serializes back out as null.
    expect(run('1e999')).toBe(0);
    expect(run('-1e999')).toBe(0);
    expect(run('9'.repeat(400))).toBe(0);
  });

  test('enumValue', () => {
    expectAgrees(enumValue(['normal', 'token', 'segmented']));
    expectAgrees(enumValue([null, 'ltr', 'rtl']));
    expectAgrees(enumValue(['a', 'b'], 'b'));
  });

  test('an enum member spelled undefined is never matched', () => {
    // enumValue checks for undefined before membership, so an absent property
    // takes the default rather than the in-band member.
    const schema = enumValue([undefined, 'a'], 'a');
    expectAgrees(schema);
    expect(compiled(schema)(undefined)).toBe('a');
  });

  test('aliasedValue', () => {
    const aliases = {bold: 1, italic: 2};
    const schema = aliasedValue(numberValue(), aliases);
    expectAgrees(schema);
    const run = compiled(schema);
    expect(run('bold')).toBe(1);
    expect(run('italic')).toBe(2);
    expect(run(4)).toBe(4);
    expect(run('4')).toBe(4);
    expect(run('nope')).toBe(0);
  });

  test('an alias table cannot be reached through Object.prototype', () => {
    // The key comes straight out of untrusted JSON, so a plain object literal
    // would resolve 'toString' to a function and store it as the value.
    const run = compiled(aliasedValue(numberValue(), {bold: 1}));
    for (const hostile of [
      'toString',
      'constructor',
      'hasOwnProperty',
      'valueOf',
      '__proto__',
    ]) {
      expect(run(hostile)).toBe(0);
    }
  });

  test('nullable', () => {
    expectAgrees(nullable(stringValue()));
    expectAgrees(nullable(enumValue(['ltr', 'rtl'])));
    const run = compiled(nullable(stringValue()));
    expect(run('x')).toBe('x');
    expect(run(null)).toBe(null);
    expect(run(undefined)).toBe(null);
    // A value the inner schema rejects is its default, not the nil: only the
    // wrapper's own nils collapse.
    expect(run(7)).toBe('');
  });

  test('nullable with defaultAsNull', () => {
    const schema = nullable(stringValue(), {defaultAsNull: true});
    expectAgrees(schema);
    const run = compiled(schema);
    expect(run('noopener')).toBe('noopener');
    // The historical `serializedNode.rel || null`: an in-band default, and
    // anything the inner schema coerces to it, is the nil.
    expect(run('')).toBe(null);
    expect(run(7)).toBe(null);
  });

  test('optional', () => {
    expectAgrees(optional(numberValue()));
    const run = compiled(optional(numberValue()));
    expect(run(120)).toBe(120);
    expect(run(undefined)).toBe(undefined);
    // `null` is the inner schema's to answer for, unlike nullable's.
    expect(run(null)).toBe(0);
  });

  test('optional with omitDefault', () => {
    const schema = optional(numberValue(), {omitDefault: true});
    expectAgrees(schema);
    const run = compiled(schema);
    expect(run(120)).toBe(120);
    expect(run(0)).toBe(undefined);
    expect(run('x')).toBe(undefined);
  });

  test('arrayValue', () => {
    expectAgrees(arrayValue(stringValue()));
    expectAgrees(arrayValue(numberValue(0, {integer: true, min: 0})));
    const run = compiled(arrayValue(stringValue()));
    expect(run(['a', 'b'])).toEqual(['a', 'b']);
    // Every element is coerced, and a non-array is the empty default.
    expect(run(['a', 7])).toEqual(['a', '']);
    expect(run('nope')).toEqual([]);
    // A hole is read as `undefined` rather than skipped, so the result stays
    // dense — a sparse one would serialize back out as `[null]`.
    expect(run(new Array(2))).toEqual(['', '']);
  });

  test('the wrappers nest', () => {
    expectAgrees(nullable(arrayValue(optional(stringValue()))));
    const run = compiled(arrayValue(nullable(numberValue())));
    expect(run([1, null, 'x', '2'])).toEqual([1, null, 0, 2]);
  });

  test('a collapsing wrapper binds a parse that costs something to repeat', () => {
    // The wrapper compares the parsed value against the inner default and
    // then returns it. An array's parse allocates and its default comparison
    // names the value twice more, so it is bound to a local once; a string's
    // is an inline test over `v`, cheaper repeated than bound.
    const bound = compileParse(
      ...schemaArgs(nullable(arrayValue(stringValue()), {defaultAsNull: true})),
    );
    expect(bound.statements).toEqual([
      'const p0 = Array.isArray(v) ? Array.from(v, e0 => typeof e0 === \'string\' ? e0 : "") : [];',
    ]);
    expect(bound.expression).toBe(
      'v == null || (Array.isArray(p0) && p0.length === 0) ? null : p0',
    );
    const repeated = compileParse(
      ...schemaArgs(nullable(stringValue(), {defaultAsNull: true})),
    );
    expect(repeated.statements).toEqual([]);

    // Both still agree with the schema they came from, which is the contract
    // the shape is in service of.
    expectAgrees(nullable(arrayValue(stringValue()), {defaultAsNull: true}));
    expectAgrees(optional(arrayValue(numberValue()), {omitDefault: true}));
    expectAgrees(
      nullable(aliasedValue(numberValue(), {bold: 1}), {defaultAsNull: true}),
    );
    const run = compiled(
      nullable(arrayValue(stringValue()), {defaultAsNull: true}),
    );
    expect(run(['a'])).toEqual(['a']);
    expect(run([])).toBe(null);
    expect(run('nope')).toBe(null);
  });

  test('a clamping numberValue', () => {
    const schema = numberValue(0, {
      clamp: true,
      integer: true,
      max: 128,
      min: 0,
    });
    expectAgrees(schema);
    const run = compiled(schema);
    expect(run(5)).toBe(5);
    // The point of `clamp`: out of range is the nearest bound, where the
    // plain bounds would fall back to the default and read a deeply indented
    // list item as a top-level one.
    expect(run(1e6)).toBe(128);
    expect(run(-4)).toBe(0);
    expect(run('1e6')).toBe(128);
    // Not a number at all, or not an integer when one is required, still
    // falls back: there is no nearest bound for either.
    expect(run(1.5)).toBe(0);
    expect(run('banana')).toBe(0);
    expect(run(Infinity)).toBe(0);
  });
});

describe('compileParse refuses what it cannot express', () => {
  test.each([
    ['unionValue', () => unionValue([numberValue(), stringValue()])],
    ['rawValue', () => rawValue()],
    ['objectValue', () => objectValue({a: stringValue()})],
    // The wrappers compile, but only over an inner schema that does. A
    // transform is opaque, so nothing built on one can be reproduced.
    ['nullable over a transform', () => nullable(transformed())],
    ['optional over a transform', () => optional(transformed())],
    ['an array of transforms', () => arrayValue(transformed())],
  ])('%s', (_label, build) => {
    const schema = build() as AnySerializationSchema;
    expect(() => compileParse(schema.meta, schema.defaultValue, 'T')).toThrow(
      NotCompilable,
    );
  });
});

describe('aliasTableOf resolves the tables compileParse numbered', () => {
  // A generated module holds no copy of a table: the declaration it emits is
  // `aliasTableOf(fields, key, index)`, resolved off the schema when the class
  // is registered. So the walk there has to descend exactly the schemas the
  // compiler descends, or registration hands the code a table it did not
  // compile against — or throws. The compiler is in this package and the walk
  // is in `lexical`, so this is where the two meet.
  const table = {one: 1, two: 2};
  const other = {three: 3};
  const both = {all: [3, 3]};
  test.each([
    ['a bare aliasedValue', () => aliasedValue(numberValue(), table), [table]],
    [
      'consecutive aliases',
      () => aliasedValue(aliasedValue(numberValue(), other), table),
      [table, other],
    ],
    [
      'an alias under an array',
      () => arrayValue(aliasedValue(numberValue(), table)),
      [table],
    ],
    [
      'an alias under optional',
      () => optional(aliasedValue(numberValue(), table)),
      [table],
    ],
    [
      'an alias under nullable',
      () => nullable(aliasedValue(numberValue(), table)),
      [table],
    ],
    [
      // The outer table's values are the array the inner schema parses to, so
      // this is also the case where the two tables have different shapes and
      // picking the wrong one is a type error rather than a silent swap.
      'aliases on both sides of a wrapper',
      () => aliasedValue(arrayValue(aliasedValue(numberValue(), other)), both),
      [both, other],
    ],
  ])('%s', (_label, build, expected) => {
    const schema = build() as AnySerializationSchema;
    const {tables} = compileParse(schema.meta, schema.defaultValue, 'T');
    expect(tables.map(({table: t}) => ({...t}))).toEqual(
      expected.map(t => ({...t})),
    );
    const fields = new Map([['p', schema]]);
    for (let i = 0; i < tables.length; i++) {
      expect({...aliasTableOf(fields, 'p', i)}).toEqual({...tables[i].table});
    }
    // One past the end is the miss, not a table from somewhere else.
    expect(() => aliasTableOf(fields, 'p', tables.length)).toThrow();
  });

  test('a schema with no alias at all resolves nothing', () => {
    const fields = new Map([
      ['p', arrayValue(numberValue()) as AnySerializationSchema],
    ]);
    expect(() => aliasTableOf(fields, 'p', 0)).toThrow();
  });
});

describe('a constrained numberValue compiles to its bounds', () => {
  test.each([
    ['a minimum', () => numberValue(0, {min: 1})],
    ['a maximum', () => numberValue(0, {max: 10})],
    ['integers only', () => numberValue(0, {integer: true})],
    ['all three', () => numberValue(2, {integer: true, max: 8, min: 1})],
    // The bound an absent option stands for is ±Infinity, which JSON.stringify
    // renders as `null` — so it is emitted as source, not through `literal`.
    ['no bounds at all', () => numberValue(3)],
  ])('%s', (_label, build) => {
    const schema = build() as AnySerializationSchema;
    const {expression, tables} = compileParse(
      schema.meta,
      schema.defaultValue,
      'T',
    );
    // The verification runs the emitted expression against the schema over the
    // corpus, so this is what proves the bounds were reproduced rather than
    // merely emitted.
    expect(() =>
      verifyCompiledParse({expression, schema, tables}),
    ).not.toThrow();
  });
});

describe('compileParse reports the helpers its expression calls', () => {
  // The caller emits their definitions, so it has to know which ones the
  // expression uses — and it cannot find out by reading the result back: a
  // schema key named `num` puts `json.num` in the parser and `num:` in the
  // exporter beside it, and neither is a call. Reported here instead, by the
  // compile that wrote the call.
  test.each([
    ['unbounded', () => numberValue(0), ['num']],
    ['bounded', () => numberValue(0, {min: 1}), ['numC']],
    ['clamped', () => numberValue(0, {clamp: true, min: 1}), ['numK']],
    ['not a number at all', () => stringValue(), []],
  ])('%s', (_label, build, expected) => {
    const schema = build() as AnySerializationSchema;
    const {expression, helpers} = compileParse(
      schema.meta,
      schema.defaultValue,
      'T',
    );
    expect(helpers).toEqual(expected);
    // What was reported is what the expression calls, which is the claim.
    for (const helper of ['num', 'numC', 'numK']) {
      expect(expression.includes(`${helper}(`)).toBe(
        (expected as string[]).includes(helper),
      );
    }
  });

  test('including one a wrapper or an array hides', () => {
    // The recursion collects into one set, so a helper the outermost kind does
    // not call is still reported when something inside it does.
    const wrapped = optional(
      arrayValue(numberValue(0, {min: 1})),
    ) as AnySerializationSchema;
    expect(
      compileParse(wrapped.meta, wrapped.defaultValue, 'T').helpers,
    ).toEqual(['numC']);
  });
});

describe('verifyCompiledParse is what catches a plausible-but-wrong parse', () => {
  test('a transformValue is refused rather than sampled', () => {
    // A transform is an opaque closure, so the corpus cannot be trusted to
    // contain a value that reveals it: this one differs from the identity on
    // every input, but `value => value === 'special' ? 'other' : value` would
    // differ on none the corpus knows to try, and the compiled parse — which
    // stores the un-transformed input — would pass verification and ship.
    // Naming the transform in the meta is what makes the refusal structural.
    const schema = transformValue(
      enumValue(['a', 'b']),
      value => (value === 'a' ? 1 : 2) as unknown,
    ) as AnySerializationSchema;
    expect(() => compileParse(schema.meta, schema.defaultValue, 'T')).toThrow(
      NotCompilable,
    );
    expect(() => compileParse(schema.meta, schema.defaultValue, 'T')).toThrow(
      /a transform schema/,
    );
  });

  test('the corpus still reaches through a transform to its input domain', () => {
    // The refusal is not the end of the transform's meta: an enum wrapped in
    // one still names its members, and those are what a schema *around* the
    // transform gets verified over.
    const schema = transformValue(enumValue(['a', 'b']), value =>
      value.toUpperCase(),
    ) as AnySerializationSchema;
    expect(verificationCorpus(schema.meta)).toEqual(
      expect.arrayContaining(['a', 'b']),
    );
  });

  test('a faithful parse passes', () => {
    const schema = aliasedValue(numberValue(), {bold: 1});
    const {expression, tables} = compileParse(
      schema.meta,
      schema.defaultValue,
      'T',
    );
    expect(() =>
      verifyCompiledParse({
        expression,
        nullPrototypeTables: tables.map(({name}) => name),
        schema,
        tables,
      }),
    ).not.toThrow();
  });

  test('a table left with Object.prototype fails the check', () => {
    // Not declaring the table null-prototype is exactly the bug the hostile
    // keys in the corpus are there to find.
    const schema = aliasedValue(numberValue(), {bold: 1});
    const {expression, tables} = compileParse(
      schema.meta,
      schema.defaultValue,
      'T',
    );
    expect(() =>
      verifyCompiledParse({
        expression,
        nullPrototypeTables: [],
        schema,
        tables,
      }),
    ).toThrow(/disagrees with its schema on "toString"/);
  });

  test('a value named for the verifier’s own scope is still verified', () => {
    // The helpers reach the compiled expression under a second parameter. That
    // parameter used to be spelled `SCOPE` outright, so an expression compiled
    // against a value of that name — a schema property really called `SCOPE` —
    // was shadowed by it: two parameters of one name is legal in a body that
    // is not strict, and the second wins. The parse then read the bag of
    // helpers and disagreed with its schema about every input, refusing a
    // schema that is perfectly well formed.
    const schema = stringValue('x');
    const {expression, statements, tables} = compileParse(
      schema.meta,
      schema.defaultValue,
      'T',
      undefined,
      'SCOPE',
    );
    expect(expression).toContain('SCOPE');
    expect(() =>
      verifyCompiledParse({
        expression,
        schema,
        statements,
        tables,
        valueName: 'SCOPE',
      }),
    ).not.toThrow();
  });

  test('a value named for a helper the expression calls is refused', () => {
    // The same body binds `num`, `numC`, `numK` and every table as `const`s,
    // and a `const` redeclaring a parameter is an unconditional SyntaxError —
    // so unlike the shadowing above there is nothing to rename around. It is
    // not compilable in a generated module either, where the helpers are
    // module scope and a local of that name shadows them, so this says so as
    // a NotCompilable rather than letting a raw SyntaxError take down a build
    // that would otherwise have named the property and fallen back.
    const schema = numberValue(0);
    const {expression, statements, tables} = compileParse(
      schema.meta,
      schema.defaultValue,
      'T',
      undefined,
      'num',
    );
    expect(() =>
      verifyCompiledParse({
        expression,
        schema,
        statements,
        tables,
        valueName: 'num',
      }),
    ).toThrow(NotCompilable);
  });
});

describe('verifyTableCoversDomain', () => {
  const mode = enumValue(['normal', 'token', 'segmented']);

  test('a total table passes', () => {
    expect(() =>
      verifyTableCoversDomain({
        schema: mode,
        table: {normal: 0, segmented: 2, token: 1},
      }),
    ).not.toThrow();
  });

  test('a missing member is named', () => {
    // Without this the generated lookup would fall back and store 'segmented'
    // as whatever the default encodes to, turning one value into another.
    expect(() =>
      verifyTableCoversDomain({schema: mode, table: {normal: 0, token: 1}}),
    ).toThrow(/no table entry for "segmented"/);
  });

  test('an inherited key does not count as coverage', () => {
    expect(() =>
      verifyTableCoversDomain({
        schema: enumValue(['toString']),
        table: {other: 1},
      }),
    ).toThrow(/no table entry for "toString"/);
  });

  test('a key the enum cannot produce is named', () => {
    // The other direction of the same drift: a member added to the table and
    // not to the enum is one import silently coerces to the default.
    expect(() =>
      verifyTableCoversDomain({
        schema: mode,
        table: {extra: 3, normal: 0, segmented: 2, token: 1},
      }),
    ).toThrow(/table entry for "extra" that its enum cannot produce/);
  });

  test('numeric members are compared as the property keys they become', () => {
    expect(() =>
      verifyTableCoversDomain({
        schema: enumValue([0, 1]),
        table: {0: 'a', 1: 'b'},
      }),
    ).not.toThrow();
  });
});

describe('compileDiffersFromDefault', () => {
  /** Compile and verify, the way the generator uses the two together. */
  function differs(schema: AnySerializationSchema): string {
    const expression = compileDiffersFromDefault(schema, 'value');
    verifyDiffersFromDefault({expression, name: 'value', schema});
    return expression;
  }

  test('a primitive default compares against its literal', () => {
    expect(differs(stringValue('fallback'))).toBe('value !== "fallback"');
    expect(differs(numberValue(7))).toBe('value !== 7');
    expect(differs(booleanValue(true))).toBe('value !== true');
    expect(differs(optional(numberValue()))).toBe('value !== undefined');
    expect(differs(nullable(stringValue()))).toBe('value !== null');
  });

  test('an empty array default becomes the length test its equality reduces to', () => {
    // arrayValue compares by content, so a fresh empty array *is* the default
    // even though no literal could be `===` to it.
    expect(differs(arrayValue(stringValue()))).toBe(
      '!(Array.isArray(value) && value.length === 0)',
    );
  });

  test.each([
    ['an object', () => objectValue({a: stringValue()})],
    ['a non-finite number', () => numberValue(Infinity)],
    [
      'a non-empty array',
      () => transformValue(arrayValue(numberValue()), () => [1] as number[]),
    ],
  ])('%s has no faithful comparison', (_label, build) => {
    const schema = build() as AnySerializationSchema;
    expect(() => compileDiffersFromDefault(schema, 'value')).toThrow(
      NotCompilable,
    );
  });

  test('an equality over a primitive domain is refused at the schema', () => {
    // Not a codegen limitation: `===` already decides a primitive, so a
    // comparator can only declare two distinct serialized values equal, and
    // the compact form then drops one and parses it back as the other. The
    // sampled verification cannot be the backstop — this comparator agrees
    // with `value !== 0` on every value the corpus tries and disagrees on the
    // first rotation a real document carries — so it is refused where it is
    // written.
    expect(() =>
      transformValue(numberValue(), value => value, {
        isEqual: (a, b) => a % 360 === b % 360,
      }),
    ).toThrow(/isEqual compares reference-typed values/);
  });

  test('an equality lifted onto a primitive default is refused by the codegen', () => {
    // The shape that survives the rule above: the comparator belongs to the
    // inner array, whose domain really is reference-typed, and the wrapper
    // that lifted it has `null` for a default. Emitting `value !== null` here
    // happens to be right, but nothing available can establish that, so it is
    // not emitted.
    const schema = nullable(arrayValue(stringValue()), {
      defaultAsNull: true,
    }) as AnySerializationSchema;
    expect(schema.isEqual).toBeTypeOf('function');
    expect(() => compileDiffersFromDefault(schema, 'value')).toThrow(
      /an equality of its own/,
    );
  });

  test('a structural test for a default compared by identity is caught', () => {
    // An empty-array default without arrayValue's equality: the walk omits
    // only the very object it holds, so a length test would omit too much.
    // compileDiffersFromDefault refuses it outright, and the verification
    // would have refused the expression had it been emitted.
    const schema = transformValue(
      stringValue(),
      () => [] as string[],
    ) as AnySerializationSchema;
    expect(() => compileDiffersFromDefault(schema, 'value')).toThrow(
      NotCompilable,
    );
    expect(() =>
      verifyDiffersFromDefault({
        expression: '!(Array.isArray(value) && value.length === 0)',
        name: 'value',
        schema,
      }),
    ).toThrow(/disagrees with its schema on whether \[\] is the default/);
  });
});

describe('the emitted num helper', () => {
  test('is the one the verification ran', () => {
    // Emitting a second spelling of this logic is the drift the whole
    // verification exists to prevent, so the source is shared rather than
    // written twice.
    expect(NUM_HELPER_SOURCE).toContain('function num(v: unknown, d: number)');
    expect(NUM_HELPER_SOURCE).toContain('Number.isFinite(v) ? v : d');
    expect(NUM_HELPER_SOURCE).toContain('JSON_NUMBER.test(v)');
  });
});

describe('verificationCorpus', () => {
  test('covers the values a schema names and the shapes JSON arrives in', () => {
    const values = verificationCorpus(
      aliasedValue(numberValue(), {bold: 1}).meta,
    );
    // Both sides of every alias, so a table that maps the wrong way is caught.
    expect(values).toContain('bold');
    expect(values).toContain(1);
    // And the prototype members a lookup must not resolve.
    for (const hostile of ['toString', 'constructor', '__proto__', 'valueOf']) {
      expect(values).toContain(hostile);
    }
    expect(values).toContain(undefined);
  });

  test('is fixed, so a generator using it is reproducible', () => {
    const meta = enumValue(['a', 'b']).meta;
    expect(verificationCorpus(meta)).toEqual(verificationCorpus(meta));
  });
});
