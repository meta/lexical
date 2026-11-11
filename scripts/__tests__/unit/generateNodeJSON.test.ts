/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  NUM_HELPER_SOURCE,
  NUM_RANGE_HELPER_SOURCE,
} from '@lexical/compiler/SchemaJsonCodegen';
import {transformSync} from 'esbuild';
import {
  aliasedValue,
  aliasTableOf,
  arrayValue,
  createEditor,
  enumValue,
  getComposedSchemaFields,
  getterTableOf,
  LineBreakNode,
  nodeSchema,
  numberValue,
  objectValue,
  optional,
  setterDefaultOf,
  setterTableOf,
  stringValue,
  TextNode,
  withAccessors,
  withField,
} from 'lexical';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import ts from 'typescript';
import {describe, expect, test} from 'vitest';

import {
  checkTableLocals,
  declareTable,
  emittable,
  generateCompactExport,
  generatePackage,
  generateUpdate,
  references,
  resetTableLocals,
  tableDeclaration,
  tableDeclarations,
  // @ts-expect-error - a .mjs script with JSDoc types, not a typed module
} from '../../shared/generateNodeJSON.mjs';
import {
  MANIFEST,
  stubSource,
  // @ts-expect-error - a .mjs script with JSDoc types, not a typed module
} from '../../shared/generateNodeJSONManifest.mjs';

/**
 * A generated source as a strict-mode script, which is what an ES module is.
 * Types are stripped first — a binding illegal in strict mode is a SyntaxError
 * the emitted TypeScript also has, but `new Function` cannot parse the
 * annotations to reach it — and the module form is lowered with it, so a whole
 * emitted module goes through here as readily as one function does.
 */
function parseAsModule(source: string): void {
  const {code} = transformSync(source, {format: 'cjs', loader: 'ts'});
  // Constructed for the parse alone, which is what throws.
  // eslint-disable-next-line no-new-func
  const parsed = new Function(`"use strict";\n${code}`);
  expect(typeof parsed).toBe('function');
}

/**
 * A generated module type-checked for real, not just transpiled.
 *
 * `ts.transpileModule` reports syntax alone, so an assertion the checker
 * rejects — `(x as string)` over a value it knows is a number — goes straight
 * through it. A schema whose node type-checks must not produce a module that
 * does not.
 */
function expectTypeChecks(module: string): void {
  const fileName = '/generated.ts';
  const options: ts.CompilerOptions = {
    // The repo's own lib set (`tsconfig.json`), so a generated form is held to
    // what `pnpm run tsc` holds it to. The default for a target is narrower,
    // which would reject something the real build accepts.
    lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) =>
    name === fileName
      ? ts.createSourceFile(name, module, ts.ScriptTarget.ESNext, true)
      : getSourceFile(name, ...rest);
  const program = ts.createProgram([fileName], options, host);
  // That the module was compiled at all, before what the checker said about
  // it. A diagnostic about the program rather than about a file — a lib that
  // did not resolve, a root file that was not found — carries no `file`, so
  // reporting only the ones inside the module would let "nothing was checked"
  // read exactly like "nothing was wrong".
  expect(program.getSourceFile(fileName)).toBeDefined();
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .filter(d => d.file === undefined || d.file.fileName === fileName)
      .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
  ).toEqual([]);
}

/**
 * One generated form as a module {@link expectTypeChecks} can compile on its
 * own: `lexical` does not resolve from a virtual file, so what the real module
 * imports is declared here instead, and the class the form was generated from
 * is declared as the shape it reads.
 *
 * The declared return types are the real ones (`LexicalSchema.ts`), not
 * `unknown`: an assertion off `unknown` is unconditionally legal, where one
 * off a concrete type goes through comparability — which is the check a
 * generated lookup has to pass.
 *
 * Call it with the table declarations of the same {@link resetTableLocals}
 * run that produced `source`.
 */
function checkableModule(shape: string, source: string): string {
  return [
    // An ES module, as the real one is. Without this the file is a script and
    // everything in it is global, where a `shape` named for a lib.dom
    // interface would *merge* with that interface rather than replace it —
    // `interface Text {...}` would quietly inherit every member of the DOM's.
    'export {};',
    // The helpers a bounded numeric domain parses through, as the module that
    // would hold this form declares them.
    NUM_HELPER_SOURCE,
    NUM_RANGE_HELPER_SOURCE,
    'declare const fields: unknown;',
    'type Table = {readonly [key: string]: unknown};',
    'declare function aliasTableOf(f: unknown, k: string, i: number): Table;',
    'declare function getterTableOf(f: unknown, k: string): Table;',
    'declare function setterTableOf(f: unknown, k: string): Table;',
    'declare function setterDefaultOf(f: unknown, k: string): unknown;',
    shape,
    // Only the tables this form reads, which is the filter `generatePackage`
    // applies before it writes a module: naming a class's locals registers its
    // getter tables too, and a parser reads none of them.
    ...tableDeclarations()
      .filter(([name]: [string, string]) => references(source, name))
      .map(
        ([name, declaration]: [string, string]) =>
          `const ${name} = ${declaration};`,
      ),
    source,
  ].join('\n');
}

