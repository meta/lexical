/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {nodeArbitrary} from '@lexical/fast-check';
import * as fc from 'fast-check';
import {
  $getState,
  aliasedValue,
  arraySetValue,
  arrayValue,
  createEditor,
  createState,
  ElementNode,
  enumValue,
  getComposedSchemaFields,
  getStaticNodeConfig,
  type Klass,
  type LexicalNode,
  type LexicalSchemaInput,
  nodeSchema,
  nullable,
  numberValue,
  ParagraphNode,
  type SerializedElementNode,
  type SerializedLexicalNode,
  type SerializedPartial,
  type Spread,
  stringValue,
  TextNode,
  transformValue,
  withField,
} from 'lexical';
import {describe, expect, expectTypeOf, test} from 'vitest';

type SerializedMergeNode = Spread<
  {variant: 'a' | 'b' | 'c'},
  SerializedElementNode
>;

const mergeNodeSchema = nodeSchema<MergeNode>()({
  variant: enumValue(['a', 'b', 'c']),
});

// A custom element node that declares its OWN schema field; composeNodeSerializationSchema
// must merge it with the schema it inherits from the abstract ElementNode base.
// It carries no static or JSON boilerplate: `$config` synthesizes
// getType/clone/importJSON, afterCloneFrom copies the property, and the base
// updateFromJSON applies `variant` through setVariant via the schema.
class MergeNode extends ElementNode {
  __variant: 'a' | 'b' | 'c' = 'a';
  $config() {
    return this.config('merge-test', {
      extends: ElementNode,
      json: mergeNodeSchema,
    });
  }
  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__variant = prevNode.__variant;
  }
  exportJSON(): SerializedMergeNode {
    return {...super.exportJSON(), variant: this.__variant};
  }
  getVariant(): 'a' | 'b' | 'c' {
    return this.getLatest().__variant;
  }
  setVariant(variant: 'a' | 'b' | 'c'): this {
    const self = this.getWritable();
    self.__variant = variant;
    return self;
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): false {
    return false;
  }
}

const countState = createState('count', {parse: numberValue()});

// A node whose only own serialized property is a flat NodeState. It carries no
// updateFromJSON/exportJSON or static boilerplate: the base updateFromJSON
// applies the flat state via $setState and exportJSON flattens it. fast-check
// should still generate `count` because the flat state's value schema
// (numberValue) is introspectable.
class FlatStateNode extends ElementNode {
  $config() {
    return this.config('flat-state-test', {
      extends: ElementNode,
      stateConfigs: [{flat: true, stateConfig: countState}],
    });
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): false {
    return false;
  }
}

type TestNodeClass = Klass<LexicalNode> & {
  importJSON(serialized: SerializedLexicalNode): LexicalNode;
};

