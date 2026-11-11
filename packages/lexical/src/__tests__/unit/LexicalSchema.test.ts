/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {QuoteNode} from '@lexical/rich-text';

import {
  buildEditorFromExtensions,
  defineExtension,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTabNode,
  $isTextNode,
  aliasedValue,
  type AnySerializationSchema,
  arrayValue,
  booleanValue,
  type CompactSerializedEditorState,
  createState,
  declaredAccepts,
  DecoratorNode,
  ElementNode,
  enumValue,
  getComposedSchemaFields,
  IS_BOLD,
  type Klass,
  type LexicalExportJSON,
  type LexicalNode,
  type LexicalParseJSON,
  type LexicalSchemaInput,
  type LexicalUpdateJSON,
  LineBreakNode,
  nodeSchema,
  type NodeSerializationSchema,
  nullable,
  numberValue,
  objectValue,
  optional,
  type ParagraphNode,
  type ParsableSerializedNode,
  rawValue,
  type SchemaInput,
  type SerializationSchema,
  type SerializationSchemaShape,
  type SerializationSchemaValue,
  type SerializedElementNode,
  type SerializedLexicalNode,
  type SerializedParagraphNode,
  type SerializedPartial,
  type SerializedPartialNode,
  type SerializedTextNode,
  type Spread,
  stringValue,
  TabNode,
  TextNode,
  transformValue,
  unionValue,
  withAccessors,
  withField,
} from 'lexical';
import {assert, describe, expect, expectTypeOf, test} from 'vitest';

import {
  isSchemaDefault,
  isSchemaEqual,
  isSchemaField,
} from '../../LexicalSchema';
import {resolveSchemaField} from '../../LexicalUtils';
import {initializeUnitTest} from '../utils';

describe('LexicalSchema value schemas', () => {
  test('stringValue', () => {
    const parse = stringValue();
    expect(parse('hello')).toBe('hello');
    expect(parse('')).toBe('');
    // out of domain -> default
    expect(parse(undefined)).toBe('');
    expect(parse(null)).toBe('');
    expect(parse(42)).toBe('');
    expect(parse({})).toBe('');
    // custom default
    expect(stringValue('fallback')(undefined)).toBe('fallback');
    expect(stringValue('fallback')(42)).toBe('fallback');
  });

  test('numberValue', () => {
    const parse = numberValue();
    expect(parse(42)).toBe(42);
    expect(parse(0)).toBe(0);
    expect(parse(-1.5)).toBe(-1.5);
    // a stringified number is an input encoding of the same domain
    expect(parse('42')).toBe(42);
    // out of domain -> default
    expect(parse(undefined)).toBe(0);
    expect(parse('forty-two')).toBe(0);
    expect(parse(NaN)).toBe(0);
    expect(parse(Infinity)).toBe(0);
    expect(parse(-Infinity)).toBe(0);
    // custom default
    expect(numberValue(1)(undefined)).toBe(1);
    expect(numberValue(1)(NaN)).toBe(1);
  });

  test('booleanValue', () => {
    const parse = booleanValue();
    expect(parse(true)).toBe(true);
    expect(parse(false)).toBe(false);
    // out of domain -> default
    expect(parse(undefined)).toBe(false);
    expect(parse(0)).toBe(false);
    expect(parse('true')).toBe(false);
    // custom default
    expect(booleanValue(true)(undefined)).toBe(true);
    expect(booleanValue(true)(1)).toBe(true);
  });

  test('enumValue', () => {
    const parse = enumValue(['normal', 'token', 'segmented']);
    expect(parse('token')).toBe('token');
    // out of domain -> first value by default
    expect(parse('bogus')).toBe('normal');
    expect(parse(undefined)).toBe('normal');
    expect(parse(42)).toBe('normal');
    // explicit default
    expect(enumValue(['normal', 'token'], 'token')('bogus')).toBe('token');
    // null may be a valid member
    const direction = enumValue([null, 'ltr', 'rtl']);
    expect(direction('rtl')).toBe('rtl');
    expect(direction('bogus')).toBe(null);
    // An empty domain admits nothing, so every value would parse to a default
    // that came from nowhere. Refused by the type...
    // @ts-expect-error - values must be a non-empty tuple
    expect(() => enumValue([])).toThrow();
    // ...and at runtime, since a type can be asserted past.
    expect(() => enumValue([] as unknown as [string, ...string[]])).toThrow(
      /must not be empty/,
    );
    expect(direction(null)).toBe(null);
  });

  test('nullable', () => {
    const parse = nullable(stringValue());
    expect(parse('noopener')).toBe('noopener');
    expect(parse('')).toBe('');
    // null and undefined both collapse to null (the recoverable default)
    expect(parse(null)).toBe(null);
    expect(parse(undefined)).toBe(null);
    // non-null, out-of-domain values delegate to the inner schema's default
    expect(parse(42)).toBe('');
    // composes with any schema
    const parseDirection = nullable(enumValue(['ltr', 'rtl']));
    expect(parseDirection('rtl')).toBe('rtl');
    expect(parseDirection(null)).toBe(null);
    expect(parseDirection(undefined)).toBe(null);
  });

  test('optional', () => {
    const parse = optional(numberValue());
    expect(parse(120)).toBe(120);
    // only undefined collapses to undefined (the recoverable default)
    expect(parse(undefined)).toBe(undefined);
    // present-but-out-of-domain delegates to the inner schema's default
    expect(parse(null)).toBe(0);
    expect(parse('nope')).toBe(0);
    // composes with nullable for `T | null | undefined`
    const parseLanguage = optional(nullable(stringValue()));
    expect(parseLanguage(undefined)).toBe(undefined);
    expect(parseLanguage(null)).toBe(null);
    expect(parseLanguage('js')).toBe('js');
  });

  test('arrayValue', () => {
    const parse = arrayValue(stringValue());
    expect(parse(['a', 'b'])).toEqual(['a', 'b']);
    expect(parse([])).toEqual([]);
    // each entry is coerced through the item schema
    expect(parse(['a', 42, null])).toEqual(['a', '', '']);
    // non-array (incl. undefined) -> empty array (the recoverable default)
    expect(parse(undefined)).toEqual([]);
    expect(parse('nope')).toEqual([]);
  });

  test('objectValue validates and fully populates', () => {
    const parse = objectValue({
      count: numberValue(),
      tags: arrayValue(stringValue()),
      title: stringValue(),
    });
    expect(parse({count: 2, tags: ['x'], title: 'hi'})).toEqual({
      count: 2,
      tags: ['x'],
      title: 'hi',
    });
    // missing/extra/out-of-domain properties -> per-field defaults, extras dropped
    expect(parse({count: 'bad', extra: true})).toEqual({
      count: 0,
      tags: [],
      title: '',
    });
    // the all-defaults object is recoverable
    expect(parse(undefined)).toEqual({count: 0, tags: [], title: ''});
  });

  test('the default is recoverable via parse(undefined)', () => {
    // This mirrors NodeState (StateValueConfig) and lets a future "compact"
    // exportJSON omit a key whose value equals the default.
    expect(stringValue()(undefined)).toBe('');
    expect(numberValue(7)(undefined)).toBe(7);
    expect(booleanValue(true)(undefined)).toBe(true);
    expect(enumValue(['a', 'b'], 'b')(undefined)).toBe('b');
    expect(nullable(stringValue())(undefined)).toBe(null);
  });
});

/**
 * Assert that `build` is refused for wrapping a schema that names an accessor
 * — the runtime half of the rule every combinator states in its type.
 */
function refused(combinator: string, build: () => unknown): void {
  expect(build).toThrow(`${combinator}: the schema it wraps names an accessor`);
}

describe('updateFromJSON tolerates partial and out-of-domain JSON', () => {
  initializeUnitTest(testEnv => {
    test('TextNode applies defaults when properties are missing', () => {
      const {editor} = testEnv;
      editor.update(() => {
        const node = $createTextNode('initial');
        // A "compact" serialized node with no node-specific properties.
        node.updateFromJSON({});
        expect(node.getTextContent()).toBe('');
        expect(node.getFormat()).toBe(0);
        expect(node.getDetail()).toBe(0);
        expect(node.getMode()).toBe('normal');
        expect(node.getStyle()).toBe('');
      });
    });

    test('TextNode rejects out-of-domain values', () => {
      const {editor} = testEnv;
      editor.update(() => {
        const node = $createTextNode('initial');
        node.updateFromJSON({
          detail: 'nope',
          format: null,
          mode: 'bogus',
          style: 42,
          text: 99,
          // deliberately out of domain, so the double cast is required
        } as unknown as LexicalParseJSON<SerializedTextNode>);
        expect(node.getTextContent()).toBe('');
        expect(node.getFormat()).toBe(0);
        expect(node.getDetail()).toBe(0);
        expect(node.getMode()).toBe('normal');
        expect(node.getStyle()).toBe('');
      });
    });

    test('TextNode preserves valid values', () => {
      const {editor} = testEnv;
      editor.update(() => {
        const node = $createTextNode('initial');
        node.updateFromJSON({
          detail: 0,
          format: 1,
          mode: 'token',
          style: 'color: red',
          text: 'hello',
        });
        expect(node.getTextContent()).toBe('hello');
        expect(node.getFormat()).toBe(1);
        expect(node.getMode()).toBe('token');
        expect(node.getStyle()).toBe('color: red');
      });
    });

    test('parseEditorState round-trips compact node JSON', () => {
      const {editor} = testEnv;
      const editorState = editor.parseEditorState(
        JSON.stringify({
          root: {
            children: [
              {
                // ParagraphNode missing direction/format/indent/textFormat/...
                children: [
                  // TextNode missing detail/format/mode/style
                  {text: 'hello', type: 'text', version: 1},
                ],
                type: 'paragraph',
                version: 1,
              },
            ],
            type: 'root',
            version: 1,
          },
        }),
      );
      editorState.read(() => {
        const textNodes = $getRoot().getAllTextNodes();
        expect(textNodes).toHaveLength(1);
        expect(textNodes[0].getTextContent()).toBe('hello');
        expect(textNodes[0].getFormat()).toBe(0);
        expect(textNodes[0].getDetail()).toBe(0);
        expect(textNodes[0].getMode()).toBe('normal');
        expect(textNodes[0].getStyle()).toBe('');
      });
    });

    test('TextNode accepts the legacy string names for format and detail', () => {
      // Hand-authored and older documents carry e.g. `format: 'bold'`, which
      // setFormat/setDetail have always converted from.
      const {editor} = testEnv;
      editor.update(() => {
        const node = $createTextNode('x');
        node.updateFromJSON({
          detail: 'directionless',
          format: 'bold',
        } as unknown as LexicalParseJSON<SerializedTextNode>);
        expect(node.hasFormat('bold')).toBe(true);
        expect(node.isDirectionless()).toBe(true);
      });
    });

    test('TabNode ignores JSON for its fixed properties', () => {
      // text/detail/mode are derived for a tab (setTextContent normalizes, and
      // setDetail/setMode reject anything else), so a hand-authored or foreign
      // value for them must be ignored rather than reach a setter that throws.
      const {editor} = testEnv;
      for (const bad of [
        {mode: 'token'},
        {detail: 0},
        {text: 'xyz'},
        {detail: 'directionless', mode: 'segmented', text: ''},
      ]) {
        const state = editor.parseEditorState(
          JSON.stringify({
            root: {
              children: [
                {
                  children: [{type: 'tab', version: 1, ...bad}],
                  type: 'paragraph',
                  version: 1,
                },
              ],
              type: 'root',
              version: 1,
            },
          }),
        );
        state.read(() => {
          const [tab] = $getRoot().getAllTextNodes();
          expect($isTabNode(tab)).toBe(true);
          expect(tab.getTextContent()).toBe('\t');
          expect(tab.isUnmergeable()).toBe(true);
          expect(tab.getMode()).toBe('normal');
        });
      }
    });

    test('TabNode imports fully compact JSON', () => {
      // TabNode's own schema must override the inherited TextNode field
      // defaults: applying `detail: 0` or `text: ''` would throw in its
      // setters, so `{type: 'tab'}` alone must restore the canonical tab.
      const {editor} = testEnv;
      const editorState = editor.parseEditorState(
        JSON.stringify({
          root: {
            children: [
              {
                children: [
                  {type: 'tab', version: 1},
                  // Out-of-domain values fall back to the same canonical state
                  {detail: 'bogus', text: 'xyz', type: 'tab', version: 1},
                ],
                type: 'paragraph',
                version: 1,
              },
            ],
            type: 'root',
            version: 1,
          },
        }),
      );
      editorState.read(() => {
        const textNodes = $getRoot().getAllTextNodes();
        expect(textNodes).toHaveLength(2);
        for (const node of textNodes) {
          expect($isTabNode(node)).toBe(true);
          expect(node.getTextContent()).toBe('\t');
          expect(node.isUnmergeable()).toBe(true);
        }
      });
    });
  });

  describe('numberValue domain options', () => {
    test('min rejects values below the bound', () => {
      const span = numberValue(1, {min: 1});
      expect(span(3)).toBe(3);
      expect(span(0)).toBe(1);
      expect(span(-4)).toBe(1);
      expect(span(undefined)).toBe(1);
      expect(span.defaultValue).toBe(1);
    });
    test('integer rejects fractional values', () => {
      const span = numberValue(1, {integer: true, min: 1});
      expect(span(2)).toBe(2);
      expect(span(2.5)).toBe(1);
    });
    test('max rejects values above the bound', () => {
      const pct = numberValue(0, {max: 100, min: 0});
      expect(pct(100)).toBe(100);
      expect(pct(101)).toBe(0);
    });
    test('clamp brings an out-of-range value to the nearest bound', () => {
      const indent = numberValue(0, {
        clamp: true,
        integer: true,
        max: 128,
        min: 0,
      });
      expect(indent(5)).toBe(5);
      expect(indent(1e6)).toBe(128);
      expect(indent(-4)).toBe(0);
      // The string encoding of a number is read the same way.
      expect(indent('1e6')).toBe(128);
      // Only the range stops deciding membership: a value that is not a
      // finite number, or not an integer where one is required, has no
      // nearest bound and still falls back to the default.
      expect(indent(1.5)).toBe(0);
      expect(indent(Infinity)).toBe(0);
      expect(indent('banana')).toBe(0);
      expect(indent(undefined)).toBe(0);
    });
    test('an integer domain rounds its bounds inward', () => {
      // The clamped result has to be a member, or a reload parses what the
      // last one wrote back to the default and the property changes on every
      // round trip.
      const parse = numberValue(1, {
        clamp: true,
        integer: true,
        max: 2.5,
        min: 0.5,
      });
      expect(parse(0)).toBe(1);
      expect(parse(3)).toBe(2);
      expect(parse(parse(0))).toBe(parse(0));
      expect(parse(parse(3))).toBe(parse(3));
      // The same rounding, reported: `>= 0.5` and `>= 1` admit the same
      // integers, so this is the domain either way — now stated where a
      // generator can read it.
      expect(parse.meta).toEqual({
        clamp: true,
        integer: true,
        kind: 'number',
        max: 2,
        min: 1,
      });
      // Without `clamp` nothing about the domain changed.
      const strict = numberValue(1, {integer: true, max: 2.5, min: 0.5});
      expect(strict(0)).toBe(1);
      expect(strict(1)).toBe(1);
      expect(strict(2)).toBe(2);
      expect(strict(3)).toBe(1);
    });
    test('a fractional domain keeps its bounds', () => {
      expect(numberValue(1, {max: 2.5, min: 0.5}).meta).toEqual({
        clamp: undefined,
        integer: undefined,
        kind: 'number',
        max: 2.5,
        min: 0.5,
      });
      expect(numberValue(1, {clamp: true, max: 2.5, min: 0.5})(3)).toBe(2.5);
    });
    test('an empty domain is refused where it is declared', () => {
      expect(() => numberValue(0, {max: 1, min: 2})).toThrow(
        /the domain is empty; min 2 is above max 1/,
      );
      // Empty only after the inward rounding, which is worth saying.
      expect(() => numberValue(0, {integer: true, max: 0.7, min: 0.5})).toThrow(
        /rounded inward from 0.5\.\.0\.7/,
      );
    });
    test('clamp widens what the domain accepts', () => {
      // A value outside the bounds is one this schema reads — it parses to a
      // bound rather than to the default — so a union must not skip past it.
      expect(numberValue(0, {clamp: true, max: 10}).accepts!(99)).toBe(true);
      expect(numberValue(0, {max: 10}).accepts!(99)).toBe(false);
    });
    test('the domain is recorded on meta', () => {
      expect(numberValue(1, {integer: true, min: 1}).meta).toEqual({
        clamp: undefined,
        integer: true,
        kind: 'number',
        max: undefined,
        min: 1,
      });
      expect(numberValue(0, {clamp: true, max: 8}).meta).toEqual({
        clamp: true,
        integer: undefined,
        kind: 'number',
        max: 8,
        min: undefined,
      });
    });
  });

  describe('optional({omitDefault})', () => {
    test('treats a default-valued input as absent', () => {
      const width = optional(numberValue(), {omitDefault: true});
      expect(width(120)).toBe(120);
      expect(width(0)).toBeUndefined();
      expect(width('nonsense')).toBeUndefined();
      expect(width(undefined)).toBeUndefined();
      expect(width.defaultValue).toBeUndefined();
    });
    test('matches the `value || undefined` idiom it replaces', () => {
      const width = optional(numberValue(), {omitDefault: true});
      for (const value of [0, 120, -3, undefined]) {
        expect(width(value)).toBe((value as number) || undefined);
      }
    });
    test('without the option a default-valued input is kept', () => {
      expect(optional(numberValue())(0)).toBe(0);
    });
  });

  describe('unionValue', () => {
    const dimension = unionValue(
      [numberValue(), enumValue(['inherit'])],
      'inherit',
    );
    test('accepts a value from either member', () => {
      expect(dimension(640)).toBe(640);
      expect(dimension('inherit')).toBe('inherit');
    });
    test('falls back when no member accepts the value', () => {
      expect(dimension('banana')).toBe('inherit');
      expect(dimension(undefined)).toBe('inherit');
      expect(dimension.defaultValue).toBe('inherit');
    });
    test('defaults to the first member default when none is given', () => {
      expect(unionValue([numberValue(7), enumValue(['x'])])(null)).toBe(7);
    });
    test('records its members on meta', () => {
      expect(dimension.meta.kind).toBe('union');
    });
    test('defers equality to whichever member has one', () => {
      // What the equality is for: a member returning a fresh value per parse
      // would otherwise never equal the default and so never compact.
      const tags = unionValue([arrayValue(stringValue()), enumValue(['all'])]);
      expect(isSchemaEqual(tags, ['a'], ['a'])).toBe(true);
      expect(isSchemaEqual(tags, ['a'], ['b'])).toBe(false);
      // A member's equality is asked about every pair, not only the ones it
      // recognizes, so each has to be total — arrayValue's answers `false` for
      // the enum member's values rather than throwing on them.
      expect(isSchemaEqual(tags, 'all', 'all')).toBe(true);
      expect(isSchemaEqual(tags, 'all', ['a'])).toBe(false);
      // With no member to defer to the `some` is always false, leaving
      // isSchemaEqual's leading identity test as the whole comparison.
      expect(isSchemaEqual(dimension, 640, 640)).toBe(true);
      expect(isSchemaEqual(dimension, 640, 'inherit')).toBe(false);
    });
  });

  describe('transformValue', () => {
    const NAME_TO_BIT: Record<string, number> = {bold: 1, italic: 2};
    // The union's domain is inferred from its members; no type argument.
    const format = transformValue(
      unionValue([numberValue(), enumValue(['bold', 'italic'])], 0),
      value => (typeof value === 'string' ? NAME_TO_BIT[value] : value),
    );
    test('normalizes accepted values into the target domain', () => {
      expect(format(4)).toBe(4);
      expect(format('bold')).toBe(1);
      expect(format('italic')).toBe(2);
      // out of domain -> inner's default, transformed
      expect(format('junk')).toBe(0);
      expect(format(undefined)).toBe(0);
    });
    test('defaultValue is the transformed inner default', () => {
      expect(format.defaultValue).toBe(0);
      const upper = transformValue(stringValue('a'), s => s.toUpperCase());
      expect(upper.defaultValue).toBe('A');
      expect(upper('bc')).toBe('BC');
    });
    test('meta names the transform and holds the inner schema', () => {
      // Introspection still reaches the accepted input domain, so generated
      // examples keep exercising the legacy forms — but through a kind of its
      // own rather than by wearing the inner schema's. The transform is the
      // one part of a schema that cannot be described structurally, and a
      // consumer that reasons about the *output* has to be told that.
      const inner = stringValue();
      const t = transformValue(inner, s => s.length);
      expect(t.meta).toEqual({inner, kind: 'transform'});
    });
  });

  describe('rawValue', () => {
    test('passes an unvalidated value through', () => {
      const raw = rawValue<{editorState: unknown}>();
      const value = {editorState: {root: {}}};
      expect(raw(value)).toBe(value);
      expect(raw(undefined)).toBeUndefined();
      expect(raw.defaultValue).toBeUndefined();
      expect(raw.meta.kind).toBe('raw');
    });
  });

  describe('exportJSON is written from the schema', () => {
    initializeUnitTest(testEnv => {
      test('a getter returning undefined omits its property', () => {
        const {editor} = testEnv;
        editor.update(() => {
          // ElementNode only persists textFormat/textStyle when there are no
          // TextNode children to recompute them from, which it expresses by
          // returning undefined from the getters its schema names.
          const paragraph = $createParagraphNode();
          paragraph.append($createTextNode('x').setFormat(1));
          expect(paragraph.getSerializedTextFormat()).toBeUndefined();
          expect(paragraph.getSerializedTextStyle()).toBeUndefined();
          // and a node that does carry them writes them out
          const styled = $createParagraphNode().setTextStyle('color: red');
          expect(styled.getSerializedTextStyle()).toBe('color: red');
          expect(styled.exportJSON()).toMatchObject({textStyle: 'color: red'});
        });
      });

      test('a property is read through the getter its schema names', () => {
        const {editor} = testEnv;
        editor.update(() => {
          // `text` is declared with getTextContent, not the default getText,
          // and ElementNode's `format` with getFormatType (a string) rather
          // than the numeric getFormat.
          expect($createTextNode('hi').exportJSON()).toMatchObject({
            text: 'hi',
            type: 'text',
          });
          expect($createParagraphNode().exportJSON()).toMatchObject({
            format: '',
            type: 'paragraph',
          });
        });
      });

      test('export round-trips through import for every schema property', () => {
        const {editor} = testEnv;
        editor.update(() => {
          const node = $createTextNode('round trip')
            .setFormat(1)
            .setStyle('color: red')
            .setMode('token');
          const json = node.exportJSON();
          const restored = $createTextNode('').updateFromJSON(json);
          expect(restored.exportJSON()).toEqual(json);
        });
      });
    });
  });

  describe('accessor resolution', () => {
    test('null states that a direction is deliberately unsupported', () => {
      const derived = withAccessors(stringValue(), {setter: null});
      expect(derived.setter).toBeNull();
      // Both directions are named in the one call: a `null` is a declaration
      // — that the direction is derived — so a second layer is refused like
      // any other name, at compile time and at run time.
      expect(
        withAccessors(stringValue(), {getter: 'getFoo', setter: null}).setter,
      ).toBeNull();
      refused('withAccessors', () =>
        // @ts-expect-error -- `derived` already names its setter
        withAccessors(derived, {getter: 'getFoo'}),
      );
      // Around the wrapper rather than under it, since that is where every
      // accessor is stated: `optional` describes a wider domain than the
      // schema it wraps, and the accessors answer for the whole property.
      expect(
        withAccessors(optional(stringValue()), {setter: null}).setter,
      ).toBeNull();
      // @ts-expect-error -- and under it, a `null` is refused like a name is
      refused('optional', () => optional(derived));
    });
  });

  describe('withAccessors is the outermost combinator of a property', () => {
    test('a wrapper names nothing of its own', () => {
      // A field like `language: optional(nullable(stringValue()))` names its
      // accessors on the outside, where they are obliged to accept the domain
      // the wrappers describe. Nothing is carried up from inside, so a name
      // that ends up under a wrapper is not quietly used for the property —
      // which is what makes refusing it at the type level worth doing.
      const inner = stringValue();
      expect(optional(inner).setter).toBeUndefined();
      expect(nullable(inner).setter).toBeUndefined();
      expect(transformValue(inner, s => s.length).setter).toBeUndefined();
      expect(aliasedValue(inner, {a: 'b'}).setter).toBeUndefined();
      expect(unionValue([inner, numberValue()]).setter).toBeUndefined();
      expect(
        withAccessors(optional(nullable(inner)), {setter: 'setBar'}).setter,
      ).toBe('setBar');
    });

    test('withAccessors records both directions at once', () => {
      const schema = withAccessors(stringValue(), {
        getter: 'getFoo',
        setter: 'setFoo',
      });
      expect(schema.getter).toBe('getFoo');
      expect(schema.setter).toBe('setFoo');
      // and only at once: a second layer would name a direction the first
      // already named, and the walk calls the outer one only — an obligation
      // checked for an accessor that is never called.
      refused('withAccessors', () =>
        withAccessors(
          // @ts-expect-error -- the inner layer already names an accessor
          withAccessors(stringValue(), {setter: 'setA'}),
          {getter: 'getA'},
        ),
      );
      // withField is a getter that reads the node's own field
      expect(withField(stringValue(), {field: '__foo'}).getter).toEqual({
        field: '__foo',
      });
    });

    test('withField splits its options into the direction each belongs to', () => {
      // Every option but `field` is one direction's, so the direction that
      // does not take it must not end up carrying it: a `when` on the setter
      // has nothing to gate, and each table is read by one side only.
      const schema = withField(numberValue(), {
        field: '__count',
        getter: 'getCount',
        getterTable: {1: 'one'},
        setter: 'setCount',
        setterTable: {one: 1},
        when: 'shouldWriteCount',
      });
      expect(schema.getter).toEqual({
        field: '__count',
        getterTable: {1: 'one'},
        method: 'getCount',
        when: 'shouldWriteCount',
      });
      expect(schema.setter).toEqual({
        field: '__count',
        method: 'setCount',
        setterTable: {one: 1},
      });
    });
  });
});

