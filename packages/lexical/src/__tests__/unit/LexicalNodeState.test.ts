/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  $copyNode,
  $create,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKeyOrThrow,
  $getRoot,
  $getState,
  $getStateChange,
  $isParagraphNode,
  $setState,
  aliasedValue,
  arraySetValue,
  arrayValue,
  createEditor,
  createState,
  ElementNode,
  enumValue,
  type LexicalExportJSON,
  NODE_STATE_DIRECT,
  NODE_STATE_KEY,
  nodeSchema,
  type NodeStateJSON,
  nullable,
  numberValue,
  objectValue,
  optional,
  ParagraphNode,
  type RootNode,
  type SerializedElementNode,
  type SerializedLexicalNode,
  type StateConfig,
  type StateValueOrUpdater,
  stringValue as stringSchema,
  transformValue,
  unionValue,
  withField,
} from 'lexical';
import {beforeEach, describe, expect, expectTypeOf, test} from 'vitest';

import {nodeStatesAreEquivalent} from '../../LexicalNodeState';
import {$assertNodeType, initializeUnitTest, invariant} from '../utils';
import {TestNode} from './LexicalNode.test';

// https://www.totaltypescript.com/how-to-test-your-types
type Expect<T extends true> = T;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

const numberState = createState('numberState', {
  parse: v => (typeof v === 'number' ? v : 0),
});
const boolState = createState('boolState', {parse: Boolean});
class StateNode extends TestNode {
  $config() {
    return this.config('state', {
      extends: TestNode,
      stateConfigs: [{flat: true, stateConfig: numberState}, boolState],
    });
  }
  getNumber() {
    return $getState(this, numberState);
  }
  setNumber(valueOrUpdater: StateValueOrUpdater<typeof numberState>): this {
    return $setState(this, numberState, valueOrUpdater);
  }
}

const extraState = createState('extra', {parse: String});
class ExtraStateNode extends StateNode {
  $config() {
    return this.config('extra-state', {
      extends: StateNode,
      stateConfigs: [{flat: true, stateConfig: extraState}],
    });
  }
}

type StateNodeStateJSON = NodeStateJSON<StateNode>;
type _TestNodeStateJSON = Expect<
  Equal<
    StateNodeStateJSON,
    {
      [NODE_STATE_KEY]?: {boolState?: boolean | undefined} | undefined;
      numberState?: number | undefined;
    }
  >
>;
type StateNodeExportJSON = LexicalExportJSON<StateNode>;
type _TestStateNodeExportJSON = Expect<
  Equal<
    StateNodeExportJSON,
    {
      [NODE_STATE_KEY]?:
        | (Record<string, unknown> & {
            boolState?: boolean | undefined;
          })
        | undefined;
      $slots?: Record<string, SerializedLexicalNode>;
      version: number;
      type: 'state';
      numberState?: number | undefined;
    }
  >
>;

type ExtraStateNodeExportJSON = LexicalExportJSON<ExtraStateNode>;
type _TestExtraStateNodeExportJSON = Expect<
  Equal<
    ExtraStateNodeExportJSON,
    {
      [NODE_STATE_KEY]?:
        | (Record<string, unknown> & {
            boolState?: boolean | undefined;
          })
        | undefined;
      $slots?: Record<string, SerializedLexicalNode>;
      version: number;
      type: 'extra-state';
      numberState?: number | undefined;
      extra?: string | undefined;
    }
  >
>;

function $createStateNode() {
  return new StateNode();
}

// ===========================================================================
// Interleaved abstract/concrete $config hierarchy:
//   ElementNode -> InterleaveParagraph (concrete) -> InterleaveAbstract
//   (abstract, Symbol-keyed) -> InterleaveConcrete (concrete)
// A required flat state is declared at each level below ElementNode, and the
// abstract base also registers a $transform. Before the accessor-based config
// fix:
//   - InterleaveAbstract.$config did not type-check as an override of the
//     accessor-bearing InterleaveParagraph.$config, and
//   - NodeStateJSON<InterleaveConcrete> truncated at the Symbol-keyed base to
//     just {icState}, dropping iaState and ipState even though the runtime
//     registered and serialized all three.
// ===========================================================================
const ipState = createState('ipState', {
  parse: v => (typeof v === 'number' ? v : 0),
});
const iaState = createState('iaState', {
  parse: v => (typeof v === 'number' ? v : 0),
});
const icState = createState('icState', {
  parse: v => (typeof v === 'number' ? v : 0),
});
const interleaveTransforms: string[] = [];

class InterleaveParagraph extends ElementNode {
  $config() {
    return this.config('interleave-paragraph', {
      extends: ElementNode,
      stateConfigs: [{flat: true, stateConfig: ipState}],
    });
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): false {
    return false;
  }
}
class InterleaveAbstract extends InterleaveParagraph {
  $config() {
    return this.config(Symbol.for('InterleaveAbstract'), {
      $transform: (node: InterleaveAbstract) => {
        interleaveTransforms.push(node.getType());
      },
      extends: InterleaveParagraph,
      stateConfigs: [{flat: true, stateConfig: iaState}],
    });
  }
}
class InterleaveConcrete extends InterleaveAbstract {
  $config() {
    return this.config('interleave-concrete', {
      extends: InterleaveAbstract,
      stateConfigs: [{flat: true, stateConfig: icState}],
    });
  }
}