/**
 * The generator interpolates schema keys, field names, accessor names and
 * predicate names straight into the JavaScript it writes. Every name in the
 * checked-in manifest is an ordinary identifier, so these refusals have no
 * other way to be exercised — and the failure they replace is either a syntax
 * error reported against generated code rather than against the schema that
 * caused it, or, for the names that do parse, code that reads something other
 * than what was declared.
 */
describe('names interpolated into generated code', () => {
  test('a plain identifier is returned unchanged', () => {
    expect(emittable('textFormat', 'schema key')).toBe('textFormat');
    expect(emittable('__style', 'getter field')).toBe('__style');
    expect(emittable('$weird', 'schema key')).toBe('$weird');
    // The shape is all this decides. A name that cannot be *bound* is not
    // refused here — it keeps its name in every property position and gets a
    // renamed local; see the rename tests below.
    expect(emittable('class', 'schema key')).toBe('class');
    expect(emittable('node', 'schema key')).toBe('node');
  });

  test('anything that is not an identifier is refused', () => {
    for (const name of ['data-foo', '2fast', 'a b', '', 'a.b', 'ids[]']) {
      expect(() => emittable(name, 'schema key')).toThrow(
        /is not a plain identifier/,
      );
    }
  });

  test('a name a sibling schema key already binds is refused', () => {
    // The compact exporter binds `const <key>` for every property and
    // `hoistGatedReads` binds `const <predicate>` in the same scope, so a
    // `when` predicate sharing a sibling's name emitted two `const`s and a
    // generated module that does not parse — a `SyntaxError` reported against
    // generated code rather than against the schema that caused it. The
    // rename gives two *different* names two different locals, but it cannot
    // invent a difference between a name and itself, which is why this one
    // collision is still a refusal.
    expect(emittable('shown', 'when predicate', new Set(['visible']))).toBe(
      'shown',
    );
    expect(() =>
      emittable('shown', 'when predicate', new Set(['shown', 'visible'])),
    ).toThrow(/collides with a name the generated code binds/);
    // A renamed name is held to the same rule: `arguments` as both a property
    // and the predicate gating it emitted `const arguments_` twice.
    expect(emittable('arguments', 'when predicate', new Set(['label']))).toBe(
      'arguments',
    );
    expect(() =>
      emittable('arguments', 'when predicate', new Set(['arguments'])),
    ).toThrow(/collides with a name the generated code binds/);
  });
});

describe('lookup table locals', () => {
  test('the same declaration may be bound again under its own name', () => {
    const declaration = tableDeclaration('setter', 'mode', {a: 1});
    declareTable('TEXT_MODE_SETTER', declaration);
    expect(() => declareTable('TEXT_MODE_SETTER', declaration)).not.toThrow();
  });

  test('two different tables cannot share a name', () => {
    // Names are derived by upper-casing, which is not injective: `textFormat`
    // and `textformat` produce the same one. Silently replacing the first
    // binding would leave one property decoding through the other's table.
    declareTable('COLLIDE_GETTER', tableDeclaration('getter', 'a', {a: 1}));
    expect(() =>
      declareTable('COLLIDE_GETTER', tableDeclaration('getter', 'b', {b: 2})),
    ).toThrow(/two different lookup tables both want the name/);
  });
});

/**
 * A generated module binds each table it reads to a local of the class's
 * factory, read off the composed schema the factory is handed, so the only
 * thing it states about a table is its type. No manifest class has a table
 * whose values need every spelling below, so they are driven through
 * `tableDeclaration`.
 */