describe('defaults and untrusted input', () => {
  test('a declared fallback survives a member that accepts undefined', () => {
    // `parse(undefined)` is how most combinators name their default, but here
    // `undefined` is in-domain, so deriving it would discard the fallback.
    expect(unionValue([rawValue(), numberValue()], 5).defaultValue).toBe(5);
    expect(
      unionValue([optional(numberValue()), enumValue(['inherit'])], 'inherit')
        .defaultValue,
    ).toBe('inherit');
    expect(
      enumValue([undefined, 'middle', 'bottom'], 'middle').defaultValue,
    ).toBe('middle');
    // A declared `undefined` is a value like any other, so it is legal only
    // where a member produces one. An optional parameter would have admitted
    // it everywhere — `undefined` is in the type of every optional parameter,
    // whatever it is declared as — and the union then reported `number |
    // string` for a schema that returns `undefined` from every fall-through.
    expect(
      unionValue([optional(numberValue()), stringValue()], undefined)
        .defaultValue,
    ).toBeUndefined();
    // @ts-expect-error -- no member of this union produces `undefined`
    unionValue([numberValue(), stringValue()], undefined);
    // The same rule for the other factory whose domain may hold `undefined`:
    // a default parameter replaced a declared `undefined` with `values[0]`.
    expect(enumValue(['middle', undefined], undefined).defaultValue).toBe(
      undefined,
    );
    expect(enumValue(['middle', undefined]).defaultValue).toBe('middle');
    // and the same rule at run time, for the caller the type does not reach
    expect(() =>
      // @ts-expect-error -- `undefined` is not a member of this enum
      enumValue(['middle', 'bottom'], undefined),
    ).toThrow('enumValue: the default value is not one of the values');
    // The documented spelling for asserting the values against a known
    // domain still holds: the domain is the type parameter, and the default
    // has one of its own bounded by it.
    type Mode = 'normal' | 'segmented' | 'token';
    expectTypeOf(enumValue<Mode>(['normal', 'token'])).toEqualTypeOf<
      SerializationSchema<Mode>
    >();
    // @ts-expect-error -- 'bogus' is not a Mode
    enumValue<Mode>(['normal', 'bogus']);
    expect(() =>
      // @ts-expect-error -- 'c' is not one of the values
      enumValue(['a', 'b'], 'c'),
    ).toThrow('enumValue: the default value is not one of the values');
  });

  test('a schema shape describes what a property parses to, not what it reads', () => {
    // The record of per-property schemas for a known object type. Pinning each
    // field's *input* to the property type rejected the combinator for the very
    // type the shape names: `numberValue()` reads a stringified number, so it
    // is a `SerializationSchema<number, never, number | string>`, and a shape
    // of `{count: number}` would not accept it.
    const fields: SerializationSchemaShape<{count: number; label: string}> = {
      count: numberValue(),
      label: stringValue(),
    };
    expect(objectValue(fields).defaultValue).toEqual({count: 0, label: ''});
    // What each property parses to is still checked, which is the point of
    // naming the type at all.
    expectTypeOf<
      SerializationSchemaShape<{count: number}>['count']['defaultValue']
    >().toEqualTypeOf<number>();
    const wrong: SerializationSchemaShape<{count: number}> = {
      // @ts-expect-error -- a string schema does not describe a number
      count: stringValue(),
    };
    expect(wrong).toBeDefined();
  });

  test('a union accepts exactly what its members accept', () => {
    // Set membership is SameValueZero, so a member can return NaN unchanged;
    // an identity test would read that as a rejection.
    const schema = unionValue([enumValue([NaN, 1]), numberValue()], 1);
    expect(schema(NaN)).toBeNaN();
  });

  test('a union names its accessors on the union, not on a member', () => {
    // A member's names would answer for a domain narrower than the union's:
    // whichever member won would decide which accessor the whole property
    // used. Named on the union, they are obliged to accept every member's
    // value — which is what `getDim`/`setDim` are declared for here.
    const schema = withAccessors(
      unionValue([numberValue(), enumValue(['inherit'])]),
      {getter: 'getDim', setter: 'setDim'},
    );
    expect(schema.getter).toBe('getDim');
    expect(schema.setter).toBe('setDim');
    // and the union itself names nothing
    expect(
      unionValue([numberValue(), enumValue(['inherit'])]).getter,
    ).toBeUndefined();
  });

  test('a reference-typed default cannot be mutated into every node', () => {
    // StateConfig hands this very object to $getState for a node with no
    // state of its own, so a push here would be visible from every node.
    const schema = arrayValue(stringValue());
    expect(() => schema.defaultValue.push('leak')).toThrow();
    expect(schema.defaultValue).toEqual([]);
    // a parsed value is a fresh array and stays writable
    expect(() => schema(['a']).push('b')).not.toThrow();
  });

  test('a field named for an Object.prototype member is refused', () => {
    // Every read of a serialized property is a bare one, here and in the node
    // walk and a generated parser: an absent property is `undefined`, which is
    // the field's default already. A field named for something the object
    // *inherits* is the single case where that reads a value — the method, for
    // JSON that never carried the key — so the name is refused where it is
    // written instead of being guarded against on every read of every field.
    // `nodeSchema` shares the check, which is why the message names the
    // combinator it was called through.
    expect(() => objectValue({toString: rawValue<string>()})).toThrow(
      /objectValue: "toString" is a member of Object\.prototype/,
    );
    // `__proto__` is refused in every build, not only this one: assigning it
    // would reparent the parsed object rather than write the property.
    expect(() => objectValue({['__proto__']: rawValue<string>()})).toThrow(
      /"__proto__" is not a valid field name/,
    );
    // A name it does not carry reads straight off parsed JSON.
    const schema = objectValue({label: rawValue<string>()});
    expect(schema(JSON.parse('{}'))).toEqual({label: undefined});
    expect(schema(JSON.parse('{"label":"mine"}'))).toEqual({label: 'mine'});
  });
});

describe('the export and parse shapes differ only where parsing is looser', () => {
  test('version is optional exactly where it is absent', () => {
    // The legacy form writes it unconditionally, so the full output type
    // promises it — relaxing it at the base would take that promise away from
    // every consumer of a legacy export to describe a case they are not in.
    expectTypeOf<SerializedLexicalNode['version']>().toEqualTypeOf<number>();
    // The compact form omits it, along with everything else parsing restores.
    expectTypeOf<
      SerializedPartial<SerializedLexicalNode>['version']
    >().toEqualTypeOf<number | undefined>();
    // a slot value is parsed by the same rules, so it relaxes the same way
    expectTypeOf<
      NonNullable<
        SerializedPartial<SerializedLexicalNode>['$slots']
      >[string]['version']
    >().toEqualTypeOf<number | undefined>();
    // Parsing drops it outright rather than relaxing it: nothing reads it.
    expectTypeOf<
      'version' extends keyof LexicalParseJSON<SerializedLexicalNode>
        ? true
        : false
    >().toEqualTypeOf<false>();
  });

  test('an element relaxes its children too', () => {
    // Every node in a compact document is compact, not just the root: a child
    // read off the array is another node written in the same form, and the
    // properties it omitted are absent there as well.
    type CompactParagraph = SerializedPartial<SerializedParagraphNode>;
    const child: NonNullable<CompactParagraph['children']>[number] = {
      type: 'text',
    };
    expectTypeOf(child.version).toEqualTypeOf<number | undefined>();
    // The legacy form still promises what it writes, at every depth.
    expectTypeOf<
      SerializedParagraphNode['children'][number]['version']
    >().toEqualTypeOf<number>();
    // A node with no children is not given one.
    expectTypeOf<
      'children' extends keyof SerializedPartial<SerializedTextNode>
        ? true
        : false
    >().toEqualTypeOf<false>();
  });

  initializeUnitTest(testEnv => {
    test('exportJSON(true) type-checks as the value it actually returns', () => {
      // The compact form omits version; while it was required, reading it off
      // the result type-checked as a number and was undefined at runtime.
      testEnv.editor.update(() => {
        const node = $createParagraphNode();
        const compact = node.exportJSON(true);
        expectTypeOf(compact.version).toEqualTypeOf<number | undefined>();
        expect(compact).not.toHaveProperty('version');
        expect(node.exportJSON()).toHaveProperty('version', 1);
      });
    });

    test('the compact form is typed as the partial it returns', () => {
      testEnv.editor.update(() => {
        const node = $createParagraphNode();
        // The legacy form writes every property, so it is the full type…
        expectTypeOf(
          node.exportJSON(),
        ).toEqualTypeOf<SerializedParagraphNode>();
        expectTypeOf(
          node.exportJSON(false),
        ).toEqualTypeOf<SerializedParagraphNode>();
        // …and the compact form omits them, so every one is optional. Typing
        // it as the full shape is what let `json.indent.toFixed()` compile on
        // a value the form had dropped.
        expectTypeOf(node.exportJSON(true)).toEqualTypeOf<
          SerializedPartial<SerializedParagraphNode>
        >();
        expectTypeOf(node.exportJSON(true).indent).toEqualTypeOf<
          number | undefined
        >();
        // A flag whose value is not known statically cannot promise either
        // form, so it resolves to the one that admits both.
        const compact: boolean = Math.max(0, 1) > 0;
        expectTypeOf(node.exportJSON(compact)).toEqualTypeOf<
          SerializedPartial<SerializedParagraphNode>
        >();
        // LexicalExportJSON still describes the legacy form, which is the one
        // that writes everything — it reads the first overload, not the last.
        expectTypeOf<
          LexicalExportJSON<ParagraphNode>['indent']
        >().toEqualTypeOf<number>();
      });
    });
  });
});

class CountingNode extends ElementNode {
  getLatestCalls = 0;

  getLatest(): this {
    const latest = super.getLatest();
    latest.getLatestCalls += 1;
    return latest;
  }
}

class PlainCountingNode extends CountingNode {
  $config() {
    return this.config('plain-counting', {extends: CountingNode});
  }
}

describe('withField compiles to direct field access', () => {
  class FieldNode extends CountingNode {
    __label = 'default';
    calls = 0;

    $config() {
      return this.config('field-node', {
        extends: CountingNode,
        json: nodeSchema<FieldNode>()({
          label: withField(stringValue('default'), {field: '__label'}),
        }),
      });
    }

    afterCloneFrom(prevNode: this): void {
      super.afterCloneFrom(prevNode);
      this.__label = prevNode.__label;
    }

    // Present so a regression that resolved the conventional name instead of
    // the field would be observable rather than silently equivalent.
    setLabel(label: string): this {
      const self = this.getWritable();
      self.calls += 1;
      self.__label = `via-setter:${label}`;
      return self;
    }

    getLabel(): string {
      return `via-getter:${this.getLatest().__label}`;
    }
  }

  test('the field is read and written directly, not through the methods', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[with-field]',
        nodes: [FieldNode],
      }),
    );
    editor.update(
      () => {
        const node = FieldNode.importJSON({label: 'hello', type: 'field-node'});
        assert(node instanceof FieldNode);
        expect(node.__label).toBe('hello');
        expect(node.calls).toBe(0);
        expect(node.exportJSON()).toMatchObject({label: 'hello'});
      },
      {discrete: true},
    );
  });

  test('an absent property still parses to the schema default', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[with-field-default]',
        nodes: [FieldNode],
      }),
    );
    editor.update(
      () => {
        const bare = FieldNode.importJSON({type: 'field-node'});
        assert(bare instanceof FieldNode);
        expect(bare.__label).toBe('default');
      },
      {discrete: true},
    );
  });

  test('a field property adds no version resolution to an export', () => {
    // ElementNode's own properties are method-backed and each resolve the
    // latest version themselves, so the absolute count is theirs. What this
    // pins is the delta: declaring a `withField` property must add nothing,
    // because the walk already handed exportJSON the current node.
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[with-field-latest]',
        nodes: [FieldNode, PlainCountingNode],
      }),
    );
    editor.update(
      () => {
        const withFieldNode = $create(FieldNode);
        const withoutFieldNode = $create(PlainCountingNode);
        $getRoot().append(withFieldNode, withoutFieldNode);
        const [a, b] = $getRoot().getChildren();
        assert(a instanceof FieldNode && b instanceof PlainCountingNode);
        a.getLatestCalls = 0;
        b.getLatestCalls = 0;
        a.exportJSON();
        b.exportJSON();
        expect(a.getLatestCalls).toBe(b.getLatestCalls);
      },
      {discrete: true},
    );
  });

  test('the field name is introspectable, which is what makes it compilable', () => {
    // A codegen pass emitting a specialized parser reads the accessor names
    // off the schema; the `__` prefix is what marks one as a field.
    const schema = withField(stringValue(), {field: '__label'});
    // Both directions name the same field, and each says so explicitly rather
    // than leaving the kind to be inferred from the name.
    expect(schema.getter).toEqual({field: '__label'});
    expect(schema.setter).toEqual({field: '__label'});
    expect(isSchemaField(schema.getter)).toBe(true);
    // A method name is a plain string, so the two can never be confused.
    expect(
      isSchemaField(withAccessors(stringValue(), {getter: 'getLabel'}).getter),
    ).toBe(false);
  });
});

describe('a field stands in for its accessor only while nobody overrides it', () => {
  // TextNode declares every one of its properties as the field it is, naming
  // the accessor each stands in for. Before the schema existed both JSON
  // methods went through those accessors, so a subclass that overrides one
  // has to keep deciding what its own serialization says.
  class LoudTextNode extends TextNode {
    $config() {
      return this.config('loud-text', {extends: TextNode});
    }
    getStyle(): string {
      return `${super.getStyle()};loud`;
    }
    setStyle(style: string): this {
      return super.setStyle(`${style};set`);
    }
  }
  // Inherits the same schema and overrides nothing, so it keeps the field path.
  class QuietTextNode extends TextNode {
    $config() {
      return this.config('quiet-text', {extends: TextNode});
    }
  }

  function withEditor(fn: () => void): void {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[field-override]',
        nodes: [LoudTextNode, QuietTextNode],
      }),
    );
    editor.update(fn, {discrete: true});
  }

  test('an overridden accessor is consulted in both directions', () => {
    withEditor(() => {
      const node = $create(LoudTextNode).setStyle('color: red');
      // The getter override runs, so its suffix reaches the JSON — which is
      // what reading __style directly would have dropped.
      expect(node.getStyle()).toBe('color: red;set;loud');
      expect(node.exportJSON().style).toBe('color: red;set;loud');
      // And the setter override runs on the way back in.
      const parsed = $create(LoudTextNode).updateFromJSON({
        style: 'color: blue',
        text: 'x',
      });
      expect(parsed.getStyle()).toBe('color: blue;set;loud');
    });
  });

  test('a property whose accessor is not overridden keeps the field path', () => {
    withEditor(() => {
      // `text` is declared the same way as `style`; only `style` was
      // overridden, so the rest of the class is unaffected.
      const node = $create(LoudTextNode).setTextContent('hello');
      expect(node.exportJSON().text).toBe('hello');
      // And a subclass that overrides nothing behaves exactly like TextNode.
      const quiet = $create(QuietTextNode).setStyle('color: red');
      expect(quiet.exportJSON().style).toBe('color: red');
    });
  });

  test('the accessor resolves through the whole chain, not just one level', () => {
    // The override is on LoudTextNode and the schema field is declared by
    // TextNode, so nothing would catch it by looking at one class alone.
    expect(
      resolveSchemaField(
        LoudTextNode,
        'style',
        {field: '__style', method: 'setStyle'},
        'setStyle',
      ),
    ).toBe('setStyle');
    expect(
      resolveSchemaField(
        QuietTextNode,
        'style',
        {field: '__style', method: 'setStyle'},
        'setStyle',
      ),
    ).toEqual({field: '__style', method: 'setStyle'});
    // Naming no accessor defers to the conventional one for the key, which is
    // the same `setStyle` — so leaving it out is not a way to bypass an
    // override, it is just the common case spelled shorter.
    expect(
      resolveSchemaField(LoudTextNode, 'style', {field: '__style'}, 'setStyle'),
    ).toBe('setStyle');
    expect(
      resolveSchemaField(
        QuietTextNode,
        'style',
        {field: '__style'},
        'setStyle',
      ),
    ).toEqual({field: '__style'});
    // A key whose conventional accessor does not exist has nothing to defer
    // to: both prototypes resolve undefined and compare equal.
    expect(
      resolveSchemaField(LoudTextNode, 'style', {field: '__style'}, 'setNope'),
    ).toEqual({field: '__style'});
  });

  test('a spelled accessor is guarded alongside the one it wraps', () => {
    // The case the conventional name is checked for, which every other
    // declaration in the tree spells the same as its conventional name and so
    // cannot reach. ElementNode's `textFormat` names `getSerializedTextFormat`,
    // which computes its result from `getTextFormat` — the accessor exportJSON
    // read before this schema existed, and the one a subclass reaches for.
    // Guarding only the wrapper kept the direct field read for such a subclass
    // and exported the stored field instead of what the node says it is.
    //
    // Straight off ElementNode rather than ParagraphNode, whose hand-written
    // exportJSON backfills `textFormat` from `getTextFormat()` for #7971 and
    // would answer for the override whatever the schema resolved.
    class WrappedElementNode extends ElementNode {
      $config() {
        return this.config('wrapped-element', {extends: ElementNode});
      }
      getTextFormat(): number {
        return super.getTextFormat() | 1;
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[wrapped-textformat]',
        nodes: [WrappedElementNode],
      }),
    );
    editor.update(
      () => {
        // No TextNode child, so `shouldSerializeTextStyles` is true and the
        // property is written at all.
        const node = $create(WrappedElementNode).setTextFormat(2);
        expect(node.exportJSON().textFormat).toBe(3);
      },
      {discrete: true},
    );
  });

  test('setterTable and getterTable carry a property whose two forms differ', () => {
    // TextNode stores `mode` as a bitmask and serializes it as a name, so it
    // stays off getMode()/setMode() only because both tables are declared.
    withEditor(() => {
      const node = $create(QuietTextNode).setMode('segmented');
      expect(node.exportJSON().mode).toBe('segmented');
      const parsed = $create(QuietTextNode).updateFromJSON({
        mode: 'token',
        text: 'x',
      });
      expect(parsed.getMode()).toBe('token');
      expect(parsed.exportJSON().mode).toBe('token');
      // Out of domain falls back to the schema default rather than writing an
      // undefined bitmask through the table.
      const bogus = $create(QuietTextNode).updateFromJSON({
        mode: 'nonsense' as 'normal',
        text: 'x',
      });
      expect(bogus.getMode()).toBe('normal');
    });
  });
});