describe('LexicalNode state', () => {
  initializeUnitTest(
    testEnv => {
      let root: RootNode;

      beforeEach(async () => {
        const {editor} = testEnv;
        await editor.update(() => {
          root = $getRoot();
        });
      });

      test(`state.$set() and state.$get() need to be inside an update`, async () => {
        const stringState = createState('stringState', {
          parse: value => (typeof value === 'string' ? value : ''),
        });
        const $fn = () => {
          $setState(root, stringState, 'hello');
        };
        const $fn2 = () => {
          $setState(root, stringState, 'hello');
        };
        expect($fn).toThrow();
        expect($fn2).toThrow();
        const {editor} = testEnv;
        editor.update(() => {
          expect($fn).not.toThrow();
          expect($fn2).not.toThrow();
        });
      });

      test('__state is not an enumerable property', () => {
        const {editor} = testEnv;
        editor.update(
          () => {
            expect(Object.keys($getRoot())).not.toContain('__state');
          },
          {discrete: true},
        );
      });

      test(`getState and setState`, async () => {
        const stringState = createState('stringState', {
          parse: value => (typeof value === 'string' ? value : ''),
        });
        const {editor} = testEnv;
        editor.update(() => {
          const stringValue = $getState(root, stringState);
          type _Test = Expect<Equal<typeof stringValue, string>>;
          expect(stringValue).toBe('');
          $setState(root, stringState, 'hello');
          expect($getState(root, stringState)).toBe('hello');

          const maybeStringState = createState('maybeStringState', {
            parse: value => (typeof value === 'string' ? value : undefined),
          });
          const maybeStringValue = $getState(root, maybeStringState);
          type _Test2 = Expect<
            Equal<typeof maybeStringValue, string | undefined>
          >;
          expect(maybeStringValue).toBeUndefined();
        });
      });

      test(`import and export state`, async () => {
        const {editor} = testEnv;
        editor.update(() => {
          const paragraph = $createParagraphNode();
          const json = paragraph.exportJSON();
          // We don't export state as an empty object
          expect(json).not.toHaveProperty(NODE_STATE_KEY);
          $setState(paragraph, numberState, 1);
          const json2 = paragraph.exportJSON();
          expect(json2[NODE_STATE_KEY]).toStrictEqual({
            numberState: 1,
          });
          const paragraph2 = ParagraphNode.importJSON(json2);
          const json3 = paragraph2.exportJSON();
          expect(json3[NODE_STATE_KEY]).toStrictEqual({
            numberState: 1,
          });
        });
      });

      test('importJSON ignores prototype-polluting state keys', () => {
        const {editor} = testEnv;
        editor.update(() => {
          // `__proto__` is only an own enumerable key when produced by
          // JSON.parse; an object literal would invoke the setter instead.
          const malicious = JSON.parse(
            `{"type":"paragraph","version":1,"${NODE_STATE_KEY}":{"__proto__":{"injectedKey":"evil"}}}`,
          );
          const paragraph = ParagraphNode.importJSON(malicious);
          // The global prototype is untouched.
          expect(({} as Record<string, unknown>).injectedKey).toBeUndefined();
          expect(Object.prototype).not.toHaveProperty('injectedKey');
          // The smuggled `__proto__` must not re-parent the state record:
          // because getValue resolves keys with the `in` operator (which walks
          // the prototype chain), an unguarded merge would let it inject this
          // value. Reading the matching key must return the default instead.
          const injectedState = createState('injectedKey', {
            parse: v => (typeof v === 'string' ? v : 'default'),
          });
          expect($getState(paragraph, injectedState)).toBe('default');
          // The dangerous key is dropped, so no node state is emitted.
          expect(paragraph.exportJSON()).not.toHaveProperty(NODE_STATE_KEY);
        });
      });

      test('states cannot be registered with the same key string', () => {
        const {editor} = testEnv;
        editor.update(
          () => {
            const k0 = createState('foo', {parse: v => !!v});
            const k1 = createState('foo', {parse: () => 'foo'});
            expect($getState(root, k0)).toBe(false);
            $setState(root, k0, true);
            expect($getState(root, k0)).toBe(true);
            expect(() => $getState(root, k1)).toThrow(
              'State key collision "foo" detected in RootNode node with type root and key root. Only one StateConfig with a given key should be used on a node.',
            );
            expect(() => $setState(root, k1, 'foo')).toThrow(
              'State key collision "foo" detected in RootNode node with type root and key root. Only one StateConfig with a given key should be used on a node.',
            );
            expect($getState(root, k0)).toBe(true);
          },
          {discrete: true},
        );
      });

      test('nodeGetter() and nodeSetter()', () => {
        const {editor} = testEnv;
        editor.update(() => {
          const stateNode = $createStateNode();
          expect(stateNode.getNumber()).toBe(0);
          stateNode.setNumber(1);
          expect(stateNode.getNumber()).toBe(1);
          stateNode.setNumber(n => n + 1);
          expect(stateNode.getNumber()).toBe(2);
          $setState(stateNode, boolState, true);
          expect(stateNode.exportJSON()).toMatchObject({
            [NODE_STATE_KEY]: {boolState: true},
            numberState: 2,
            type: 'state',
          });
        });
      });

      test('flat config serialization round-trip', () => {
        const {editor} = testEnv;
        editor.update(() => {
          const flatJSON: LexicalExportJSON<StateNode> = {
            [NODE_STATE_KEY]: {boolState: true},
            numberState: 2,
            type: 'state',
            version: 1,
          };
          const nestedJSON: LexicalExportJSON<StateNode> = {
            [NODE_STATE_KEY]: {boolState: true, numberState: 2},
            type: 'state',
            version: 1,
          };
          const bothJSON: LexicalExportJSON<StateNode> = {
            [NODE_STATE_KEY]: {boolState: true, numberState: 3},
            numberState: 2,
            type: 'state',
            version: 1,
          };
          for (const doc of [flatJSON, nestedJSON, bothJSON]) {
            const node = StateNode.importJSON(doc);
            expect(node.exportJSON()).toEqual(flatJSON);
            expect($getState(node, boolState)).toBe(true);
            expect($getState(node, numberState)).toBe(2);
          }
        });
      });

      test('an absent flat key leaves the nested value alone', () => {
        // The reason the flat pass tests for presence at all rather than
        // parsing every key: `$updateStateFromJSON` applies the nested `$`
        // blob first, and this runs over it. Parsing an absent flat key to
        // its default would overwrite what the blob supplied, so a document
        // that spells a flat-capable state the nested way would lose it —
        // which is what the round-trip above reads back through `nestedJSON`,
        // stated here as the rule it follows from.
        const {editor} = testEnv;
        editor.update(() => {
          const node = StateNode.importJSON({
            [NODE_STATE_KEY]: {numberState: 7},
            type: 'state',
            version: 1,
          });
          expect($getState(node, numberState)).toBe(7);
          // And a flat key that *is* present wins over the blob's value.
          const both = StateNode.importJSON({
            [NODE_STATE_KEY]: {numberState: 7},
            numberState: 9,
            type: 'state',
            version: 1,
          });
          expect($getState(both, numberState)).toBe(9);
        });
      });

      test('default value should not be exported', async () => {
        const {editor} = testEnv;
        editor.update(() => {
          const indentState = createState('indent', {
            parse: value => (typeof value === 'number' ? value : 0),
          });
          const paragraph = $createParagraphNode();
          expect($getState(paragraph, indentState)).toBe(0);
          const json = paragraph.exportJSON();
          expect(json).not.toHaveProperty(NODE_STATE_KEY);
          $setState(paragraph, indentState, 1);
          const json2 = paragraph.exportJSON();
          expect(json2[NODE_STATE_KEY]).toStrictEqual({
            indent: 1,
          });
          // set the default value explicitly
          $setState(paragraph, indentState, 0);
          const json3 = paragraph.exportJSON();
          expect(json3).not.toHaveProperty(NODE_STATE_KEY);

          const foo = createState('foo', {
            parse: value => (typeof value === 'string' ? value : ''),
          });
          $setState(paragraph, foo, 'fooValue');
          const json4 = paragraph.exportJSON();
          expect(json4[NODE_STATE_KEY]).toStrictEqual({
            foo: 'fooValue',
          });
        });
      });

      test('getState returns immutable values, setState require an Object literal', async () => {
        type TestObject = {
          foo: string;
          bar: number;
        };
        const {editor} = testEnv;
        editor.update(() => {
          const paragraph = $createParagraphNode();
          const objectState = createState('object', {
            parse: value =>
              (value as TestObject) || {
                bar: 0,
                foo: '',
              },
          });
          const paragraphObject = $getState(paragraph, objectState);
          type _Test = Expect<
            Equal<
              typeof paragraphObject,
              {
                bar: number;
                foo: string;
              }
            >
          >;

          // @ts-expect-error - foo is required
          $setState(paragraph, objectState, {bar: 1});
          // @ts-expect-error - baz is not a valid property
          $setState(paragraph, objectState, {bar: 1, baz: 'baz', foo: 'foo'});

          $setState(paragraph, objectState, paragraphObject!);
          $setState(paragraph, objectState, {...paragraphObject!, foo: 'foo'});
        });
      });

      test('setting state shouldn’t affect previous reconciled versions of the node', () => {
        const {editor} = testEnv;
        let initialRoot: RootNode;
        let v0: RootNode;
        let v1: RootNode;
        const vk = createState('vk', {
          parse: v => (typeof v === 'number' ? v : null),
        });
        editor.update(
          () => {
            initialRoot = $getRoot();
            v0 = $setState(initialRoot, vk, 0);
            expect($getState(v0, vk)).toBe(0);
            expect($getStateChange(v0, initialRoot, vk)).toEqual([0, null]);
          },
          {discrete: true},
        );
        const state0 = editor.getEditorState();
        editor.update(
          () => {
            v1 = $setState(v0, vk, 1);
            expect(v1).not.toBe(v0);
            expect(v1.is(v0)).toBe(true);
            // This is testing getLatest()
            expect($getState(v0, vk)).toBe(1);
            expect($getState(v0, vk, NODE_STATE_DIRECT)).toBe(0);
            expect($getState(v1, vk)).toBe(1);
            expect($getStateChange(v1, v0, vk)).toEqual([1, 0]);
          },
          {discrete: true},
        );
        const state1 = editor.getEditorState();
        // Test that the correct version is returned and that they are independent
        expect(state0.read(() => $getState(v0, vk))).toBe(0);
        expect(state1.read(() => $getState(v1, vk))).toBe(1);
        // Test that getLatest is used and not the __state property directly
        expect(state0.read(() => $getState(v1, vk))).toBe(0);
        expect(state1.read(() => $getState(v0, vk))).toBe(1);
        // Test that 'direct' doesn't actually require an editor state.
        const noState = {
          read<T>(f: () => T): T {
            return f();
          },
        };
        expect(
          noState.read(() => $getState(initialRoot, vk, NODE_STATE_DIRECT)),
        ).toBe(null);
        expect(noState.read(() => $getState(v0, vk, NODE_STATE_DIRECT))).toBe(
          0,
        );
        expect(noState.read(() => $getState(v1, vk, NODE_STATE_DIRECT))).toBe(
          1,
        );
      });
      describe('nodeStatesAreEquivalent', () => {
        test('undefined states are equivalent', () => {
          expect(nodeStatesAreEquivalent(undefined, undefined)).toBe(true);
        });
        test('merges text nodes with different number of default state values', () => {
          const {editor} = testEnv;
          // Initialise with non-default state.
          editor.update(
            () => {
              const firstTextNode = $createTextNode('hello');
              const secondTextNode = $createTextNode('world');
              $setState(firstTextNode, numberState, 1);
              $setState(firstTextNode, boolState, true);
              $setState(secondTextNode, boolState, true);
              $getRoot()
                .clear()
                .append(
                  $createParagraphNode().append(firstTextNode, secondTextNode),
                );
            },
            {discrete: true},
          );
          editor.read(() => {
            const textNodes = $getRoot().getAllTextNodes();
            expect(textNodes).toHaveLength(2);
          });
          // Revert to default value for number state.
          editor.update(
            () => {
              const paragraph = $assertNodeType(
                $getRoot().getFirstChild(),
                $isParagraphNode,
              );
              const [firstTextNode] = paragraph.getChildren();
              $setState(firstTextNode, numberState, 0);
            },
            {discrete: true},
          );
          // Test that the text nodes are merged.
          editor.read(() => {
            const textNodes = $getRoot().getAllTextNodes();
            expect(textNodes).toHaveLength(1);
            expect($getState(textNodes[0], numberState)).toBe(0);
            expect($getState(textNodes[0], boolState)).toBe(true);
          });
        });
        test('TextNode merging only with equivalent state', () => {
          const {editor} = testEnv;
          const classNameState = createState('className', {
            parse: v => (typeof v === 'string' ? v : ''),
          });
          const $createTextWithClassName = (className: string) =>
            $setState($createTextNode(className), classNameState, className);
          editor.update(
            () => {
              $getRoot()
                .clear()
                .append(
                  $createParagraphNode().append(
                    $createTextWithClassName('red'),
                    $createTextNode('none!'),
                    $createTextWithClassName('red'),
                    $createTextWithClassName('blue'),
                    $createTextWithClassName('blue'),
                    $createTextWithClassName('red'),
                    $createTextWithClassName('blue'),
                  ),
                );
            },
            {discrete: true},
          );
          editor.read(() => {
            const textNodes = $getRoot().getAllTextNodes();
            expect(textNodes).toHaveLength(6);
            expect(
              textNodes.map(node => $getState(node, classNameState)),
            ).toEqual(['red', '', 'red', 'blue', 'red', 'blue']);
            expect(textNodes.map(node => node.getTextContent())).toEqual([
              'red',
              'none!',
              'red',
              'blueblue',
              'red',
              'blue',
            ]);
          });
          editor.update(
            () => {
              const paragraph = $getRoot().getFirstChildOrThrow();
              invariant($isParagraphNode(paragraph), 'must be a paragraph');
              // change none! to red
              $setState(paragraph.getChildAtIndex(1)!, classNameState, 'red');
            },
            {discrete: true},
          );
          editor.read(() => {
            const textNodes = $getRoot().getAllTextNodes();
            expect(textNodes).toHaveLength(4);
            expect(
              textNodes.map(node => $getState(node, classNameState)),
            ).toEqual(['red', 'blue', 'red', 'blue']);
            expect(textNodes.map(node => node.getTextContent())).toEqual([
              'rednone!red',
              'blueblue',
              'red',
              'blue',
            ]);
          });
        });
        test('different versions of the same state are not equivalent', () => {
          const {editor} = testEnv;
          let initialRoot!: RootNode;
          let v0!: RootNode;
          let v1!: RootNode;
          let v2!: RootNode;
          let v3!: RootNode;
          let v4!: RootNode;
          let v5!: RootNode;
          const vk = createState('vk', {
            parse: v => (typeof v === 'number' ? v : null),
          });
          editor.update(
            () => {
              initialRoot = $getRoot();
              v0 = $setState(initialRoot, vk, 0);
              expect($getState(v0, vk)).toBe(0);
              expect($getStateChange(v0, initialRoot, vk)).toEqual([0, null]);
            },
            {discrete: true},
          );
          editor.update(
            () => {
              v1 = $setState(v0, vk, 1);
              expect(v1).not.toBe(v0);
              expect(v1.is(v0)).toBe(true);
              // This is testing getLatest()
              expect($getState(v0, vk)).toBe(1);
              expect($getState(v0, vk, NODE_STATE_DIRECT)).toBe(0);
              expect($getState(v1, vk)).toBe(1);
              expect($getStateChange(v1, v0, vk)).toEqual([1, 0]);
            },
            {discrete: true},
          );
          // Set the state back to v0
          editor.update(
            () => {
              v2 = $setState(v1, vk, 0);
            },
            {discrete: true},
          );
          // Set the state back to default
          editor.update(
            () => {
              v3 = $setState(v2, vk, null);
            },
            {discrete: true},
          );
          editor.update(
            () => {
              v4 = v3.updateFromJSON({
                ...v3.exportJSON(),
                [NODE_STATE_KEY]: {vk: 1},
              });
            },
            {discrete: true},
          );
          editor.update(
            () => {
              v5 = v4.updateFromJSON({
                ...v4.exportJSON(),
                [NODE_STATE_KEY]: {unknown: true, vk: 1},
              });
            },
            {discrete: true},
          );
          // Each sub-array's elements are all equivalent, but not equivalent to states from other arrays
          const equivalences = [
            [initialRoot.__state, v3.__state, undefined],
            [v0.__state, v2.__state],
            [v1.__state, v4.__state],
            [v5.__state],
          ];
          for (let i = 0; i < equivalences.length; i++) {
            const aSet = equivalences[i];
            for (let j = i + 1; j < equivalences.length; j++) {
              const bSet = equivalences[j];
              for (const a of aSet) {
                for (const b of bSet) {
                  expect(nodeStatesAreEquivalent(a, b)).toBe(false);
                  expect(nodeStatesAreEquivalent(b, a)).toBe(false);
                }
              }
            }
            for (let j = 0; j < aSet.length; j++) {
              const a0 = aSet[j];
              for (let k = j + 1; k < aSet.length; k++) {
                const a1 = aSet[k];
                expect(nodeStatesAreEquivalent(a0, a1)).toBe(true);
                expect(nodeStatesAreEquivalent(a1, a0)).toBe(true);
              }
            }
          }
        });
      });

      describe('resetOnCopyNode', () => {
        test('state with resetOnCopyNode: true is reset when using $copyNode', () => {
          const {editor} = testEnv;
          const resetState = createState('resetState', {
            parse: v => (typeof v === 'number' ? v : 0),
            resetOnCopyNode: true,
          });
          editor.update(
            () => {
              const node = $createStateNode();
              $setState(node, resetState, 42);
              expect($getState(node, resetState)).toBe(42);

              const copy = $copyNode(node);
              expect($getState(copy, resetState)).toBe(0);
              expect($getState(node, resetState)).toBe(42);
            },
            {discrete: true},
          );
        });

        test('state with resetOnCopyNode: false is preserved when using $copyNode', () => {
          const {editor} = testEnv;
          const persistState = createState('persistState', {
            parse: v => (typeof v === 'number' ? v : 0),
            resetOnCopyNode: false,
          });
          editor.update(
            () => {
              const node = $createStateNode();
              $setState(node, persistState, 42);
              expect($getState(node, persistState)).toBe(42);

              const copy = $copyNode(node);
              expect($getState(copy, persistState)).toBe(42);
              expect($getState(node, persistState)).toBe(42);
            },
            {discrete: true},
          );
        });

        test('state without resetOnCopyNode option is preserved when using $copyNode', () => {
          const {editor} = testEnv;
          const defaultState = createState('defaultState', {
            parse: v => (typeof v === 'number' ? v : 0),
          });
          editor.update(
            () => {
              const node = $createStateNode();
              $setState(node, defaultState, 42);
              expect($getState(node, defaultState)).toBe(42);

              const copy = $copyNode(node);
              expect($getState(copy, defaultState)).toBe(42);
              expect($getState(node, defaultState)).toBe(42);
            },
            {discrete: true},
          );
        });

        test('multiple states with different resetOnCopyNode configurations', () => {
          const {editor} = testEnv;
          const resetState = createState('resetState', {
            parse: v => (typeof v === 'number' ? v : 0),
            resetOnCopyNode: true,
          });
          const persistState = createState('persistState', {
            parse: v => (typeof v === 'string' ? v : ''),
            resetOnCopyNode: false,
          });
          const defaultState = createState('defaultState', {
            parse: v => (typeof v === 'boolean' ? v : false),
          });

          editor.update(
            () => {
              const node = $createStateNode();
              $setState(node, resetState, 100);
              $setState(node, persistState, 'hello');
              $setState(node, defaultState, true);

              expect($getState(node, resetState)).toBe(100);
              expect($getState(node, persistState)).toBe('hello');
              expect($getState(node, defaultState)).toBe(true);

              const copy = $copyNode(node);
              expect($getState(copy, resetState)).toBe(0);
              expect($getState(copy, persistState)).toBe('hello');
              expect($getState(copy, defaultState)).toBe(true);

              // Original node should be unchanged
              expect($getState(node, resetState)).toBe(100);
              expect($getState(node, persistState)).toBe('hello');
              expect($getState(node, defaultState)).toBe(true);

              const fullCopy = $copyNode(node, true);
              // Original node should be unchanged
              expect($getState(node, resetState)).toBe(100);
              expect($getState(node, persistState)).toBe('hello');
              expect($getState(node, defaultState)).toBe(true);
              // Full copy should match all properties
              expect($getState(fullCopy, resetState)).toBe(100);
              expect($getState(fullCopy, persistState)).toBe('hello');
              expect($getState(fullCopy, defaultState)).toBe(true);
            },
            {discrete: true},
          );
        });
      });
    },
    {
      namespace: '',
      nodes: [TestNode, StateNode],
      theme: {},
    },
  );
});