describe('a lookup table declaration', () => {
  test('reads the table off the schema and states its type', () => {
    expect(tableDeclaration('getter', 'mode', {0: 'normal', 1: 'token'})).toBe(
      'getterTableOf(fields, "mode") as {readonly [key: string]: "normal" | "token"}',
    );
    expect(tableDeclaration('setter', 'mode', {normal: 0, token: 1})).toBe(
      'setterTableOf(fields, "mode") as {readonly [key: string]: 0 | 1}',
    );
    expect(tableDeclaration('alias', 'format', {bold: 1}, 0)).toBe(
      'aliasTableOf(fields, "format", 0) as {readonly [key: string]: 1}',
    );
  });

  test('spells an undefined value as the type undefined', () => {
    // A `getterTable` may map a stored value to `undefined`: that is how a
    // stored value whose serialized form is the omitted default is spelled.
    // `JSON.stringify` has no spelling for it, and once left a type ending in
    // ` | `; the value itself is the schema's to hold now.
    expect(
      tableDeclaration('getter', 'mode', {0: undefined, 1: 'special'}),
    ).toBe(
      'getterTableOf(fields, "mode") as {readonly [key: string]: "special" | undefined}',
    );
  });

  test('keeps the literal union however many values there are', () => {
    // A `setterTable`'s value is assigned to the field, and a field is often
    // narrower than its primitive: nine modes stored as `0 | 1 | ... | 8`.
    // Widening the table to `number` past a readable size made the generated
    // parser fail to compile for a node whose schema type-checks.
    const table: {[key: string]: unknown} = {};
    for (let i = 0; i < 9; i++) {
      table[`mode${i}`] = i;
    }
    expect(tableDeclaration('setter', 'mode', table)).toContain(
      '{readonly [key: string]: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}',
    );
  });

  test('a number JSON cannot spell is the type number', () => {
    // `setterTable: {unlimited: Infinity}` serializes the string and stores the
    // sentinel. Written through `JSON.stringify` the module once held `null`
    // where the walk stored `Infinity`; nothing about the value is written
    // now, and `Infinity` is no literal type, so the type widens to `number`
    // beside the finite literals. `-0` is the type `0`.
    expect(
      tableDeclaration('setter', 'limit', {
        minus: -Infinity,
        nan: NaN,
        one: 1,
        unlimited: Infinity,
        zero: -0,
      }),
    ).toContain('{readonly [key: string]: 0 | 1 | number}');
  });

  test('an empty alias table is declared as mapping to never', () => {
    // `aliasedValue(numberValue(), {})` is a valid schema — an alias table
    // with nothing in it — and registers and imports correctly. Its type is
    // the union of its values, which is empty, and an empty union spelled as
    // nothing left `{readonly [key: string]: }` in the module: no type at all.
    expect(tableDeclaration('alias', 'value', {}, 0)).toBe(
      'aliasTableOf(fields, "value", 0) as {readonly [key: string]: never}',
    );
    class ValueNode extends LineBreakNode {
      __value = 0;
      $config() {
        return this.config('generate-empty-alias', {
          extends: LineBreakNode,
          json: nodeSchema<ValueNode>()({
            value: withField(aliasedValue(numberValue(), {}), {
              field: '__value',
            }),
          }),
        });
      }
    }
    resetTableLocals();
    const source: string = generateUpdate(ValueNode);
    // What the module would hold for this class, checked as TypeScript
    // rather than read: an empty type is a syntax error the type checker
    // reports against generated code.
    const module = [
      NUM_HELPER_SOURCE,
      ...tableDeclarations().map(
        ([name, declaration]: [string, string]) =>
          `const ${name} = ${declaration};`,
      ),
      source,
    ].join('\n');
    const {diagnostics} = ts.transpileModule(module, {
      reportDiagnostics: true,
    });
    expect(
      (diagnostics || []).map(d =>
        ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      ),
    ).toEqual([]);
  });

  test('a parser falls back to the encoded default for a value the table misses', () => {
    // `verifyTableCoversDomain` proves an enum's table total, but a bounded
    // numeric domain it samples: `2` is in this one and need not be in the
    // corpus, and the table does not map it. The walk stores the encoded
    // default for such a miss, so the generated parser must too — read off
    // the schema when the code is attached, like the table itself, not
    // written into the module. Read bare, it stored `undefined`.
    // A LineBreakNode subclass: the base declares no property of its own, so
    // the composed schema — and the factory body assembled below — is this
    // one property and nothing else.
    class LimitNode extends LineBreakNode {
      __limit = 0;
      $config() {
        return this.config('generate-limit-miss', {
          extends: LineBreakNode,
          json: nodeSchema<LimitNode>()({
            limit: withField(numberValue(0, {integer: true, max: 2, min: 0}), {
              field: '__limit',
              getterTable: {0: 0, 1: 1},
              setterTable: {0: 0, 1: 1},
            }),
          }),
        });
      }
    }
    // As `generatePackage` does before each class: the forms bind their
    // tables into one registry, and the tests above have bound some already.
    resetTableLocals();
    const source: string = generateUpdate(LimitNode);
    // The factory's locals, the parser, and the parser handed back: what the
    // emitted module does, assembled for one class and run here against the
    // real helpers and the class's real composed schema.
    const module = [
      // The module-scope helpers a bounded numeric domain parses through.
      NUM_HELPER_SOURCE,
      NUM_RANGE_HELPER_SOURCE,
      ...tableDeclarations().map(
        ([name, declaration]: [string, string]) =>
          `const ${name} = ${declaration};`,
      ),
      source,
      'return updateLimitNode;',
    ].join('\n');
    const {code} = transformSync(module, {loader: 'ts'});
    const fields = new Map(Object.entries(getComposedSchemaFields(LimitNode)));
    // The assembled module is source, and running it is the point.
    // eslint-disable-next-line no-new-func
    const update = new Function(
      'fields',
      'aliasTableOf',
      'getterTableOf',
      'setterTableOf',
      'setterDefaultOf',
      code,
    )(fields, aliasTableOf, getterTableOf, setterTableOf, setterDefaultOf) as (
      node: LimitNode,
      json: {readonly [key: string]: unknown},
    ) => LimitNode;
    const editor = createEditor({
      namespace: '',
      nodes: [LimitNode],
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        const node = new LimitNode();
        update(node, {limit: 2});
        expect(node.__limit).toBe(0);
        update(node, {limit: 1});
        expect(node.__limit).toBe(1);
      },
      {discrete: true},
    );
    expect(source).toContain(
      '(limitParsed as string) in LIMIT_LIMIT_SETTER ? LIMIT_LIMIT_SETTER[limitParsed as string] : LIMIT_LIMIT_SETTER_DEFAULT',
    );
  });

  test('a table whose keys are numbers is indexed without a refused cast', () => {
    // The lookup spells its key `as string`, since that is what indexing an
    // object takes. Over a numeric domain the parsed value is `0 | 1`, which
    // does not overlap `string` at all, and TypeScript refuses the assertion
    // outright: `TS2352`, reported against generated code, for a node and a
    // schema that both type-check. The lookup itself is right either way — a
    // numeric key and its decimal string are the same property — so what the
    // parsed local needs is a type with nothing to say about it.
    class ModeNode extends LineBreakNode {
      __mode: 0 | 1 = 0;
      $config() {
        return this.config('generate-numeric-table', {
          extends: LineBreakNode,
          json: nodeSchema<ModeNode>()({
            mode: withField(enumValue([0, 1] as const), {
              field: '__mode',
              getterTable: {0: 0, 1: 1},
              setterTable: {0: 0, 1: 1},
            }),
          }),
        });
      }
    }
    resetTableLocals();
    const source: string = generateUpdate(ModeNode, true);
    expect(source).toContain('const modeParsed: unknown =');
    expect(() => parseAsModule(source)).not.toThrow();
    expectTypeChecks(
      checkableModule('interface ModeNode {\n  __mode: 0 | 1;\n}', source),
    );
  });
});