describe('reference-typed defaults compact by content', () => {
  test('an array equal to its default is dropped, a differing one is not', () => {
    // A parse returns a fresh array, so identity alone would never match the
    // empty default and such a property could never be compacted.
    const ids = arrayValue(stringValue());
    expect(ids.isEqual!([], [])).toBe(true);
    expect(ids.isEqual!(['a'], ['a'])).toBe(true);
    expect(ids.isEqual!(['a'], ['b'])).toBe(false);
    expect(ids.isEqual!(['a'], [])).toBe(false);
  });

  test('an object compares by its declared fields', () => {
    const point = objectValue({x: numberValue(), y: numberValue()});
    expect(point.isEqual!({x: 0, y: 0}, {x: 0, y: 0})).toBe(true);
    expect(point.isEqual!({x: 1, y: 0}, {x: 0, y: 0})).toBe(false);
  });

  test('a node with an array property compacts it away when empty', () => {
    class TagsNode extends ElementNode {
      __tags: string[] = [];
      $config() {
        return this.config('tags-node', {
          extends: ElementNode,
          json: nodeSchema<TagsNode>()({
            tags: withField(arrayValue(stringValue()), {field: '__tags'}),
          }),
        });
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[array-compaction]',
        nodes: [TagsNode],
      }),
    );
    editor.update(
      () => {
        const empty = $create(TagsNode);
        const full = $create(TagsNode);
        full.__tags = ['a'];
        $getRoot().append(empty, full);
      },
      {discrete: true},
    );
    const root = editor.read(() => editor.getEditorState().toJSON(true).root);
    const [emptyJSON, fullJSON] = root.children!;
    expect(emptyJSON).not.toHaveProperty('tags');
    expect(fullJSON).toMatchObject({tags: ['a']});
    // and it still round-trips
    expect(
      editor.parseEditorState(JSON.stringify({root})).read(() =>
        $getRoot()
          .getChildren()
          .map(n => (n as TagsNode).__tags),
      ),
    ).toEqual([[], ['a']]);
  });
});

describe('a clone carries the fields the schema declares', () => {
  /** Whether this exact class carries a method, rather than inheriting one. */
  function hasOwnAfterCloneFrom(klass: Klass<LexicalNode>): boolean {
    return Object.prototype.hasOwnProperty.call(
      klass.prototype,
      'afterCloneFrom',
    );
  }

  /**
   * A node is only cloned across updates: within one, `$setNodeKey` has put it
   * in `_cloneNotNeeded` and `getWritable()` hands back the same object, so a
   * single-update test would never reach `afterCloneFrom` at all.
   */
  function writeThenRewrite<T extends ElementNode>(
    editor: LexicalEditorWithDispose,
    klass: Klass<T>,
    write: (node: T) => void,
  ): T {
    let key = '';
    editor.update(
      () => {
        const node = $create(klass);
        write(node);
        $getRoot().clear().append(node);
        key = node.getKey();
      },
      {discrete: true},
    );
    let cloned!: T;
    editor.update(
      () => {
        cloned = $getRoot().getFirstChild()!.getWritable() as T;
        expect(cloned.getKey()).toBe(key);
      },
      {discrete: true},
    );
    return cloned;
  }

  test('a node that declares only fields needs no afterCloneFrom', () => {
    // The node the docs teach: three properties, each declared as a field, and
    // no clone boilerplate. Before the schema carried them, every one of them
    // reverted to its constructor default on the first edit after the node was
    // created.
    class CalloutNode extends ElementNode {
      __label: string = '';
      __level: number = 1;
      __tone: 'info' | 'warning' | 'danger' = 'info';
      $config() {
        return this.config('callout', {
          extends: ElementNode,
          json: nodeSchema<CalloutNode>()({
            label: withField(stringValue(), {field: '__label'}),
            level: withField(numberValue(1, {integer: true, max: 3, min: 1}), {
              field: '__level',
            }),
            tone: withField(enumValue(['info', 'warning', 'danger']), {
              field: '__tone',
            }),
          }),
        });
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[callout-clone]',
        nodes: [CalloutNode],
      }),
    );
    const cloned = writeThenRewrite(editor, CalloutNode, node => {
      node.__label = 'Heads up';
      node.__level = 3;
      node.__tone = 'danger';
    });
    editor.read(() =>
      expect(cloned.exportJSON()).toMatchObject({
        label: 'Heads up',
        level: 3,
        tone: 'danger',
      }),
    );
  });

  test('each class carries its own fields and delegates the rest', () => {
    class BaseNode extends ElementNode {
      __base: string = '';
      $config() {
        return this.config('carry-base', {
          extends: ElementNode,
          json: nodeSchema<BaseNode>()({
            base: withField(stringValue(), {field: '__base'}),
          }),
        });
      }
    }
    class DerivedNode extends BaseNode {
      __derived: string = '';
      $config() {
        return this.config('carry-derived', {
          extends: BaseNode,
          json: nodeSchema<DerivedNode>()({
            derived: withField(stringValue(), {field: '__derived'}),
          }),
        });
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[carry-chain]',
        nodes: [BaseNode, DerivedNode],
      }),
    );
    const cloned = writeThenRewrite(editor, DerivedNode, node => {
      node.__base = 'from the base';
      node.__derived = 'from the subclass';
    });
    expect(cloned.__base).toBe('from the base');
    expect(cloned.__derived).toBe('from the subclass');
  });

  test('a hand-written afterCloneFrom is left alone', () => {
    // A property declared through accessor methods names no field, so nothing
    // is derived for it and the class stays responsible. The counter proves
    // the class's own method is what ran.
    let calls = 0;
    class AccessorNode extends ElementNode {
      __ids: readonly string[] = [];
      $config() {
        return this.config('carry-accessor', {
          extends: ElementNode,
          json: nodeSchema<AccessorNode>()({
            ids: withAccessors(arrayValue(stringValue()), {
              getter: 'getIds',
              setter: 'setIds',
            }),
          }),
        });
      }
      afterCloneFrom(prevNode: this): void {
        super.afterCloneFrom(prevNode);
        calls += 1;
        this.__ids = prevNode.__ids;
      }
      getIds(): readonly string[] {
        return this.getLatest().__ids;
      }
      setIds(ids: readonly string[]): this {
        const self = this.getWritable();
        self.__ids = ids;
        return self;
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[carry-accessor]',
        nodes: [AccessorNode],
      }),
    );
    const cloned = writeThenRewrite(editor, AccessorNode, node => {
      node.__ids = ['a', 'b'];
    });
    expect(cloned.__ids).toEqual(['a', 'b']);
    expect(calls).toBeGreaterThan(0);
  });

  test('a re-declared field is assigned once, by the class that owns it', () => {
    // Re-declaring an inherited property changes how it is serialized, not
    // where it is stored, and the ancestor's afterCloneFrom has already
    // assigned it by the time the subclass's would. TabNode is the in-tree
    // case: it restates TextNode's `text`, `detail` and `mode`.
    class StoreNode extends ElementNode {
      __shared: string = '';
      $config() {
        return this.config('assign-once-base', {
          extends: ElementNode,
          json: nodeSchema<StoreNode>()({
            shared: withField(stringValue(), {field: '__shared'}),
          }),
        });
      }
    }
    class RestateNode extends StoreNode {
      $config() {
        return this.config('assign-once-derived', {
          extends: StoreNode,
          json: nodeSchema<RestateNode>()({
            shared: withField(stringValue('other'), {field: '__shared'}),
          }),
        });
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[assign-once]',
        nodes: [StoreNode, RestateNode],
      }),
    );
    // Only the class that declared it first gets a method; the subclass has
    // nothing left of its own and inherits that one.
    expect(hasOwnAfterCloneFrom(StoreNode)).toBe(true);
    expect(hasOwnAfterCloneFrom(RestateNode)).toBe(false);
    // Same rule, applied to the real pair.
    expect(hasOwnAfterCloneFrom(TextNode)).toBe(true);
    expect(hasOwnAfterCloneFrom(TabNode)).toBe(false);

    editor.update(
      () => {
        const node = $create(RestateNode);
        const writes: string[] = [];
        let stored = node.__shared;
        Object.defineProperty(node, '__shared', {
          configurable: true,
          get: () => stored,
          set: (value: string) => {
            writes.push(value);
            stored = value;
          },
        });
        const prev = $create(RestateNode);
        prev.__shared = 'carried';
        node.afterCloneFrom(prev);
        expect(writes).toEqual(['carried']);
      },
      {discrete: true},
    );
  });

  test('what a base class carries does not depend on registration order', () => {
    // The subclass re-declares the base's field, so it owns that key in every
    // composition that contains it. Registering the subclass must not leave the
    // base with a method that has stopped copying its own field, which is what
    // deriving each class's list from the registered class's view would do.
    class ReBaseNode extends ElementNode {
      __shared: string = '';
      $config() {
        return this.config('order-base', {
          extends: ElementNode,
          json: nodeSchema<ReBaseNode>()({
            shared: withField(stringValue(), {field: '__shared'}),
          }),
        });
      }
    }
    class ReDerivedNode extends ReBaseNode {
      $config() {
        return this.config('order-derived', {
          extends: ReBaseNode,
          json: nodeSchema<ReDerivedNode>()({
            shared: withField(stringValue('fallback'), {field: '__shared'}),
          }),
        });
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[order-independence]',
        // The subclass first, so the base is only ever reached through it.
        nodes: [ReDerivedNode, ReBaseNode],
      }),
    );
    expect(
      writeThenRewrite(editor, ReBaseNode, node => {
        node.__shared = 'base value';
      }).__shared,
    ).toBe('base value');
    expect(
      writeThenRewrite(editor, ReDerivedNode, node => {
        node.__shared = 'derived value';
      }).__shared,
    ).toBe('derived value');
  });
});

describe('review fixes', () => {
  test('a caller-supplied default is not frozen', () => {
    // Only a default this factory derived is metadata it owns; one passed in
    // still belongs to the caller.
    const shared = {cols: 2};
    enumValue([shared, null], shared);
    expect(Object.isFrozen(shared)).toBe(false);
    // a derived reference default is still frozen
    expect(Object.isFrozen(arrayValue(stringValue()).defaultValue)).toBe(true);
  });

  test('equality is total: an unvalidated getter result cannot throw', () => {
    // The export path hands isEqual whatever a node getter returned, which
    // nothing validated.
    const ids = arrayValue(stringValue());
    const point = objectValue({x: numberValue()});
    for (const value of [null, undefined, 7, 'x']) {
      expect(() => isSchemaDefault(ids, value as never)).not.toThrow();
      expect(() => isSchemaDefault(point, value as never)).not.toThrow();
    }
  });

  test('optional and nullable keep the inner content comparison', () => {
    const ids = arrayValue(stringValue());
    expect(optional(ids, {omitDefault: true})([])).toBeUndefined();
    expect(nullable(ids, {defaultAsNull: true})([])).toBeNull();
    // and the nil cases still compare by identity
    expect(optional(ids).isEqual!(undefined, undefined)).toBe(true);
    expect(optional(ids).isEqual!(undefined, [])).toBe(false);
  });

  test('a union parses undefined to the fallback it declared', () => {
    // A member that accepts undefined would otherwise win and return it,
    // contradicting defaultValue — which compaction compares against.
    const schema = unionValue(
      [optional(numberValue()), enumValue(['inherit'])],
      'inherit',
    );
    expect(schema.defaultValue).toBe('inherit');
    expect(schema(undefined)).toBe('inherit');
    expect(schema(640)).toBe(640);
  });

  test('a state built from a schema adopts its equality and default', () => {
    const idsState = createState('ids', {parse: arrayValue(stringValue())});
    expect(idsState.isEqual([], idsState.defaultValue)).toBe(true);
    expect(idsState.isEqual(['a'], [])).toBe(false);
    // and the shared default cannot be mutated into every node
    expect(() => idsState.defaultValue.push('leak')).toThrow();
  });
});

describe('numberValue accepts a stringified number', () => {
  test('a string spelled as a JSON number is converted', () => {
    // Lexical writes numbers, but a hand-authored fixture, a converter or a
    // backend that stringified its numbers can hand one back as a string.
    const parse = numberValue(0);
    expect(parse('2')).toBe(2);
    expect(parse('0')).toBe(0);
    expect(parse('1e3')).toBe(1000);
    expect(parse('1E3')).toBe(1000);
    expect(parse('1e-3')).toBe(0.001);
    expect(parse('2.5')).toBe(2.5);
    expect(parse('-4')).toBe(-4);
    expect(parse('-0.5')).toBe(-0.5);
  });

  test('only the JSON grammar is read', () => {
    // Number() would take all of these; JSON.stringify writes none of them, so
    // they are not evidence of a number that was stringified.
    const parse = numberValue(7);
    for (const value of [
      '0x10', // 16
      '0b11', // 3
      '0o17', // 15
      '1_000', // NaN, but a valid numeric literal in source
      '+1', // 1
      '05', // 5
      '.5', // 0.5
      '5.', // 5
      ' 2 ', // 2, leading/trailing whitespace ignored
      '\n2', // 2
      '2n', // NaN
    ]) {
      expect(parse(value)).toBe(7);
    }
  });

  test('anything that does not read as a finite number is out of domain', () => {
    const parse = numberValue(7);
    // blank is the absence of a value, not Number('') === 0
    for (const value of ['', '   ', 'abc', 'Infinity', 'NaN', true, null, []]) {
      expect(parse(value)).toBe(7);
    }
  });

  test('the bounds apply to the converted value', () => {
    const span = numberValue(1, {integer: true, min: 1});
    expect(span('2')).toBe(2);
    expect(span('0')).toBe(1);
    expect(span('2.5')).toBe(1);
  });

  test('the reported domain is still numbers', () => {
    // A string is an input encoding, not part of the domain tooling generates.
    expect(numberValue().meta).toMatchObject({kind: 'number'});
    expect(numberValue(3).defaultValue).toBe(3);
  });

  test('a union accepts through a converting member', () => {
    // A member accepts when parsing lands anywhere but its own default, so one
    // that normalizes its input composes here just as it behaves alone — and
    // the union yields what that member parsed, not the raw value.
    const schema = unionValue([numberValue(), enumValue(['auto'])], 'auto');
    expect(schema('2')).toBe(2);
    expect(schema(2)).toBe(2);
    expect(schema('auto')).toBe('auto');
    // Still out of every member's domain, so still the declared fallback.
    expect(schema('banana')).toBe('auto');
    expect(transformValue(schema, v => (v === 'auto' ? 0 : v))('auto')).toBe(0);
  });

  test('the union reads a stringified number for a real node property', () => {
    // TextNode's format is a union, so this is the shape the coercion has to
    // survive to reach a document that stringified its numbers.
    const format = transformValue(
      unionValue([numberValue(), enumValue(['bold', 'italic'])], 0),
      value =>
        typeof value === 'string' ? {bold: 1, italic: 2}[value] : value,
    );
    expect(format('1')).toBe(1);
    expect(format(1)).toBe(1);
    expect(format('bold')).toBe(1);
    expect(format('junk')).toBe(0);
  });
});

describe('a default is metadata, so nothing hands out a mutable one', () => {
  test('a nested reference default is frozen too, not just the outer one', () => {
    // A value nested in an objectValue default is shared by every node with
    // none of its own exactly as the outer value is, so a shallow freeze would
    // leave the same hazard one level down.
    const schema = objectValue({
      items: arrayValue(stringValue()),
      n: numberValue(),
    });
    expect(Object.isFrozen(schema.defaultValue)).toBe(true);
    expect(Object.isFrozen(schema.defaultValue.items)).toBe(true);
    expect(() => schema.defaultValue.items.push('boom')).toThrow();
  });

  test('a union yields a fresh parse rather than a member default', () => {
    // Every other combinator allocates per parse; this one used to return the
    // member's frozen defaultValue by reference for an accepted value.
    const schema = unionValue([arrayValue(stringValue())]);
    const parsed = schema(['a']);
    expect(parsed).toEqual(['a']);
    expect(Object.isFrozen(parsed)).toBe(false);
    expect(schema([])).not.toBe(schema([]));
  });

  test('a comparator is called with no receiver, and its type says so', () => {
    // Every caller reads `isEqual` off the schema and calls it on its own —
    // NodeState equality, `optional({omitDefault})`, the compact export — so
    // a comparator that reaches for `this` throws. Method syntax implied a
    // receiver it is never given; `this: void` is that fact in the type.
    type Comparator = NonNullable<SerializationSchema<string>['isEqual']>;
    const plain: Comparator = (a, b) => a === b;
    expect(plain('x', 'x')).toBe(true);
    const wantsReceiver = function (
      this: {meta: unknown},
      a: string,
      b: string,
    ): boolean {
      return this.meta !== undefined && a === b;
    };
    // @ts-expect-error -- there is no receiver to read
    const assigned: Comparator = wantsReceiver;
    expect(assigned).toBeDefined();
    // And the bivariance the method syntax is for is unchanged: a `this`
    // parameter is not a parameter for that purpose.
    const erased: AnySerializationSchema = stringValue();
    expect(erased.meta.kind).toBe('string');
  });

  test('transformValue does not freeze the value its transform returned', () => {
    // The transform is the caller's function, so what it produces is theirs —
    // possibly a module constant they also use elsewhere.
    const shared = {a: 1};
    transformValue(stringValue(), () => shared);
    expect(Object.isFrozen(shared)).toBe(false);
  });

  test('nor does an enclosing schema deriving its own default', () => {
    // Leaving the caller's value out of *this* schema's freeze is only half of
    // it: an enclosing schema derives its own default by parsing `undefined`,
    // which hands back that same object, and the recursive freeze reached
    // straight through it. Declaring a default and then finding your own
    // object read-only is the failure, and it happened in every build.
    const shared = {columns: 2};
    const layout = unionValue([objectValue({columns: numberValue()})], shared);
    objectValue({layout});
    expect(Object.isFrozen(shared)).toBe(false);
    shared.columns = 3;
    expect(shared.columns).toBe(3);

    // An enum's members are the caller's on the same terms: the default is one
    // of them, declared or not.
    const member = {tag: 'a'};
    objectValue({tag: enumValue([member])});
    expect(Object.isFrozen(member)).toBe(false);

    // The schema's own derived defaults are still frozen — that is the hazard
    // this is carved out of, not a retreat from it.
    const derived = objectValue({items: arrayValue(stringValue())});
    expect(Object.isFrozen(derived.defaultValue)).toBe(true);
    expect(Object.isFrozen(derived.defaultValue.items)).toBe(true);
  });
});

describe('schema(undefined) is always the schema default', () => {
  test('enumValue reads an absent value as its default, not as a member', () => {
    // An absent JSON property parses as undefined. Reading that as the in-band
    // undefined would make defaultValue a value parsing never restores, and
    // compaction drops a default-valued property expecting exactly that.
    const schema = enumValue([undefined, 'middle', 'bottom'], 'middle');
    expect(schema.defaultValue).toBe('middle');
    expect(schema(undefined)).toBe('middle');
    expect(schema('bottom')).toBe('bottom');
    // Unchanged when undefined leads the list, so it is also the default.
    const leading = enumValue([undefined, 'middle']);
    expect(leading.defaultValue).toBeUndefined();
    expect(leading(undefined)).toBeUndefined();
  });
});

describe('isEqual is total over the values a getter can return', () => {
  test('an array with holes is not equal to a dense one of the same length', () => {
    const schema = arrayValue(stringValue());
    assert(schema.isEqual !== undefined);
    expect(schema.isEqual(new Array(3), ['a', 'b', 'c'])).toBe(false);
    expect(schema.isEqual(['a', 'b'], ['a', 'b'])).toBe(true);
  });

  test('an object carrying undeclared keys is not equal to the default', () => {
    // Those keys say something; reporting equality would drop them from the
    // export, and a flat NodeState borrows this comparator to decide that.
    const schema = objectValue({x: numberValue()});
    assert(schema.isEqual !== undefined);
    expect(schema.isEqual({x: 0}, schema.defaultValue)).toBe(true);
    expect(
      schema.isEqual({extra: 'keep', x: 0} as never, schema.defaultValue),
    ).toBe(false);
    // An array is an object, but not one this schema describes.
    expect(schema.isEqual([] as never, schema.defaultValue)).toBe(false);
  });

  test('transformValue takes an isEqual for a reference-typed output', () => {
    // Not inherited from inner, whose comparator is defined on a domain the
    // transform may have left entirely.
    const plain = transformValue(arrayValue(stringValue()), value => value);
    expect(plain.isEqual).toBeUndefined();
    const compared = transformValue(arrayValue(stringValue()), value => value, {
      isEqual: (a, b) => a.join() === b.join(),
    });
    assert(compared.isEqual !== undefined);
    expect(compared.isEqual([], compared.defaultValue)).toBe(true);
  });
});