describe('$config interleaved abstract/concrete classes', () => {
  test('serializes, transforms, and types every interleaved level’s state', () => {
    interleaveTransforms.length = 0;
    const editor = createEditor({
      nodes: [InterleaveConcrete],
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        const node = $setState(
          $setState(
            $setState($create(InterleaveConcrete), ipState, 1),
            iaState,
            2,
          ),
          icState,
          3,
        );
        $getRoot().append(node);
        const json = node.exportJSON();

        // Value: every interleaved level's flat state was serialized — the
        // concrete ancestor's (ipState), the Symbol-keyed abstract base's
        // (iaState) and the concrete leaf's (icState).
        expect(json).toMatchObject({
          iaState: 2,
          icState: 3,
          ipState: 1,
          type: 'interleave-concrete',
        });

        // Type: exportJSON()'s return stays the generic serialized type (it must,
        // to remain compatible with subclassing) — the precise per-node JSON is
        // described by NodeStateJSON, which now collects every interleaved
        // level's flat state. Before the fix this truncated at the Symbol-keyed
        // base to just {icState}.
        expectTypeOf(json).toEqualTypeOf<SerializedElementNode>();
        expectTypeOf<
          keyof Omit<NodeStateJSON<InterleaveConcrete>, typeof NODE_STATE_KEY>
        >().toEqualTypeOf<'ipState' | 'iaState' | 'icState'>();
        expectTypeOf<
          NodeStateJSON<InterleaveConcrete>['ipState']
        >().toEqualTypeOf<number | undefined>();
        expectTypeOf<
          NodeStateJSON<InterleaveConcrete>['iaState']
        >().toEqualTypeOf<number | undefined>();
        expectTypeOf<
          NodeStateJSON<InterleaveConcrete>['icState']
        >().toEqualTypeOf<number | undefined>();
      },
      {discrete: true},
    );
    // The abstract base's $transform ran for the concrete leaf (transforms fire
    // during reconciliation once the node is part of the document).
    expect(interleaveTransforms).toContain('interleave-concrete');
  });
});