/**
 * The compact form omits a property whose value parsing would restore, and the
 * generator states that comparison as source where the default has a literal a
 * value could be `===`. What it does where the default has none is invisible in
 * the checked-in output — no manifest class has such a property — so these
 * drive the generator over classes it does not contain.
 */
describe('a property the compact form cannot compare as source', () => {
  test('a default of undefined needs no comparison at all', () => {
    // `optional` lifts its inner schema's `isEqual`, so this property has one
    // while its default is `undefined` — and comparing against `undefined`
    // with an equality of its own is one of `differsFromDefault`'s refusals.
    // The walk skips an undefined value before it ever looks at the default,
    // and so does the generated form, so for this property the refusal is
    // moot: rendering the comparison first threw it over a string the test
    // was about to discard.
    class OptionalTags extends TextNode {
      __tags: undefined | number[] = undefined;
      $config() {
        return this.config('generate-optional-tags', {
          extends: TextNode,
          json: nodeSchema<OptionalTags>()({
            tags: withField(optional(arrayValue(numberValue())), {
              field: '__tags',
            }),
          }),
        });
      }
    }
    const source: string = generateCompactExport(OptionalTags);
    expect(source).toContain('const tags = node.__tags;');
    // The whole test, with nothing else and'd onto it.
    expect(source).toContain('if (tags !== undefined) {');
    // While a sibling that does have a default still compares against it.
    expect(source).toContain('if (style !== undefined && style !== "") {');
  });

  test('asks the schema at run time, and costs its siblings nothing', () => {
    // An object default — here the one `objectValue` composes from its fields'
    // — genuinely has no literal a value could be `===`, so the comparison
    // cannot be written down and the schema answers when the node is exported
    // instead. It used to take the whole class out of this form, which cost
    // `text`, `style` and the rest their generated code over one property they
    // have nothing to do with.
    class ObjectDefault extends TextNode {
      __box: {w: number} = {w: 0};
      $config() {
        return this.config('generate-object-default', {
          extends: TextNode,
          json: nodeSchema<ObjectDefault>()({
            box: withField(objectValue({w: numberValue()}), {field: '__box'}),
          }),
        });
      }
    }
    const source: string = generateCompactExport(ObjectDefault);
    // Same rule as the parser's: a published node whose omission test is a
    // call back into the schema is one we meant to state as source.
    expect(() => generateCompactExport(ObjectDefault, true)).toThrow(
      /compact export compares "box" at run time/,
    );
    expect(source).toContain('const box = node.__box;');
    expect(source).toContain(
      'if (box !== undefined && !isCompactDefault("box", box)) {',
    );
    // Which is what the parameter is declared for, and only then.
    expect(source).toContain('isCompactDefault: CompactDefaultTest,');
    // The siblings keep the comparisons they always had, as source.
    expect(source).toContain('if (style !== undefined && style !== "") {');
    expect(source).toContain('if (text !== undefined && text !== "") {');
  });

  test('and a default spelled like that call is not one', () => {
    // The parameter was declared where the body *contained* the call's text,
    // which a string default spelled that way puts there without calling
    // anything: the exporter grew a second parameter nothing used. What
    // compiled the comparison says whether it needs one, the way the numeric
    // helpers report themselves.
    class Spelled extends TextNode {
      __label: string = 'isCompactDefault(';
      $config() {
        return this.config('generate-spelled-default', {
          extends: TextNode,
          json: nodeSchema<Spelled>()({
            label: withField(stringValue('isCompactDefault('), {
              field: '__label',
            }),
          }),
        });
      }
    }
    const source: string = generateCompactExport(Spelled, true);
    expect(source).toContain('"isCompactDefault("');
    expect(source).not.toContain('isCompactDefault: CompactDefaultTest,');
    expect(source).toContain(`function exportCompactSpelled(node: Spelled)`);
  });
});

/**
 * A schema key, a `when` predicate and a lookup table all reach the generated
 * code as identifiers, and the generated forms bind locals of their own beside
 * them. Nothing in the checked-in output exercises a name that collides with
 * one — every manifest property is called something ordinary — so these drive
 * the generator over classes it does not contain, for the two failures a bad
 * name produces: a module that does not parse, and one that parses and reads
 * something other than what was declared.
 */