describe('a schema tracks what it accepts, not only what it parses to', () => {
  // The two differ wherever a schema reads more than it writes, and the
  // difference is not decoration: `nodeArbitrary` generates the legacy
  // spellings an `aliasedValue` accepts, so a type that describes only the
  // parsed output is wrong about the values that actually reach a parser.

  test('a primitive accepts what it parses, except where it reads more', () => {
    const text = stringValue();
    const flag = booleanValue();
    const count = numberValue();
    expect(text('x')).toBe('x');
    expect(flag(true)).toBe(true);
    // numberValue also reads a number spelled as a string, which is the one
    // place here where what it accepts is wider than what it parses to.
    expect(count('2')).toBe(2);
    expectTypeOf<SchemaInput<typeof text>>().toEqualTypeOf<string>();
    expectTypeOf<SchemaInput<typeof flag>>().toEqualTypeOf<boolean>();
    expectTypeOf<SchemaInput<typeof count>>().toEqualTypeOf<number | string>();
  });

  test('an alias table widens the accepted input, not the output', () => {
    const format = aliasedValue(numberValue(), {bold: 1, italic: 2});
    expectTypeOf<
      SerializationSchemaValue<typeof format>
    >().toEqualTypeOf<number>();
    expectTypeOf<SchemaInput<typeof format>>().toEqualTypeOf<
      number | string | 'bold' | 'italic'
    >();
    // and the values really are accepted
    expect(format('bold')).toBe(1);
    expect(format('2')).toBe(2);
  });

  test('the wrappers widen their inner the way they widen its output', () => {
    const s = stringValue();
    const maybe = optional(s);
    const orNull = nullable(s);
    const many = arrayValue(numberValue());
    expect(s('x')).toBe('x');
    expect(maybe(undefined)).toBe(undefined);
    expect(orNull(null)).toBe(null);
    // The element's wider input really is accepted, not just declared.
    expect(many(['1', 2])).toEqual([1, 2]);
    expectTypeOf<SchemaInput<typeof s>>().toEqualTypeOf<string>();
    expectTypeOf<SchemaInput<typeof maybe>>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<SchemaInput<typeof orNull>>().toEqualTypeOf<
      string | null | undefined
    >();
    // an array of whatever the item accepts, which for `numberValue` is wider
    // than what it parses to — the element's input type propagates, so the
    // array's does too.
    expectTypeOf<SerializationSchemaValue<typeof many>>().toEqualTypeOf<
      number[]
    >();
    expectTypeOf<SchemaInput<typeof many>>().toEqualTypeOf<
      readonly (number | string)[]
    >();
  });

  test('a union accepts what any member accepts', () => {
    const dimension = unionValue(
      [numberValue(), enumValue(['inherit'])],
      'inherit',
    );
    expectTypeOf<SerializationSchemaValue<typeof dimension>>().toEqualTypeOf<
      number | 'inherit'
    >();
    expectTypeOf<SchemaInput<typeof dimension>>().toEqualTypeOf<
      number | string | 'inherit'
    >();
    expect(dimension('640')).toBe(640);
  });

  test('a node schema keeps the input of the fields it was given', () => {
    // What the currying is for. `nodeSchema<N>` has to take `N` explicitly,
    // and TypeScript will not infer the field types alongside a type argument
    // that was written out — so with both on one call the fields were widened
    // to the index signature and their input went with them. Split in two, the
    // node is explicit on the first and the fields are inferred on the second.
    class InputNode extends ElementNode {
      __format = 0;
      __label = '';
    }
    const schema = nodeSchema<InputNode>()({
      format: withField(aliasedValue(numberValue(), {bold: 1}), {
        field: '__format',
      }),
      label: withField(stringValue(), {field: '__label'}),
    });
    expectTypeOf<SchemaInput<typeof schema>>().toEqualTypeOf<{
      readonly format?: number | string;
      readonly label?: string;
    }>();
    // and the alias really parses, which is what the type is describing. Asked
    // of the field rather than of the node schema: a node schema is not a
    // parser, since its properties are applied to a node one at a time.
    expect(schema.meta.fields.format('bold')).toBe(1);
  });

  test('a node composes the input it accepts across its config chain', () => {
    // ParagraphNode declares no schema of its own, so everything here is
    // ElementNode's — reached by following each config's `extends`, which is
    // why every config in the tree names one even though the runtime defaults
    // it to the superclass.
    expectTypeOf<keyof LexicalSchemaInput<ParagraphNode>>().toEqualTypeOf<
      'direction' | 'format' | 'indent' | 'textFormat' | 'textStyle'
    >();
    // TextNode's are its own, and `format` accepts the legacy spellings its
    // aliasedValue declares as well as the number it stores.
    expectTypeOf<LexicalSchemaInput<TextNode>['format']>().toEqualTypeOf<
      number | string | undefined
    >();
  });

  test('a chain deeper than any bound resolves, base included', () => {
    // Twenty links, which is past the fixed slot count an earlier
    // hand-rolled fold here allowed: the walk resolves the chain to a tuple
    // and the fold over it is tail-recursive, so ancestors do not quietly
    // stop contributing at a depth nothing names. Only the two ends declare
    // a schema — the assertion reads those, and the eighteen links between
    // them are what makes it a depth test, so paying `nodeSchema`'s
    // per-member obligation check on each of them buys nothing.
    class Deep1 extends ElementNode {
      __p1 = '';
      $config() {
        return this.config('deep-1', {
          extends: ElementNode,
          json: nodeSchema<Deep1>()({
            p1: withField(stringValue(), {field: '__p1'}),
          }),
        });
      }
    }
    class Deep2 extends Deep1 {
      $config() {
        return this.config('deep-2', {extends: Deep1});
      }
    }
    class Deep3 extends Deep2 {
      $config() {
        return this.config('deep-3', {extends: Deep2});
      }
    }
    class Deep4 extends Deep3 {
      $config() {
        return this.config('deep-4', {extends: Deep3});
      }
    }
    class Deep5 extends Deep4 {
      $config() {
        return this.config('deep-5', {extends: Deep4});
      }
    }
    class Deep6 extends Deep5 {
      $config() {
        return this.config('deep-6', {extends: Deep5});
      }
    }
    class Deep7 extends Deep6 {
      $config() {
        return this.config('deep-7', {extends: Deep6});
      }
    }
    class Deep8 extends Deep7 {
      $config() {
        return this.config('deep-8', {extends: Deep7});
      }
    }
    class Deep9 extends Deep8 {
      $config() {
        return this.config('deep-9', {extends: Deep8});
      }
    }
    class Deep10 extends Deep9 {
      $config() {
        return this.config('deep-10', {extends: Deep9});
      }
    }
    class Deep11 extends Deep10 {
      $config() {
        return this.config('deep-11', {extends: Deep10});
      }
    }
    class Deep12 extends Deep11 {
      $config() {
        return this.config('deep-12', {extends: Deep11});
      }
    }
    class Deep13 extends Deep12 {
      $config() {
        return this.config('deep-13', {extends: Deep12});
      }
    }
    class Deep14 extends Deep13 {
      $config() {
        return this.config('deep-14', {extends: Deep13});
      }
    }
    class Deep15 extends Deep14 {
      $config() {
        return this.config('deep-15', {extends: Deep14});
      }
    }
    class Deep16 extends Deep15 {
      $config() {
        return this.config('deep-16', {extends: Deep15});
      }
    }
    class Deep17 extends Deep16 {
      $config() {
        return this.config('deep-17', {extends: Deep16});
      }
    }
    class Deep18 extends Deep17 {
      $config() {
        return this.config('deep-18', {extends: Deep17});
      }
    }
    class Deep19 extends Deep18 {
      $config() {
        return this.config('deep-19', {extends: Deep18});
      }
    }
    class Deep20 extends Deep19 {
      $config() {
        return this.config('deep-45', {extends: Deep19});
      }
    }
    class Deep21 extends Deep20 {
      $config() {
        return this.config('deep-21', {extends: Deep20});
      }
    }
    class Deep22 extends Deep21 {
      $config() {
        return this.config('deep-22', {extends: Deep21});
      }
    }
    class Deep23 extends Deep22 {
      $config() {
        return this.config('deep-23', {extends: Deep22});
      }
    }
    class Deep24 extends Deep23 {
      $config() {
        return this.config('deep-24', {extends: Deep23});
      }
    }
    class Deep25 extends Deep24 {
      $config() {
        return this.config('deep-25', {extends: Deep24});
      }
    }
    class Deep26 extends Deep25 {
      $config() {
        return this.config('deep-26', {extends: Deep25});
      }
    }
    class Deep27 extends Deep26 {
      $config() {
        return this.config('deep-27', {extends: Deep26});
      }
    }
    class Deep28 extends Deep27 {
      $config() {
        return this.config('deep-28', {extends: Deep27});
      }
    }
    class Deep29 extends Deep28 {
      $config() {
        return this.config('deep-29', {extends: Deep28});
      }
    }
    class Deep30 extends Deep29 {
      $config() {
        return this.config('deep-30', {extends: Deep29});
      }
    }
    class Deep31 extends Deep30 {
      $config() {
        return this.config('deep-31', {extends: Deep30});
      }
    }
    class Deep32 extends Deep31 {
      $config() {
        return this.config('deep-32', {extends: Deep31});
      }
    }
    class Deep33 extends Deep32 {
      $config() {
        return this.config('deep-33', {extends: Deep32});
      }
    }
    class Deep34 extends Deep33 {
      $config() {
        return this.config('deep-34', {extends: Deep33});
      }
    }
    class Deep35 extends Deep34 {
      $config() {
        return this.config('deep-35', {extends: Deep34});
      }
    }
    class Deep36 extends Deep35 {
      $config() {
        return this.config('deep-36', {extends: Deep35});
      }
    }
    class Deep37 extends Deep36 {
      $config() {
        return this.config('deep-37', {extends: Deep36});
      }
    }
    class Deep38 extends Deep37 {
      $config() {
        return this.config('deep-38', {extends: Deep37});
      }
    }
    class Deep39 extends Deep38 {
      $config() {
        return this.config('deep-39', {extends: Deep38});
      }
    }
    class Deep40 extends Deep39 {
      $config() {
        return this.config('deep-40', {extends: Deep39});
      }
    }
    class Deep41 extends Deep40 {
      $config() {
        return this.config('deep-41', {extends: Deep40});
      }
    }
    class Deep42 extends Deep41 {
      $config() {
        return this.config('deep-42', {extends: Deep41});
      }
    }
    class Deep43 extends Deep42 {
      $config() {
        return this.config('deep-43', {extends: Deep42});
      }
    }
    class Deep44 extends Deep43 {
      $config() {
        return this.config('deep-44', {extends: Deep43});
      }
    }
    class Deep45 extends Deep44 {
      __p45 = '';
      $config() {
        return this.config('deep-20', {
          extends: Deep44,
          json: nodeSchema<Deep45>()({
            p45: withField(stringValue(), {field: '__p45'}),
          }),
        });
      }
    }
    // Exact, not assignable-to: a fold that dropped the base would still
    // satisfy `const k: keyof ... = 'p20'`, which is the whole failure being
    // guarded against.
    expectTypeOf<keyof LexicalSchemaInput<Deep45>>().toEqualTypeOf<
      | 'p1'
      | 'p45'
      | 'direction'
      | 'format'
      | 'indent'
      | 'textFormat'
      | 'textStyle'
    >();
    // and the runtime walk reaches just as far, which is what the type is
    // claiming to describe. (Type assertions are erased by the test runner,
    // so without this the case would pass under `test-unit` either way.)
    expect(Object.keys(getComposedSchemaFields(Deep45)).sort()).toEqual([
      'direction',
      'format',
      'indent',
      'p1',
      'p45',
      'textFormat',
      'textStyle',
    ]);
  });

  test('a node that omits extends keeps its own schema', () => {
    // Its superclass declares no `$config()`, so the record carries no
    // accessor and the walk has nothing to follow — but the node's own
    // declaration is still there to be read, by type as it is at runtime.
    class CaptionNode extends DecoratorNode<null> {
      __caption = '';
      $config() {
        return this.config('caption-no-extends', {
          json: nodeSchema<CaptionNode>()({
            caption: withField(stringValue(), {field: '__caption'}),
          }),
        });
      }
      decorate(): null {
        return null;
      }
    }
    const key: keyof LexicalSchemaInput<CaptionNode> = 'caption';
    expect(key).toBe('caption');
  });

  test('a re-declared property is the subclass’s, not the intersection', () => {
    // `composeSchema` resolves a re-declared key to one winning schema, most
    // derived first, so a subclass that widens a domain really does accept the
    // wider one. Intersecting the two would report the ancestor's.
    //
    // Widened on the *input* side, with an alias the base does not know: both
    // schemas parse to what `__tag` holds, which is what the field obligation
    // asks of each. Widening the parsed domain instead is a contradiction the
    // check now reports — a field the base declares narrower than it is holds
    // values the base's own schema declines.
    class TagBase extends ElementNode {
      __tag: 'a' | 'b' | 'c' = 'a';
      $config() {
        return this.config('tag-base', {
          extends: ElementNode,
          json: nodeSchema<TagBase>()({
            tag: withField(enumValue(['a', 'b', 'c']), {field: '__tag'}),
          }),
        });
      }
    }
    class TagSub extends TagBase {
      $config() {
        return this.config('tag-sub', {
          extends: TagBase,
          json: nodeSchema<TagSub>()({
            tag: withField(
              aliasedValue(enumValue(['a', 'b', 'c']), {third: 'c'}),
              {field: '__tag'},
            ),
          }),
        });
      }
    }
    const widened: LexicalSchemaInput<TagSub>['tag'] = 'third';
    expect(widened).toBe('third');
    // and the runtime agrees, which is what makes the type worth pinning
    expect(getComposedSchemaFields(TagSub).tag('third')).toBe('c');
    expect(getComposedSchemaFields(TagBase).tag('third')).toBe('a');
  });

  test('a node composes its flat NodeState too', () => {
    // `getComposedSchemaFields` folds flat NodeState in beside the schema's
    // own properties, and `nodeArbitrary` generates from that — so a type
    // describing what a node accepts has to carry those keys or it denies
    // values the generator really produces. QuoteNode's `shadowRoot` is the
    // in-tree case.
    const key: keyof LexicalSchemaInput<QuoteNode> = 'shadowRoot';
    expect(key).toBe('shadowRoot');
  });

  test('an object accepts each property’s input, any of them absent', () => {
    const point = objectValue({label: stringValue(), x: numberValue()});
    expect(point({x: '3'})).toEqual({label: '', x: 3});
    expectTypeOf<SchemaInput<typeof point>>().toEqualTypeOf<{
      readonly label?: string;
      readonly x?: number | string;
    }>();
  });
});

describe('the parse shape accepts what a parser actually accepts', () => {
  initializeUnitTest(testEnv => {
    test('a legacy alias and a stringified number type-check as input', () => {
      testEnv.editor.update(
        () => {
          const node = $createTextNode('hi');
          // Both are values TextNode's schema accepts and normalizes. Before
          // the parse shape was widened, each was a type error at the call
          // site while working perfectly at runtime — the type described what
          // the parser produces rather than what it takes.
          node.updateFromJSON({detail: 'directionless', format: 'bold'});
          expect(node.getFormat()).toBe(IS_BOLD);
          expect(node.isDirectionless()).toBe(true);
        },
        {discrete: true},
      );
    });

    test('a property the node does not have is still refused', () => {
      testEnv.editor.update(
        () => {
          const node = $createTextNode('hi');
          node.updateFromJSON({
            // @ts-expect-error -- widening the values keeps the names checked
            frmat: 'bold',
          });
        },
        {discrete: true},
      );
    });
  });
});

describe('a schema is bound to the node it was checked against', () => {
  class Alpha extends ElementNode {
    __alpha = '';
    getAlpha(): string {
      return this.getLatest().__alpha;
    }
    setAlpha(alpha: string): this {
      const self = this.getWritable();
      self.__alpha = alpha;
      return self;
    }
  }
  class Beta extends ElementNode {
    __beta = '';
  }
  const alphaSchema = nodeSchema<Alpha>()({
    alpha: withField(stringValue(), {field: '__alpha'}),
  });

  test('it installs on the node it names, and on a subclass of it', () => {
    class AlphaNode extends Alpha {
      $config() {
        return this.config('bound-alpha', {
          extends: ElementNode,
          json: alphaSchema,
        });
      }
    }
    expect(typeof AlphaNode).toBe('function');
    expectTypeOf(alphaSchema).toMatchTypeOf<NodeSerializationSchema<Alpha>>();
  });

  test('it does not install on an unrelated node', () => {
    // Asserted on `config()` directly rather than inside a `$config()`
    // override: a rejected call has the error type for a return type, which
    // would fail the override check too and report twice for one mistake.
    // Declared, never called: the assertion is the compile error below.
    const _refused = (beta: Beta) =>
      // @ts-expect-error -- alphaSchema was checked against Alpha, whose
      // members Beta does not have: "Type 'Beta' is missing the following
      // properties from type 'Alpha': __alpha, getAlpha, setAlpha"
      beta.config('bound-beta', {extends: ElementNode, json: alphaSchema});
    expect(typeof _refused).toBe('function');
  });

  test('an objectValue is not a node schema', () => {
    // `objectValue` describes a *value* one property holds, and its fields
    // name no accessor, so it says nothing about how a node is serialized.
    // Installing one as `json` used to type-check and compose to nothing.
    // Declared, never called: the assertion is the compile error below.
    const _refused = (beta: Beta) =>
      // @ts-expect-error -- `json` takes a nodeSchema; an objectValue's meta
      // is a value's, not a node's
      beta.config('bound-any', {
        extends: ElementNode,
        json: objectValue({label: rawValue()}),
      });
    expect(typeof _refused).toBe('function');
  });
});

describe('a misconfigured accessor fails at registration', () => {
  class MissingSetterNode extends ElementNode {
    $config() {
      return this.config('missing-setter-node', {
        extends: ElementNode,
        // There is no setLabel() on this class. The types refuse this where it
        // is written, so the cast is what stands in for a caller who has no
        // type checking at all — Flow, or plain JavaScript — and this is the
        // diagnostic they get instead.
        json: nodeSchema<MissingSetterNode>()({
          label: stringValue(),
        } as never),
      });
    }
  }

  test('and keeps failing, rather than registering in silence', () => {
    const build = () =>
      buildEditorFromExtensions(
        defineExtension({name: '[missing-setter]', nodes: [MissingSetterNode]}),
      );
    // Registration is where the error names the class that is misconfigured;
    // later it would surface from whichever autosave or copy handler happened
    // to serialize one of these nodes first. Run it twice: the per-class record
    // is dropped when compiling throws, and caching one whose tables never
    // compiled would let the second attempt succeed against a broken class.
    for (let i = 0; i < 2; i++) {
      expect(build).toThrow('has no setter setLabel()');
    }
  });

  test('a `setterTable` that cannot setterTable the default is refused', () => {
    // A parsed value the table does not map is stored as the encoded default,
    // so a default the table does not map has no stored form: the walk wrote
    // the raw default — here the string '' — into the numeric field.
    class CodeNode extends ElementNode {
      __code = 0;
      $config() {
        return this.config('unencodable-default-node', {
          extends: ElementNode,
          json: nodeSchema<CodeNode>()({
            code: withField(stringValue(), {
              field: '__code',
              getterTable: {1: 'a'},
              setterTable: {a: 1},
            }),
          }),
        });
      }
    }
    const build = () =>
      buildEditorFromExtensions(
        defineExtension({name: '[unencodable-default]', nodes: [CodeNode]}),
      );
    for (let i = 0; i < 2; i++) {
      expect(build).toThrow('has no setterTable entry for ""');
    }
  });
});

describe('a misspelled field name is caught in both directions', () => {
  class ImportOnlyFieldNode extends ElementNode {
    __label = '';
    $config() {
      return this.config('import-only-field-node', {
        extends: ElementNode,
        // Import-only, and the field name is a typo of __label. Because the
        // property is never exported, this declaration produces an ownField
        // entry on the setter table and none on the getter table.
        //
        // Checked against a type that *claims* the field, which is how a
        // JavaScript caller's schema looks to the runtime: `nodeSchema`
        // rejects the typo against the real class, which is the point of it —
        // what is under test here is the runtime check that still has to
        // catch the same mistake for a caller with no compiler.
        json: nodeSchema<ImportOnlyFieldNode & {__lable: string}>()({
          label: withAccessors(stringValue(), {
            getter: null,
            setter: {field: '__lable'},
          }),
        }) as NodeSerializationSchema,
      });
    }
  }

  const build = () =>
    buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[import-only-field]',
        nodes: [ImportOnlyFieldNode],
      }),
    );

  test('exporting reports a typo that only the import side declares', () => {
    // Whichever direction runs first validates both tables. Checking only the
    // caller's would leave this one unreported for the whole process, since
    // exporting (autosave) generally precedes importing (paste).
    using editor = build();
    editor.update(
      () => {
        const node = $create(ImportOnlyFieldNode);
        expect(() => node.exportJSON()).toThrow(
          'names a node field __lable that the node does not have',
        );
      },
      {discrete: true},
    );
  });

  test('a swallowed failure does not retire the check', () => {
    // What a serialization path throws does not always reach the caller —
    // parseEditorState routes it to the editor's onError — so the class must
    // not be marked validated until the whole pass has run.
    using editor = build();
    editor.update(
      () => {
        const node = $create(ImportOnlyFieldNode);
        for (let i = 0; i < 2; i++) {
          expect(() => node.exportJSON()).toThrow(
            'names a node field __lable that the node does not have',
          );
        }
      },
      {discrete: true},
    );
  });

  test('an initialized optional field is an own property', () => {
    // `__caption?: string` with no initializer emits no own property, and the
    // check below cannot tell that from a misspelling — so the field is
    // initialized, which is also what keeps a node's shape stable. What must
    // hold is that an own property holding `undefined` is not reported.
    class OptionalFieldNode extends ElementNode {
      __caption: string | undefined = undefined;
      $config() {
        return this.config('optional-field-node', {
          extends: ElementNode,
          json: nodeSchema<OptionalFieldNode>()({
            caption: withField(optional(stringValue()), {field: '__caption'}),
          }),
        });
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[optional-field]',
        nodes: [OptionalFieldNode],
      }),
    );
    editor.update(
      () => {
        const node = $create(OptionalFieldNode);
        expect(node.exportJSON()).toMatchObject({
          caption: undefined,
          type: 'optional-field-node',
        });
        expect(
          node.updateFromJSON({caption: 'hi'} as never).exportJSON(),
        ).toMatchObject({caption: 'hi'});
      },
      {discrete: true},
    );
  });

  test('a misspelled optional field is still a misspelling', () => {
    // The check was once relaxed for any schema whose default is `undefined`,
    // on the theory that a field declared without an initializer has no own
    // property to find. True — and true of a typo, which the check cannot
    // tell apart, so relaxing it for one relaxed it for the other: every
    // `optional`, `rawValue` and union-with-an-optional field stopped
    // reporting a name the node does not have, on both sides.
    class TypoNode extends ElementNode {
      __caption: string | undefined = undefined;
      $config() {
        return this.config('optional-typo-node', {
          extends: ElementNode,
          // The type claims the field, as a JavaScript caller's schema would.
          json: nodeSchema<TypoNode & {__captoin: string | undefined}>()({
            caption: withField(optional(stringValue()), {field: '__captoin'}),
          }) as NodeSerializationSchema,
        });
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[optional-typo]',
        nodes: [TypoNode],
      }),
    );
    editor.update(
      () => {
        expect(() => $create(TypoNode).exportJSON()).toThrow(
          'names a node field __captoin that the node does not have. Check the spelling',
        );
      },
      {discrete: true},
    );
  });
});