describe('flat NodeState through a node replacement', () => {
  const replacedFlatState = createState('replacedFlatKey', {
    parse: v => (typeof v === 'string' ? v : ''),
  });

  class FlatParagraph extends ParagraphNode {
    $config() {
      return this.config('flat-paragraph', {
        extends: ParagraphNode,
        stateConfigs: [{flat: true, stateConfig: replacedFlatState}],
      });
    }
  }

  // A replacement class that reuses the replaced class's type — the only shape
  // in which the RegisteredNode for a live node's type could come from the
  // `replace` entry rather than from the subclass's own registration.
  class SameTypeParagraph extends ParagraphNode {
    $config() {
      return this.config('paragraph', {
        extends: ParagraphNode,
        stateConfigs: [{flat: true, stateConfig: replacedFlatState}],
      });
    }
  }

  test('the subclass writes and reads its own flat state top-level', () => {
    // Flat state is applied on import from the composed schema of
    // `node.constructor`, but written on export from the SharedNodeState the
    // node's *type* is registered with. Those agree here because a replacement
    // class is registered under its own type: the two directions cannot drift.
    const editor = createEditor({
      namespace: '',
      nodes: [
        FlatParagraph,
        {
          replace: ParagraphNode,
          with: () => new FlatParagraph(),
          withKlass: FlatParagraph,
        },
      ],
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        const p = $createParagraphNode();
        expect(p).toBeInstanceOf(FlatParagraph);
        expect(p.getType()).toBe('flat-paragraph');
        $getRoot()
          .clear()
          .append(p.append($createTextNode('x')));
        $setState(p, replacedFlatState, 'hello');
      },
      {discrete: true},
    );

    const json = editor.getEditorState().toJSON();
    const exported = json.root.children[0];
    // written top-level, not nested under the NodeState key
    expect(exported).toMatchObject({replacedFlatKey: 'hello'});
    expect(exported[NODE_STATE_KEY]).toBeUndefined();

    const reparsed = editor.parseEditorState(JSON.stringify(json));
    expect(
      reparsed.read(() =>
        $getState($getRoot().getFirstChildOrThrow(), replacedFlatState),
      ),
    ).toBe('hello');
  });

  test('withKlass must itself be registered', () => {
    const editor = createEditor({
      namespace: '',
      nodes: [
        {
          replace: ParagraphNode,
          with: () => new FlatParagraph(),
          withKlass: FlatParagraph,
        },
      ],
      onError: err => {
        throw err;
      },
    });
    expect(() =>
      editor.update(() => void $createParagraphNode(), {discrete: true}),
    ).toThrow(/not configured to be used on the editor/);
  });

  test('a replacement class cannot reuse the replaced type', () => {
    const editor = createEditor({
      namespace: '',
      nodes: [
        {
          replace: ParagraphNode,
          with: () => new SameTypeParagraph(),
          withKlass: SameTypeParagraph,
        },
      ],
      onError: err => {
        throw err;
      },
    });
    expect(() =>
      editor.update(() => void $createParagraphNode(), {discrete: true}),
    ).toThrow(/does not match registered node ParagraphNode/);
  });
});