describe('names the generated forms have to bind', () => {
  test('a strict-mode binding name gets a local it can bind', () => {
    // `arguments` and `eval` are legal identifiers, legal property names, and
    // legal member accesses, but cannot be bound in strict mode — which every
    // emitted module is. `const arguments = node.__args;` is a SyntaxError
    // that no check of the name's shape would catch, so the local is renamed
    // and the property keeps its own name.
    class StrictNames extends TextNode {
      __args: string = '';
      __evaluated: string = '';
      $config() {
        return this.config('generate-strict-names', {
          extends: TextNode,
          json: nodeSchema<StrictNames>()({
            arguments: withField(stringValue(), {field: '__args'}),
            eval: withField(stringValue(), {field: '__evaluated'}),
          }),
        });
      }
    }
    const source: string = generateCompactExport(StrictNames);
    expect(source).toContain('const arguments_ = node.__args;');
    expect(source).toContain('const eval_ = node.__evaluated;');
    expect(source).toContain(
      'if (arguments_ !== undefined && arguments_ !== "") {',
    );
    // The serialized property is still spelled as the schema declared it.
    expect(source).toContain('json.arguments = arguments_;');
    expect(source).toContain('json.eval = eval_;');
    // And the whole thing is something a module can actually contain, which
    // is the part a check of the name alone would miss.
    expect(() => parseAsModule(source)).not.toThrow();
  });

  test('a table reference is matched literally, not as a pattern', () => {
    // A table's name comes from a schema key, so it may contain `$`, which a
    // pattern reads as an anchor. The unreferenced-table filter used
    // `new RegExp(`\\b${name}\\b`)`, so `DOLLAR_$MODE_GETTER` matched nothing:
    // the declaration was dropped while the code reading it was kept, and the
    // emitted module threw `ReferenceError`.
    expect(references('T[DOLLAR_$MODE_GETTER]', 'DOLLAR_$MODE_GETTER')).toBe(
      true,
    );
    expect(references('const x = 1;', 'DOLLAR_$MODE_GETTER')).toBe(false);
    // And a name that is only part of a longer identifier is not a reference,
    // which is what the word boundaries were there for: `X_Y_SETTER` is a
    // prefix of `X_Y_SETTER_DEFAULT`.
    expect(references('a = X_Y_SETTER_DEFAULT;', 'X_Y_SETTER')).toBe(false);
    expect(references('a = X_Y_SETTER;', 'X_Y_SETTER')).toBe(true);
    expect(references('a = $X_Y_SETTER;', 'X_Y_SETTER')).toBe(false);
  });

  test('and inside a string literal it is not a reference at all', () => {
    // A schema's own values reach the output as string literals, so a name
    // that appears in one was written by the schema, not called by the code.
    // Declaring for it emits something nothing uses, which `noUnusedLocals`
    // rejects — the build failing over what a property's default was spelled.
    expect(references('v = "X_Y_SETTER";', 'X_Y_SETTER')).toBe(false);
    expect(references('v = "numC(";', 'numC')).toBe(false);
    // Still found where the code does use it, beside a literal that does not.
    expect(references('v = c ? "numC(" : numC(v, 0);', 'numC')).toBe(true);
    // An escaped quote does not end the literal, and an escaped backslash does
    // not escape the quote after it.
    expect(references('v = "a\\"X_Y_SETTER\\"b";', 'X_Y_SETTER')).toBe(false);
    expect(references('v = "a\\\\"; X_Y_SETTER;', 'X_Y_SETTER')).toBe(true);
    // Apostrophes in the generated docblocks are prose, not quotes: masking
    // from one would swallow the code after it.
    expect(
      references(
        "/** ListNode's schema. */\nfunction f() {\n  return X_Y_SETTER;\n}",
        'X_Y_SETTER',
      ),
    ).toBe(true);
  });

  test('a property named for a lookup table is refused', () => {
    // The table is bound in the class's factory and the local inside a form it
    // encloses, so the local shadows it and a read before its own declaration
    // is a ReferenceError.
    class NamedTableNode extends TextNode {
      __m = 0;
      NAMEDTABLE_MODE_GETTER = '';
      $config() {
        return this.config('named-table', {
          extends: TextNode,
          json: nodeSchema<NamedTableNode>()({
            NAMEDTABLE_MODE_GETTER: withField(stringValue(), {
              field: 'NAMEDTABLE_MODE_GETTER',
            }),
            mode: withField(enumValue(['normal', 'token']), {
              field: '__m',
              getterTable: {0: 'normal', 1: 'token'},
              setterTable: {normal: 0, token: 1},
            }),
          }),
        });
      }
    }
    expect(() =>
      checkTableLocals(NamedTableNode, ['NAMEDTABLE_MODE_GETTER']),
    ).toThrow(/collides with a local the generated code binds/);
    // A table whose name no property takes is fine.
    expect(() =>
      checkTableLocals(NamedTableNode, ['NAMEDTABLE_MODE_SETTER']),
    ).not.toThrow();
  });

  test('even when the property is one the exporter never reads', () => {
    // The parser binds a local for an import-only property too, so it shadows
    // a table exactly as a readable one does — and this said nothing about it,
    // because it asked what the *exporter's* reads bind. What shipped was a
    // parser reading its lookup table out of the serialized JSON.
    class ImportOnlyTableNode extends TextNode {
      __m = 0;
      __shadow = '';
      $config() {
        return this.config('named-table-import-only', {
          extends: TextNode,
          json: nodeSchema<ImportOnlyTableNode>()({
            IMPORTONLYTABLE_MODE_SETTER: withAccessors(stringValue(), {
              getter: null,
              setter: {field: '__shadow'},
            }),
            mode: withField(enumValue(['normal', 'token']), {
              field: '__m',
              getterTable: {0: 'normal', 1: 'token'},
              setterTable: {normal: 0, token: 1},
            }),
          }),
        });
      }
    }
    expect(() =>
      checkTableLocals(ImportOnlyTableNode, ['IMPORTONLYTABLE_MODE_SETTER']),
    ).toThrow(/collides with a local the generated code binds/);
  });

  test('a local never takes the name of a global the code reads', () => {
    // `const undefined = node.__label;` is legal, and turns every omission
    // test into `undefined !== undefined` — false for every value, so the
    // compact form silently drops the property. `const Array = node.__tags;`
    // shadows the `Array.isArray` an empty-array default comparison calls.
    class Globals extends TextNode {
      __label: string = '';
      __tags: string[] = [];
      $config() {
        return this.config('generate-globals', {
          extends: TextNode,
          json: nodeSchema<Globals>()({
            Array: withField(arrayValue(stringValue()), {field: '__tags'}),
            undefined: withField(stringValue(), {field: '__label'}),
          }),
        });
      }
    }
    const source: string = generateCompactExport(Globals);
    expect(source).toContain('const undefined_ = node.__label;');
    expect(source).toContain('const Array_ = node.__tags;');
    // The omission tests compare against the global, not against themselves.
    expect(source).toContain('if (undefined_ !== undefined && undefined_');
    expect(source).toContain('!(Array.isArray(Array_) && Array_.length === 0)');
    expect(source).toContain('json.undefined = undefined_;');
    expect(source).toContain('json.Array = Array_;');
    expect(() => parseAsModule(source)).not.toThrow();
  });

  test('a reserved word or an emitted local is renamed, not refused', () => {
    // `const default = node.__fallback;` is a SyntaxError and `const node =
    // node.__owner;` shadows the parameter it reads from, so neither name can
    // be bound — but both are perfectly good serialized property names, and
    // refusing them cost the class its generated code over what the property
    // was called.
    class Awkward extends TextNode {
      __fallback: string = '';
      __owner: string = '';
      $config() {
        return this.config('generate-awkward', {
          extends: TextNode,
          json: nodeSchema<Awkward>()({
            default: withField(stringValue(), {field: '__fallback'}),
            node: withField(stringValue(), {field: '__owner'}),
          }),
        });
      }
    }
    const source: string = generateCompactExport(Awkward);
    expect(source).toContain('const default_ = node.__fallback;');
    expect(source).toContain('const node_ = node.__owner;');
    // The property keeps the name the schema gave it everywhere it is one.
    expect(source).toContain('json.default = default_;');
    expect(source).toContain('json.node = node_;');
    expect(() => parseAsModule(source)).not.toThrow();
  });

  test('a renamed local does not collide with a sibling of that name', () => {
    // The rename is an underscore, so a schema that declares both names needs
    // the second one to keep going until it is free.
    class Both extends TextNode {
      __args: string = '';
      __underscored: string = '';
      $config() {
        return this.config('generate-strict-collision', {
          extends: TextNode,
          json: nodeSchema<Both>()({
            arguments: withField(stringValue(), {field: '__args'}),
            arguments_: withField(stringValue(), {field: '__underscored'}),
          }),
        });
      }
    }
    const source: string = generateCompactExport(Both);
    expect(source).toContain('const arguments__ = node.__args;');
    expect(source).toContain('const arguments_ = node.__underscored;');
    expect(source).toContain('json.arguments = arguments__;');
    expect(source).toContain('json.arguments_ = arguments_;');
    expect(() => parseAsModule(source)).not.toThrow();
  });

  test('nor with a sibling spelled like a local derived from a name', () => {
    // A property whose parse ends in a lookup binds a second local for what
    // the parse made of the value, named `<local>Parsed` — and a sibling
    // property may be called exactly that. Two `const`s of one name in one
    // function body is a SyntaxError, so the derived name goes through the
    // same allocator the property names do rather than being spelled out.
    class Sibling extends LineBreakNode {
      __mode: 0 | 1 = 0;
      __note: string = '';
      $config() {
        return this.config('generate-parsed-collision', {
          extends: LineBreakNode,
          json: nodeSchema<Sibling>()({
            mode: withField(enumValue([0, 1] as const), {
              field: '__mode',
              getterTable: {0: 0, 1: 1},
              setterTable: {0: 0, 1: 1},
            }),
            modeParsed: withField(stringValue(), {field: '__note'}),
          }),
        });
      }
    }
    resetTableLocals();
    const source: string = generateUpdate(Sibling, true);
    // The property keeps its name; the derived local is the one that moves.
    expect(source).toContain('const modeParsed = json.modeParsed;');
    expect(source).toContain('const modeParsed_: unknown =');
    expect(source).toContain('node.__note = ');
    expect(() => parseAsModule(source)).not.toThrow();
    // The renamed local is still a lookup key the checker accepts, which is a
    // separate claim from the module parsing and has its own way to regress.
    expectTypeChecks(
      checkableModule(
        'interface Sibling {\n  __mode: 0 | 1;\n  __note: string;\n}',
        source,
      ),
    );
  });

  test('including a sibling the exporter never reads', () => {
    // The parser binds a local for every property in the composed schema, and
    // an import-only one is a property like any other — but it has no read, so
    // a name set derived from the exporter's reads does not mention it. Both
    // allocators were, and both landed straight on top of one.
    class ImportOnly extends LineBreakNode {
      __mode: 0 | 1 = 0;
      __note: string = '';
      __tail: string = '';
      $config() {
        return this.config('generate-import-only-collision', {
          extends: LineBreakNode,
          json: nodeSchema<ImportOnly>()({
            default: withField(stringValue(), {field: '__tail'}),
            // Spelled as the rename of `default`, which cannot be bound.
            default_: withAccessors(stringValue(), {
              getter: null,
              setter: {field: '__note'},
            }),
            mode: withField(enumValue([0, 1] as const), {
              field: '__mode',
              getterTable: {0: 0, 1: 1},
              setterTable: {0: 0, 1: 1},
            }),
            modeParsed: withAccessors(stringValue(), {
              getter: null,
              setter: {field: '__note'},
            }),
          }),
        });
      }
    }
    resetTableLocals();
    const source: string = generateUpdate(ImportOnly, true);
    // The derived local moves past the import-only sibling,
    expect(source).toContain('const modeParsed = json.modeParsed;');
    expect(source).toContain('const modeParsed_: unknown =');
    // and so does the rename of a name that cannot be bound.
    expect(source).toContain('const default__ = json.default;');
    expect(source).toContain('const default_ = json.default_;');
    expect(() => parseAsModule(source)).not.toThrow();
  });

  test('a property named for the verifier’s own scope still compiles', () => {
    // A compiled parse is checked by running it against the same corpus the
    // schema is run against, in a function that takes the value under one
    // parameter and the helpers it calls under another. Spelling the second
    // `SCOPE` outright made a property of that name shadow the value, so the
    // parse read the bag of helpers and disagreed with its schema about every
    // input — a refusal, and a class that silently fell back to the walk,
    // over what one property happened to be called.
    class Scoped extends LineBreakNode {
      __scope: string = '';
      $config() {
        return this.config('generate-scope-name', {
          extends: LineBreakNode,
          json: nodeSchema<Scoped>()({
            SCOPE: withField(stringValue(), {field: '__scope'}),
          }),
        });
      }
    }
    resetTableLocals();
    // Strict, so a regression is the refusal it really is: without it the
    // class silently loses its parser and the assertion below reports only
    // that `null` is not a string.
    const source: string = generateUpdate(Scoped, true);
    expect(source).toContain('const SCOPE = json.SCOPE;');
    expect(source).toContain(
      'node.__scope = typeof SCOPE === \'string\' ? SCOPE : "";',
    );
    expect(() => parseAsModule(source)).not.toThrow();
  });
});