describe('the JSON input types', () => {
  test('LexicalUpdateJSON keeps the properties a hand-written override reads', () => {
    // The helper an override has always taken: every property keeps its
    // declared type, so `json.color` is a string. The wider input a
    // schema-driven parser faces — every property optional and `unknown` — is
    // `LexicalParseJSON`'s, and widening the established helper to it broke
    // every existing override that read a property.
    type SerializedColoredNode = Spread<{color: string}, SerializedElementNode>;
    class ColoredNode extends ElementNode {
      __color = '';
      setColor(color: string): this {
        const self = this.getWritable();
        self.__color = color;
        return self;
      }
      updateFromJSON(json: LexicalUpdateJSON<SerializedColoredNode>): this {
        return super.updateFromJSON(json).setColor(json.color);
      }
    }
    expect(typeof ColoredNode).toBe('function');
    expectTypeOf<
      LexicalParseJSON<SerializedColoredNode>['color']
    >().toEqualTypeOf<unknown>();
  });

  test('a $importJSON callback typed against SerializedLexicalNode still fits', () => {
    // The callback is handed the untrusted JSON, which may be the compact
    // form now, so a callback may take `SerializedPartial<SerializedLexicalNode>`.
    // One written before that form existed takes `SerializedLexicalNode`,
    // `version` required, and has to stay assignable: it compiled against the
    // last release, and a node that never asks for the compact form cannot
    // be made to change its signature for it.
    class LegacyImportNode extends LineBreakNode {
      $config(this: LegacyImportNode) {
        return this.config('legacy-import', {
          $importJSON: (json: SerializedLexicalNode): LegacyImportNode =>
            $create(LegacyImportNode).updateFromJSON(json),
          extends: LineBreakNode,
        });
      }
    }
    class CompactImportNode extends LineBreakNode {
      $config(this: CompactImportNode) {
        return this.config('compact-import', {
          $importJSON: (
            json: SerializedPartial<SerializedLexicalNode>,
          ): CompactImportNode =>
            $create(CompactImportNode).updateFromJSON(json),
          extends: LineBreakNode,
        });
      }
    }
    expect(typeof LegacyImportNode).toBe('function');
    expect(typeof CompactImportNode).toBe('function');
  });
});

describe('a union member knows its own domain', () => {
  const dimension = unionValue(
    [numberValue(), enumValue(['inherit'])],
    'inherit',
  );

  test('a value a member normalizes into its default is still that member', () => {
    // The ambiguous case: numberValue reads '0' as 0, which is also what it
    // returns for a value it did not recognize. Inferring membership from the
    // parse alone reads this as a fallback and skips to the next member.
    expect(dimension('0')).toBe(0);
    expect(dimension('-0')).toBe(-0);
    expect(dimension(0)).toBe(0);
    // Still not a number, so still the union's fallback.
    expect(dimension('banana')).toBe('inherit');
    expect(dimension('inherit')).toBe('inherit');
  });

  test('an alias whose target is the inner default is still that member', () => {
    // The same ambiguity one level down, and the reason an aliased schema
    // always declares `accepts`: `stringValue` declares none, so membership
    // would be inferred from a parse that lands on the default — which the
    // inference reads as "did not recognize it" — and the union would fall
    // back for a value its only member does accept.
    const legacy = aliasedValue(stringValue(), {none: ''});
    expect(legacy('none')).toBe('');
    expect(unionValue([legacy], 'fallback')('none')).toBe('');
    // A value no member accepts still falls back.
    expect(unionValue([legacy], 'fallback')(42)).toBe('fallback');
  });

  test('a comparator never sees values its own member did not produce', () => {
    // A custom isEqual is arbitrary code written for one domain, and a union
    // cannot know which member produced a value — it selects by what each
    // member *accepts*, and a transform accepts one domain and produces
    // another. So it defers to no member and compares by content, which is
    // what arrayValue and objectValue's own comparators do anyway.
    const byId = transformValue(
      objectValue({id: numberValue(), tag: stringValue()}),
      value => value,
      {isEqual: (a, b) => a.id === b.id},
    );
    const plain = objectValue({v: numberValue()});
    const union = unionValue([byId, plain]);
    expect(union.isEqual!({v: 1} as never, {v: 2} as never)).toBe(false);
    // The custom rule is not consulted, so two values it would call equal are
    // reported as different. That is the safe direction: it costs a property
    // its compaction, where the reverse would drop the difference.
    expect(
      union.isEqual!({id: 1, tag: 'a'} as never, {id: 1, tag: 'b'} as never),
    ).toBe(false);
    // And the member's own comparator is untouched outside the union.
    expect(isSchemaEqual(byId, {id: 1, tag: 'a'}, {id: 1, tag: 'b'})).toBe(
      true,
    );
  });

  test('nodeSchema rejects a name the node does not have', () => {
    class NamedNode extends ElementNode {
      __label = '';
      getLabel(): string {
        return this.getLatest().__label;
      }
      setLabel(label: string): this {
        const self = this.getWritable();
        self.__label = label;
        return self;
      }
      shouldWrite(): boolean {
        return true;
      }
    }
    // Every name resolves, so this compiles.
    const ok = nodeSchema<NamedNode>()({
      gated: withAccessors(stringValue(), {
        getter: {field: '__label', method: 'getLabel', when: 'shouldWrite'},
        // Export-only: with no `setGated` on the node, the conventional setter
        // would be a name the walk cannot resolve.
        setter: null,
      }),
      label: withField(stringValue(), {field: '__label'}),
    });
    expect(ok).toBeDefined();

    nodeSchema<NamedNode>()({
      // @ts-expect-error -- __lable is not a field of NamedNode
      label: withField(stringValue(), {field: '__lable'}),
    });
    nodeSchema<NamedNode>()({
      // @ts-expect-error -- getLabl is not a method of NamedNode
      label: withField(stringValue(), {field: '__label', getter: 'getLabl'}),
    });
    nodeSchema<NamedNode>()({
      // @ts-expect-error -- shouldWrit is not a method of NamedNode
      label: withAccessors(stringValue(), {
        getter: {field: '__label', when: 'shouldWrit'},
      }),
    });
    nodeSchema<NamedNode>()({
      // @ts-expect-error -- withField declares a predicate the same way
      label: withField(stringValue(), {field: '__label', when: 'shouldWrit'}),
    });
  });

  test('nodeSchema checks a schema the node’s own $config consumes', () => {
    // The position every real schema is written in, and the one the check was
    // switched off for. Scanning a class for the member a declaration names
    // means asking what type each member has, and `$config()`'s is inferred
    // from the very schema being checked — a cycle TypeScript answers by
    // dropping the constraint. So every `@ts-expect-error` above passed while
    // the same mistake on a real node compiled; `ScannableKeys` skips the two
    // members whose types come from the schema, and the check runs again.
    class InlineNode extends ElementNode {
      __label = '';
      getLabel(): string {
        return this.getLatest().__label;
      }
      setLabel(label: string): this {
        const self = this.getWritable();
        self.__label = label;
        return self;
      }
      shouldWrite(): boolean {
        return true;
      }
      $config() {
        return this.config('schema-inline', {
          extends: ElementNode,
          json: nodeSchema<InlineNode>()({
            // @ts-expect-error -- setLabel takes a string, not a number
            count: withAccessors(numberValue(), {setter: 'setLabel'}),
            // @ts-expect-error -- shouldWrit is not a predicate of InlineNode
            gated: withField(stringValue(), {
              field: '__label',
              when: 'shouldWrit',
            }),
            // @ts-expect-error -- __lable is not a field of InlineNode
            label: withField(stringValue(), {field: '__lable'}),
            // @ts-expect-error -- getLabl is not a method of InlineNode
            name: withAccessors(stringValue(), {getter: 'getLabl'}),
            // @ts-expect-error -- nor is setLabl
            other: withAccessors(stringValue(), {setter: 'setLabl'}),
            // A `this`-returning setter, named correctly: the obligation it
            // discharges is stated as the node's own domain rather than by
            // comparing the class against its base, which is what made a
            // schema above its class a cycle (see `SetterReturn`).
            title: withAccessors(stringValue(), {
              getter: 'getLabel',
              setter: 'setLabel',
            }),
          }),
        });
      }
    }
    // And when the schema is a binding the class refers to, which is how every
    // node in the tree spells it.
    const aboveSchema = nodeSchema<AboveNode>()({
      // @ts-expect-error -- nor is __lable a field of AboveNode
      label: withField(stringValue(), {field: '__lable'}),
    });
    class AboveNode extends ElementNode {
      __label = '';
      $config() {
        return this.config('schema-above', {
          extends: ElementNode,
          json: aboveSchema,
        });
      }
    }
    expect(typeof InlineNode).toBe('function');
  });

  test('nodeSchema rejects a name used in the wrong position', () => {
    // Every name below is a real member. What is wrong is the position it was
    // written in, which a check that only asks "does the node have this?"
    // cannot see: the walk resolves the method, calls it, and quietly does
    // something other than what was declared.
    class RoleNode extends ElementNode {
      __label = '';
      getLabel(): string {
        return this.getLatest().__label;
      }
      setLabel(label: string): this {
        const self = this.getWritable();
        self.__label = label;
        return self;
      }
      describe(): string {
        return `label=${this.__label}`;
      }
      gated(flag: boolean): boolean {
        return flag;
      }
      shouldWrite(): boolean {
        return true;
      }
    }
    // The correct positions still compile.
    expect(
      nodeSchema<RoleNode>()({
        label: withAccessors(stringValue(), {
          getter: {field: '__label', method: 'getLabel', when: 'shouldWrite'},
          setter: 'setLabel',
        }),
      }),
    ).toBeDefined();

    nodeSchema<RoleNode>()({
      // @ts-expect-error -- setLabel needs an argument the walk does not pass
      label: withField(stringValue(), {field: '__label', getter: 'setLabel'}),
    });
    nodeSchema<RoleNode>()({
      // @ts-expect-error -- getLabel takes nothing, so it cannot apply a value
      label: withField(stringValue(), {field: '__label', setter: 'getLabel'}),
    });
    nodeSchema<RoleNode>()({
      // @ts-expect-error -- describe() returns a string, not a boolean
      label: withField(stringValue(), {field: '__label', when: 'describe'}),
    });
    nodeSchema<RoleNode>()({
      // @ts-expect-error -- gated() takes an argument; a predicate takes none
      label: withField(stringValue(), {field: '__label', when: 'gated'}),
    });
  });

  test('a lookup table replaces the field check for its own direction only', () => {
    // `getterTable` maps the stored value on export and `setterTable` the parsed value
    // on import, so a table stands in for the field check in one direction
    // and leaves the other as it was. Supplying either used to withhold both:
    // a `getterTable` alone let `'token'` be written into a numeric field on
    // import, and a `setterTable` mapping to the wrong type did the same.
    class ModeNode extends ElementNode {
      __mode = 0;
    }
    class NarrowModeNode extends ElementNode {
      __mode: 0 | 1 = 0;
    }
    // Both tables, each mapping into the type its destination holds.
    expect(
      nodeSchema<ModeNode>()({
        mode: withField(enumValue(['normal', 'token']), {
          field: '__mode',
          getterTable: {0: 'normal', 1: 'token'},
          setterTable: {normal: 0, token: 1},
        }),
      }),
    ).toBeDefined();
    expect(
      nodeSchema<NarrowModeNode>()({
        mode: withField(enumValue(['normal', 'token']), {
          field: '__mode',
          // An omitted export is `undefined`, which the getterTable side admits.
          getterTable: {0: undefined, 1: 'token'},
          setterTable: {normal: 0, token: 1},
        }),
      }),
    ).toBeDefined();
    expect(
      nodeSchema<ModeNode>()({
        mode: withAccessors(enumValue(['normal', 'token']), {
          getter: {field: '__mode', getterTable: {0: 'normal', 1: 'token'}},
          setter: {field: '__mode', setterTable: {normal: 0, token: 1}},
        }),
      }),
    ).toBeDefined();

    nodeSchema<ModeNode>()({
      // @ts-expect-error -- no `setterTable`: import writes 'normal' | 'token' into a number
      mode: withField(enumValue(['normal', 'token']), {
        field: '__mode',
        getterTable: {0: 'normal', 1: 'token'},
      }),
    });
    nodeSchema<ModeNode>()({
      // @ts-expect-error -- the `setterTable` maps 'token' to a string, not a number
      mode: withField(enumValue(['normal', 'token']), {
        field: '__mode',
        getterTable: {0: 'normal', 1: 'token'},
        setterTable: {normal: 0, token: 'x'},
      }),
    });
    nodeSchema<NarrowModeNode>()({
      // @ts-expect-error -- 2 is outside the field's 0 | 1
      mode: withField(enumValue(['normal', 'token']), {
        field: '__mode',
        getterTable: {0: 'normal', 1: 'token'},
        setterTable: {normal: 0, token: 2},
      }),
    });
    nodeSchema<ModeNode>()({
      // @ts-expect-error -- the `getterTable` maps 1 to a value the schema does not serialize
      mode: withField(enumValue(['normal', 'token']), {
        field: '__mode',
        getterTable: {0: 'normal', 1: 'bogus'},
        setterTable: {normal: 0, token: 1},
      }),
    });
    nodeSchema<ModeNode>()({
      // @ts-expect-error -- the same setterTable mismatch, declared per direction
      mode: withAccessors(enumValue(['normal', 'token']), {
        getter: {field: '__mode', getterTable: {0: 'normal', 1: 'token'}},
        setter: {field: '__mode', setterTable: {normal: 0, token: 'x'}},
      }),
    });
    // A `setterTable` has to map every value the schema can produce: a parsed
    // value it does not map falls back to the encoded default, and a default
    // it does not map has no stored form at all. For a finite domain that is
    // decidable at compile time.
    nodeSchema<ModeNode>()({
      // @ts-expect-error -- 'normal', the default, has no setterTable entry
      mode: withField(enumValue(['normal', 'token']), {
        field: '__mode',
        getterTable: {0: 'normal', 1: 'token'},
        setterTable: {token: 1},
      }),
    });
    nodeSchema<ModeNode>()({
      // @ts-expect-error -- the same missing entry, declared per direction
      mode: withAccessors(enumValue(['normal', 'token']), {
        getter: {field: '__mode', getterTable: {0: 'normal', 1: 'token'}},
        setter: {field: '__mode', setterTable: {token: 1}},
      }),
    });
    // A domain the types cannot enumerate is left to registration, which
    // checks that the default is mapped.
    class CodeNode extends ElementNode {
      __code = 0;
    }
    expect(
      nodeSchema<CodeNode>()({
        code: withField(stringValue(), {
          field: '__code',
          getterTable: {0: '', 1: 'a'},
          setterTable: {'': 0, a: 1},
        }),
      }),
    ).toBeDefined();
  });

  test('nodeSchema rejects a setter that needs more than the parsed value', () => {
    class BoxNode extends ElementNode {
      __height = 0;
      __width = 0;
      getWidth(): number {
        return this.getLatest().__width;
      }
      setDimensions(width: number, height: number): this {
        const self = this.getWritable();
        self.__width = width;
        self.__height = height;
        return self;
      }
      setWidth(width: number, _options?: {quiet?: boolean}): this {
        const self = this.getWritable();
        self.__width = width;
        return self;
      }
    }
    nodeSchema<BoxNode>()({
      // @ts-expect-error -- setDimensions needs a second argument, and the walk
      // calls a setter with the parsed value alone, so `height` arrived
      // `undefined`. Matching "the first parameter of however many" accepted
      // it; the obligation is a one-parameter signature.
      width: withAccessors(numberValue(10), {
        getter: 'getWidth',
        setter: 'setDimensions',
      }),
    });
    // A trailing *optional* parameter is still callable with one argument, so
    // this stays legal — the rule is about what the walk can supply, not about
    // the arity written down.
    nodeSchema<BoxNode>()({
      width: withAccessors(numberValue(10), {
        getter: 'getWidth',
        setter: 'setWidth',
      }),
    });
  });

  test('a wrapper refuses a schema that already declares accessors', () => {
    // A wrapper changes what the schema parses, and so what its accessors are
    // handed. Rather than restate every obligation for the new value type —
    // which is what an earlier version did, and got wrong for `union` and the
    // wrappers — the wrappers simply do not take a schema that declares any:
    // an accessor belongs outside the combinator whose domain it must accept.
    // `setLabel` was otherwise still obliged to take a `string` while the
    // parser hands it `null` for a document that omits the property, so a
    // `setLabel` calling `.toUpperCase()` type-checked and threw.
    class LabelNode extends ElementNode {
      __label: null | string = '';
      getLabel(): null | string {
        return this.getLatest().__label;
      }
      setLabel(value: string): this {
        const self = this.getWritable();
        self.__label = value.toUpperCase();
        return self;
      }
      setNullableLabel(value: null | string): this {
        const self = this.getWritable();
        self.__label = value;
        return self;
      }
    }
    // Refused at compile time, and — for the caller the types do not reach —
    // at run time, by every combinator.
    refused('nullable', () =>
      // @ts-expect-error -- nullable parses an absent property to `null`
      nullable(withAccessors(stringValue(), {setter: 'setLabel'})),
    );
    refused('optional', () =>
      // @ts-expect-error -- optional parses it to `undefined`
      optional(withAccessors(stringValue(), {setter: 'setLabel'})),
    );
    refused('transformValue', () =>
      transformValue(
        // @ts-expect-error -- and a transform, to a type of its own
        withAccessors(stringValue(), {setter: 'setLabel'}),
        value => value.length,
      ),
    );
    refused('unionValue', () =>
      unionValue([
        // @ts-expect-error -- a union parses to any member's value, so a
        // setter named on one member is handed another's when that one wins
        withAccessors(stringValue(), {setter: 'setLabel'}),
        numberValue(),
      ]),
    );
    refused('arrayValue', () =>
      // @ts-expect-error -- an item names the *element*'s accessor, not the
      // array-valued property's, so this one was dropped rather than restated
      arrayValue(withAccessors(stringValue(), {setter: 'setLabel'})),
    );
    refused('aliasedValue', () =>
      // @ts-expect-error -- an alias widens only the input, but the rule is
      // one rule: every accessor is stated on the outermost schema
      aliasedValue(withAccessors(stringValue(), {setter: 'setLabel'}), {
        x: 'y',
      }),
    );
    expect(() =>
      objectValue({
        // @ts-expect-error -- a nested object's field is not the node's
        // property, so a name on one was lifted to the node and never used
        x: withAccessors(stringValue(), {setter: 'setLabel'}),
      }),
    ).toThrow('objectValue: field "x" names an accessor');
    // Declared around the wrapper rather than under it, which is the spelling
    // the docs use, the accessor is obliged to take what the property really
    // parses to — so this is the same schema, correctly stated.
    nodeSchema<LabelNode>()({
      label: withAccessors(nullable(stringValue()), {
        getter: 'getLabel',
        setter: 'setNullableLabel',
      }),
    });
    // And stated for the narrower domain, it is the node check that refuses
    // it — which is the check the whole reordering exists to reach.
    nodeSchema<LabelNode>()({
      // @ts-expect-error -- setLabel(value: string) is handed null | string
      label: withAccessors(nullable(stringValue()), {setter: 'setLabel'}),
    });
    // A field read back from a node schema's `meta` may name an accessor —
    // this one does — so its type says it may, and wrapping it again is
    // refused where it is written rather than where it runs. A cast to
    // `InnerSerializationSchemaFields` labelled every such field undeclared,
    // and `arrayValue(meta.fields.label)` compiled and threw.
    const {meta} = nodeSchema<LabelNode>()({
      label: withAccessors(nullable(stringValue()), {
        getter: 'getLabel',
        setter: 'setNullableLabel',
      }),
    });
    assert(meta.kind === 'node');
    expectTypeOf(meta.fields.label).toEqualTypeOf<AnySerializationSchema>();
    refused('arrayValue', () =>
      // @ts-expect-error -- a node schema's field may name an accessor
      arrayValue(meta.fields.label),
    );
    // And the node schema itself names them — on its fields, which is where
    // a nested one's would never be resolved from — so it is not an inner
    // either, at either level.
    const inner = nodeSchema<LabelNode>()({
      label: withAccessors(nullable(stringValue()), {
        setter: 'setNullableLabel',
      }),
    });
    // @ts-expect-error -- a node schema is declared, on its fields
    refused('optional', () => optional(inner));
    // Known exactly rather than by looking: one whose fields leave every
    // accessor to convention cannot be told from an objectValue by its shape,
    // and is refused all the same — as is a node schema nested as a field of
    // another, whose names the walk would never resolve.
    const conventional = nodeSchema<LabelNode>()({
      label: withAccessors(nullable(stringValue()), {
        getter: 'getLabel',
        setter: 'setNullableLabel',
      }),
    });
    refused('arrayValue', () => arrayValue(conventional as never));
    expect(() =>
      nodeSchema<LabelNode>()({inner: conventional as never}),
    ).toThrow('nodeSchema: field "inner" is itself a node schema');
  });

  test('nodeSchema refuses a node it cannot check', () => {
    // `keyof N` is `string | number` for a class with a string index
    // signature — and for `any` — so there is no member list to check a name
    // against. Declaring such a node unchecked would be the silent failure the
    // check exists to remove, so it is refused where the node is named.
    class IndexedNode extends ElementNode {
      [key: string]: unknown;
      __label = '';
    }
    // @ts-expect-error -- a string index signature leaves nothing to check
    nodeSchema<IndexedNode>();

    // @ts-expect-error -- and `any` is not a way around the check
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the escape hatch under test
    nodeSchema<any>();
  });

  test('nodeSchema checks the accessors a field leaves to convention', () => {
    // A field that names no accessor is applied through `set<Prop>` and read
    // through `get<Prop>`, which the walk resolves by name and the check never
    // saw: `label: stringValue()` beside a `setLabel(value: string): string`
    // compiled, and `importJSON` handed back the string.
    class StringSetterNode extends ElementNode {
      __label = '';
      getLabel(): string {
        return this.getLatest().__label;
      }
      setLabel(value: string): string {
        this.getWritable().__label = value;
        return value;
      }
    }
    nodeSchema<StringSetterNode>()({
      // @ts-expect-error -- the conventional setLabel returns a string
      label: stringValue(),
    });
    class ConventionalNode extends ElementNode {
      __count = 0;
      __label = '';
      getCount(): number {
        return this.getLatest().__count;
      }
      setCount(value: number): this {
        const self = this.getWritable();
        self.__count = value;
        return self;
      }
      getLabel(): string {
        return this.getLatest().__label;
      }
      setLabel(value: string): this {
        const self = this.getWritable();
        self.__label = value;
        return self;
      }
    }
    // Sound in both directions: nothing to report.
    expect(
      nodeSchema<ConventionalNode>()({
        count: numberValue(),
        label: stringValue(),
      }),
    ).toBeDefined();
    nodeSchema<ConventionalNode>()({
      // @ts-expect-error -- getCount returns a number, not a string
      count: stringValue(),
    });
    nodeSchema<ConventionalNode>()({
      // @ts-expect-error -- the node has neither getTitle nor setTitle
      title: stringValue(),
    });
    // A declared direction is checked as declared; the other stays
    // conventional. `null` declares a direction derived, so nothing is asked
    // of it.
    nodeSchema<ConventionalNode>()({
      label: withAccessors(stringValue(), {setter: null}),
    });
    nodeSchema<ConventionalNode>()({
      // @ts-expect-error -- the getter is declared, and the conventional
      // setLabel is handed the number this parses to
      label: withAccessors(numberValue(), {getter: 'getCount'}),
    });
  });

  test('nodeSchema rejects a setter whose return the walk cannot follow', () => {
    // The walk applies a property through the setter and continues with what
    // it returns, so a return that is not a node — or nothing — is a value it
    // would then treat as one. Only the parameter was checked, so
    // `setLabel(value: string): string` discharged the obligation and
    // `importJSON` handed back the string.
    class ReturnsNode extends ElementNode {
      __label: string = '';
      getLabel(): string {
        return this.getLatest().__label;
      }
      setLabel(value: string): this {
        const self = this.getWritable();
        self.__label = value;
        return self;
      }
      setLabelVoid(value: string): void {
        this.getWritable().__label = value;
      }
      setLabelString(value: string): string {
        this.getWritable().__label = value;
        return value;
      }
      setLabelBase(value: string): ElementNode {
        return this.setLabel(value);
      }
      setLabelMaybe(value: string): this | undefined {
        return value === '' ? undefined : this.setLabel(value);
      }
      setLabelKeyed(value: string): {__key: string} {
        return {__key: this.setLabel(value).__key};
      }
    }
    // A node — as `this`, as a base type, or perhaps — and nothing are what a
    // setter may hand back. Nothing reads it; what this rules out is a method
    // that is not a setter at all being named as one.
    nodeSchema<ReturnsNode>()({
      label: withAccessors(stringValue(), {setter: 'setLabel'}),
    });
    nodeSchema<ReturnsNode>()({
      label: withAccessors(stringValue(), {setter: 'setLabelBase'}),
    });
    nodeSchema<ReturnsNode>()({
      label: withAccessors(stringValue(), {setter: 'setLabelMaybe'}),
    });
    nodeSchema<ReturnsNode>()({
      label: withAccessors(stringValue(), {setter: 'setLabelVoid'}),
    });
    nodeSchema<ReturnsNode>()({
      // @ts-expect-error -- a string is not a node the walk can continue from
      label: withAccessors(stringValue(), {setter: 'setLabelString'}),
    });
    nodeSchema<ReturnsNode>()({
      // @ts-expect-error -- nor is a thing that merely has a key: the node is
      // stated by the brand every LexicalNode carries, not by its shape
      label: withAccessors(stringValue(), {setter: 'setLabelKeyed'}),
    });
  });

  test('nodeSchema checks a field in the direction it is used', () => {
    // One covariant obligation answered for both directions, which is wrong
    // each way: writing a `string` into a `string | number` field passed —
    // exporting `42` and parsing it back gave `''` — while reading a `true`
    // field through a `booleanValue()` schema was rejected, though widening on
    // the way out is exactly what reading allows.
    class Directional extends ElementNode {
      __flag = true as const;
      __label: string | number = '';
    }
    nodeSchema<Directional>()({
      // @ts-expect-error -- withField writes as well as reads, and a `string`
      // schema cannot promise what a `string | number` field holds
      label: withField(stringValue(), {field: '__label'}),
    });
    // Reading alone is sound: `true` is a boolean, so the export is in domain.
    nodeSchema<Directional>()({
      flag: withAccessors(booleanValue(), {
        getter: {field: '__flag'},
        setter: null,
      }),
    });
    nodeSchema<Directional>()({
      // @ts-expect-error -- but writing a `boolean` into a `true` field is not
      flag: withAccessors(booleanValue(), {setter: {field: '__flag'}}),
    });
  });

  test('nodeSchema rejects a type the node member cannot hold', () => {
    // Every name here resolves and is used in the right position. What is
    // wrong is the type behind it, which nothing checked: the parser wrote a
    // string into a numeric field, and the schema's default and equality were
    // string-shaped, so the property could never compact and nothing failed.
    class TypedNode extends ElementNode {
      __count = 0;
      __ids: readonly string[] = [];
      getCount(): number {
        return this.getLatest().__count;
      }
      setCount(count: number): this {
        const self = this.getWritable();
        self.__count = count;
        return self;
      }
      getIds(): readonly string[] {
        return this.getLatest().__ids;
      }
    }
    // The types line up, so this compiles.
    expect(
      nodeSchema<TypedNode>()({
        count: withField(numberValue(), {field: '__count'}),
        // `readonly` is a property of the reference, not of the JSON, so a
        // readonly array satisfies an arrayValue property.
        ids: withAccessors(arrayValue(stringValue()), {
          getter: 'getIds',
          setter: null,
        }),
      }),
    ).toBeDefined();

    nodeSchema<TypedNode>()({
      // @ts-expect-error -- __count holds a number, not a string
      count: withField(stringValue(), {field: '__count'}),
    });
    nodeSchema<TypedNode>()({
      // @ts-expect-error -- getCount() returns a number, not a string
      count: withAccessors(stringValue(), {getter: 'getCount'}),
    });
    nodeSchema<TypedNode>()({
      // @ts-expect-error -- setCount() takes a number, not a string
      count: withAccessors(stringValue(), {setter: 'setCount'}),
    });
  });

  test('a value table declares that the two forms differ', () => {
    // A field whose stored and serialized forms differ says so with a table,
    // and the table is that declaration — so the field is not held to the
    // schema's type. TextNode's `mode` is the in-tree case: a bitmask stored,
    // a name serialized. Without this carve-out it would fail its own check.
    const MODES = {normal: 0, segmented: 2, token: 1} as const;
    const NAMES = {0: 'normal', 1: 'token', 2: 'segmented'} as const;
    class ModeNode extends ElementNode {
      __mode: 0 | 1 | 2 = 0;
    }
    expect(
      nodeSchema<ModeNode>()({
        mode: withField(enumValue(['normal', 'token', 'segmented']), {
          field: '__mode',
          getterTable: NAMES,
          setterTable: MODES,
        }),
      }),
    ).toBeDefined();
  });

  test('each value table is declared only on the direction that reads it', () => {
    // `getterTable` is applied on export and `setterTable` on import, so naming either
    // on the other side used to type-check and then be silently ignored. They
    // are declared on the direction-specific field types now, which makes the
    // wrong pairing a compile error rather than a property that does nothing.
    const schema = withAccessors(stringValue(), {
      getter: {field: '__x', getterTable: {stored: 'serialized'}},
      setter: {field: '__x', setterTable: {serialized: 'stored'}},
    });
    expect(isSchemaField(schema.getter)).toBe(true);
    expect(isSchemaField(schema.setter)).toBe(true);
    assert(isSchemaField(schema.getter));
    assert(isSchemaField(schema.setter));
    // isSchemaField narrows to the direction it was handed, so each side sees
    // only its own table.
    expectTypeOf(schema.getter).toHaveProperty('getterTable');
    expectTypeOf(schema.setter).toHaveProperty('setterTable');
    // @ts-expect-error -- `setterTable` is the import direction's table
    withAccessors(stringValue(), {getter: {field: '__x', setterTable: {a: 1}}});
    // @ts-expect-error -- `getterTable` is the export direction's table
    withAccessors(stringValue(), {setter: {field: '__x', getterTable: {a: 1}}});
  });

  test('a wrapper carries its inner membership into the union', () => {
    // Transforming the output or admitting a nil says nothing about which
    // *inputs* the member recognizes, so every wrapper forwards `accepts` —
    // without that, ImageNode's width-or-'inherit' shape reads a stringified
    // '0' as 'inherit' the moment the member is wrapped, because '0'
    // normalizes into numberValue's own default and only `accepts` can tell
    // that apart from a fallback.
    const number = numberValue();
    // Naming an accessor says nothing about the domain either, but the two
    // that do it are a property's outermost schema rather than a member, so
    // what they have to keep is the predicate itself — copied by reference,
    // which is also how it keeps the provenance `DERIVED_ACCEPTS` records.
    expect(withAccessors(number, {getter: 'getSerializedWidth'}).accepts).toBe(
      number.accepts,
    );
    expect(withField(number, {field: '__width'}).accepts).toBe(number.accepts);

    const width = unionValue([number, enumValue(['inherit'])], 'inherit');
    expect(width('0')).toBe(0);
    expect(width(640)).toBe(640);
    expect(width('banana')).toBe('inherit');

    const transformed = unionValue(
      [transformValue(numberValue(), value => value), enumValue(['inherit'])],
      'inherit',
    );
    expect(transformed('0')).toBe(0);

    const nilable = unionValue(
      [nullable(numberValue()), enumValue(['inherit'])],
      'inherit',
    );
    expect(nilable('0')).toBe(0);

    const maybe = unionValue(
      [optional(numberValue()), enumValue(['inherit'])],
      'inherit',
    );
    expect(maybe('0')).toBe(0);
  });

  test('a union is itself a member, so nesting one keeps its domain', () => {
    // The chain has to close: a union that declared no `accepts` of its own
    // would be read by the parse-inference, which cannot tell a value it
    // normalized into its own default from a fallback — so the nested union
    // parsing '0' to 0 (its default) would be skipped entirely.
    const inner = unionValue([numberValue(), enumValue(['inherit'])], 0);
    expect(typeof inner.accepts).toBe('function');
    const outer = unionValue([inner, stringValue('zzz')], 'zzz');
    expect(outer('0')).toBe(0);
    expect(outer(640)).toBe(640);
    expect(outer('inherit')).toBe('inherit');
    // A value no member recognizes still falls through to the string member.
    expect(outer('banana')).toBe('banana');
    // And through a wrapper, which lifts the union's membership like any
    // other inner schema's.
    expect(unionValue([nullable(inner), stringValue('zzz')], 'zzz')('0')).toBe(
      0,
    );
  });

  test('optional lifts membership for undefined only, nullable for both', () => {
    // `optional` hands `null` to its inner schema rather than absorbing it, so
    // claiming to accept null would commit the union to a member that then
    // answers with the inner fallback — 0 — where the unwrapped member
    // correctly declines and the union reaches its own default.
    const bare = unionValue([numberValue(), enumValue(['inherit'])], 'inherit');
    const maybe = unionValue(
      [optional(numberValue()), enumValue(['inherit'])],
      'inherit',
    );
    expect(bare(null)).toBe('inherit');
    expect(maybe(null)).toBe('inherit');
    // nullable *does* absorb both nils, so it accepts null and yields it.
    expect(
      unionValue(
        [nullable(numberValue()), enumValue(['inherit'])],
        'inherit',
      )(null),
    ).toBe(null);
  });

  test('a union defers equality to the member that recognizes the pair', () => {
    // Without this a union over a reference-typed member compares by identity:
    // the property could never equal its default and so never compact, and as
    // a createState parse it would dirty the node on every equal write.
    const ids = unionValue([arrayValue(stringValue()), enumValue(['all'])]);
    expect(isSchemaDefault(ids, [])).toBe(true);
    expect(isSchemaDefault(ids, ['a'])).toBe(false);
    expect(isSchemaEqual(ids, ['a', 'b'], ['a', 'b'])).toBe(true);
    expect(isSchemaEqual(ids, ['a'], ['b'])).toBe(false);
    // A primitive member still compares by identity through the same path.
    expect(isSchemaEqual(ids, 'all', 'all')).toBe(true);
  });

  test('a bounded member rejects what falls outside its bounds', () => {
    const span = unionValue([numberValue(1, {integer: true, min: 1})], 1);
    expect(span('4')).toBe(4);
    expect(span('0')).toBe(1);
    expect(span('1.5')).toBe(1);
  });
});