describe('importJSON applies state to the node it just built', () => {
  // importJSON constructs the node itself, so it skips the getWritable() that
  // updateFromJSON opens with — $setNodeKey already made that node the
  // writable latest. What must not be skipped is the state itself.
  const flatKey = createState('importFlatKey', {
    parse: v => (typeof v === 'string' ? v : ''),
  });
  const directKey = createState('importDirectKey', {
    parse: v => (typeof v === 'number' ? v : 0),
  });

  class StatefulParagraph extends ParagraphNode {
    $config() {
      return this.config('stateful-paragraph', {
        extends: ParagraphNode,
        stateConfigs: [{flat: true, stateConfig: flatKey}],
      });
    }
  }

  function editorWith() {
    return createEditor({
      namespace: '',
      nodes: [StatefulParagraph],
      onError: err => {
        throw err;
      },
    });
  }

  test('both flat and nested state survive a round trip through importJSON', () => {
    const editor = editorWith();
    editor.update(
      () => {
        const p = $create(StatefulParagraph);
        $getRoot()
          .clear()
          .append(p.append($createTextNode('x')));
        $setState(p, flatKey, 'flat-value');
        $setState(p, directKey, 42);
      },
      {discrete: true},
    );
    const json = JSON.stringify(editor.getEditorState().toJSON());
    const reparsed = editor.parseEditorState(json);
    reparsed.read(() => {
      const p = $getRoot().getFirstChildOrThrow();
      // The flat one comes back through the compiled schema, the nested one
      // through $updateStateFromJSON — the branch importJSON only takes when
      // the JSON actually carries state.
      expect($getState(p, flatKey)).toBe('flat-value');
      expect($getState(p, directKey)).toBe(42);
    });
  });

  test('a node whose JSON carries no state still imports its own properties', () => {
    const editor = editorWith();
    editor.update(
      () => {
        const p = $create(StatefulParagraph);
        $getRoot()
          .clear()
          .append(p.append($createTextNode('hello')));
        p.setIndent(2);
      },
      {discrete: true},
    );
    const json = JSON.stringify(editor.getEditorState().toJSON());
    expect(json).not.toContain(NODE_STATE_KEY);
    const reparsed = editor.parseEditorState(json);
    reparsed.read(() => {
      const p = $getRoot().getFirstChildOrThrow();
      invariant($isParagraphNode(p), 'expected a paragraph');
      expect(p.getIndent()).toBe(2);
      expect(p.getTextContent()).toBe('hello');
      expect($getState(p, flatKey)).toBe('');
    });
  });

  test('the node importJSON returns is writable, so its properties stick', () => {
    // If the skipped getWritable() had been load-bearing, the writes would
    // land on a stale version and the reconciled state would not see them.
    const editor = editorWith();
    editor.update(
      () => {
        const node = ParagraphNode.importJSON({
          children: [],
          direction: null,
          format: '',
          indent: 3,
          type: 'paragraph',
          version: 1,
        });
        invariant($isParagraphNode(node), 'expected a paragraph');
        $getRoot()
          .clear()
          .append(node.append($createTextNode('y')));
      },
      {discrete: true},
    );
    editor.read(() => {
      const p = $getRoot().getFirstChildOrThrow();
      invariant($isParagraphNode(p), 'expected a paragraph');
      expect(p.getIndent()).toBe(3);
      expect(p.getTextContent()).toBe('y');
    });
  });
});