/**
 * The compiler reads a property's `meta` and nothing else, so a schema whose
 * author installed a membership predicate of its own describes a domain the
 * compiler cannot see. `verifyCompiledParse` samples a fixed corpus, so it
 * passes whenever the narrowing rejects nothing that corpus happens to hold —
 * which is why this is refused rather than left to the verifier.
 */
describe('a property whose schema narrows its own domain', () => {
  test('takes its class out of the import half rather than compiling', () => {
    const accepts = (value: unknown) =>
      typeof value === 'string' && !String(value).startsWith('#');
    const base = stringValue();
    const narrowed = Object.assign(
      (value: unknown) => (accepts(value) ? String(value) : base.defaultValue),
      base,
      {accepts},
    ) as never;
    class NarrowedNode extends TextNode {
      __tag: string = '';
      $config() {
        return this.config('generate-narrowed-tag', {
          extends: TextNode,
          json: nodeSchema<NarrowedNode>()({
            tag: withField(narrowed, {field: '__tag'}),
          }),
        });
      }
    }
    expect(generateUpdate(NarrowedNode)).toBeNull();
    // Falling back to the walk is the right answer for a class outside this
    // repo. For one inside it, a parser we meant to ship and did not is a
    // build failure, which is what `generatePackage` asks for.
    expect(() => generateUpdate(NarrowedNode, true)).toThrow(
      /no generated parser, "tag" declares a membership predicate/,
    );
    // And wherever it sits in the schema, not only at the top. `aliasedValue`
    // derives its own predicate, so asking the outermost schema alone let this
    // through and compiled the inner *combinator's* parse — which keeps a
    // `#`-prefixed string the schema itself replaces with its default.
    class AliasedNarrowedNode extends TextNode {
      __tag: string = '';
      $config() {
        return this.config('generate-aliased-narrowed-tag', {
          extends: TextNode,
          json: nodeSchema<AliasedNarrowedNode>()({
            tag: withField(aliasedValue(narrowed, {legacy: 'modern'}), {
              field: '__tag',
            }),
          }),
        });
      }
    }
    expect(generateUpdate(AliasedNarrowedNode)).toBeNull();
    // The export half is unaffected: reading a property back out asks the
    // schema nothing about membership.
    expect(generateCompactExport(NarrowedNode)).toContain(
      'const tag = node.__tag;',
    );
  });
});