describe('a sparse array is parsed, not passed through', () => {
  test('holes go through the item schema like any other element', () => {
    // `map` preserves holes, so the item schema would never see them and a
    // string[] property would serialize them as null.
    const schema = arrayValue(stringValue());
    const parsed = schema(new Array(3));
    expect(parsed).toEqual(['', '', '']);
    expect(0 in parsed).toBe(true);
    expect(schema(['a', 42, null])).toEqual(['a', '', '']);
  });
});

describe('objectValue refuses a __proto__ field in every build', () => {
  test('because the parse would reparent its result instead of writing it', () => {
    // A computed key, since `{__proto__: x}` in a literal sets the prototype
    // rather than creating an own property — which is the same hazard one
    // level up.
    expect(() => objectValue({['__proto__']: stringValue()})).toThrow(
      /__proto__/,
    );
    // What it prevents: `result['__proto__'] = value` invokes the inherited
    // setter, so the parse would return an object without the property it
    // declared, having reparented itself instead.
    // Through a variable, exactly as the parse assigns it: written as a
    // literal, dot-notation and no-proto rewrite and then reject it, and
    // neither is what the parse actually does.
    const key = '__proto__';
    const result: {[key: string]: unknown} = {};
    result[key] = {reparented: true};
    expect(Object.keys(result)).toEqual([]);
  });
});

describe('a schema does not take back an override the node already had', () => {
  class PlainBlock extends ElementNode {
    $config() {
      return this.config('schema-plain-block', {extends: ElementNode});
    }
    createDOM(): HTMLElement {
      return document.createElement('div');
    }
    updateDOM(): boolean {
      return false;
    }
  }
  class StyledBlock extends PlainBlock {
    $config() {
      return this.config('schema-styled-block', {extends: PlainBlock});
    }
    getTextFormat(): number {
      return IS_BOLD;
    }
    getTextStyle(): string {
      return 'color: red;';
    }
  }
  class MigratingText extends TextNode {
    $config() {
      return this.config('schema-migrating-text', {extends: TextNode});
    }
    updateFromJSON(json: LexicalUpdateJSON<SerializedTextNode>): this {
      return super.updateFromJSON(json).setStyle('color: red;');
    }
  }

  test('an overridden getTextFormat/getTextStyle still decides the export', () => {
    // ElementNode's schema reads both from `__textFormat`/`__textStyle`
    // through `getSerializedTextFormat`/`getSerializedTextStyle`. Those
    // wrappers are new; `getTextFormat`/`getTextStyle` are what a subclass has
    // always overridden, and what exportJSON called before the schema existed.
    // A field read that ignored them would export the stored 0/'' instead.
    const editor = buildEditorFromExtensions(
      defineExtension({
        name: '[root]',
        nodes: [PlainBlock, StyledBlock],
      }),
    );
    editor.update(
      () => {
        expect($create(StyledBlock).exportJSON()).toMatchObject({
          textFormat: IS_BOLD,
          textStyle: 'color: red;',
        });
        // The class that overrides nothing keeps the direct-field path, so the
        // guard costs it nothing: both are at their defaults and omitted.
        const plain = $create(PlainBlock).exportJSON() as Record<
          string,
          unknown
        >;
        expect(plain.textFormat).toBeUndefined();
        expect(plain.textStyle).toBeUndefined();
      },
      {discrete: true},
    );
    editor.dispose();
  });

  test('a synthesized importJSON calls an overridden updateFromJSON', () => {
    // The synthesized importJSON applies the schema directly, skipping the
    // getWritable() a fresh node does not need. That shortcut is only the base
    // updateFromJSON when the node has not replaced it — a node that migrates
    // an older payload there would otherwise be silently skipped on import
    // while still running everywhere else.
    const editor = buildEditorFromExtensions(
      defineExtension({name: '[root]', nodes: [MigratingText]}),
    );
    editor.update(
      () => {
        const imported = MigratingText.importJSON({
          detail: 0,
          format: 0,
          mode: 'normal',
          style: '',
          text: 'hi',
          type: 'schema-migrating-text',
          version: 1,
        });
        assert($isTextNode(imported));
        expect(imported.getStyle()).toBe('color: red;');
        expect(imported.getTextContent()).toBe('hi');
      },
      {discrete: true},
    );
    editor.dispose();
  });
});

describe('a wrapper answers for its inner schema’s domain', () => {
  test('a union picks the wrapper whose inner schema recognizes the value', () => {
    // `''` is stringValue's default, so `defaultAsNull` reads it as null — the
    // wrapper's own default. Inferring membership from *that* reads a value the
    // schema recognized as one it fell back on, and the union moves on to a
    // member whose domain does not contain it at all.
    const schema = unionValue(
      [nullable(stringValue(), {defaultAsNull: true}), enumValue(['auto'])],
      'auto',
    );
    expect(schema('')).toBe(null);
    expect(schema('left')).toBe('left');
    expect(schema('auto')).toBe('auto');
    // A value neither member's domain contains still falls back.
    expect(schema(42)).toBe('auto');
  });

  test('the same holds for optional and for a transformed domain', () => {
    const opt = unionValue(
      [optional(stringValue(), {omitDefault: true}), enumValue(['auto'])],
      'auto',
    );
    expect(opt('')).toBeUndefined();

    // The transform leaves the inner domain entirely, so inferring membership
    // from its output compares a parsed array against a string input — with the
    // caller's own comparator, which is written for arrays.
    const toArray = transformValue(stringValue(), value => value.split(','), {
      isEqual: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
    });
    const union = unionValue([toArray, enumValue(['auto'])], 'auto');
    expect(union('')).toEqual(['']);
    expect(union('a,b')).toEqual(['a', 'b']);
  });

  test('a wrapper still declines what its inner schema declines', () => {
    // The guard the unconditional `accepts` must not give up: `null` is not
    // `optional`'s nil, so it goes to `inner`, which does not recognize it —
    // and the union must reach the member that does.
    const schema = unionValue(
      [optional(numberValue()), enumValue([null])],
      null,
    );
    // `0` here would mean the optional member claimed `null` and handed it to
    // numberValue, which falls back.
    expect(schema(null)).toBe(null);
    expect(schema(7)).toBe(7);
  });
});

describe('a schema declares the domain it reads, and only that', () => {
  // `accepts` is a predicate on a schema's serialized *input*; `defaultValue`
  // is one of its parsed *values*. An earlier version had `makeSchema` OR in
  // `value === schema.defaultValue` around every declared predicate, to spare
  // each combinator from restating "a schema recognizes its own default" —
  // which conflated the two domains and cost more than it bought. These pin
  // both halves: the shapes whose predicate really was wrong, fixed where they
  // are declared, and the ones that must keep declining.

  test('a raw value validates nothing, so it declines nothing', () => {
    // Was `value !== undefined`, which read as "an absent property is not
    // mine" — but an absent property is exactly what a raw field holds when it
    // has no value. `objectValue` asks this of every declared key the input
    // carries, so one `{note: undefined}` took the whole enclosing object out
    // of a union and lost every sibling property with it.
    const raw = rawValue<string>();
    expect(raw.accepts!(undefined)).toBe(true);
    expect(raw.accepts!('hi')).toBe(true);

    const union = unionValue(
      [objectValue({note: raw, title: stringValue()}), enumValue(['auto'])],
      'auto',
    );
    expect(union({note: undefined, title: 'keep me'})).toEqual({
      note: undefined,
      title: 'keep me',
    });
  });

  test('an enum listing undefined recognizes it, when it is the default', () => {
    // The documented spelling for defaulting to `undefined`, which
    // `TableCellNode`'s `verticalAlign` uses. The parse reads `undefined` as
    // "absent" before it checks membership, so claiming it is only honest when
    // the default is `undefined` too.
    expect(enumValue([undefined, 'top']).accepts!(undefined)).toBe(true);
    // Listed but not the default: the parse answers `'top'`, so a union that
    // committed here would be handed a value it never asked for.
    expect(enumValue(['top', undefined]).accepts!(undefined)).toBe(false);
    // And a default outside the listed values is not a schema at all: every
    // parse could produce it and none could read it back.
    expect(() => enumValue(['top', 'middle'], 'unset' as 'top')).toThrow(
      'enumValue: the default value is not one of the values',
    );

    const union = unionValue(
      [
        objectValue({align: enumValue([undefined, 'top']), id: stringValue()}),
        enumValue(['auto']),
      ],
      'auto',
    );
    expect(union({align: undefined, id: 'x'})).toEqual({
      align: undefined,
      id: 'x',
    });
    // A value out of the *field's* domain costs that field, not the object:
    // `align` is coerced to the enum's default and `id` survives. Declining
    // the whole object here — which is what asking each field its `accepts`
    // used to do — threw `id` away with it.
    expect(union({align: 'sideways', id: 'x'})).toEqual({
      align: undefined,
      id: 'x',
    });
  });

  test('a constrained member still declines its own out-of-domain default', () => {
    // What `unionValue`'s docblock promises, and what the blanket escape took
    // away: a member whose `defaultValue` sits outside its own constraints is
    // saying "this value is not mine", and the union must fall through.
    expect(numberValue(0, {min: 1}).accepts!(0)).toBe(false);
    expect(
      unionValue([numberValue(0, {min: 1}), enumValue(['auto'])], 'auto')(0),
    ).toBe('auto');
    // `numberValue` is the one factory whose constraints can exclude its own
    // default; an enum with a default outside its values is refused where it
    // is written, so there is no such member to fall through.
  });

  test('a transform describes what it reads, not what it writes', () => {
    // Its default is an output, so asking whether it "accepts its own default"
    // is asking an input predicate about a value from the other side of the
    // transform. The escape answered yes and a union then handed a caller
    // `'n0'` where the member produces numbers.
    const prefixed = transformValue(numberValue(), value => `n${value}`);
    expect(prefixed.accepts!('n0')).toBe(false);
    expect(prefixed.accepts!(0)).toBe(true);
    expect(
      unionValue(
        [prefixed, aliasedValue(numberValue(), {n0: 42})],
        0 as never,
      )('n0'),
    ).toBe(42);
  });
});