describe('set-valued state (arraySetValue)', () => {
  const tagsState = createState('tags', {parse: arraySetValue(stringSchema())});

  function $paragraphWithTags(tags: readonly string[]): ParagraphNode {
    const p = $setState($createParagraphNode(), tagsState, tags);
    $getRoot().clear().append(p);
    return p;
  }

  function createSetEditor() {
    return createEditor({
      namespace: '',
      onError: err => {
        throw err;
      },
    });
  }

  test('the value is a readonly array, and the schema says it is a set', () => {
    expectTypeOf(tagsState).toEqualTypeOf<
      StateConfig<'tags', readonly string[]>
    >();
    expect(tagsState.defaultValue).toEqual([]);
    expect(Object.isFrozen(tagsState.defaultValue)).toBe(true);
    const {schema} = tagsState;
    invariant(schema !== undefined, 'expected a schema');
    // The kind code outside the core reads
    expect(schema.meta.kind).toBe('set');
    expect(schema.meta.kind === 'set' && schema.meta.item.meta.kind).toBe(
      'string',
    );
  });

  test('parsing drops duplicates and rejected entries, sorts and freezes', () => {
    const parsed = tagsState.parse(['b', 'a', 'b', 1, null, undefined, 'c']);
    expect(parsed).toEqual(['a', 'b', 'c']);
    expect(Object.isFrozen(parsed)).toBe(true);
    // Sorted by UTF-16 code unit, as Array.prototype.sort does
    expect(tagsState.parse(['b', 'B', 'a', 'é', 'e'])).toEqual([
      'B',
      'a',
      'b',
      'e',
      'é',
    ]);
    for (const notAnArray of ['a', undefined, null, 1, {a: true}]) {
      const empty = tagsState.parse(notAnArray);
      expect(empty).toEqual([]);
      expect(Object.isFrozen(empty)).toBe(true);
    }
    // A value that is already canonical is kept as is
    expect(tagsState.parse(parsed)).toBe(parsed);
    // An unfrozen or unsorted one is not
    const unfrozen = ['a', 'b'];
    expect(tagsState.parse(unfrozen)).not.toBe(unfrozen);
    const sizeState = createState('size', {
      parse: arraySetValue(enumValue(['s', 'm', 'l'])),
    });
    expectTypeOf(sizeState).toEqualTypeOf<
      StateConfig<'size', readonly ('s' | 'm' | 'l')[]>
    >();
    expect(sizeState.parse(['xl', 'l', 's', 'l'])).toEqual(['l', 's']);
    expect(sizeState.parse(Object.freeze(['l', 'xl']))).toEqual(['l']);
  });

  test('the value is frozen, so mutating it in place throws', () => {
    // Test modules are ES modules, so strict mode code
    const parsed = tagsState.parse(['b', 'a']) as string[];
    expect(() => parsed.push('c')).toThrow(TypeError);
    expect(() => parsed.sort()).toThrow(TypeError);
    expect(() => {
      parsed[0] = 'z';
    }).toThrow(TypeError);
    expect(parsed).toEqual(['a', 'b']);
    const editor = createSetEditor();
    editor.update(
      () => {
        const p = $paragraphWithTags(['b', 'a']);
        const stored = $getState(p, tagsState) as string[];
        expect(() => stored.push('c')).toThrow(TypeError);
        expect($getState(p, tagsState)).toEqual(['a', 'b']);
      },
      {discrete: true},
    );
  });

  test('$setState stores unsorted or duplicated input in the canonical form', () => {
    const editor = createSetEditor();
    let key = '';
    editor.update(
      () => {
        const p = $paragraphWithTags(['b', 'a', 'a']);
        key = p.getKey();
        const stored = $getState(p, tagsState);
        expect(stored).toEqual(['a', 'b']);
        expect(Object.isFrozen(stored)).toBe(true);
        // An updater's result is canonicalized too
        $setState(p, tagsState, prev => [...prev, 'c', 'a', 'c']);
        expect($getState(p, tagsState)).toEqual(['a', 'b', 'c']);
        expect(Object.isFrozen($getState(p, tagsState))).toBe(true);
        expect(p.exportJSON()[NODE_STATE_KEY]).toEqual({tags: ['a', 'b', 'c']});
      },
      {discrete: true},
    );
    editor.read(() => {
      const p = $getNodeByKeyOrThrow(key);
      expect($getState(p, tagsState)).toEqual(['a', 'b', 'c']);
      expect(Object.isFrozen($getState(p, tagsState))).toBe(true);
    });
  });

  test('equality is element by element on the canonical form', () => {
    const ab = tagsState.parse(['a', 'b']);
    expect(tagsState.isEqual(ab, tagsState.parse(['b', 'a', 'b']))).toBe(true);
    expect(tagsState.isEqual(ab, ['a', 'b'])).toBe(true);
    expect(tagsState.isEqual(ab, tagsState.parse(['a']))).toBe(false);
    expect(tagsState.isEqual(ab, tagsState.parse(['a', 'c']))).toBe(false);
    // Total: not an array is not equal
    expect(tagsState.isEqual(ab, 'a,b' as never)).toBe(false);
  });

  test('the JSON is one sorted array, and the empty set is omitted', () => {
    const editor = createSetEditor();
    editor.update(
      () => {
        const p = $paragraphWithTags(['c', 'a', 'b']);
        expect(p.exportJSON()[NODE_STATE_KEY]).toEqual({tags: ['a', 'b', 'c']});
        $setState(p, tagsState, []);
        expect(p.exportJSON()).not.toHaveProperty(NODE_STATE_KEY);
        $setState(p, tagsState, ['a', 'a']);
        expect(p.exportJSON()[NODE_STATE_KEY]).toEqual({tags: ['a']});
      },
      {discrete: true},
    );
  });

  test('setting the same members in another order does not mark the node dirty', () => {
    const editor = createSetEditor();
    let key = '';
    editor.update(
      () => {
        key = $paragraphWithTags(['a', 'b']).getKey();
      },
      {discrete: true},
    );
    const dirty: string[] = [];
    editor.registerUpdateListener(({dirtyElements, dirtyLeaves}) => {
      dirty.push(...dirtyElements.keys(), ...dirtyLeaves);
    });
    editor.update(
      () => {
        const p = $getRoot().getFirstChildOrThrow();
        $setState(p, tagsState, () => ['b', 'a', 'b']);
        // Returning the previous value as is
        $setState(p, tagsState, prev => prev);
      },
      {discrete: true},
    );
    expect(dirty).not.toContain(key);
  });

  test('the JSON is canonical and stable across a round trip', () => {
    // Declared for the node type, so JSON is parsed when it is loaded
    class TagsParagraphNode extends ParagraphNode {
      $config() {
        return this.config('tags-paragraph', {
          extends: ParagraphNode,
          stateConfigs: [{stateConfig: tagsState}],
        });
      }
    }
    const createTagsEditor = () =>
      createEditor({
        namespace: '',
        nodes: [TagsParagraphNode],
        onError: err => {
          throw err;
        },
      });
    const editor = createTagsEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($setState($create(TagsParagraphNode), tagsState, ['b', 'a']));
      },
      {discrete: true},
    );
    const json = JSON.stringify(editor.getEditorState().toJSON());
    expect(json).toContain('"$":{"tags":["a","b"]}');
    // Unordered, duplicated input with an entry out of the item's domain is
    // the same set, and is written back canonical without being read
    const unordered = json.replace('["a","b"]', '["b","a","b",7]');
    for (const input of [json, unordered]) {
      const loaded = createTagsEditor();
      loaded.setEditorState(loaded.parseEditorState(input));
      expect(JSON.stringify(loaded.getEditorState().toJSON())).toBe(json);
      loaded.read(() => {
        const value = $getState($getRoot().getFirstChildOrThrow(), tagsState);
        expect(value).toEqual(['a', 'b']);
        expect(Object.isFrozen(value)).toBe(true);
      });
    }
  });

  test('an unparse of its own still wins', () => {
    const csvState = createState('csv', {
      parse: arraySetValue(stringSchema()),
      unparse: (v: readonly string[]) => v.join(','),
    });
    expect(csvState.unparse(csvState.parse(['b', 'a']))).toBe('a,b');
  });

  test('an arraySetValue can only be the whole value of a createState', () => {
    const item = stringSchema();
    for (const build of [
      () => arrayValue(arraySetValue(item)),
      () => nullable(arraySetValue(item)),
      () => arraySetValue(arraySetValue(item) as never),
      () => objectValue({tags: arraySetValue(item)}),
      () => withField(arraySetValue(item), {field: '__tags'}),
      () => nodeSchema<ParagraphNode>()({tags: arraySetValue(item)} as never),
      () => optional(arraySetValue(item)),
      () => unionValue([arraySetValue(item) as never, stringSchema()]),
      () => aliasedValue(arraySetValue(item) as never, {}),
      () => transformValue(arraySetValue(item), v => v.length),
    ]) {
      expect(build).toThrow(/arraySetValue can only be the whole value/);
    }
  });

  test('the item schema must produce strings', () => {
    expect(() => arraySetValue(numberValue() as never)).toThrow(
      /the item schema must produce strings/,
    );
  });

  test('an item schema that declines some strings drops them', () => {
    const word = Object.assign(
      (value: unknown) => (typeof value === 'string' ? value : ''),
      {
        accepts: (value: unknown) =>
          typeof value === 'string' && /^\w+$/.test(value),
        defaultValue: '',
        meta: {kind: 'string'} as const,
      },
    );
    const parse = arraySetValue(word);
    expect(parse(['b', 'a b', '', 'a', 7])).toEqual(['a', 'b']);
    expect(parse(Object.freeze(['a', 'b c']))).toEqual(['a']);
  });

  test('a frozen value that is not canonical is still canonicalized', () => {
    for (const [input, expected] of [
      [['a', 'a'], ['a']],
      [
        ['b', 'a'],
        ['a', 'b'],
      ],
      [['a', 1], ['a']],
      [[], []],
    ] as const) {
      const frozen = Object.freeze(input.slice());
      const parsed = tagsState.parse(frozen);
      expect(parsed).toEqual(expected);
      expect(Object.isFrozen(parsed)).toBe(true);
      if (input.length > 0) {
        expect(parsed).not.toBe(frozen);
      }
    }
    // A canonical frozen value is kept as is
    const canonical = Object.freeze(['a', 'b']);
    expect(tagsState.parse(canonical)).toBe(canonical);
    const editor = createSetEditor();
    editor.update(
      () => {
        const p = $paragraphWithTags([]);
        $setState(p, tagsState, Object.freeze(['b', 'a', 'a']));
        expect($getState(p, tagsState)).toEqual(['a', 'b']);
      },
      {discrete: true},
    );
  });

  test('a state that is not declared is canonical when it is read after loading JSON', () => {
    const editor = createSetEditor();
    editor.update(
      () => {
        $paragraphWithTags(['a']);
      },
      {discrete: true},
    );
    const json = JSON.stringify(editor.getEditorState().toJSON()).replace(
      '["a"]',
      '["b","a","b"]',
    );
    const loaded = createSetEditor();
    loaded.setEditorState(loaded.parseEditorState(json));
    loaded.read(() => {
      const value = $getState($getRoot().getFirstChildOrThrow(), tagsState);
      expect(value).toEqual(['a', 'b']);
      expect(Object.isFrozen(value)).toBe(true);
    });
  });
});