describe('generated clone helpers', () => {
  test('the phase-one stub throws rather than dropping fields', () => {
    // Phase one writes the stubs *in place*, so a run whose second phase
    // fails leaves them in the tree — and `ElementNode` and `CodeNode` call
    // their helper unconditionally from `afterCloneFrom`. The stub used to be
    // a no-op, which is the silent version of the very bug the helpers exist
    // to prevent: `{"indent": 2}` came back as `{"indent": 0}` after one
    // getWritable(), with nothing anywhere saying why.
    for (const pkg of MANIFEST) {
      const source: string = stubSource(pkg);
      expect(() => parseAsModule(source)).not.toThrow();
      for (const name of pkg.afterClone) {
        expect(source).toContain(`export function ${name}(`);
        expect(source).toContain('did not finish; run it again.');
      }
    }
  });

  test('every one of them has an end-to-end clone test', () => {
    // A class whose own `$config` names a field gets its `afterCloneFrom`
    // derived from the schema rather than written by hand, so nothing in the
    // class says which fields a clone carries and nothing fails when the
    // derivation stops covering one — the field keeps the constructor's
    // default and the node loses the value on its next getWritable().
    //
    // `CloneCarriesSchemaFields.test.ts` is what catches that, one case per
    // class, and its coverage was silently partial: seven classes lost their
    // hand-written method with nothing put in its place. This holds the file
    // to the manifest, so adding a class to one means adding it to the other.
    const covered = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'packages',
        'lexical-fast-check',
        'src',
        '__tests__',
        'unit',
        'CloneCarriesSchemaFields.test.ts',
      ),
      'utf-8',
    );
    const missing = MANIFEST.flatMap(pkg => pkg.afterClone).filter(
      name => !references(covered, name.replace(/^afterClone/, '')),
    );
    expect(missing).toEqual([]);
  });
});