describe('a catch-all is a last resort, not a mismatch', () => {
  // `rawValue` validates nothing. That makes it neutral *inside* a container —
  // nothing in the value can be out of a domain that admits everything — and a
  // last resort *as a member*, where it would otherwise win the specific pass
  // against the member that describes the data.

  test('a raw field does not veto its enclosing container', () => {
    // Answering "not a whole match" for a raw field propagated: one such
    // property took its whole object out of the first pass, so an array of
    // them was handed to an earlier `arrayValue(numberValue())` and coerced.
    expect(
      unionValue(
        [
          arrayValue(numberValue()),
          arrayValue(
            objectValue({label: stringValue(), note: rawValue<string>()}),
          ),
        ],
        [] as never,
      )([{label: 'keep label', note: 'keep note'}] as never),
    ).toEqual([{label: 'keep label', note: 'keep note'}]);

    // And a raw sibling does not disturb selection between two variants.
    expect(
      unionValue(
        [
          objectValue({note: rawValue(), tags: arrayValue(numberValue())}),
          objectValue({note: rawValue(), tags: arrayValue(stringValue())}),
        ],
        'x' as never,
      )({note: 'hi', tags: ['red', 'blue']} as never),
    ).toEqual({note: 'hi', tags: ['red', 'blue']});
  });

  test('but a union that merely contains one is not itself a catch-all', () => {
    // Treating "contains a catch-all" as "is a catch-all" skipped the whole
    // nested union in the specific pass, discarding the matches of its other
    // members along with the raw one.
    expect(
      unionValue(
        [
          arrayValue(numberValue()),
          unionValue([arrayValue(stringValue()), rawValue()], [] as never),
        ],
        [] as never,
      )(['red', '42']),
    ).toEqual(['red', '42']);
    // And the mirror, with the catch-all-bearing union declared first.
    expect(
      unionValue(
        [
          unionValue([arrayValue(numberValue()), rawValue()], [] as never),
          arrayValue(stringValue()),
        ],
        [] as never,
      )(['red', '42']),
    ).toEqual(['red', '42']);
  });

  test('and a fit earned through a catch-all ranks below a real one', () => {
    // A union that fits only because its own `rawValue()` covers the value is
    // not as good a match as a sibling that describes every part of it. Ranking
    // the two the same let the fallback win: the inner union picked its raw,
    // and "fits entirely" could not say that was how.
    expect(
      unionValue(
        [
          unionValue([numberValue(), rawValue()], 0 as never),
          arrayValue(numberValue()),
        ],
        [] as never,
      )(['42']),
    ).toEqual([42]);
    expect(
      unionValue(
        [
          unionValue([enumValue(['auto']), rawValue()], 'auto' as never),
          numberValue(),
        ],
        0 as never,
      )('640'),
    ).toBe(640);
  });

  test('and measuring a union costs one traversal, not two', () => {
    // Measuring a union used to run its selection and then re-measure the
    // member it picked, doubling the work at every level of nesting: a leaf
    // under sixteen nested unions was visited 65,535 times. The existing
    // parse-count tests miss it, because the duplication is in the membership
    // walk rather than in the parse.
    const counts: number[] = [];
    for (const depth of [4, 8, 12, 16]) {
      const base = numberValue();
      let checks = 0;
      const leaf = Object.assign((value: unknown) => base(value), {
        accepts: (value: unknown) => {
          checks++;
          return base.accepts!(value);
        },
        defaultValue: base.defaultValue,
        isEqual: base.isEqual,
        meta: base.meta,
      }) as never;
      let schema: unknown = leaf;
      let value: unknown = 1;
      for (let i = 0; i < depth; i++) {
        schema = unionValue(
          [objectValue({value: schema as never}), stringValue()],
          '' as never,
        );
        value = {value};
      }
      checks = 0;
      (schema as (v: unknown) => unknown)(value);
      counts.push(checks);
      // Linear in the nesting, with room for a constant factor — the point is
      // that it does not double per level.
      expect(checks).toBeLessThanOrEqual(depth * 4);
    }
    // And strictly so: doubling would make each step four times the last.
    expect(counts[3]).toBeLessThan(counts[0] * 8);
  });

  test('and a union field holding undefined is still the fit its members give it', () => {
    // A union's own `accepts` declines `undefined` outright when it declares a
    // fallback, mirroring its parse's early return — but its *fit* is what
    // `$bestUnionMember` picks, and `optional(numberValue())` owns `undefined`
    // entirely. Answering that field from the predicate instead took the
    // object holding it from a whole fit to a coerced one, so the sibling with
    // a `rawValue()` in the same place won and `w` was dropped. Present-with-
    // undefined is what `objectValue`'s own parse writes for an absent field.
    const width = unionValue(
      [optional(numberValue()), enumValue(['inherit'])],
      'inherit' as never,
    );
    const specific = objectValue({label: stringValue(), w: width});
    const catchAll = objectValue({label: stringValue(), w: rawValue()});
    expect(
      unionValue(
        [specific, catchAll],
        'x' as never,
      )({
        label: 'keep me',
        w: undefined,
      } as never),
    ).toEqual({label: 'keep me', w: 'inherit'});
    // From either position, so it is the fit deciding and not declaration
    // order.
    expect(
      unionValue(
        [catchAll, specific],
        'x' as never,
      )({
        label: 'keep me',
        w: undefined,
      } as never),
    ).toEqual({label: 'keep me', w: 'inherit'});
  });

  test('and nesting unions directly costs no more than that', () => {
    // The test above puts an `objectValue` between the levels, whose predicate
    // is structural and answers without descending. With unions nested
    // directly, a level whose own `accepts` is consulted re-walks everything
    // beneath it before its members are measured — which is how a membership
    // check that asked every schema's predicate, built-in ones included, made
    // this quadratic (4/8/12/16 became 14/44/90/152) while the shape above
    // stayed inside its bound.
    const counts: number[] = [];
    for (const depth of [4, 8, 12, 16]) {
      const base = numberValue();
      let checks = 0;
      const leaf = Object.assign((value: unknown) => base(value), {
        accepts: (value: unknown) => {
          checks++;
          return base.accepts!(value);
        },
        defaultValue: base.defaultValue,
        isEqual: base.isEqual,
        meta: base.meta,
      }) as never;
      let schema: unknown = leaf;
      for (let i = 0; i < depth; i++) {
        schema = unionValue([schema as never, stringValue()], '' as never);
      }
      checks = 0;
      (schema as (v: unknown) => unknown)(1);
      counts.push(checks);
      expect(checks).toBeLessThanOrEqual(depth * 4);
    }
    expect(counts[3]).toBeLessThan(counts[0] * 8);
  });

  test('but only if that member would really reach it', () => {
    // Measuring a union has to run the union's own selection, not ask whether
    // any member fits. `unionValue([arrayValue(numberValue()), rawValue()])`
    // parses `['red', '42']` with `arrayValue(numberValue())` — its first pass
    // passes over the catch-all and its second lands on the array — so the
    // enclosing object claimed a complete match through a fallback it never
    // reaches, and the sibling that owns the value never got it.
    const viaFallback = objectValue({
      tags: unionValue([arrayValue(numberValue()), rawValue()], [] as never),
    });
    expect(viaFallback({tags: ['red', '42']} as never)).toEqual({
      tags: [0, 42],
    });
    expect(
      unionValue(
        [viaFallback, objectValue({tags: arrayValue(stringValue())})],
        'x' as never,
      )({tags: ['red', '42']} as never),
    ).toEqual({tags: ['red', '42']});
  });

  test('and a catch-all inside a member is part of what that member fits', () => {
    // Choosing between members and measuring one are different questions. A
    // `union[stringValue(), rawValue()]` sitting in a field really does write
    // `[]` back unchanged, so excluding the raw there made the enclosing object
    // under-report its fit and the sibling member coerced `b` to `''`.
    expect(
      unionValue(
        [
          objectValue({a: stringValue(), b: stringValue()}),
          objectValue({
            a: stringValue(),
            b: unionValue([stringValue(), rawValue()], '' as never),
          }),
        ],
        'x' as never,
      )({a: '', b: []} as never),
    ).toEqual({a: '', b: []});
  });

  test('and a member that normalizes still wins by declaration order', () => {
    // The guide's own reason to put `numberValue` in a union: its domain
    // contains values it rewrites. Preferring a member that preserves the value
    // over one that normalizes it would take that away.
    expect(
      unionValue([numberValue(), enumValue(['inherit'])], 'inherit')('640'),
    ).toBe(640);
  });

  test('and a catch-all is one wherever it is reached from', () => {
    // Reading `meta.kind` off the member alone missed every indirect one. A
    // wrapper is transparent, and a union answers with `some`, so one raw
    // member makes the whole union claim every value — which an enclosing
    // union then preferred over the member that describes the data.
    expect(
      unionValue(
        [
          unionValue([arrayValue(numberValue()), rawValue()], [] as never),
          arrayValue(stringValue()),
        ],
        [] as never,
      )(['red', '42']),
    ).toEqual(['red', '42']);

    for (const wrapped of [
      optional(rawValue()),
      nullable(rawValue()),
      unionValue([rawValue()], undefined as never),
    ]) {
      expect(
        unionValue(
          [objectValue({id: stringValue()}), wrapped as never],
          'x' as never,
        )({id: 42} as never),
      ).toEqual({id: ''});
      // Still a catch-all, not a no-op: a value no typed member owns lands
      // here rather than on the union's default.
      expect(
        unionValue(
          [numberValue(), wrapped as never],
          0 as never,
        )({
          odd: 1,
        } as never),
      ).toEqual({odd: 1});
    }
  });

  test('but a bare raw member still comes last, and still catches', () => {
    expect(
      unionValue(
        [arrayValue(numberValue()), rawValue()],
        [] as never,
      )([1, 'x']),
    ).toEqual([1, 0]);
    // Last resort, not no resort: a value no typed member owns still lands
    // here rather than on the union's default.
    expect(
      unionValue([numberValue(), rawValue()], 0 as never)({odd: 1} as never),
    ).toEqual({odd: 1});
  });

  test('and what a union reports is the member it will actually use', () => {
    // The mirror of the test above it. There, the nested union really does
    // reach its raw — `stringValue()` declines `[]` — so reporting a fit
    // earned through a catch-all is honest. Here it does not: the array and
    // the raw rank alike once the catch-all is demoted, so declaration order
    // takes the array, and answering with the raw's rank advertised a fit the
    // union was never going to deliver. The enclosing object then beat the
    // sibling whose own `tags` matches every element, and the strings were
    // read back as numbers.
    const viaFallback = objectValue({
      note: rawValue(),
      tags: unionValue([arrayValue(numberValue()), rawValue()], [] as never),
    });
    const specific = objectValue({
      note: rawValue(),
      tags: arrayValue(stringValue()),
    });
    expect(
      unionValue(
        [viaFallback, specific],
        'x' as never,
      )({
        note: 'keep me',
        tags: ['red', '42'],
      } as never),
    ).toEqual({note: 'keep me', tags: ['red', '42']});
    // Declaration order is not what decided it: the specific member wins from
    // either position.
    expect(
      unionValue(
        [specific, viaFallback],
        'x' as never,
      )({
        note: 'keep me',
        tags: ['red', '42'],
      } as never),
    ).toEqual({note: 'keep me', tags: ['red', '42']});
  });
});

describe('a declaration means what it says', () => {
  test('an explicit undefined default is a default', () => {
    // `undefined` is in this union's domain — the `optional` member produces
    // it — so it is a default a caller may mean. Comparing the argument
    // against `undefined` rather than counting it substituted the first
    // member's, so the union defaulted to `0` and then declined the value it
    // had been told to fall back to.
    const declared = unionValue(
      [numberValue(), optional(stringValue())],
      undefined,
    );
    expect(declared.defaultValue).toBeUndefined();
    // And omitting it still falls back to the first member's, as documented.
    expect(
      unionValue([numberValue(), optional(stringValue())]).defaultValue,
    ).toBe(0);
  });

  test('a union names nothing, so no member can overrule another', () => {
    // A union used to carry its first member's accessor names. `setter: null`
    // means *derived*, not *unset*, and scanning past the first member for one
    // that named something let a later member's `null` win over an earlier
    // member's conventional `set<Prop>` — which `compileSetters` then skipped
    // entirely, making the whole property unreadable and unwritable. Nothing
    // is carried up now: a member that names one is refused, at compile time
    // and — for the caller the types do not reach — at run time, and the
    // accessors belong to the property, which is the schema that wraps the
    // union.
    refused('unionValue', () =>
      unionValue([
        stringValue(),
        // @ts-expect-error -- a `null` is a declaration too
        withAccessors(numberValue(), {setter: null}),
      ]),
    );
    const union = unionValue([stringValue(), numberValue()]);
    expect(union.setter).toBeUndefined();
    expect(withAccessors(union, {setter: null}).setter).toBeNull();
  });

  test('a default a caller owns is not frozen', () => {
    // `transformValue` returns whatever its transform did, possibly a module
    // constant the caller uses elsewhere — which is why it passes its default
    // explicitly rather than letting one be derived and frozen. An enclosing
    // `objectValue` derives *its* default, which holds that same object, and
    // the recursive freeze reached it.
    const shared = {cols: 2};
    objectValue({
      layout: transformValue(numberValue(), () => shared, {
        isEqual: (a, b) => a === b,
      }),
    });
    expect(Object.isFrozen(shared)).toBe(false);
    // What the schema derived for itself is still frozen.
    expect(Object.isFrozen(objectValue({n: numberValue()}).defaultValue)).toBe(
      true,
    );
  });
});

describe('a container schema answers for its shape, not its contents', () => {
  // `accepts` says whether a member could parse the value at all; whether the
  // contents *fit* is the whole-match question. Asking one predicate both
  // questions is what made every previous adjustment trade one loss for
  // another — an object that inspected its fields declined the very value it
  // had written, exactly as an array that inspected its elements did.

  test('but a declared predicate still says which values are its own', () => {
    // The built-in containers' `accepts` is the structural test and nothing
    // more, so the walk reproducing it changed no answer — and that is why
    // dropping the call went unnoticed. A schema that carries container
    // metadata and states a *narrower* domain had its predicate skipped
    // entirely: the fields alone decided, and since it declares the same two
    // fields as the general shape, it won a value it had said was not its own
    // and its parse replaced both with its default.
    const fields = {kind: stringValue(), text: stringValue()};
    const special = Object.assign(
      (_value: unknown) => ({kind: 'special', text: ''}),
      {
        accepts: (value: unknown) =>
          typeof value === 'object' &&
          value !== null &&
          (value as {kind?: unknown}).kind === 'special',
        defaultValue: {kind: 'special', text: ''},
        meta: {fields, kind: 'object'},
      },
    ) as never;
    const general = objectValue(fields);
    const parse = unionValue([special, general], 'x' as never);
    expect(parse({kind: 'ordinary', text: 'keep me'} as never)).toEqual({
      kind: 'ordinary',
      text: 'keep me',
    });
    // And it still wins the values it did claim.
    expect(parse({kind: 'special', text: 'anything'} as never)).toEqual({
      kind: 'special',
      text: '',
    });
  });

  // Not only the containers. Every case of `$fitOf` answers from the metadata
  // — an array's items, an object's fields, a wrapper's inner schema, a
  // union's members, a raw's nothing-at-all — which describes what the
  // *combinator* admits, not what a schema built on top of one narrowed that
  // to. Each of these carries a base's metadata and a predicate admitting only
  // `#`-prefixed strings, and parses one to upper case so that *which* member
  // a union picked is visible in the answer: a base that merely forwards its
  // input returns what the plain `stringValue()` sibling returns, and the
  // assertion then holds whichever member won.
  test.each([
    ['raw', rawValue()],
    ['nullable', nullable(stringValue())],
    ['optional', optional(stringValue())],
    ['transform', transformValue(stringValue(), value => value)],
    ['aliased', aliasedValue(stringValue(), {'#alias': '#aliased'})],
    ['union', unionValue([stringValue(), numberValue()], '' as never)],
  ])(
    'but a declared predicate still says which values are its own: %s',
    (_kind, base) => {
      const accepts = (value: unknown) =>
        typeof value === 'string' && value.startsWith('#');
      const tagged = Object.assign(
        (value: unknown) =>
          accepts(value) ? String(value).toUpperCase() : base.defaultValue,
        base,
        {accepts},
      ) as never;
      const parse = unionValue([tagged, stringValue()], '' as never);
      // Declined, so the sibling that does describe it keeps it verbatim.
      expect(parse('ordinary')).toBe('ordinary');
      // Claimed, so its own parse runs — which is what makes this observable.
      expect(parse('#tag')).toBe('#TAG');
    },
  );

  test('and naming an accessor on one neither silences it nor its original', () => {
    // `withAccessors` is the one place a predicate is forwarded rather than
    // authored, and the record of which predicates a combinator derived is
    // keyed by function identity — so claiming a forwarded one as derived
    // silenced it on the copy *and*, because the two share the function, on
    // the schema it came from. Naming an accessor retroactively changed how an
    // already-built union parsed.
    const accepts = (value: unknown) =>
      typeof value === 'string' && value.startsWith('#');
    const base = nullable(stringValue());
    const tagged = Object.assign(
      (value: unknown) =>
        accepts(value) ? String(value).toUpperCase() : base.defaultValue,
      base,
      {accepts},
    ) as never;
    const original = unionValue([tagged, stringValue()], '' as never);
    expect(original('ordinary')).toBe('ordinary');
    // Building the copy must not change the schema it was copied from.
    const named = withAccessors(tagged, {setter: 'setLabel'});
    expect(original('ordinary')).toBe('ordinary');
    // And the copy keeps the predicate as the author's: it is the same
    // function, and still not one a combinator derived — which is what a
    // container asks through `declaredAccepts` before trusting the metadata.
    expect(named.accepts).toBe(accepts);
    expect(declaredAccepts(named)).toBe(accepts);
    expect(declaredAccepts(tagged)).toBe(accepts);
  });

  test('and a predicate wider than its metadata is not overruled by it', () => {
    // The other direction. A schema over `arrayValue` whose parse also reads
    // the comma-separated spelling an older version wrote claims `'a,b'`, but
    // the case's own `Array.isArray` decided first and reported no fit — so a
    // union declined the member that owns the value and fell to its fallback.
    const items = arrayValue(stringValue());
    const legacy = Object.assign(
      (value: unknown) =>
        typeof value === 'string' ? value.split(',') : items(value),
      items,
      {
        accepts: (value: unknown) =>
          Array.isArray(value) || typeof value === 'string',
      },
    ) as never;
    expect(
      unionValue([legacy, numberValue()], 0 as never)('a,b' as never),
    ).toEqual(['a', 'b']);
    // The metadata still decides for a value the predicate does not claim.
    expect(unionValue([legacy, numberValue()], 0 as never)(7 as never)).toBe(7);
  });

  test('and that holds for a wrapper or a union, not just a container', () => {
    // The rule is stated once, above the switch, so every kind gets it. Per
    // case, only `array` and `object` had it: an `optional` that also reads a
    // legacy spelling had its metadata overrule the claim, `$fitOf` reported
    // no fit for a value the schema really does parse, and the union fell to
    // its fallback rather than handing the value to the member that owns it.
    const accepts = (value: unknown) =>
      value === undefined || typeof value === 'number' || value === 'inherit';
    for (const base of [
      optional(numberValue()),
      unionValue([numberValue()], 0 as never),
    ]) {
      const width = Object.assign(
        (value: unknown) => (value === 'inherit' ? 'inherit' : base(value)),
        base,
        {accepts},
      ) as never;
      const parse = unionValue([width, enumValue(['auto'])], 'auto' as never);
      expect(parse('inherit')).toBe('inherit');
      // And a value it does not claim still goes to the sibling.
      expect(parse('auto')).toBe('auto');
    }
  });

  test('an object with a transform field round-trips', () => {
    // The field's `accepts` describes the transform's *input*; the document
    // holds its *output*, so asking cost the whole object on reload.
    const shape = objectValue({
      title: stringValue(),
      v: transformValue(numberValue(), value => `n${value}`),
    });
    expect(
      unionValue(
        [shape, enumValue(['LOST'])],
        'LOST' as never,
      )({
        title: 'keep me',
        v: 'n5',
      } as never),
    ).toEqual({title: 'keep me', v: 'n0'});
  });

  test('and one whose field declines its own default', () => {
    expect(
      unionValue(
        [
          objectValue({label: stringValue(), n: numberValue(0, {min: 1})}),
          enumValue(['auto']),
        ],
        'auto',
      )(JSON.parse('{"label":"keep me","n":0}')),
    ).toEqual({label: 'keep me', n: 0});
  });

  test('and a nested object that gained a key keeps its siblings', () => {
    // Forward compatibility: a document written by a newer version, read by an
    // older one. The unknown key is dropped by the parse, not paid for by the
    // whole document.
    expect(
      unionValue(
        [
          objectValue({
            item: objectValue({id: stringValue()}),
            title: stringValue(),
          }),
          enumValue(['auto']),
        ],
        'auto',
      )({item: {extra: 1, id: 'a'}, title: 'T'} as never),
    ).toEqual({item: {id: 'a'}, title: 'T'});
  });

  test('while the strict pass still tells the variants apart', () => {
    expect(
      unionValue(
        [objectValue({x: numberValue()}), objectValue({y: numberValue()})],
        'none' as never,
      )({y: 1}),
    ).toEqual({y: 1});
  });
});