describe('@lexical/fast-check', () => {
  const editor = createEditor({
    namespace: 'fast-check',
    nodes: [MergeNode, FlatStateNode],
    onError: error => {
      throw error;
    },
  });

  function importExport(
    klass: TestNodeClass,
    // The extra keys are the node-specific properties under test; the base
    // `importJSON` accepts them the same way.
    serialized: SerializedPartial<SerializedLexicalNode> &
      Record<string, unknown>,
  ): Record<string, unknown> {
    let exported: Record<string, unknown> = {};
    editor.update(
      () => {
        exported = klass.importJSON(serialized).exportJSON() as Record<
          string,
          unknown
        >;
      },
      {discrete: true},
    );
    return exported;
  }

  test('TextNode publishes its own schema on $config', () => {
    expect(getStaticNodeConfig(TextNode).ownNodeConfig?.json).toBeDefined();
  });

  test('ParagraphNode composes the schema ElementNode declares (abstract)', () => {
    // ParagraphNode declares no schema of its own; it inherits ElementNode's,
    // which ElementNode publishes under Symbol.for('ElementNode').
    expect(
      getStaticNodeConfig(ParagraphNode).ownNodeConfig?.json,
    ).toBeUndefined();
    expect(Object.keys(getComposedSchemaFields(ParagraphNode)).sort()).toEqual([
      'direction',
      'format',
      'indent',
      'textFormat',
      'textStyle',
    ]);
  });

  test('a subclass schema merges with its abstract base schema', () => {
    // MergeNode's own `variant` is merged with the five properties it inherits
    // from ElementNode's abstract schema.
    expect(Object.keys(getComposedSchemaFields(MergeNode)).sort()).toEqual([
      'direction',
      'format',
      'indent',
      'textFormat',
      'textStyle',
      'variant',
    ]);
  });

  test('a flat node state is included with the inherited schemas', () => {
    // FlatStateNode declares no serialization schema, only a flat `count`
    // state; its value schema (numberValue) makes it introspectable, so it
    // appears
    // alongside the five properties inherited from ElementNode.
    expect(Object.keys(getComposedSchemaFields(FlatStateNode)).sort()).toEqual([
      'count',
      'direction',
      'format',
      'indent',
      'textFormat',
      'textStyle',
    ]);
  });

  describe.each<[string, TestNodeClass]>([
    ['text', TextNode],
    ['paragraph', ParagraphNode],
    ['merge-test', MergeNode],
    ['flat-state-test', FlatStateNode],
  ])('%s', (type, klass) => {
    test('generated JSON imports and re-exports stably (idempotent)', () => {
      fc.assert(
        fc.property(nodeArbitrary(klass), props => {
          const once = importExport(klass, {
            ...props,
            type,
          });
          // export ∘ import is a fixed point: re-importing what we exported and
          // exporting again yields the same JSON (tolerant of default-omission).
          expect(importExport(klass, once as SerializedLexicalNode)).toEqual(
            once,
          );
        }),
      );
    });
  });

  test('nodeArbitrary generates absent properties, not only complete records', () => {
    // The parsers face SerializedPartial: any node-specific property may be
    // missing (an older document, or a compact export that omitted a
    // default-valued property). A fixed seed keeps this deterministic.
    const samples = fc.sample(nodeArbitrary(TextNode), {
      numRuns: 200,
      seed: 42,
    });
    const keys = Object.keys(getComposedSchemaFields(TextNode));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(samples.some(props => !(key in props))).toBe(true);
      expect(samples.some(props => key in props)).toBe(true);
    }
  });

  test('compact TextNode JSON imports and exports with valid defaults', () => {
    // Every node-specific property omitted — including `version`, which is
    // deprecated: nothing reads it on the way in, and exportJSON always writes
    // it for backwards-compatible output. Each property must come back as its
    // schema default rather than undefined.
    const exported = importExport(TextNode, {type: 'text'});
    expect(exported).toMatchObject({
      detail: 0,
      format: 0,
      mode: 'normal',
      style: '',
      text: '',
      version: 1,
    });
  });

  test('a partially compact TextNode keeps the properties it does carry', () => {
    const exported = importExport(TextNode, {
      text: 'hello',
      type: 'text',
    });
    expect(exported).toMatchObject({
      detail: 0,
      format: 0,
      mode: 'normal',
      style: '',
      text: 'hello',
    });
  });

  test('TextNode tolerates out-of-domain property values', () => {
    const garbage = fc.record({
      detail: fc.anything(),
      format: fc.anything(),
      mode: fc.anything(),
      style: fc.anything(),
      text: fc.anything(),
    });
    fc.assert(
      fc.property(garbage, props => {
        const exported = importExport(TextNode, {
          ...props,
          type: 'text',
        });
        // parsing never throws and always lands inside each property's domain
        expect(typeof exported.text).toBe('string');
        expect(typeof exported.format).toBe('number');
        expect(typeof exported.detail).toBe('number');
        expect(typeof exported.style).toBe('string');
        expect(['normal', 'token', 'segmented']).toContain(exported.mode);
      }),
    );
  });
});