describe('what a generated module declares at its top level', () => {
  /**
   * One package around one class, as the manifest would describe it.
   *
   * `home` is false, so the module imports its interface from `lexical`
   * rather than declaring it, which keeps the assertions below about the
   * helpers and tables alone.
   */
  function moduleFor(klass: Klass<LexicalNode>): string {
    resetTableLocals();
    return generatePackage({
      afterClone: [],
      entries: ['GENERATED_PROBE'],
      file: 'packages/probe/src/Probe.ts',
      targets: [{klass, module: './Probe'}],
    });
  }

  test('a numeric helper is declared only where one is called', () => {
    class BoundedNode extends TextNode {
      __n: number = 0;
      $config() {
        return this.config('declares-bounded', {
          extends: TextNode,
          json: nodeSchema<BoundedNode>()({
            n: withField(numberValue(0, {integer: true, min: 0}), {
              field: '__n',
            }),
          }),
        });
      }
    }
    const bounded: string = moduleFor(BoundedNode);
    expect(bounded).toContain('function num(');
    expect(bounded).toContain('function numC(');
    // Read once, so the read is the argument and the property binds nothing.
    expect(bounded).toContain('node.__n = numC(json.n, 0, 0, Infinity, true)');
  });

  test('and not where the name only appears inside a string', () => {
    // The helpers were chosen with `source.includes('numC(')`, which a string
    // default spelled that way satisfies without calling anything: the module
    // declared a helper nothing used, and `noUnusedLocals` failed the build
    // for a schema that is perfectly well formed.
    // Off LineBreakNode, whose schema has no numeric property: a TextNode
    // subclass inherits `detail` and `format`, so `num` would be declared for
    // those however this answered.
    class StringyNode extends LineBreakNode {
      __tag: string = '';
      $config() {
        return this.config('declares-stringy', {
          extends: LineBreakNode,
          json: nodeSchema<StringyNode>()({
            tag: withField(stringValue('numC('), {field: '__tag'}),
          }),
        });
      }
    }
    const stringy: string = moduleFor(StringyNode);
    expect(stringy).toContain('"numC("');
    expect(stringy).not.toContain('function numC(');
    expect(stringy).not.toContain('function num(');
  });

  test('nor where it is the name of a property', () => {
    // A schema key is a property everywhere it appears — `json.num` in the
    // parser, `num:` in the exporter beside it — and none of those is a call.
    // No scan of the emitted text can tell the difference, which is why the
    // compile reports what it needs instead of the result being read back.
    class NumberedNode extends LineBreakNode {
      __text: string = '';
      $config() {
        return this.config('declares-numbered', {
          extends: LineBreakNode,
          json: nodeSchema<NumberedNode>()({
            num: withField(stringValue(), {field: '__text'}),
          }),
        });
      }
    }
    const numbered: string = moduleFor(NumberedNode);
    // The local is named for the property, and renamed only where the name
    // cannot be bound — `num` is a helper the module may declare, so it is.
    expect(numbered).toContain('const num_ = json.num;');
    expect(numbered).toContain('num: node.__text');
    expect(numbered).not.toContain('function num(');
    expect(numbered).not.toContain('function numC(');
  });
});