describe('$setState stores the value as given for every state that is not an arraySetValue', () => {
  test('arrayValue, a hand-written parse and an updater keep the exact reference', () => {
    const listState = createState('list', {parse: arrayValue(stringSchema())});
    const handState = createState('hand', {
      parse: (v: unknown) => (Array.isArray(v) ? (v as string[]) : []),
    });
    const objectState = createState('object', {
      parse: objectValue({a: stringSchema()}),
    });
    const editor = createEditor({
      namespace: '',
      onError: err => {
        throw err;
      },
    });
    editor.update(
      () => {
        const p = $createParagraphNode();
        $getRoot().clear().append(p);
        const list = ['b', 'a', 'a'];
        $setState(p, listState, list);
        expect($getState(p, listState)).toBe(list);
        expect(Object.isFrozen(list)).toBe(false);
        const hand = ['b', 'a'];
        $setState(p, handState, hand);
        expect($getState(p, handState)).toBe(hand);
        const updated = ['z', 'y'];
        $setState(p, listState, () => updated);
        expect($getState(p, listState)).toBe(updated);
        const object = {a: 'x'};
        $setState(p, objectState, object);
        expect($getState(p, objectState)).toBe(object);
        // Out of the parse's domain, and still stored as given
        $setState(p, handState, 'not an array' as never);
        expect($getState(p, handState)).toBe('not an array');
      },
      {discrete: true},
    );
  });
});