describe('a strict match never claims what the schema itself declines', () => {
  // The first pass is a *strengthening* of `accepts`, not a second opinion:
  // it asks the lenient predicate first, so every guard that one carries
  // applies, and a schema that says "not mine" is never handed the value.

  test('so a union and its own accepts cannot disagree', () => {
    const inner = unionValue(
      [optional(numberValue()), enumValue(['auto'])],
      'auto' as never,
    );
    const shape = objectValue({title: stringValue(), x: inner});
    const value = {title: 't', x: undefined};
    const outer = unionValue([shape, enumValue(['none'])], 'none' as never);
    // The invariant, not a particular answer: `accepts` and the parse agree.
    // The strict pass used to be *more* permissive than the lenient one here,
    // so `accepts` said no while the parse committed to that member — and a
    // container asking `accepts` then discarded a value the union owned.
    const accepted = shape.accepts!(value);
    expect(outer(value)).toEqual(accepted ? shape(value as never) : 'none');
    // Which of the two it is may change as the domain rules do; that the two
    // halves cannot disagree is what this pins.
    expect(typeof accepted).toBe('boolean');
  });

  test('and wrapping a member does not change the union’s answer', () => {
    // `optional` around a non-nil value is a no-op, so it must not decide
    // membership. Each wrapper now forwards to `inner` except for the nil it
    // owns; treating all three alike made a `null` a whole match for an
    // `optional` without `inner` ever being asked.
    const member = objectValue({
      note: unionValue([optional(numberValue()), stringValue()], 0 as never),
      title: stringValue(),
    });
    const value = {note: undefined, title: 'keep me'};
    const answers = [
      member,
      optional(member),
      nullable(member),
      transformValue(member, x => x),
    ].map(m =>
      unionValue([m as never, enumValue(['LOST'])], 'LOST' as never)(value),
    );
    expect(new Set(answers.map(a => JSON.stringify(a))).size).toBe(1);
  });

  test('and a schema carrying no meta is asked, not walked', () => {
    // The interface is public and `makeSchema` is not exported, so a
    // hand-rolled schema is how a consumer adds one — and reading `meta.kind`
    // off it threw where the parse used to work.
    const handRolled = Object.assign((value: unknown) => value, {
      accepts: () => false,
      defaultValue: 0,
    }) as never;
    expect(unionValue([handRolled, stringValue()], 'x' as never)('hi')).toBe(
      'hi',
    );
    // And a `meta` whose payload is missing or malformed however the type is
    // declared — a hand-rolled schema has opted out of the type, so the walk
    // reads through it defensively and falls back to what `accepts` said.
    for (const meta of [
      undefined,
      null,
      {kind: 'object'},
      {kind: 'union'},
      {kind: 'array'},
      {kind: 'nullable'},
      {kind: 'aliased'},
      {kind: 'someFutureKind'},
    ]) {
      const partial = Object.assign((value: unknown) => value, {
        accepts: () => true,
        defaultValue: 0,
        meta,
      }) as never;
      expect(() =>
        unionValue([partial, stringValue()], 'x' as never)({a: 1} as never),
      ).not.toThrow();
    }
    // A key out of untrusted JSON is not read as a field schema.
    const permissive = Object.assign((value: unknown) => value, {
      accepts: () => true,
      defaultValue: 0,
      meta: {fields: {a: stringValue()}, kind: 'object'},
    }) as never;
    expect(() =>
      unionValue(
        [permissive, stringValue()],
        'x' as never,
      )(JSON.parse('{"toString":1}')),
    ).not.toThrow();
  });

  test('and a union recognizes the value it defaults to', () => {
    // The clause `enumValue` got and `unionValue` did not: a union whose
    // fallback is `undefined` parses `undefined` to `undefined`, so declining
    // it is a schema refusing its own output — and an `objectValue` holding an
    // absent union-typed field then declined the object it had just produced.
    const u = unionValue(
      [optional(stringValue()), numberValue()],
      undefined as never,
    );
    expect(u.accepts!(undefined)).toBe(true);
    const shape = objectValue({note: u, title: stringValue()});
    expect(shape.accepts!(shape({title: 'x'} as never))).toBe(true);
    expect(
      unionValue([shape, enumValue(['LOST'])], 'LOST' as never)({title: 'x'}),
    ).toEqual({note: undefined, title: 'x'});
  });
});

describe('an array schema keeps what it can rather than falling back', () => {
  test('one malformed element does not discard the good ones', () => {
    // Asking `every` cost the whole array where the parse would have coerced a
    // single element — and through an enclosing object, every sibling property
    // with it.
    expect(
      unionValue(
        [arrayValue(stringValue()), enumValue(['none'])],
        'none',
      )(['a', 1]),
    ).toEqual(['a', '']);

    const shape = objectValue({
      label: stringValue(),
      tags: arrayValue(numberValue()),
    });
    expect(
      unionValue(
        [shape, enumValue(['auto'])],
        'auto',
      )(JSON.parse('{"label":"keep me","tags":[1,null]}')),
    ).toEqual({label: 'keep me', tags: [1, 0]});
  });

  test('an array no element of which matches keeps its enclosing object', () => {
    // The half the `some` form missed: asking the elements at all meant an
    // array with nothing in the item domain was refused, and because
    // `objectValue` asks each declared field, the refusal took the whole
    // object — a legacy document whose array holds the pre-migration element
    // type lost every sibling property with it.
    const shape = objectValue({
      label: stringValue(),
      tags: arrayValue(numberValue()),
    });
    expect(
      unionValue(
        [shape, enumValue(['auto'])],
        'auto',
      )(JSON.parse('{"label":"keep me","tags":["banana"]}')),
    ).toEqual({label: 'keep me', tags: [0]});

    // The same refusal hit an element carrying a key a newer version added,
    // which is the shape schema evolution is supposed to survive.
    const doc = objectValue({
      items: arrayValue(objectValue({id: stringValue()})),
      title: stringValue(),
    });
    expect(
      unionValue(
        [doc, enumValue(['auto'])],
        'auto',
      )({
        items: [{extra: 1, id: 'a'}],
        title: 'T',
      } as never),
    ).toEqual({items: [{id: 'a'}], title: 'T'});

    // And an array over a transform, whose elements on disk are the
    // transform's *outputs* while the item's domain is the inner *input* — so
    // it declined the very array it had written, one reload later.
    const rows = arrayValue(transformValue(numberValue(), v => `n${v}`));
    expect(
      unionValue([rows, enumValue(['none'])], 'none' as never)(['n1', 'n2']),
    ).toEqual(['n0', 'n0']);
  });

  test('and a catch-all member never outranks one that owns the value', () => {
    // `rawValue` validates nothing, so it accepts everything — which made it a
    // *complete* match for every value and let it win the first pass ahead of
    // a typed member that would have coerced. The value then reached a setter
    // declared `number[]` holding a string.
    expect(
      unionValue(
        [arrayValue(numberValue()), rawValue()],
        [] as never,
      )([1, 'x']),
    ).toEqual([1, 0]);
    expect(rawValue().accepts!('anything')).toBe(true);
  });

  test('an absent element says nothing either way', () => {
    // A hole is filled from the item's own default exactly as `objectValue`
    // fills an absent field, so an array of nothing else has nothing to
    // contradict — as the empty array has nothing to contradict.
    expect(arrayValue(stringValue()).accepts!(new Array(2))).toBe(true);
    expect(arrayValue(stringValue()).accepts!([undefined])).toBe(true);
    expect(arrayValue(stringValue()).accepts!([])).toBe(true);
  });

  test('a complete match beats a partial one, whichever comes first', () => {
    // A container answers "mine" for a value it would only partly coerce, so
    // the first accepting member is not always the member the value belongs
    // to. `'42'` is a number spelled as a string, which made `['red', '42']`
    // look like an array of numbers — and `'red'` was coerced away.
    expect(
      unionValue(
        [arrayValue(numberValue()), arrayValue(stringValue())],
        [] as never,
      )(['red', '42']),
    ).toEqual(['red', '42']);

    // The same shape as a NodeState value: two object variants where one is
    // the other plus an optional property. Saving a plain tag beside a
    // coloured one and reading it back dropped the colour, because the plain
    // variant accepted the array on the strength of its first element.
    const tags = unionValue(
      [
        arrayValue(objectValue({label: stringValue()})),
        arrayValue(
          objectValue({color: optional(stringValue()), label: stringValue()}),
        ),
      ],
      [] as never,
    );
    expect(tags([{label: 'a'}, {color: 'red', label: 'b'}] as never)).toEqual([
      {label: 'a'},
      {color: 'red', label: 'b'},
    ]);
  });

  test('and still picks the variant whose items match', () => {
    // The selection this predicate exists for, undamaged by the leniency:
    // nothing in these arrays is in the other member's item domain.
    expect(
      unionValue(
        [arrayValue(numberValue()), arrayValue(stringValue())],
        [] as never,
      )(['red', 'blue']),
    ).toEqual(['red', 'blue']);
    expect(
      unionValue(
        [
          arrayValue(objectValue({x: numberValue()})),
          arrayValue(objectValue({y: numberValue()})),
        ],
        [] as never,
      )([{y: 1}]),
    ).toEqual([{y: 1}]);
    // Through an enclosing object too — the strict pass is what declines here,
    // not the array's own `accepts`, which stays permissive on purpose.
    expect(
      unionValue(
        [
          objectValue({tags: arrayValue(numberValue())}),
          objectValue({tags: arrayValue(stringValue())}),
        ],
        'none' as never,
      )({tags: ['red', 'blue']}),
    ).toEqual({tags: ['red', 'blue']});
  });
});

describe('a union compares by content, not by a member’s comparator', () => {
  // The transform leaves the string domain entirely, so nothing about what the
  // member accepts says anything about the arrays it produces.
  const toArray = transformValue(stringValue(), value => value.split(','), {
    isEqual: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]),
  });

  test('a transformed output compares by content', () => {
    const union = unionValue([toArray], ['']);
    // Two equal arrays, from two parses, are the same value. Falling back to
    // identity here reports every parse as a change.
    expect(isSchemaEqual(union, union('a,b'), union('a,b'))).toBe(true);
    expect(isSchemaEqual(union, union('a,b'), union('a,c'))).toBe(false);
  });

  test('through nullable and optional, whose default is a nil', () => {
    // A wrapper's default is `null`/`undefined`, so nothing about it describes
    // the arrays the member underneath produces.
    for (const member of [nullable(toArray), optional(toArray)]) {
      const union = unionValue([member], null as never);
      expect(isSchemaEqual(union, ['a', 'b'], ['a', 'b'])).toBe(true);
      expect(isSchemaEqual(union, ['a', 'b'], ['a', 'c'])).toBe(false);
    }
  });

  test('so a wrapper around it can still recognize its own default', () => {
    // `omitDefault` asks the inner schema whether the parse *is* the default,
    // which for a union is that comparison. Without it `''` parses to the
    // default array and is written out as one anyway.
    const schema = optional(unionValue([toArray], ['']), {omitDefault: true});
    expect(schema('')).toBeUndefined();
    expect(schema('a,b')).toEqual(['a', 'b']);
  });

  test('and two members’ values are never confused for each other', () => {
    // The failure a shape test could not rule out: an id comparator handed two
    // plain strings reads two `undefined` ids and calls them equal, and equal
    // is the answer that discards an update.
    const toIds = transformValue(
      stringValue(),
      value => value.split(',').map(id => ({id: Number(id)})),
      {
        isEqual: (a, b) =>
          a.length === b.length && a.every((x, i) => x.id === b[i].id),
      },
    );
    const union = unionValue([toIds, arrayValue(stringValue())], []);
    expect(isSchemaEqual(union, ['red'], ['blue'])).toBe(false);
    expect(isSchemaEqual(union, ['red'], ['red'])).toBe(true);
    // Same key count, different property types — the other way a shape test
    // sent values to a comparator written for something else.
    const byId = transformValue(
      objectValue({id: numberValue(), tag: stringValue()}),
      value => value,
      {isEqual: (a, b) => a.id === b.id},
    );
    const numeric = unionValue(
      [byId, objectValue({id: numberValue(), tag: numberValue()})],
      {id: 0, tag: 0},
    );
    expect(isSchemaEqual(numeric, {id: 1, tag: 5}, {id: 1, tag: 9})).toBe(
      false,
    );
  });

  test('a value with its own prototype compares by identity', () => {
    // Own keys do not describe what a Map carries, so content equality has
    // nothing to say and identity is the honest answer.
    const union = unionValue([rawValue<unknown>()], null);
    const map = new Map([['a', 1]]);
    expect(isSchemaEqual(union, map, map)).toBe(true);
    expect(isSchemaEqual(union, map, new Map([['a', 1]]))).toBe(false);
  });
});

describe('an object schema answers only for its own shape', () => {
  const point = objectValue({x: numberValue()});
  const label = objectValue({label: stringValue()});
  const union = unionValue([point, label]);

  test('a union falls through to the variant whose keys match', () => {
    // Accepting every object would let the first variant answer for all of
    // them: `{label: 'hello'}` would read as `{x: 0}`, losing the property —
    // and as a flat NodeState that parse equals the default, so exporting
    // drops the state entirely.
    expect(union({label: 'hello'} as never)).toEqual({label: 'hello'});
    expect(union({x: 5} as never)).toEqual({x: 5});
  });

  test('and declines what belongs to neither', () => {
    // An out-of-domain value for a declared key, an array, a string: none is
    // either variant's, so the union falls back rather than committing.
    for (const value of [{x: 'banana'}, [1, 2], 'str']) {
      expect(union(value as never)).toEqual(union.defaultValue);
    }
  });

  test('an empty object belongs to every variant', () => {
    // Every field is optional on the way in, so `{}` is in the domain — and it
    // is a shape an object schema produces, since one whose fields are all
    // `optional({omitDefault})` serializes to `{}`. The first variant answers,
    // as it does for anything two members both accept.
    expect(union({} as never)).toEqual({x: 0});
  });

  test('which is what lets a nested empty object survive a round trip', () => {
    // The check recurses, so rejecting `{}` took the enclosing object with it:
    // this parsed to `'auto'`, losing `label` outright.
    const nested = unionValue([
      enumValue(['auto']),
      objectValue({
        label: stringValue(),
        options: objectValue({
          color: optional(stringValue(), {omitDefault: true}),
        }),
      }),
    ]);
    const parsed = nested({label: 'hello', options: {color: ''}} as never);
    expect(parsed).toEqual({label: 'hello', options: {color: undefined}});
    // What JSON.stringify leaves of it, reparsed.
    expect(nested(JSON.parse(JSON.stringify(parsed)))).toEqual({
      label: 'hello',
      options: {color: undefined},
    });
  });

  test('membership is the same question the parse asks', () => {
    expect(point.accepts!({x: 1})).toBe(true);
    expect(point.accepts!({label: 'hello'})).toBe(false);
    expect(point.accepts!({label: 'hello', x: 1})).toBe(false);
    // In the domain: a parse fills what is missing.
    expect(point.accepts!({})).toBe(true);
    expect(point.accepts!([])).toBe(false);
  });
});

describe('a value is parsed once per traversal', () => {
  // Deciding which member or field a value belongs to used to go through the
  // parse, so a nested value was read once to decide and again to keep it —
  // compounding, since each level asked the same of the one below. Ten levels
  // of unionValue/objectValue reached 59,049 parses of a single leaf.
  let parses = 0;
  const leaf = () =>
    transformValue(stringValue(), value => {
      parses++;
      return value;
    });

  function count(schema: (json: unknown) => unknown, value: unknown): number {
    parses = 0;
    schema(value);
    return parses;
  }

  test('through an object, a union, and the wrappers', () => {
    expect(count(objectValue({a: leaf()}), {a: 'x'})).toBe(1);
    expect(
      count(unionValue([enumValue(['auto']), objectValue({a: leaf()})]), {
        a: 'x',
      }),
    ).toBe(1);
    expect(count(nullable(objectValue({a: leaf()})), {a: 'x'})).toBe(1);
    expect(
      count(optional(unionValue([objectValue({a: leaf()})])), {a: 'x'}),
    ).toBe(1);
    expect(count(aliasedValue(objectValue({a: leaf()}), {}), {a: 'x'})).toBe(1);
  });

  test('once per element of an array, not once per element per element', () => {
    expect(count(arrayValue(leaf()), ['a', 'b', 'c'])).toBe(3);
  });

  test('and stays linear as unions nest', () => {
    let schema: unknown = objectValue({a: leaf()});
    let value: unknown = {a: 'x'};
    for (let i = 0; i < 10; i++) {
      schema = unionValue([
        enumValue(['auto']),
        objectValue({inner: schema as never}),
      ]);
      value = {inner: value};
    }
    expect(count(schema as never, value)).toBe(1);
  });
});

describe('a compact document relaxes at every depth', () => {
  test('a nested element carries its own children', () => {
    // The outer type is refinable — you know what you asked for — and its
    // children are not: a node cannot declare what kind of children it takes,
    // so any node may appear under any element. Naming them
    // `SerializedPartial<SerializedLexicalNode>` said only what every node has,
    // which left a nested element unable to carry the children it does have.
    const compact: SerializedPartial<SerializedElementNode> = {
      children: [
        {
          children: [{type: 'text'}],
          type: 'paragraph',
        },
      ],
      type: 'root',
    };
    expect(compact.children).toHaveLength(1);
    expect(compact.children?.[0].children).toHaveLength(1);
  });

  test('and the whole document does', () => {
    const state: CompactSerializedEditorState = {
      root: {children: [{type: 'paragraph'}], type: 'root'},
    };
    expect(state.root.children).toHaveLength(1);
  });

  test('and a declared interface reaches the parse entry point', () => {
    // An interface gets no implicit index signature in TypeScript, so a real
    // serialized type extending another was not assignable to a type that has
    // one — and the index signature is what keeps a document writable as a
    // literal. The parameter names both, so each form is checked against the
    // member it fits.
    interface SerializedCustomText extends SerializedTextNode {
      tag: string;
    }
    const declared: SerializedCustomText = {
      detail: 0,
      format: 0,
      mode: 'normal',
      style: '',
      tag: 'x',
      text: 'hi',
      type: 'text',
      version: 1,
    };
    // Plain assignments to the members the parse entry point names, so a
    // regression reads as "not assignable" rather than as a failed constraint
    // on a matcher's type argument — and each form is stated against the
    // member it is meant to fit rather than against the whole union.
    const fromInterface: ParsableSerializedNode = declared;
    // And a literal carrying node data still goes through, at any depth.
    const fromLiteral: SerializedPartialNode = {
      children: [{text: 'hi', type: 'text'}],
      type: 'paragraph',
    };
    expect(fromInterface.type).toBe('text');
    expect(fromLiteral.type).toBe('paragraph');
  });

  test('a child property is unknown until it is narrowed', () => {
    // There is no type to read a child's own properties from, so they arrive
    // as `unknown` rather than as a promise the value may not keep — and a
    // document stays writable as a literal, which closing the type took away.
    expectTypeOf<SerializedPartialNode['text']>().toEqualTypeOf<unknown>();
    // What every node does have keeps its type, at every depth.
    expectTypeOf<SerializedPartialNode['type']>().toEqualTypeOf<string>();
    expectTypeOf<SerializedPartialNode['children']>().toEqualTypeOf<
      SerializedPartialNode[] | undefined
    >();
    // And a child really can carry a node's own data, which is the whole point
    // of a compact document being something you can write down.
    const doc: SerializedPartial<SerializedElementNode> = {
      children: [{children: [{text: 'hi', type: 'text'}], type: 'paragraph'}],
      type: 'root',
    };
    expect(doc.children?.[0].children).toHaveLength(1);
  });
});

describe('an array schema answers only for its own element domain', () => {
  test('a union falls through to the array variant whose items match', () => {
    // "Is an array" is true of every array, so the first array-typed member
    // would otherwise answer for all of them and coerce the elements into its
    // own item domain — losing the data the later member describes exactly.
    const union = unionValue([
      arrayValue(numberValue()),
      arrayValue(stringValue()),
    ]);
    expect(union(['red', 'blue'] as never)).toEqual(['red', 'blue']);
    expect(union([1, 2] as never)).toEqual([1, 2]);

    const objects = unionValue([
      arrayValue(objectValue({x: numberValue()})),
      arrayValue(objectValue({y: numberValue()})),
    ]);
    expect(objects([{y: 1}] as never)).toEqual([{y: 1}]);
  });

  test('and an enclosing object still picks the variant its items fit', () => {
    // An array schema's own `accepts` is deliberately just "is an array": it
    // answers "could this member coerce the value at all", and declining
    // there cost the whole enclosing object rather than one element. Telling
    // two array variants apart is the *strict* question, which the union asks
    // first — so the selection this guards still happens, one level up.
    const strings = objectValue({tags: arrayValue(stringValue())});
    const numbers = objectValue({tags: arrayValue(numberValue())});
    expect(strings.accepts!({tags: [1, 2]})).toBe(true);
    expect(
      unionValue([numbers, strings], 'none' as never)({tags: ['a', 'b']}),
    ).toEqual({tags: ['a', 'b']});
    expect(
      unionValue([strings, numbers], 'none' as never)({tags: [1, 2]}),
    ).toEqual({tags: [1, 2]});
    // And a value neither variant owns outright is still coerced by the first
    // that can take it, rather than discarded.
    expect(strings({tags: [1, 2]})).toEqual({tags: ['', '']});
  });

  test('an empty array belongs to every array schema', () => {
    // No element to disagree about, and it is a shape every array parse
    // produces.
    expect(arrayValue(numberValue()).accepts!([])).toBe(true);
    expect(arrayValue(objectValue({x: numberValue()})).accepts!([])).toBe(true);
  });
});