describe('an arbitrary covers the whole domain a schema declares', () => {
  class BoundedNode extends ElementNode {
    // An interval whose lower bound is past fc.integer's default 32-bit
    // maximum, which it would otherwise use as the (smaller) upper bound.
    __big = 1e12;
    // An alias table that declares no alias: legal, parses fine, and has
    // nothing for `fc.constantFrom` to choose from.
    __n = 0;
    $config() {
      return this.config('fast-check-bounded', {
        extends: ElementNode,
        json: nodeSchema<BoundedNode>()({
          big: withField(numberValue(1e12, {integer: true, min: 1e12}), {
            field: '__big',
          }),
          n: withField(aliasedValue(numberValue(), {}), {field: '__n'}),
        }),
      });
    }
    createDOM(): HTMLElement {
      return document.createElement('div');
    }
    updateDOM(): boolean {
      return false;
    }
  }

  test.each([
    // Rounded inward, so both bounds land on the integers the domain admits.
    ['a fractional interval', {integer: true, max: 2.5, min: 0.5} as const, 1],
    // Above the safe integers, where fc.integer cannot generate and the
    // integers are no longer adjacent (1e16 + 1 === 1e16). This is also the
    // empty-interval branch: the safe-integer clamp leaves a minimum above the
    // maximum. An interval that is empty on its own terms — `{integer: true,
    // min: 0.5, max: 0.7}` — cannot be tested here, because `numberValue`
    // refuses to build one.
    ['a domain past 2^53', {integer: true, min: 1e16} as const, 1e16],
  ])('%s generates instead of throwing', (_label, options, dflt) => {
    class OddNode extends ElementNode {
      __v = dflt;
      $config() {
        return this.config(`fast-check-odd-${dflt}`, {
          extends: ElementNode,
          json: nodeSchema<OddNode>()({
            v: withField(numberValue(dflt, options), {field: '__v'}),
          }),
        });
      }
      createDOM(): HTMLElement {
        return document.createElement('div');
      }
      updateDOM(): boolean {
        return false;
      }
    }
    const samples = fc.sample(nodeArbitrary(OddNode), 20);
    expect(samples.length).toBe(20);
    for (const sample of samples) {
      const {v} = sample as {v?: number};
      if (v !== undefined) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  test('an unbounded-above integer domain and an empty alias table generate', () => {
    const arbitrary = nodeArbitrary(BoundedNode);
    fc.assert(
      fc.property(arbitrary, value => {
        const {big, n} = value as {big?: number; n?: number};
        // Everything generated is in the domain the schema declared, which is
        // what makes the generator worth trusting.
        expect(
          big === undefined || (Number.isInteger(big) && big >= 1e12),
        ).toBe(true);
        expect(n === undefined || typeof n === 'number').toBe(true);
      }),
      {numRuns: 50},
    );
  });
});

describe('a flat NodeState is generated as the JSON that carries it', () => {
  // A state whose parse converts: the value type is Date, the JSON is a string.
  const timestamp = createState('timestamp', {
    parse: transformValue(stringValue('1970-01-01'), value => new Date(value), {
      isEqual: (a, b) => a.getTime() === b.getTime(),
    }),
  });

  class StampedNode extends ElementNode {
    $config() {
      return this.config('fast-check-stamped', {
        extends: ElementNode,
        stateConfigs: [{flat: true, stateConfig: timestamp}],
      });
    }
    createDOM(): HTMLElement {
      return document.createElement('div');
    }
    updateDOM(): boolean {
      return false;
    }
  }

  test('so its input type is unknown, not the parsed value type', () => {
    // Typing it `Date` let a caller write `timestamp.getTime()` against a
    // string, with no cast anywhere to warn them.
    expectTypeOf<
      LexicalSchemaInput<StampedNode>['timestamp']
    >().toEqualTypeOf<unknown>();
    for (const sample of fc.sample(nodeArbitrary(StampedNode), 20)) {
      const {timestamp: value} = sample as {timestamp?: unknown};
      // What is generated is what the JSON holds, which the state parses.
      expect(value === undefined || typeof value === 'string').toBe(true);
      expect(timestamp.parse(value)).toBeInstanceOf(Date);
    }
  });
});

describe('a flat set-valued NodeState', () => {
  const tags = createState('tags', {
    parse: arraySetValue(enumValue(['a', 'b', 'c'])),
  });

  class TaggedNode extends TextNode {
    $config() {
      return this.config('fast-check-tagged', {
        extends: TextNode,
        stateConfigs: [{flat: true, stateConfig: tags}],
      });
    }
  }

  test('is generated as any array of its items, which import makes a set', () => {
    const samples = fc.sample(nodeArbitrary(TaggedNode), {
      numRuns: 300,
      seed: 1,
    });
    const editor = createEditor({
      nodes: [TaggedNode],
      onError: error => {
        throw error;
      },
    });
    let present = 0;
    let notCanonical = 0;
    for (const sample of samples) {
      const {tags: value} = sample as {tags?: unknown};
      if (value === undefined) {
        continue;
      }
      present++;
      // The input domain of the set: an array of items, in any order and
      // with duplicates
      expect(Array.isArray(value)).toBe(true);
      const items = value as string[];
      for (const item of items) {
        expect(['a', 'b', 'c']).toContain(item);
      }
      const canonical = Array.from(new Set(items)).sort();
      if (JSON.stringify(canonical) !== JSON.stringify(items)) {
        notCanonical++;
      }
      editor.update(
        () => {
          const node = TaggedNode.importJSON({
            ...new TaggedNode().exportJSON(),
            ...sample,
            type: 'fast-check-tagged',
          } as Parameters<typeof TaggedNode.importJSON>[0]);
          expect($getState(node, tags)).toEqual(canonical);
        },
        {discrete: true},
      );
    }
    expect(present).toBeGreaterThan(100);
    expect(notCanonical).toBeGreaterThan(0);
  });
});

describe('a schema that narrows its own domain', () => {
  // `nodeArbitrary` builds each property's values from its schema's metadata,
  // which describes what the *combinator* accepts. A schema whose author
  // installed a membership predicate of its own admits less than that while
  // still carrying the combinator's metadata, so generating from the metadata
  // alone produced values the schema declines — and a round-trip property then
  // failed on values this claimed were in domain.
  const accepts = (value: unknown) =>
    typeof value === 'string' && value.startsWith('#');
  const base = stringValue();
  // Cast to the schema it really is, rather than to `never`: the latter is
  // assignable to any parameter, so `withField(tag, {field: '__tag'})`
  // inferred `unknown` for what the property parses to and the field check
  // then had nothing to check.
  const tag = Object.assign(
    (value: unknown) => (accepts(value) ? String(value) : base.defaultValue),
    base,
    {accepts},
  ) as unknown as typeof base;

  class TaggedNode extends ElementNode {
    __tag: string = '';
    $config() {
      return this.config('fast-check-tagged', {
        extends: ElementNode,
        json: nodeSchema<TaggedNode>()({
          tag: withField(tag, {field: '__tag'}),
        }),
      });
    }
    createDOM(): HTMLElement {
      return document.createElement('div');
    }
    updateDOM(): boolean {
      return false;
    }
  }

  test('generates only what it accepts', () => {
    const samples = fc.sample(nodeArbitrary(TaggedNode), 50);
    for (const sample of samples) {
      const {tag: value} = sample as {tag?: unknown};
      expect(value === undefined || accepts(value)).toBe(true);
    }
    // Not vacuous: the property really is generated, not merely always absent.
    expect(
      samples.some(sample => (sample as {tag?: unknown}).tag !== undefined),
    ).toBe(true);
  });

  // And wherever the narrowed schema sits, not only at the top of a property.
  // Every container and wrapper derives its own predicate, so a filter applied
  // to the outermost schema alone is no filter at all for what is inside it —
  // the arbitrary for the items came straight from the item's metadata.
  class NestedTaggedNode extends ElementNode {
    __tags: string[] = [];
    __maybe: null | string = null;
    $config() {
      return this.config('fast-check-nested-tagged', {
        extends: ElementNode,
        json: nodeSchema<NestedTaggedNode>()({
          maybe: withField(nullable(tag), {field: '__maybe'}),
          tags: withField(arrayValue(tag), {field: '__tags'}),
        }),
      });
    }
    createDOM(): HTMLElement {
      return document.createElement('div');
    }
    updateDOM(): boolean {
      return false;
    }
  }

  test('generates only what it accepts inside a container or wrapper', () => {
    const samples = fc.sample(nodeArbitrary(NestedTaggedNode), 50);
    let items = 0;
    for (const sample of samples) {
      const {maybe, tags} = sample as {maybe?: unknown; tags?: unknown};
      expect(maybe === undefined || maybe === null || accepts(maybe)).toBe(
        true,
      );
      for (const item of Array.isArray(tags) ? tags : []) {
        items++;
        expect(accepts(item)).toBe(true);
      }
    }
    // Not vacuous: elements really are generated.
    expect(items).toBeGreaterThan(0);
  });
});
