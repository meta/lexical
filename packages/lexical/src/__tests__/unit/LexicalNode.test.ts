/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import invariant from '@lexical/internal/invariant';
import {
  $cloneWithProperties,
  $create,
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTabNode,
  $createTextNode,
  $getNodeByKey,
  $getNodeByKeyOrThrow,
  $getRoot,
  $getSelection,
  $isDecoratorNode,
  $isElementNode,
  $isRangeSelection,
  $isTabNode,
  $setSelection,
  createEditor,
  DecoratorNode,
  type EditorConfig,
  ElementNode,
  type LexicalEditor,
  type NodeKey,
  ParagraphNode,
  type RangeSelection,
  type TabNode,
  TextNode,
} from 'lexical';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from 'vitest';

import {LexicalNode} from '../../LexicalNode';
import {
  $createTestElementNode,
  $createTestInlineElementNode,
  initializeUnitTest,
  TestElementNode,
  TestInlineElementNode,
} from '../utils';

export class TestNode extends LexicalNode {
  $config() {
    return this.config('test', {extends: LexicalNode});
  }

  createDOM() {
    return document.createElement('div');
  }
}

class InlineDecoratorNode extends DecoratorNode<string> {
  $config() {
    return this.config('inline-decorator', {extends: DecoratorNode});
  }

  createDOM(): HTMLElement {
    return document.createElement('span');
  }

  isInline(): true {
    return true;
  }

  isParentRequired(): true {
    return true;
  }

  decorate() {
    return 'inline-decorator';
  }
}

class BlockDecoratorNode extends DecoratorNode<string> {
  $config() {
    return this.config('block-decorator', {extends: DecoratorNode});
  }

  createDOM(): HTMLElement {
    return document.createElement('div');
  }

  isInline(): false {
    return false;
  }

  decorate() {
    return 'block-decorator';
  }
}

describe('LexicalNode tests', () => {
  beforeAll(() => {
    // Give the abstract base a concrete type for `new LexicalNode()` tests, but
    // delegate for subclasses: now that ported nodes derive their type from
    // `$config` (instead of their own static `getType`), they reach this base
    // method until `getStaticNodeConfig` injects their own, so it must resolve
    // the real type rather than collapsing every subclass to 'node'.
    const realGetType = LexicalNode.getType;
    vi.spyOn(LexicalNode, 'getType').mockImplementation(function (
      this: typeof LexicalNode,
    ) {
      return this === LexicalNode ? 'node' : realGetType.call(this);
    });
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });
  initializeUnitTest(
    testEnv => {
      let paragraphNode: ParagraphNode;
      let textNode: TextNode;

      beforeEach(async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const rootNode = $getRoot();
          paragraphNode = new ParagraphNode();
          textNode = new TextNode('foo');
          paragraphNode.append(textNode);
          rootNode.append(paragraphNode);
        });
      });

      test('LexicalNode.constructor', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const node = new LexicalNode('__custom_key__');
          expect(node.__type).toBe('node');
          expect(node.__key).toBe('__custom_key__');
          expect(node.__parent).toBe(null);
        });

        // Intentionally read without an active editor (no {editor} context)
        // so that constructing a keyed node throws via getActiveEditor().
        await editor.getEditorState().read(() => {
          expect(() => new LexicalNode()).toThrow();
          expect(() => new LexicalNode('__custom_key__')).toThrow();
        });
      });

      test('LexicalNode.constructor: type change detected', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const validNode = new TextNode(textNode.__text, textNode.__key);
          expect(textNode.getLatest()).toBe(textNode);
          expect(validNode.getLatest()).toBe(textNode);
          expect(() => new TestNode(textNode.__key)).toThrow(
            /TestNode.*re-use key.*TextNode/,
          );
        });
      });

      test('LexicalNode.clone()', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const node = new LexicalNode('__custom_key__');

          expect(() => LexicalNode.clone(node)).toThrow();
        });
      });
      test('LexicalNode.afterCloneFrom()', () => {
        class VersionedTextNode extends TextNode {
          // declare ['constructor']: KlassConstructor<typeof VersionedTextNode>;
          __version = 0;
          $config() {
            return this.config('vtext', {extends: TextNode});
          }
          afterCloneFrom(node: this): void {
            super.afterCloneFrom(node);
            this.__version = node.__version + 1;
          }
        }
        const editor = createEditor({
          nodes: [VersionedTextNode],
          onError(err) {
            throw err;
          },
        });
        let versionedTextNode: VersionedTextNode;

        editor.update(
          () => {
            versionedTextNode = new VersionedTextNode('test');
            $getRoot().append($createParagraphNode().append(versionedTextNode));
            expect(versionedTextNode.__version).toEqual(0);
          },
          {discrete: true},
        );
        editor.update(
          () => {
            expect(versionedTextNode.getLatest().__version).toEqual(0);
            expect(
              versionedTextNode.setTextContent('update').setMode('token')
                .__version,
            ).toEqual(1);
          },
          {discrete: true},
        );
        editor.update(
          () => {
            let latest = versionedTextNode.getLatest();
            expect(versionedTextNode.__version).toEqual(0);
            expect(versionedTextNode.__mode).toEqual(0);
            expect(versionedTextNode.getMode()).toEqual('token');
            expect(latest.__version).toEqual(1);
            expect(latest.__mode).toEqual(1);
            latest = latest.setTextContent('another update');
            expect(latest.__version).toEqual(2);
            expect(latest.getWritable().__version).toEqual(2);
            expect(
              versionedTextNode.getLatest().getWritable().__version,
            ).toEqual(2);
            expect(versionedTextNode.getLatest().__version).toEqual(2);
            expect(versionedTextNode.__mode).toEqual(0);
            expect(versionedTextNode.getLatest().__mode).toEqual(1);
            expect(versionedTextNode.getMode()).toEqual('token');
          },
          {discrete: true},
        );
      });

      test('LexicalNode.getType()', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const node = new LexicalNode('__custom_key__');
          expect(node.getType()).toEqual(node.__type);
        });
      });

      test('LexicalNode.isAttached()', async () => {
        const {editor} = testEnv;
        let node: LexicalNode;

        await editor.update(() => {
          node = new LexicalNode('__custom_key__');
        });

        await editor.read('latest', () => {
          expect(node.isAttached()).toBe(false);
          expect(textNode.isAttached()).toBe(true);
          expect(paragraphNode.isAttached()).toBe(true);
        });

        expect(() => textNode.isAttached()).toThrow();
      });

      test('LexicalNode.isSelected()', async () => {
        const {editor} = testEnv;
        let node: LexicalNode;

        await editor.update(() => {
          node = new LexicalNode('__custom_key__');
        });

        await editor.read('latest', () => {
          expect(node.isSelected()).toBe(false);
          expect(textNode.isSelected()).toBe(false);
          expect(paragraphNode.isSelected()).toBe(false);
        });

        await editor.update(() => {
          textNode.select(0, 0);
        });

        await editor.read('latest', () => {
          expect(textNode.isSelected()).toBe(true);
        });

        expect(() => textNode.isSelected()).toThrow();
      });

      test('LexicalNode.isSelected(): selected text node', async () => {
        const {editor} = testEnv;

        await editor.read('latest', () => {
          expect(paragraphNode.isSelected()).toBe(false);
          expect(textNode.isSelected()).toBe(false);
        });

        await editor.update(() => {
          textNode.select(0, 0);
        });

        await editor.read('latest', () => {
          expect(textNode.isSelected()).toBe(true);
          expect(paragraphNode.isSelected()).toBe(false);
        });
      });

      test('LexicalNode.isSelected(): selected block node range', async () => {
        const {editor} = testEnv;
        let newParagraphNode: ParagraphNode;
        let newTextNode: TextNode;

        await editor.update(() => {
          expect(paragraphNode.isSelected()).toBe(false);
          expect(textNode.isSelected()).toBe(false);
          newParagraphNode = new ParagraphNode();
          newTextNode = new TextNode('bar');
          newParagraphNode.append(newTextNode);
          paragraphNode.insertAfter(newParagraphNode);
          expect(newParagraphNode.isSelected()).toBe(false);
          expect(newTextNode.isSelected()).toBe(false);
        });

        await editor.update(() => {
          textNode.select(0, 0);
          const selection = $getSelection();

          expect(selection).not.toBe(null);

          if (!$isRangeSelection(selection)) {
            return;
          }

          selection.anchor.set(textNode.getKey(), 1, 'text');
          selection.focus.set(newTextNode.getKey(), 1, 'text');
        });

        await Promise.resolve().then();

        await editor.update(() => {
          const selection = $getSelection();

          if (!$isRangeSelection(selection)) {
            return;
          }

          expect(selection.anchor.key).toBe(textNode.getKey());
          expect(selection.focus.key).toBe(newTextNode.getKey());
          expect(paragraphNode.isSelected()).toBe(true);
          expect(textNode.isSelected()).toBe(true);
          expect(newParagraphNode.isSelected()).toBe(true);
          expect(newTextNode.isSelected()).toBe(true);
        });
      });

      test('LexicalNode.isSelected(): with custom range selection', async () => {
        const {editor} = testEnv;
        let newParagraphNode: ParagraphNode;
        let newTextNode: TextNode;

        await editor.update(() => {
          expect(paragraphNode.isSelected()).toBe(false);
          expect(textNode.isSelected()).toBe(false);
          newParagraphNode = new ParagraphNode();
          newTextNode = new TextNode('bar');
          newParagraphNode.append(newTextNode);
          paragraphNode.insertAfter(newParagraphNode);
          expect(newParagraphNode.isSelected()).toBe(false);
          expect(newTextNode.isSelected()).toBe(false);
        });

        await editor.update(() => {
          const rangeSelection = $createRangeSelection();

          rangeSelection.anchor.set(textNode.getKey(), 1, 'text');
          rangeSelection.focus.set(newTextNode.getKey(), 1, 'text');

          expect(paragraphNode.isSelected(rangeSelection)).toBe(true);
          expect(textNode.isSelected(rangeSelection)).toBe(true);
          expect(newParagraphNode.isSelected(rangeSelection)).toBe(true);
          expect(newTextNode.isSelected(rangeSelection)).toBe(true);
        });

        await Promise.resolve().then();
      });

      describe('LexicalNode.isSelected(): with inline decorator node', () => {
        let editor: LexicalEditor;
        let paragraphNode1: ParagraphNode;
        let paragraphNode2: ParagraphNode;
        let paragraphNode3: ParagraphNode;
        let inlineDecoratorNode: InlineDecoratorNode;
        let names: Record<NodeKey, string>;
        beforeEach(() => {
          editor = testEnv.editor;
          editor.update(() => {
            inlineDecoratorNode = new InlineDecoratorNode();
            paragraphNode1 = $createParagraphNode();
            paragraphNode2 = $createParagraphNode().append(inlineDecoratorNode);
            paragraphNode3 = $createParagraphNode();
            names = {
              [inlineDecoratorNode.getKey()]: 'd',
              [paragraphNode1.getKey()]: 'p1',
              [paragraphNode2.getKey()]: 'p2',
              [paragraphNode3.getKey()]: 'p3',
            };
            $getRoot()
              .clear()
              .append(paragraphNode1, paragraphNode2, paragraphNode3);
          });
        });
        const cases: {
          label: string;
          isSelected: boolean;
          update: () => void;
        }[] = [
          {
            isSelected: true,
            label: 'whole editor',
            update() {
              $getRoot().select(0);
            },
          },
          {
            isSelected: true,
            label: 'containing paragraph',
            update() {
              paragraphNode2.select(0);
            },
          },
          {
            isSelected: true,
            label: 'before and containing',
            update() {
              paragraphNode2
                .select(0)
                .anchor.set(paragraphNode1.getKey(), 0, 'element');
            },
          },
          {
            isSelected: true,
            label: 'containing and after',
            update() {
              paragraphNode2
                .select(0)
                .focus.set(paragraphNode3.getKey(), 0, 'element');
            },
          },
          {
            isSelected: true,
            label: 'before and after',
            update() {
              paragraphNode1
                .select(0)
                .focus.set(paragraphNode3.getKey(), 0, 'element');
            },
          },
          {
            isSelected: false,
            label: 'collapsed before',
            update() {
              paragraphNode2.select(0, 0);
            },
          },
          {
            isSelected: false,
            label: 'in another element',
            update() {
              paragraphNode1.select(0);
            },
          },
          {
            isSelected: false,
            label: 'before',
            update() {
              paragraphNode1
                .select(0)
                .focus.set(paragraphNode2.getKey(), 0, 'element');
            },
          },
          {
            isSelected: false,
            label: 'collapsed after',
            update() {
              paragraphNode2.selectEnd();
            },
          },
          {
            isSelected: false,
            label: 'after',
            update() {
              paragraphNode3
                .select(0)
                .anchor.set(
                  paragraphNode2.getKey(),
                  paragraphNode2.getChildrenSize(),
                  'element',
                );
            },
          },
        ];
        for (const {label, isSelected, update} of cases) {
          test(`${isSelected ? 'is' : "isn't"} selected ${label}`, () => {
            editor.update(update);
            const $verify = () => {
              const selection = $getSelection() as RangeSelection;
              expect($isRangeSelection(selection)).toBe(true);
              const dbg = [selection.anchor, selection.focus]
                .map(
                  point => `(${names[point.key] || point.key}:${point.offset})`,
                )
                .join(' ');
              const nodes = `[${selection
                .getNodes()
                .map(k => names[k.__key] || k.__key)
                .join(',')}]`;
              expect([dbg, nodes, inlineDecoratorNode.isSelected()]).toEqual([
                dbg,
                nodes,
                isSelected,
              ]);
            };
            editor.read($verify);
            editor.update(() => {
              const selection = $getSelection();
              if ($isRangeSelection(selection)) {
                const backwards = $createRangeSelection();
                backwards.anchor.set(
                  selection.focus.key,
                  selection.focus.offset,
                  selection.focus.type,
                );
                backwards.focus.set(
                  selection.anchor.key,
                  selection.anchor.offset,
                  selection.anchor.type,
                );
                $setSelection(backwards);
              }
              expect($isRangeSelection(selection)).toBe(true);
            });
            editor.read($verify);
          });
        }
      });

      test('LexicalNode.getKey()', async () => {
        expect(textNode.getKey()).toEqual(textNode.__key);
      });

      test('LexicalNode.getParent()', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const node = new LexicalNode();
          expect(node.getParent()).toBe(null);
        });

        await editor.read('latest', () => {
          const rootNode = $getRoot();
          expect(textNode.getParent()).toBe(paragraphNode);
          expect(paragraphNode.getParent()).toBe(rootNode);
        });
        expect(() => textNode.getParent()).toThrow();
      });

      test('LexicalNode.getParentOrThrow()', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const node = new LexicalNode();
          expect(() => node.getParentOrThrow()).toThrow();
        });

        await editor.read('latest', () => {
          const rootNode = $getRoot();
          expect(textNode.getParent()).toBe(paragraphNode);
          expect(paragraphNode.getParent()).toBe(rootNode);
        });
        expect(() => textNode.getParentOrThrow()).toThrow();
      });

      test('LexicalNode.getTopLevelElement()', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const node = new LexicalNode();
          expect(node.getTopLevelElement()).toBe(null);
        });

        await editor.read('latest', () => {
          expect(textNode.getTopLevelElement()).toBe(paragraphNode);
          expect(paragraphNode.getTopLevelElement()).toBe(paragraphNode);
        });
        expect(() => textNode.getTopLevelElement()).toThrow();
        await editor.update(() => {
          const node = new BlockDecoratorNode();
          expect(node.getTopLevelElement()).toBe(null);
          $getRoot().append(node);
          expect(node.getTopLevelElement()).toBe(node);
        });
        editor.read('latest', () => {
          const elementNodes: ElementNode[] = [];
          const decoratorNodes: DecoratorNode<unknown>[] = [];
          for (const child of $getRoot().getChildren()) {
            expect(child.getTopLevelElement()).toBe(child);
            if ($isElementNode(child)) {
              elementNodes.push(child);
            } else if ($isDecoratorNode(child)) {
              decoratorNodes.push(child);
            } else {
              throw new Error(
                'Expecting all children to be ElementNode or DecoratorNode',
              );
            }
          }
          expect(decoratorNodes).toHaveLength(1);
          expect(elementNodes).toHaveLength(1);
        });
      });

      test('LexicalNode.getTopLevelElementOrThrow()', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const node = new LexicalNode();
          expect(() => node.getTopLevelElementOrThrow()).toThrow();
        });

        await editor.read('latest', () => {
          expect(textNode.getTopLevelElementOrThrow()).toBe(paragraphNode);
          expect(paragraphNode.getTopLevelElementOrThrow()).toBe(paragraphNode);
        });
        expect(() => textNode.getTopLevelElementOrThrow()).toThrow();
        await editor.update(() => {
          const node = new InlineDecoratorNode();
          expect(() => node.getTopLevelElementOrThrow()).toThrow();
          $getRoot().append(node);
          expect(node.getTopLevelElementOrThrow()).toBe(node);
        });
      });

      test('LexicalNode.getParents()', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const node = new LexicalNode();
          expect(node.getParents()).toEqual([]);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.read('latest', () => {
          const rootNode = $getRoot();
          expect(textNode.getParents()).toEqual([paragraphNode, rootNode]);
          expect(paragraphNode.getParents()).toEqual([rootNode]);
        });
        expect(() => textNode.getParents()).toThrow();
      });

      test('LexicalNode.getPreviousSibling()', async () => {
        const {editor} = testEnv;
        let barTextNode: TextNode;

        await editor.update(() => {
          barTextNode = new TextNode('bar');
          barTextNode.toggleUnmergeable();
          paragraphNode.append(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span><span data-lexical-text="true">bar</span></p></div>',
        );

        await editor.read('latest', () => {
          expect(barTextNode.getPreviousSibling()).toEqual({
            ...textNode,
            __next: '3',
          });
          expect(textNode.getPreviousSibling()).toEqual(null);
        });
        expect(() => textNode.getPreviousSibling()).toThrow();
      });

      test('LexicalNode.getPreviousSiblings()', async () => {
        const {editor} = testEnv;
        let barTextNode: TextNode;
        let bazTextNode: TextNode;

        await editor.update(() => {
          barTextNode = new TextNode('bar');
          barTextNode.toggleUnmergeable();
          bazTextNode = new TextNode('baz');
          bazTextNode.toggleUnmergeable();
          paragraphNode.append(barTextNode, bazTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span><span data-lexical-text="true">bar</span><span data-lexical-text="true">baz</span></p></div>',
        );

        await editor.read('latest', () => {
          expect(bazTextNode.getPreviousSiblings()).toEqual([
            {
              ...textNode,
              __next: '3',
            },
            {
              ...barTextNode,
              __prev: '2',
            },
          ]);
          expect(barTextNode.getPreviousSiblings()).toEqual([
            {
              ...textNode,
              __next: '3',
            },
          ]);
          expect(textNode.getPreviousSiblings()).toEqual([]);
        });
        expect(() => textNode.getPreviousSiblings()).toThrow();
      });

      test('LexicalNode.getNextSibling()', async () => {
        const {editor} = testEnv;
        let barTextNode: TextNode;

        await editor.update(() => {
          barTextNode = new TextNode('bar');
          barTextNode.toggleUnmergeable();
          paragraphNode.append(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span><span data-lexical-text="true">bar</span></p></div>',
        );

        await editor.read('latest', () => {
          expect(barTextNode.getNextSibling()).toEqual(null);
          expect(textNode.getNextSibling()).toEqual(barTextNode);
        });
        expect(() => textNode.getNextSibling()).toThrow();
      });

      test('LexicalNode.getNextSiblings()', async () => {
        const {editor} = testEnv;
        let barTextNode: TextNode;
        let bazTextNode: TextNode;

        await editor.update(() => {
          barTextNode = new TextNode('bar');
          barTextNode.toggleUnmergeable();
          bazTextNode = new TextNode('baz');
          bazTextNode.toggleUnmergeable();
          paragraphNode.append(barTextNode, bazTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span><span data-lexical-text="true">bar</span><span data-lexical-text="true">baz</span></p></div>',
        );

        await editor.read('latest', () => {
          expect(bazTextNode.getNextSiblings()).toEqual([]);
          expect(barTextNode.getNextSiblings()).toEqual([bazTextNode]);
          expect(textNode.getNextSiblings()).toEqual([
            barTextNode,
            bazTextNode,
          ]);
        });
        expect(() => textNode.getNextSiblings()).toThrow();
      });

      test('LexicalNode.getCommonAncestor()', async () => {
        const {editor} = testEnv;
        let quxTextNode: TextNode;
        let barParagraphNode: ParagraphNode;
        let barTextNode: TextNode;
        let bazParagraphNode: ParagraphNode;
        let bazTextNode: TextNode;

        editor.update(
          () => {
            const rootNode = $getRoot();
            barParagraphNode = new ParagraphNode();
            barTextNode = new TextNode('bar');
            barTextNode.toggleUnmergeable();
            bazParagraphNode = new ParagraphNode();
            bazTextNode = new TextNode('baz');
            bazTextNode.toggleUnmergeable();
            expect(bazTextNode.getCommonAncestor(bazTextNode)).toBe(null);
            quxTextNode = new TextNode('qux');
            quxTextNode.toggleUnmergeable();
            paragraphNode.append(quxTextNode);
            expect(barTextNode.getCommonAncestor(bazTextNode)).toBe(null);
            barParagraphNode.append(barTextNode);
            bazParagraphNode.append(bazTextNode);
            expect(barTextNode.getCommonAncestor(bazTextNode)).toBe(null);
            expect(bazTextNode.getCommonAncestor(bazTextNode)).toBe(
              bazParagraphNode,
            );
            rootNode.append(barParagraphNode, bazParagraphNode);
          },
          {discrete: true},
        );

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span><span data-lexical-text="true">qux</span></p><p dir="auto"><span data-lexical-text="true">bar</span></p><p dir="auto"><span data-lexical-text="true">baz</span></p></div>',
        );

        await editor.read('latest', () => {
          const rootNode = $getRoot();
          expect(textNode.getCommonAncestor(rootNode)).toBe(rootNode);
          expect(quxTextNode.getCommonAncestor(rootNode)).toBe(rootNode);
          expect(barTextNode.getCommonAncestor(rootNode)).toBe(rootNode);
          expect(bazTextNode.getCommonAncestor(rootNode)).toBe(rootNode);
          expect(textNode.getCommonAncestor(quxTextNode)).toBe(
            paragraphNode.getLatest(),
          );
          expect(barTextNode.getCommonAncestor(bazTextNode)).toBe(rootNode);
          expect(barTextNode.getCommonAncestor(bazTextNode)).toBe(rootNode);
        });

        expect(() => textNode.getCommonAncestor(barTextNode)).toThrow();
      });

      test('LexicalNode.isBefore()', async () => {
        const {editor} = testEnv;
        let barTextNode: TextNode;
        let bazTextNode: TextNode;

        await editor.update(() => {
          barTextNode = new TextNode('bar');
          barTextNode.toggleUnmergeable();
          bazTextNode = new TextNode('baz');
          bazTextNode.toggleUnmergeable();
          paragraphNode.append(barTextNode, bazTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span><span data-lexical-text="true">bar</span><span data-lexical-text="true">baz</span></p></div>',
        );

        await editor.read('latest', () => {
          expect(textNode.isBefore(textNode)).toBe(false);
          expect(textNode.isBefore(barTextNode)).toBe(true);
          expect(textNode.isBefore(bazTextNode)).toBe(true);
          expect(barTextNode.isBefore(bazTextNode)).toBe(true);
          expect(bazTextNode.isBefore(barTextNode)).toBe(false);
          expect(bazTextNode.isBefore(textNode)).toBe(false);
        });
        expect(() => textNode.isBefore(barTextNode)).toThrow();
      });

      test('LexicalNode.isParentOf()', async () => {
        const {editor} = testEnv;

        await editor.read('latest', () => {
          const rootNode = $getRoot();
          expect(rootNode.isParentOf(textNode)).toBe(true);
          expect(rootNode.isParentOf(paragraphNode)).toBe(true);
          expect(paragraphNode.isParentOf(textNode)).toBe(true);
          expect(paragraphNode.isParentOf(rootNode)).toBe(false);
          expect(textNode.isParentOf(paragraphNode)).toBe(false);
          expect(textNode.isParentOf(rootNode)).toBe(false);
        });
        expect(() => paragraphNode.isParentOf(textNode)).toThrow();
      });

      test('LexicalNode.getNodesBetween()', async () => {
        const {editor} = testEnv;
        let barTextNode: TextNode;
        let bazTextNode: TextNode;
        let newParagraphNode: ParagraphNode;
        let quxTextNode: TextNode;

        await editor.update(() => {
          const rootNode = $getRoot();
          barTextNode = new TextNode('bar');
          barTextNode.toggleUnmergeable();
          bazTextNode = new TextNode('baz');
          bazTextNode.toggleUnmergeable();
          newParagraphNode = new ParagraphNode();
          quxTextNode = new TextNode('qux');
          quxTextNode.toggleUnmergeable();
          rootNode.append(newParagraphNode);
          paragraphNode.append(barTextNode, bazTextNode);
          newParagraphNode.append(quxTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span><span data-lexical-text="true">bar</span><span data-lexical-text="true">baz</span></p><p dir="auto"><span data-lexical-text="true">qux</span></p></div>',
        );

        await editor.read('latest', () => {
          expect(textNode.getNodesBetween(textNode)).toEqual([textNode]);
          expect(textNode.getNodesBetween(barTextNode)).toEqual([
            textNode,
            barTextNode,
          ]);
          expect(textNode.getNodesBetween(bazTextNode)).toEqual([
            textNode,
            barTextNode,
            bazTextNode,
          ]);
          expect(textNode.getNodesBetween(quxTextNode)).toEqual([
            textNode,
            barTextNode,
            bazTextNode,
            paragraphNode.getLatest(),
            newParagraphNode,
            quxTextNode,
          ]);
        });
        expect(() => textNode.getNodesBetween(bazTextNode)).toThrow();
      });

      test('LexicalNode.isToken()', async () => {
        const {editor} = testEnv;
        let tokenTextNode: TextNode;

        await editor.update(() => {
          tokenTextNode = new TextNode('token').setMode('token');
          paragraphNode.append(tokenTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span><span data-lexical-text="true">token</span></p></div>',
        );

        await editor.read('latest', () => {
          expect(textNode.isToken()).toBe(false);
          expect(tokenTextNode.isToken()).toBe(true);
        });
        expect(() => textNode.isToken()).toThrow();
      });

      test('LexicalNode.isSegmented()', async () => {
        const {editor} = testEnv;
        let segmentedTextNode: TextNode;

        await editor.update(() => {
          segmentedTextNode = new TextNode('segmented').setMode('segmented');
          paragraphNode.append(segmentedTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span><span data-lexical-text="true">segmented</span></p></div>',
        );

        await editor.read('latest', () => {
          expect(textNode.isSegmented()).toBe(false);
          expect(segmentedTextNode.isSegmented()).toBe(true);
        });
        expect(() => textNode.isSegmented()).toThrow();
      });

      test('LexicalNode.isDirectionless()', async () => {
        const {editor} = testEnv;
        let directionlessTextNode: TextNode;

        await editor.update(() => {
          directionlessTextNode = new TextNode(
            'directionless',
          ).toggleDirectionless();
          directionlessTextNode.toggleUnmergeable();
          paragraphNode.append(directionlessTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span><span data-lexical-text="true">directionless</span></p></div>',
        );

        await editor.read('latest', () => {
          expect(textNode.isDirectionless()).toBe(false);
          expect(directionlessTextNode.isDirectionless()).toBe(true);
        });
        expect(() => directionlessTextNode.isDirectionless()).toThrow();
      });

      test('LexicalNode.getLatest()', async () => {
        const {editor} = testEnv;

        await editor.read('latest', () => {
          expect(textNode.getLatest()).toBe(textNode);
        });
        expect(() => textNode.getLatest()).toThrow();
      });

      test('LexicalNode.getLatest(): garbage collected node', async () => {
        const {editor} = testEnv;
        let node: LexicalNode;
        let text: TextNode;
        let block: TestElementNode;

        await editor.update(() => {
          node = new LexicalNode();
          node.getLatest();
          text = new TextNode('');
          text.getLatest();
          block = new TestElementNode();
          block.getLatest();
        });

        await editor.update(() => {
          expect(() => node.getLatest()).toThrow();
          expect(() => text.getLatest()).toThrow();
          expect(() => block.getLatest()).toThrow();
        });
      });

      test('LexicalNode.getTextContent()', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const node = new LexicalNode();
          expect(node.getTextContent()).toBe('');
        });

        await editor.read('latest', () => {
          expect(textNode.getTextContent()).toBe('foo');
        });
        expect(() => textNode.getTextContent()).toThrow();
      });

      test('LexicalNode.getTextContentSize()', async () => {
        const {editor} = testEnv;

        await editor.read('latest', () => {
          expect(textNode.getTextContentSize()).toBe('foo'.length);
        });
        expect(() => textNode.getTextContentSize()).toThrow();
      });

      test('LexicalNode.createDOM()', async () => {
        const {editor} = testEnv;

        editor.update(() => {
          const node = new LexicalNode();
          expect(() =>
            node.createDOM(
              {
                namespace: '',
                theme: {},
              },
              editor,
            ),
          ).toThrow();
        });
      });

      test('LexicalNode.updateDOM()', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const node = new LexicalNode();
          // @ts-expect-error
          expect(() => node.updateDOM()).toThrow();
        });
      });

      test('LexicalNode.remove()', async () => {
        const {editor} = testEnv;

        await editor.read('latest', () => {
          expect(() => textNode.remove()).toThrow();
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.update(() => {
          const node = new LexicalNode();
          node.remove();
          expect(node.getParent()).toBe(null);
          textNode.remove();
          expect(textNode.getParent()).toBe(null);
          expect(editor._dirtyLeaves.has(textNode.getKey()));
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><br data-lexical-managed-linebreak="true"></p></div>',
        );
        expect(() => textNode.remove()).toThrow();
      });

      test('LexicalNode.replace()', async () => {
        const {editor} = testEnv;

        await editor.read('latest', () => {
          // @ts-expect-error
          expect(() => textNode.replace()).toThrow();
        });
        expect(() => textNode.remove()).toThrow();
      });

      test('LexicalNode.replace(): from another parent', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );
        let barTextNode: TextNode;

        await editor.update(() => {
          const rootNode = $getRoot();
          const barParagraphNode = new ParagraphNode();
          barTextNode = new TextNode('bar');
          barParagraphNode.append(barTextNode);
          rootNode.append(barParagraphNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p><p dir="auto"><span data-lexical-text="true">bar</span></p></div>',
        );

        await editor.update(() => {
          textNode.replace(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">bar</span></p><p dir="auto"><br data-lexical-managed-linebreak="true"></p></div>',
        );
      });

      test('LexicalNode.replace(): with a sibling in the same parent', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const paragraph = textNode.getParentOrThrow();
          const barTextNode = new TextNode('bar');
          paragraph.append(barTextNode);

          // Replacing a node with one of its own siblings must not leave the
          // parent's __size counting the sibling twice.
          textNode.replace(barTextNode);

          expect(paragraph.getChildrenSize()).toBe(1);
          expect(paragraph.getChildren()).toHaveLength(1);
          expect(paragraph.getFirstChild()!.getTextContent()).toBe('bar');
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">bar</span></p></div>',
        );
      });

      test('LexicalNode.replace(): text', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.update(() => {
          const barTextNode = new TextNode('bar');
          textNode.replace(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">bar</span></p></div>',
        );
      });

      test('LexicalNode.replace(): token', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.update(() => {
          const barTextNode = new TextNode('bar').setMode('token');
          textNode.replace(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">bar</span></p></div>',
        );
      });

      test('LexicalNode.replace(): segmented', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.update(() => {
          const barTextNode = new TextNode('bar').setMode('segmented');
          textNode.replace(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">bar</span></p></div>',
        );
      });

      test('LexicalNode.replace(): directionless', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.update(() => {
          const barTextNode = new TextNode(`bar`).toggleDirectionless();
          textNode.replace(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">bar</span></p></div>',
        );
        // TODO: add text direction validations
      });

      test('LexicalNode.replace() within canBeEmpty: false', async () => {
        const {editor} = testEnv;

        vi.spyOn(TestInlineElementNode.prototype, 'canBeEmpty').mockReturnValue(
          false,
        );

        await editor.update(() => {
          textNode = $createTextNode('Hello');

          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTestInlineElementNode().append(textNode),
              ),
            );

          textNode.replace($createTextNode('world'));
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><a><span data-lexical-text="true">world</span></a></p></div>',
        );
      });

      test('LexicalNode.insertAfter()', async () => {
        const {editor} = testEnv;

        await editor.read('latest', () => {
          // @ts-expect-error
          expect(() => textNode.insertAfter()).toThrow();
        });
        // @ts-expect-error
        expect(() => textNode.insertAfter()).toThrow();
      });

      test('LexicalNode.insertAfter(): text', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.update(() => {
          const barTextNode = new TextNode('bar');
          textNode.insertAfter(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foobar</span></p></div>',
        );
      });

      test('LexicalNode.insertAfter(): token', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.update(() => {
          const barTextNode = new TextNode('bar').setMode('token');
          textNode.insertAfter(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span><span data-lexical-text="true">bar</span></p></div>',
        );
      });

      test('LexicalNode.insertAfter(): segmented', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.update(() => {
          const barTextNode = new TextNode('bar').setMode('token');
          textNode.insertAfter(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span><span data-lexical-text="true">bar</span></p></div>',
        );
      });

      test('LexicalNode.insertAfter(): directionless', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.update(() => {
          const barTextNode = new TextNode(`bar`).toggleDirectionless();
          textNode.insertAfter(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foobar</span></p></div>',
        );
        // TODO: add text direction validations
      });

      test('LexicalNode.insertAfter() move blocks around', async () => {
        const {editor} = testEnv;
        let block1: ParagraphNode,
          block2: ParagraphNode,
          block3: ParagraphNode,
          text1: TextNode,
          text2: TextNode,
          text3: TextNode;

        await editor.update(() => {
          const root = $getRoot();
          root.clear();
          block1 = new ParagraphNode();
          block2 = new ParagraphNode();
          block3 = new ParagraphNode();
          text1 = new TextNode('A');
          text2 = new TextNode('B');
          text3 = new TextNode('C');
          block1.append(text1);
          block2.append(text2);
          block3.append(text3);
          root.append(block1, block2, block3);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">A</span></p><p dir="auto"><span data-lexical-text="true">B</span></p><p dir="auto"><span data-lexical-text="true">C</span></p></div>',
        );

        await editor.update(() => {
          text1.insertAfter(block2);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">A</span><p><span data-lexical-text="true">B</span></p></p><p dir="auto"><span data-lexical-text="true">C</span></p></div>',
        );
      });

      test('LexicalNode.insertAfter() move blocks around #2', async () => {
        const {editor} = testEnv;
        let block1: ParagraphNode,
          block2: ParagraphNode,
          block3: ParagraphNode,
          text1: TextNode,
          text2: TextNode,
          text3: TextNode;

        await editor.update(() => {
          const root = $getRoot();
          root.clear();
          block1 = new ParagraphNode();
          block2 = new ParagraphNode();
          block3 = new ParagraphNode();
          text1 = new TextNode('A');
          text1.toggleUnmergeable();
          text2 = new TextNode('B');
          text2.toggleUnmergeable();
          text3 = new TextNode('C');
          text3.toggleUnmergeable();
          block1.append(text1);
          block2.append(text2);
          block3.append(text3);
          root.append(block1);
          root.append(block2);
          root.append(block3);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">A</span></p><p dir="auto"><span data-lexical-text="true">B</span></p><p dir="auto"><span data-lexical-text="true">C</span></p></div>',
        );

        await editor.update(() => {
          text3.insertAfter(text1);
          text3.insertAfter(text2);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><br data-lexical-managed-linebreak="true"></p><p dir="auto"><br data-lexical-managed-linebreak="true"></p><p dir="auto"><span data-lexical-text="true">C</span><span data-lexical-text="true">B</span><span data-lexical-text="true">A</span></p></div>',
        );
      });

      test('LexicalNode.insertBefore()', async () => {
        const {editor} = testEnv;

        await editor.read('latest', () => {
          // @ts-expect-error
          expect(() => textNode.insertBefore()).toThrow();
        });
        // @ts-expect-error
        expect(() => textNode.insertBefore()).toThrow();
      });

      test('LexicalNode.insertBefore(): from another parent', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );
        let barTextNode;

        await editor.update(() => {
          const rootNode = $getRoot();
          const barParagraphNode = new ParagraphNode();
          barTextNode = new TextNode('bar');
          barParagraphNode.append(barTextNode);
          rootNode.append(barParagraphNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p><p dir="auto"><span data-lexical-text="true">bar</span></p></div>',
        );
      });

      test('LexicalNode.insertBefore(): text', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.update(() => {
          const barTextNode = new TextNode('bar');
          textNode.insertBefore(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">barfoo</span></p></div>',
        );
      });

      test('LexicalNode.insertBefore(): token', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.update(() => {
          const barTextNode = new TextNode('bar').setMode('token');
          textNode.insertBefore(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">bar</span><span data-lexical-text="true">foo</span></p></div>',
        );
      });

      test('LexicalNode.insertBefore(): segmented', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.update(() => {
          const barTextNode = new TextNode('bar').setMode('segmented');
          textNode.insertBefore(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">bar</span><span data-lexical-text="true">foo</span></p></div>',
        );
      });

      test('LexicalNode.insertBefore(): directionless', async () => {
        const {editor} = testEnv;

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">foo</span></p></div>',
        );

        await editor.update(() => {
          const barTextNode = new TextNode(`bar`).toggleDirectionless();
          textNode.insertBefore(barTextNode);
        });

        expect(testEnv.outerHTML).toBe(
          '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">barfoo</span></p></div>',
        );
      });

      test('LexicalNode.selectNext()', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const barTextNode = new TextNode('bar');
          textNode.insertAfter(barTextNode);

          expect(barTextNode.isSelected()).not.toBe(true);

          textNode.selectNext();

          expect(barTextNode.isSelected()).toBe(true);
          // TODO: additional validation of anchorOffset and focusOffset
        });
      });

      test('LexicalNode.selectNext(): no next sibling', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const selection = textNode.selectNext();
          expect(selection.anchor.getNode()).toBe(paragraphNode);
          expect(selection.anchor.offset).toBe(1);
        });
      });

      test('LexicalNode.selectNext(): non-text node', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const barNode = new TestNode();
          textNode.insertAfter(barNode);
          const selection = textNode.selectNext();

          expect(selection.anchor.getNode()).toBe(textNode.getParent());
          expect(selection.anchor.offset).toBe(1);
        });
      });
      describe('LexicalNode.$config()', () => {
        test('importJSON() with no boilerplate', () => {
          class CustomTextNode extends TextNode {
            $config() {
              return this.config('custom-text', {extends: TextNode});
            }
          }
          const editor = createEditor({
            nodes: [CustomTextNode],
            onError(err) {
              throw err;
            },
          });
          editor.update(
            () => {
              const node = CustomTextNode.importJSON({
                detail: 0,
                format: 0,
                mode: 'normal',
                style: '',
                text: 'codegen!',
                type: 'custom-text',
                version: 1,
              });
              expect(node).toBeInstanceOf(CustomTextNode);
              expect(node.getType()).toBe('custom-text');
              expect(node.getTextContent()).toBe('codegen!');
            },
            {discrete: true},
          );
        });
        test('clone() with no boilerplate', () => {
          class SNCVersionedTextNode extends TextNode {
            __version = 0;
            $config() {
              return this.config('snc-vtext', {});
            }
            afterCloneFrom(node: this): void {
              super.afterCloneFrom(node);
              this.__version = node.__version + 1;
            }
          }
          const editor = createEditor({
            nodes: [SNCVersionedTextNode],
            onError(err) {
              throw err;
            },
          });
          let versionedTextNode: SNCVersionedTextNode;

          editor.update(
            () => {
              versionedTextNode =
                $create(SNCVersionedTextNode).setTextContent('test');
              $getRoot().append(
                $createParagraphNode().append(versionedTextNode),
              );
              expect(versionedTextNode.__version).toEqual(0);
            },
            {discrete: true},
          );
          editor.update(
            () => {
              expect(versionedTextNode.getLatest().__version).toEqual(0);
              const latest = versionedTextNode
                .setTextContent('update')
                .setMode('token');
              expect(latest).toMatchObject({
                __text: 'update',
                __version: 1,
              });
              expect(versionedTextNode).toMatchObject({
                __text: 'test',
                __version: 0,
              });
            },
            {discrete: true},
          );
          editor.update(
            () => {
              let latest = versionedTextNode.getLatest();
              expect(versionedTextNode.__version).toEqual(0);
              expect(versionedTextNode.__mode).toEqual(0);
              expect(versionedTextNode.getMode()).toEqual('token');
              expect(latest.__version).toEqual(1);
              expect(latest.__mode).toEqual(1);
              latest = latest.setTextContent('another update');
              expect(latest.__version).toEqual(2);
              expect(latest.getWritable().__version).toEqual(2);
              expect(
                versionedTextNode.getLatest().getWritable().__version,
              ).toEqual(2);
              expect(versionedTextNode.getLatest().__version).toEqual(2);
              expect(versionedTextNode.__mode).toEqual(0);
              expect(versionedTextNode.getLatest().__mode).toEqual(1);
              expect(versionedTextNode.getMode()).toEqual('token');
            },
            {discrete: true},
          );
        });
        // Regression test for the $config() clone auto-synthesis BC break:
        // a node that drops its explicit static clone() in favor of $config()
        // gets a zero-arg auto-clone. When that auto-clone is invoked directly
        // (NodeClass.clone(node) / node.constructor.clone(node)) rather than
        // through $cloneWithProperties, it must still copy the source node's
        // properties via afterCloneFrom, otherwise callers silently get a
        // default-constructed node with lost state.
        test('direct clone() of an auto-synthesized node preserves properties', () => {
          class ConfigTagNode extends ElementNode {
            __tag: string = 'default';
            $config() {
              return this.config('config-tag', {extends: ElementNode});
            }
            afterCloneFrom(node: this): void {
              super.afterCloneFrom(node);
              this.__tag = node.__tag;
            }
            setTag(tag: string): this {
              const self = this.getWritable();
              self.__tag = tag;
              return self;
            }
          }
          const editor = createEditor({
            nodes: [ConfigTagNode],
            onError(err) {
              throw err;
            },
          });
          editor.update(
            () => {
              const source = $create(ConfigTagNode).setTag('custom');
              $getRoot().append(source);
              expect(source.__tag).toBe('custom');
              // Direct call to the auto-synthesized clone (the idiomatic,
              // pre-#8640 pattern) must not lose __tag.
              const directClone = ConfigTagNode.clone(source) as ConfigTagNode;
              expect(directClone.__tag).toBe('custom');
              // Going through $cloneWithProperties must remain correct too.
              const wrapperClone = $cloneWithProperties(source);
              expect(wrapperClone.__tag).toBe('custom');
            },
            {discrete: true},
          );
        });
        // afterCloneFrom is not guaranteed idempotent — some nodes accumulate
        // state there (e.g. incrementing a version counter). It must therefore
        // run exactly once per clone regardless of call path, so the direct-call
        // fix above must NOT cause $cloneWithProperties to double-apply it.
        test('afterCloneFrom runs exactly once for auto-synthesized clone', () => {
          class ConfigVersionNode extends ElementNode {
            __version: number = 0;
            $config() {
              return this.config('config-version', {extends: ElementNode});
            }
            afterCloneFrom(node: this): void {
              super.afterCloneFrom(node);
              this.__version = node.__version + 1;
            }
          }
          const editor = createEditor({
            nodes: [ConfigVersionNode],
            onError(err) {
              throw err;
            },
          });
          editor.update(
            () => {
              const source = $create(ConfigVersionNode);
              $getRoot().append(source);
              expect(source.__version).toBe(0);
              // One clone => exactly one afterCloneFrom => version + 1.
              const cloned = $cloneWithProperties(source);
              expect(cloned.__version).toBe(1);
            },
            {discrete: true},
          );
        });
        // Guards the reentrancy concern with the auto-clone fix: a direct
        // clone of one auto-synthesized node performed from within another
        // node's clone/afterCloneFrom logic must still copy its own source
        // properties. The signal that suppresses the wrapper-driven
        // afterCloneFrom must be per-call (not a shared/module-global flag),
        // otherwise a nested direct clone would wrongly inherit the outer
        // node's "skip" state and silently drop its properties.
        test('reentrant direct clone during another clone preserves properties', () => {
          class InnerTagNode extends ElementNode {
            __tag: string = 'default';
            $config() {
              return this.config('inner-tag', {extends: ElementNode});
            }
            afterCloneFrom(node: this): void {
              super.afterCloneFrom(node);
              this.__tag = node.__tag;
            }
            setTag(tag: string): this {
              const self = this.getWritable();
              self.__tag = tag;
              return self;
            }
          }
          class OuterNode extends ElementNode {
            // Populated during clone by directly cloning `__templateSource`.
            __reentrantClone: InnerTagNode | null = null;
            __templateSource: InnerTagNode | null = null;
            $config() {
              return this.config('outer-reentrant', {extends: ElementNode});
            }
            afterCloneFrom(node: this): void {
              super.afterCloneFrom(node);
              // Reentrant DIRECT clone of a different auto-synthesized node,
              // performed while this OuterNode is itself being cloned.
              if (node.__templateSource) {
                this.__reentrantClone = InnerTagNode.clone(
                  node.__templateSource,
                ) as InnerTagNode;
              }
            }
            setTemplateSource(source: InnerTagNode): this {
              const self = this.getWritable();
              self.__templateSource = source;
              return self;
            }
          }
          const editor = createEditor({
            nodes: [InnerTagNode, OuterNode],
            onError(err) {
              throw err;
            },
          });
          editor.update(
            () => {
              const inner = $create(InnerTagNode).setTag('custom');
              const outer = $create(OuterNode).setTemplateSource(inner);
              $getRoot().append(inner, outer);
              const clonedOuter = $cloneWithProperties(outer);
              // The reentrant direct clone must have copied inner's tag.
              expect(clonedOuter.__reentrantClone).not.toBeNull();
              expect(clonedOuter.__reentrantClone!.__tag).toBe('custom');
            },
            {discrete: true},
          );
        });
      });
    },
    {
      namespace: '',
      nodes: [LexicalNode, TestNode, InlineDecoratorNode, BlockDecoratorNode],
      theme: {},
    },
  );
});

describe('Element-anchored selection on old parent (#6031)', () => {
  type Mover = (target: ElementNode, mover: ElementNode) => void;
  type MethodSpec = {
    name: string;
    act: Mover;
    actNoRestore: Mover | null;
  };
  const methods: readonly MethodSpec[] = [
    {
      act: (target, mover) => target.insertBefore(mover),
      actNoRestore: (target, mover) => target.insertBefore(mover, false),
      name: 'insertBefore',
    },
    {
      act: (target, mover) => target.insertAfter(mover),
      actNoRestore: (target, mover) => target.insertAfter(mover, false),
      name: 'insertAfter',
    },
    {
      act: (target, mover) => target.replace(mover),
      actNoRestore: null,
      name: 'replace',
    },
  ];
  const methodsWithRestoreFlag = methods.filter(
    (m): m is MethodSpec & {actNoRestore: Mover} => m.actNoRestore !== null,
  );

  describe('cross-parent move', () => {
    initializeUnitTest(testEnv => {
      // Setup: root contains two TestElementNode containers. `source` holds
      // [mover, a2, a3]; `target` holds [inTarget]. Each test acts via one
      // of the three methods to move `mover` from source into target so
      // source's child count drops from 3 to 2.
      type Refs = {
        source: ElementNode;
        target: ElementNode;
        mover: ElementNode;
        inTarget: ElementNode;
      };
      const $setupTwoContainers = (out: Refs) => {
        const root = $getRoot().clear();
        out.source = $createTestElementNode();
        out.target = $createTestElementNode();
        out.mover = $createParagraphNode();
        const a2 = $createParagraphNode();
        const a3 = $createParagraphNode();
        out.inTarget = $createParagraphNode();
        out.source.append(out.mover, a2, a3);
        out.target.append(out.inTarget);
        root.append(out.source, out.target);
      };

      test.for(methods)(
        '$name shifts offset > removed index in source parent',
        ({act}) => {
          const {editor} = testEnv;
          let sourceKey = '';
          editor.update(
            () => {
              const refs = {} as Refs;
              $setupTwoContainers(refs);
              sourceKey = refs.source.__key;
              // Collapsed at end of source. 3 > removedIndex (0), so the
              // -1 shift must drive it to 2.
              refs.source.select(3, 3);
              act(refs.inTarget, refs.mover);
            },
            {discrete: true},
          );
          editor.read(() => {
            const sel = $getSelection();
            invariant($isRangeSelection(sel));
            expect(sel.anchor.key).toBe(sourceKey);
            expect(sel.anchor.type).toBe('element');
            expect(sel.anchor.offset).toBe(2);
            expect(sel.focus.offset).toBe(2);
          });
        },
      );

      test.for(methods)(
        '$name does not shift offset at removed index (boundary)',
        ({act}) => {
          const {editor} = testEnv;
          let sourceKey = '';
          editor.update(
            () => {
              const refs = {} as Refs;
              $setupTwoContainers(refs);
              sourceKey = refs.source.__key;
              // Collapsed at source offset 0. The helper uses
              // `nodeOffset < selectionOffset` for negative shifts, so
              // offset == removedIndex (both 0) must stay.
              refs.source.select(0, 0);
              act(refs.inTarget, refs.mover);
            },
            {discrete: true},
          );
          editor.read(() => {
            const sel = $getSelection();
            invariant($isRangeSelection(sel));
            expect(sel.anchor.key).toBe(sourceKey);
            expect(sel.anchor.offset).toBe(0);
            expect(sel.focus.offset).toBe(0);
          });
        },
      );

      test.for(methods)(
        '$name shifts only the past-boundary side of a non-collapsed selection',
        ({act}) => {
          const {editor} = testEnv;
          let sourceKey = '';
          editor.update(
            () => {
              const refs = {} as Refs;
              $setupTwoContainers(refs);
              sourceKey = refs.source.__key;
              // Anchor at 0 (boundary), focus at 3 (past). After removing
              // index 0: anchor stays at 0, focus shifts to 2.
              refs.source.select(0, 3);
              act(refs.inTarget, refs.mover);
            },
            {discrete: true},
          );
          editor.read(() => {
            const sel = $getSelection();
            invariant($isRangeSelection(sel));
            expect(sel.anchor.key).toBe(sourceKey);
            expect(sel.anchor.offset).toBe(0);
            expect(sel.focus.key).toBe(sourceKey);
            expect(sel.focus.offset).toBe(2);
          });
        },
      );

      test.for(methods)(
        '$name leaves selection in an unrelated third parent untouched',
        ({act}) => {
          const {editor} = testEnv;
          let sourceKey = '';
          let otherKey = '';
          editor.update(
            () => {
              const root = $getRoot().clear();
              const source = $createTestElementNode();
              const target = $createTestElementNode();
              const other = $createTestElementNode();
              const mover = $createParagraphNode();
              const a2 = $createParagraphNode();
              const a3 = $createParagraphNode();
              const inTarget = $createParagraphNode();
              const inOther = $createParagraphNode();
              source.append(mover, a2, a3);
              target.append(inTarget);
              other.append(inOther);
              root.append(source, target, other);
              sourceKey = source.__key;
              otherKey = other.__key;
              // Cursor sits in `other`, which the move does not touch.
              other.select(1, 1);
              act(inTarget, mover);
            },
            {discrete: true},
          );
          editor.read(() => {
            const sel = $getSelection();
            invariant($isRangeSelection(sel));
            expect(sel.anchor.key).toBe(otherKey);
            expect(sel.anchor.offset).toBe(1);
            expect(sel.focus.key).toBe(otherKey);
            expect(sel.focus.offset).toBe(1);
            expect(sourceKey).not.toBe(otherKey);
          });
        },
      );

      test.for(methodsWithRestoreFlag)(
        '$name with restoreSelection=false skips the source-parent shift',
        ({actNoRestore}) => {
          const {editor} = testEnv;
          let sourceKey = '';
          // Skipping the shift leaves the offset (3) past the parent's new
          // child count (2), so applying the selection to the DOM throws an
          // IndexSizeError that the reconciler catches and warns about.
          const mockWarning = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => {});
          editor.update(
            () => {
              const refs = {} as Refs;
              $setupTwoContainers(refs);
              sourceKey = refs.source.__key;
              refs.source.select(3, 3);
              actNoRestore(refs.inTarget, refs.mover);
            },
            {discrete: true},
          );
          expect(mockWarning).toHaveBeenCalledWith(expect.any(DOMException));
          mockWarning.mockRestore();
          editor.read(() => {
            const sel = $getSelection();
            invariant($isRangeSelection(sel));
            expect(sel.anchor.key).toBe(sourceKey);
            expect(sel.anchor.offset).toBe(3);
            expect(sel.focus.offset).toBe(3);
          });
        },
      );
    });
  });

  describe('within-parent move', () => {
    initializeUnitTest(testEnv => {
      // For within-parent moves the source and target parents coincide.
      // The pre-removal -1 shift and the post-insertion +1 shift compose
      // so element-anchored offsets track the (unchanged) visual layout
      // instead of going stale or out of range, which was the #6031 bug
      // for callers that did not detect same-parent moves themselves.
      const methodsForWithinParent = methodsWithRestoreFlag;

      test.for(methodsForWithinParent)(
        '$name keeps an end-of-parent cursor in range for a no-op move',
        ({name, act}) => {
          const {editor} = testEnv;
          let parentKey = '';
          editor.update(
            () => {
              const root = $getRoot().clear();
              const parent = $createTestElementNode();
              const a = $createParagraphNode();
              const b = $createParagraphNode();
              parent.append(a, b);
              root.append(parent);
              parentKey = parent.__key;
              // Collapsed at offset 2 (end of [a, b]). Pre-fix this went
              // out of range when the within-parent move's removeFromParent
              // shrank `parent` without adjusting the offset.
              parent.select(2, 2);
              // Each method is invoked so the move is a layout no-op:
              // insertBefore: b.insertBefore(a) → a stays before b
              // insertAfter:  a.insertAfter(b)  → b stays after a
              if (name === 'insertBefore') {
                act(b, a);
              } else {
                act(a, b);
              }
            },
            {discrete: true},
          );

          editor.read(() => {
            const sel = $getSelection();
            invariant($isRangeSelection(sel));
            expect(sel.anchor.key).toBe(parentKey);
            expect(sel.anchor.offset).toBe(2);
            expect(sel.focus.offset).toBe(2);
          });
        },
      );
    });
  });
});

describe('insertAfter selection side effects', () => {
  initializeUnitTest(testEnv => {
    // insertAfter reads getIndexWithinParent for two reasons only: to shift
    // element-anchored offsets in the parent that loses the node and in the
    // parent that gains it, and to re-anchor a point that was sitting on the
    // node itself when it moves between parents (#6031). These pin every one
    // of those effects, including the offsets, so that any change to when the
    // index is computed has to keep producing the same selection.
    type Refs = {
      source: ElementNode;
      target: ElementNode;
      mover: ElementNode;
      inTarget: ElementNode;
    };
    // source holds [mover, a2, a3]; target holds [inTarget]. Moving mover
    // into target puts it at target offset 1, so a point that was on mover
    // (source offset 1) belongs at target offset 2 afterwards.
    const $setupTwoContainers = (out: Refs) => {
      const root = $getRoot().clear();
      out.source = $createTestElementNode();
      out.target = $createTestElementNode();
      out.mover = $createParagraphNode();
      out.inTarget = $createParagraphNode();
      out.source.append(
        out.mover,
        $createParagraphNode(),
        $createParagraphNode(),
      );
      out.target.append(out.inTarget);
      root.append(out.source, out.target);
    };

    test('cross-parent move re-anchors a collapsed point that sat on the moved node', () => {
      const {editor} = testEnv;
      let targetKey = '';
      editor.update(
        () => {
          const refs = {} as Refs;
          $setupTwoContainers(refs);
          targetKey = refs.target.__key;
          // Collapsed at source offset 1, which is mover's index (0) plus
          // one: the point is immediately after the node being moved, so it
          // has to follow the node into target rather than stay behind.
          refs.source.select(1, 1);
          refs.inTarget.insertAfter(refs.mover);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(targetKey);
        expect(sel.anchor.type).toBe('element');
        expect(sel.anchor.offset).toBe(2);
        expect(sel.focus.key).toBe(targetKey);
        expect(sel.focus.offset).toBe(2);
      });
    });

    test('cross-parent move re-anchors only the point that sat on the moved node', () => {
      const {editor} = testEnv;
      let sourceKey = '';
      let targetKey = '';
      editor.update(
        () => {
          const refs = {} as Refs;
          $setupTwoContainers(refs);
          sourceKey = refs.source.__key;
          targetKey = refs.target.__key;
          // Anchor at source offset 0 is at the removed index, so it stays
          // put; focus at 1 sat on mover and follows it into target.
          refs.source.select(0, 1);
          refs.inTarget.insertAfter(refs.mover);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(sourceKey);
        expect(sel.anchor.type).toBe('element');
        expect(sel.anchor.offset).toBe(0);
        expect(sel.focus.key).toBe(targetKey);
        expect(sel.focus.type).toBe('element');
        expect(sel.focus.offset).toBe(2);
      });
    });

    test('cross-parent move shifts a source point past the removed index (times=-1)', () => {
      const {editor} = testEnv;
      let sourceKey = '';
      editor.update(
        () => {
          const refs = {} as Refs;
          $setupTwoContainers(refs);
          sourceKey = refs.source.__key;
          // Offset 2 is past mover's index (0) but not on it, so the removal
          // shift applies and no re-anchor does.
          refs.source.select(2, 2);
          refs.inTarget.insertAfter(refs.mover);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(sourceKey);
        expect(sel.anchor.type).toBe('element');
        expect(sel.anchor.offset).toBe(1);
        expect(sel.focus.offset).toBe(1);
      });
    });

    test('collapsed point on the destination parent shifts by one', () => {
      const {editor} = testEnv;
      let parentKey = '';
      editor.update(
        () => {
          const root = $getRoot().clear();
          const parent = $createTestElementNode();
          const a = $createParagraphNode();
          parent.append(a, $createParagraphNode());
          root.append(parent);
          parentKey = parent.__key;
          // Collapsed at the end of [a, b]. Inserting after a lands at
          // offset 1, so the cursor moves to 3.
          parent.select(2, 2);
          a.insertAfter($createParagraphNode());
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(parentKey);
        expect(sel.anchor.type).toBe('element');
        expect(sel.anchor.offset).toBe(3);
        expect(sel.focus.offset).toBe(3);
      });
    });

    test('non-collapsed selection on the destination parent shifts only the side past the insert', () => {
      const {editor} = testEnv;
      let parentKey = '';
      editor.update(
        () => {
          const root = $getRoot().clear();
          const parent = $createTestElementNode();
          const a = $createParagraphNode();
          parent.append(a, $createParagraphNode());
          root.append(parent);
          parentKey = parent.__key;
          // Anchor at 0 is before the insert point (1) and stays; focus at 2
          // is past it and shifts to 3.
          parent.select(0, 2);
          a.insertAfter($createParagraphNode());
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(parentKey);
        expect(sel.anchor.offset).toBe(0);
        expect(sel.focus.key).toBe(parentKey);
        expect(sel.focus.offset).toBe(3);
      });
    });

    test('restoreSelection=false leaves the destination parent offset alone', () => {
      const {editor} = testEnv;
      let parentKey = '';
      editor.update(
        () => {
          const root = $getRoot().clear();
          const parent = $createTestElementNode();
          const a = $createParagraphNode();
          parent.append(a, $createParagraphNode());
          root.append(parent);
          parentKey = parent.__key;
          parent.select(2, 2);
          a.insertAfter($createParagraphNode(), false);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(parentKey);
        expect(sel.anchor.offset).toBe(2);
        expect(sel.focus.offset).toBe(2);
      });
    });

    // Every scenario above moves `mover`, which is source's *first* child, so
    // an oldIndex of 0 would satisfy them by accident. These two move a node
    // from the middle instead, pinning the index value that the guarded walk
    // computes.
    const $setupMoverAtIndexOne = () => {
      const root = $getRoot().clear();
      const source = $createTestElementNode();
      const target = $createTestElementNode();
      const mover = $createParagraphNode();
      const inTarget = $createParagraphNode();
      source.append($createParagraphNode(), mover, $createParagraphNode());
      target.append(inTarget);
      root.append(source, target);
      return {inTarget, mover, source, target};
    };

    test('cross-parent move leaves a point at the moved node index alone', () => {
      const {editor} = testEnv;
      let sourceKey = '';
      editor.update(
        () => {
          const {inTarget, mover, source} = $setupMoverAtIndexOne();
          sourceKey = source.__key;
          // Offset 1 is exactly mover's index, so the removal must not shift
          // it and it is not the point that sat on mover either.
          source.select(1, 1);
          inTarget.insertAfter(mover);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(sourceKey);
        expect(sel.anchor.type).toBe('element');
        expect(sel.anchor.offset).toBe(1);
        expect(sel.focus.offset).toBe(1);
      });
    });

    test('cross-parent move re-anchors onto a moved node that is not the first child', () => {
      const {editor} = testEnv;
      let targetKey = '';
      editor.update(
        () => {
          const {inTarget, mover, source, target} = $setupMoverAtIndexOne();
          targetKey = target.__key;
          // Offset 2 is mover's index (1) plus one, so the point sat on mover
          // and follows it into target, landing after inTarget at offset 2.
          source.select(2, 2);
          inTarget.insertAfter(mover);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(targetKey);
        expect(sel.anchor.type).toBe('element');
        expect(sel.anchor.offset).toBe(2);
        expect(sel.focus.key).toBe(targetKey);
        expect(sel.focus.offset).toBe(2);
      });
    });

    // The two tests below put the anchor in a container the move does not
    // touch, so the parent that loses (or gains) the node is reachable only
    // through the focus. A guard that inspected the anchor alone would skip
    // the index walk here and silently leave the focus behind.
    test('cross-parent move re-anchors a focus-only point that sat on the moved node', () => {
      const {editor} = testEnv;
      let otherKey = '';
      let targetKey = '';
      editor.update(
        () => {
          const refs = {} as Refs;
          $setupTwoContainers(refs);
          const other = $createTestElementNode();
          other.append($createParagraphNode(), $createParagraphNode());
          $getRoot().append(other);
          otherKey = other.__key;
          targetKey = refs.target.__key;
          const sel = $createRangeSelection();
          sel.anchor.set(otherKey, 1, 'element');
          // source offset 1 is mover's index (0) plus one, so the focus sat
          // on mover and has to follow it into target.
          sel.focus.set(refs.source.__key, 1, 'element');
          $setSelection(sel);
          refs.inTarget.insertAfter(refs.mover);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(otherKey);
        expect(sel.anchor.offset).toBe(1);
        expect(sel.focus.key).toBe(targetKey);
        expect(sel.focus.type).toBe('element');
        expect(sel.focus.offset).toBe(2);
      });
    });

    test('insert shifts a focus-only point on the destination parent', () => {
      const {editor} = testEnv;
      let otherKey = '';
      let parentKey = '';
      editor.update(
        () => {
          const root = $getRoot().clear();
          const parent = $createTestElementNode();
          const a = $createParagraphNode();
          parent.append(a, $createParagraphNode());
          const other = $createTestElementNode();
          other.append($createParagraphNode(), $createParagraphNode());
          root.append(parent, other);
          parentKey = parent.__key;
          otherKey = other.__key;
          const sel = $createRangeSelection();
          sel.anchor.set(otherKey, 1, 'element');
          sel.focus.set(parentKey, 2, 'element');
          $setSelection(sel);
          // The fresh node lands at offset 1, so the focus at 2 moves to 3.
          a.insertAfter($createParagraphNode());
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(otherKey);
        expect(sel.anchor.offset).toBe(1);
        expect(sel.focus.key).toBe(parentKey);
        expect(sel.focus.type).toBe('element');
        expect(sel.focus.offset).toBe(3);
      });
    });

    test('cross-parent move re-anchors an anchor-only point that sat on the moved node', () => {
      const {editor} = testEnv;
      let otherKey = '';
      let targetKey = '';
      editor.update(
        () => {
          const refs = {} as Refs;
          $setupTwoContainers(refs);
          const other = $createTestElementNode();
          other.append($createParagraphNode(), $createParagraphNode());
          $getRoot().append(other);
          otherKey = other.__key;
          targetKey = refs.target.__key;
          const sel = $createRangeSelection();
          // The mirror of the test above: this time the focus is the one in
          // the untouched container, so the move is reachable only through
          // the anchor.
          sel.anchor.set(refs.source.__key, 1, 'element');
          sel.focus.set(otherKey, 1, 'element');
          $setSelection(sel);
          refs.inTarget.insertAfter(refs.mover);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(targetKey);
        expect(sel.anchor.type).toBe('element');
        expect(sel.anchor.offset).toBe(2);
        expect(sel.focus.key).toBe(otherKey);
        expect(sel.focus.offset).toBe(1);
      });
    });

    test('a point in an unrelated parent survives a cross-parent move untouched', () => {
      const {editor} = testEnv;
      let otherKey = '';
      editor.update(
        () => {
          const refs = {} as Refs;
          $setupTwoContainers(refs);
          const other = $createTestElementNode();
          other.append($createParagraphNode(), $createParagraphNode());
          $getRoot().append(other);
          otherKey = other.__key;
          other.select(1, 1);
          refs.inTarget.insertAfter(refs.mover);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(otherKey);
        expect(sel.anchor.offset).toBe(1);
        expect(sel.focus.key).toBe(otherKey);
        expect(sel.focus.offset).toBe(1);
      });
    });
  });
});

describe('selectPrevious and selectNext', () => {
  initializeUnitTest(testEnv => {
    test('both land on the sibling index', () => {
      const {editor} = testEnv;
      let paragraphKey = '';
      editor.update(
        () => {
          const paragraph = $createParagraphNode();
          const first = $createLineBreakNode();
          const middle = $createLineBreakNode();
          const last = $createLineBreakNode();
          paragraph.append(first, middle, last);
          $getRoot().clear().append(paragraph);
          paragraphKey = paragraph.__key;
          // A LineBreakNode sibling is neither an element nor a text node,
          // so both helpers resolve it through its index in the parent.
          const sel = last.selectPrevious();
          expect(sel.anchor.key).toBe(paragraphKey);
          expect(sel.anchor.type).toBe('element');
          expect(sel.anchor.offset).toBe(2);
          expect(sel.focus.offset).toBe(2);
          const nextSel = first.selectNext();
          expect(nextSel.anchor.key).toBe(paragraphKey);
          expect(nextSel.anchor.type).toBe('element');
          expect(nextSel.anchor.offset).toBe(1);
          expect(nextSel.focus.offset).toBe(1);
        },
        {discrete: true},
      );
    });
  });
});

describe('insertBefore, remove and replace selection side effects', () => {
  initializeUnitTest(testEnv => {
    // insertBefore, $removeNode and replace each read getIndexWithinParent
    // purely to shift element-anchored offsets in the parent whose child
    // count changed. Like the insertAfter block above, these pin the offsets
    // so that skipping the walk when no selection point can observe it has
    // to keep producing the same selection.
    // source holds [s0, s1, s2]; target holds [t0, t1].
    const $setup = () => {
      const root = $getRoot().clear();
      const source = $createTestElementNode();
      const target = $createTestElementNode();
      source.append(
        $createParagraphNode(),
        $createParagraphNode(),
        $createParagraphNode(),
      );
      target.append($createParagraphNode(), $createParagraphNode());
      root.append(source, target);
      return {source, target};
    };

    const expectSelection = (
      editor: LexicalEditor,
      anchorKey: string,
      anchorOffset: number,
      focusKey = anchorKey,
      focusOffset = anchorOffset,
    ) => {
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(anchorKey);
        expect(sel.anchor.type).toBe('element');
        expect(sel.anchor.offset).toBe(anchorOffset);
        expect(sel.focus.key).toBe(focusKey);
        expect(sel.focus.type).toBe('element');
        expect(sel.focus.offset).toBe(focusOffset);
      });
    };

    test('insertBefore shifts a point past the removed index in the old parent', () => {
      const {editor} = testEnv;
      let sourceKey = '';
      editor.update(
        () => {
          const {source, target} = $setup();
          sourceKey = source.__key;
          // Offset 2 is past s1's index (1), so the removal shifts it to 1.
          source.select(2, 2);
          target.getLastChildOrThrow().insertBefore(source.getChildAtIndex(1)!);
        },
        {discrete: true},
      );
      expectSelection(editor, sourceKey, 1);
    });

    test('insertBefore leaves a point at the removed index in the old parent alone', () => {
      const {editor} = testEnv;
      let sourceKey = '';
      editor.update(
        () => {
          const {source, target} = $setup();
          sourceKey = source.__key;
          // Offset 1 is exactly s1's index, so the removal must not shift it.
          // This pins the index value itself, not just that an update ran.
          source.select(1, 1);
          target.getLastChildOrThrow().insertBefore(source.getChildAtIndex(1)!);
        },
        {discrete: true},
      );
      expectSelection(editor, sourceKey, 1);
    });

    test('insertBefore shifts a point at or past the insert index in the new parent', () => {
      const {editor} = testEnv;
      let targetKey = '';
      editor.update(
        () => {
          const {target} = $setup();
          targetKey = target.__key;
          // t1 is at index 1, so the fresh node lands there and the collapsed
          // point at the end of [t0, t1] moves from 2 to 3.
          target.select(2, 2);
          target.getLastChildOrThrow().insertBefore($createParagraphNode());
        },
        {discrete: true},
      );
      expectSelection(editor, targetKey, 3);
    });

    test('insertBefore leaves a point before the insert index alone', () => {
      const {editor} = testEnv;
      let targetKey = '';
      editor.update(
        () => {
          const {target} = $setup();
          targetKey = target.__key;
          // Anchor at 0 is before the insert index (1) and stays; focus at 2
          // is past it and shifts to 3.
          target.select(0, 2);
          target.getLastChildOrThrow().insertBefore($createParagraphNode());
        },
        {discrete: true},
      );
      expectSelection(editor, targetKey, 0, targetKey, 3);
    });

    test('insertBefore with restoreSelection=false leaves both parents alone', () => {
      const {editor} = testEnv;
      let targetKey = '';
      editor.update(
        () => {
          const {target} = $setup();
          targetKey = target.__key;
          target.select(2, 2);
          target
            .getLastChildOrThrow()
            .insertBefore($createParagraphNode(), false);
        },
        {discrete: true},
      );
      expectSelection(editor, targetKey, 2);
    });

    test('insertBefore leaves a point in an unrelated parent untouched', () => {
      const {editor} = testEnv;
      let sourceKey = '';
      editor.update(
        () => {
          const {source, target} = $setup();
          sourceKey = source.__key;
          // The selection is on source, which neither loses nor gains a child.
          source.select(1, 1);
          target.getLastChildOrThrow().insertBefore($createParagraphNode());
        },
        {discrete: true},
      );
      expectSelection(editor, sourceKey, 1);
    });

    test('remove shifts a point past the removed index', () => {
      const {editor} = testEnv;
      let sourceKey = '';
      editor.update(
        () => {
          const {source} = $setup();
          sourceKey = source.__key;
          // Offset 3 is past s1's index (1), so it shifts to 2.
          source.select(3, 3);
          source.getChildAtIndex(1)!.remove();
        },
        {discrete: true},
      );
      expectSelection(editor, sourceKey, 2);
    });

    test('remove leaves a point at or before the removed index alone', () => {
      const {editor} = testEnv;
      let sourceKey = '';
      editor.update(
        () => {
          const {source} = $setup();
          sourceKey = source.__key;
          // Anchor at 1 is *at* the removed index so it stays; focus at 3 is
          // past it and shifts to 2.
          source.select(1, 3);
          source.getChildAtIndex(1)!.remove();
        },
        {discrete: true},
      );
      expectSelection(editor, sourceKey, 1, sourceKey, 2);
    });

    test('remove leaves a point in an unrelated parent untouched', () => {
      const {editor} = testEnv;
      let targetKey = '';
      editor.update(
        () => {
          const {source, target} = $setup();
          targetKey = target.__key;
          target.select(2, 2);
          source.getChildAtIndex(1)!.remove();
        },
        {discrete: true},
      );
      expectSelection(editor, targetKey, 2);
    });

    test("replace shifts a point past the replacement's index in its old parent", () => {
      const {editor} = testEnv;
      let sourceKey = '';
      editor.update(
        () => {
          const {source, target} = $setup();
          sourceKey = source.__key;
          // s1 leaves source at index 1 to replace t0, so the point at 2
          // shifts to 1.
          source.select(2, 2);
          target.getFirstChildOrThrow().replace(source.getChildAtIndex(1)!);
        },
        {discrete: true},
      );
      expectSelection(editor, sourceKey, 1);
    });

    test("replace leaves a point at the replacement's index in its old parent alone", () => {
      const {editor} = testEnv;
      let sourceKey = '';
      editor.update(
        () => {
          const {source, target} = $setup();
          sourceKey = source.__key;
          // Offset 1 is exactly s1's index, so its departure must not shift
          // the point. Pins the index value, not just that an update ran.
          source.select(1, 1);
          target.getFirstChildOrThrow().replace(source.getChildAtIndex(1)!);
        },
        {discrete: true},
      );
      expectSelection(editor, sourceKey, 1);
    });

    test('replace leaves a point in an unrelated parent untouched', () => {
      const {editor} = testEnv;
      let targetKey = '';
      editor.update(
        () => {
          const {source, target} = $setup();
          targetKey = target.__key;
          // The point is on target, which keeps its child count across the
          // replace, so nothing should move it.
          target.select(2, 2);
          target.getFirstChildOrThrow().replace(source.getChildAtIndex(1)!);
        },
        {discrete: true},
      );
      expectSelection(editor, targetKey, 2);
    });

    // As in the insertAfter block, these reach the affected parent only
    // through the focus, so a guard that inspected the anchor alone would
    // skip the walk and leave the focus stale.
    test('insertBefore shifts a focus-only point in the old parent', () => {
      const {editor} = testEnv;
      let otherKey = '';
      let sourceKey = '';
      editor.update(
        () => {
          const {source, target} = $setup();
          const other = $createTestElementNode();
          other.append($createParagraphNode(), $createParagraphNode());
          $getRoot().append(other);
          otherKey = other.__key;
          sourceKey = source.__key;
          const sel = $createRangeSelection();
          sel.anchor.set(otherKey, 1, 'element');
          sel.focus.set(sourceKey, 2, 'element');
          $setSelection(sel);
          target.getLastChildOrThrow().insertBefore(source.getChildAtIndex(1)!);
        },
        {discrete: true},
      );
      expectSelection(editor, otherKey, 1, sourceKey, 1);
    });

    test('insertBefore shifts a focus-only point in the new parent', () => {
      const {editor} = testEnv;
      let otherKey = '';
      let targetKey = '';
      editor.update(
        () => {
          const {target} = $setup();
          const other = $createTestElementNode();
          other.append($createParagraphNode(), $createParagraphNode());
          $getRoot().append(other);
          otherKey = other.__key;
          targetKey = target.__key;
          const sel = $createRangeSelection();
          sel.anchor.set(otherKey, 1, 'element');
          sel.focus.set(targetKey, 2, 'element');
          $setSelection(sel);
          target.getLastChildOrThrow().insertBefore($createParagraphNode());
        },
        {discrete: true},
      );
      expectSelection(editor, otherKey, 1, targetKey, 3);
    });

    test('remove shifts a focus-only point past the removed index', () => {
      const {editor} = testEnv;
      let otherKey = '';
      let sourceKey = '';
      editor.update(
        () => {
          const {source} = $setup();
          const other = $createTestElementNode();
          other.append($createParagraphNode(), $createParagraphNode());
          $getRoot().append(other);
          otherKey = other.__key;
          sourceKey = source.__key;
          const sel = $createRangeSelection();
          sel.anchor.set(otherKey, 1, 'element');
          sel.focus.set(sourceKey, 3, 'element');
          $setSelection(sel);
          source.getChildAtIndex(1)!.remove();
        },
        {discrete: true},
      );
      expectSelection(editor, otherKey, 1, sourceKey, 2);
    });

    test("replace shifts a focus-only point in the replacement's old parent", () => {
      const {editor} = testEnv;
      let otherKey = '';
      let sourceKey = '';
      editor.update(
        () => {
          const {source, target} = $setup();
          const other = $createTestElementNode();
          other.append($createParagraphNode(), $createParagraphNode());
          $getRoot().append(other);
          otherKey = other.__key;
          sourceKey = source.__key;
          const sel = $createRangeSelection();
          sel.anchor.set(otherKey, 1, 'element');
          sel.focus.set(sourceKey, 2, 'element');
          $setSelection(sel);
          target.getFirstChildOrThrow().replace(source.getChildAtIndex(1)!);
        },
        {discrete: true},
      );
      expectSelection(editor, otherKey, 1, sourceKey, 1);
    });

    test('insertBefore shifts an anchor-only point in the new parent', () => {
      const {editor} = testEnv;
      let otherKey = '';
      let targetKey = '';
      editor.update(
        () => {
          const {target} = $setup();
          const other = $createTestElementNode();
          other.append($createParagraphNode(), $createParagraphNode());
          $getRoot().append(other);
          otherKey = other.__key;
          targetKey = target.__key;
          const sel = $createRangeSelection();
          sel.anchor.set(targetKey, 2, 'element');
          sel.focus.set(otherKey, 1, 'element');
          $setSelection(sel);
          target.getLastChildOrThrow().insertBefore($createParagraphNode());
        },
        {discrete: true},
      );
      expectSelection(editor, targetKey, 3, otherKey, 1);
    });

    test('remove shifts an anchor-only point past the removed index', () => {
      const {editor} = testEnv;
      let otherKey = '';
      let sourceKey = '';
      editor.update(
        () => {
          const {source} = $setup();
          const other = $createTestElementNode();
          other.append($createParagraphNode(), $createParagraphNode());
          $getRoot().append(other);
          otherKey = other.__key;
          sourceKey = source.__key;
          const sel = $createRangeSelection();
          sel.anchor.set(sourceKey, 3, 'element');
          sel.focus.set(otherKey, 1, 'element');
          $setSelection(sel);
          source.getChildAtIndex(1)!.remove();
        },
        {discrete: true},
      );
      expectSelection(editor, sourceKey, 2, otherKey, 1);
    });

    test("replace shifts an anchor-only point in the replacement's old parent", () => {
      const {editor} = testEnv;
      let otherKey = '';
      let sourceKey = '';
      editor.update(
        () => {
          const {source, target} = $setup();
          const other = $createTestElementNode();
          other.append($createParagraphNode(), $createParagraphNode());
          $getRoot().append(other);
          otherKey = other.__key;
          sourceKey = source.__key;
          const sel = $createRangeSelection();
          sel.anchor.set(sourceKey, 2, 'element');
          sel.focus.set(otherKey, 1, 'element');
          $setSelection(sel);
          target.getFirstChildOrThrow().replace(source.getChildAtIndex(1)!);
        },
        {discrete: true},
      );
      expectSelection(editor, sourceKey, 1, otherKey, 1);
    });

    test('replace with a fresh node leaves the parent offsets alone', () => {
      const {editor} = testEnv;
      let targetKey = '';
      editor.update(
        () => {
          const {target} = $setup();
          targetKey = target.__key;
          target.select(2, 2);
          target.getFirstChildOrThrow().replace($createParagraphNode());
        },
        {discrete: true},
      );
      expectSelection(editor, targetKey, 2);
    });
  });
});

describe('replace(other, includeChildren) selection mapping', () => {
  initializeUnitTest(testEnv => {
    // When `replace` transfers `this`'s children into `other`, the
    // transferred children land at offsets [prevSize ... prevSize + N) in
    // the receiver. An element-anchored point on `this` at offset K used
    // to be relocated to the receiver's end via `$moveSelectionPointToEnd`,
    // forcing callers like `$setBlocksType` to re-anchor afterwards. The
    // receiver now natively maps that point to offset `prevSize + K`.

    test('element-anchored point maps to prevSize + originalOffset (etrepum example)', () => {
      const {editor} = testEnv;
      let newParentKey = '';
      let prevSize = 0;
      editor.update(
        () => {
          const parent = $createParagraphNode().append(
            $createLineBreakNode(),
            $createLineBreakNode(),
            $createLineBreakNode(),
          );
          $getRoot().clear().append(parent);
          parent.select(1, 1);
          const newParent = $createParagraphNode().append(
            $createTextNode('before'),
          );
          prevSize = newParent.getChildrenSize();
          newParentKey = newParent.__key;
          parent.replace(newParent, true);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.isCollapsed()).toBe(true);
        expect(sel.anchor.key).toBe(newParentKey);
        expect(sel.anchor.type).toBe('element');
        expect(sel.anchor.offset).toBe(prevSize + 1);
      });
    });

    test('non-collapsed element-anchored anchor and focus both shift by prevSize', () => {
      const {editor} = testEnv;
      let newParentKey = '';
      editor.update(
        () => {
          const parent = $createParagraphNode().append(
            $createLineBreakNode(),
            $createLineBreakNode(),
            $createLineBreakNode(),
          );
          $getRoot().clear().append(parent);
          parent.select(1, 3);
          // Use LineBreakNodes (atomic, no auto-merge) for the receiver's
          // pre-existing children so prevSize stays stable across reconcile.
          // Adjacent TextNodes would get merged by normalization and shift
          // post-cycle offsets, which is orthogonal to what this test pins.
          const newParent = $createParagraphNode().append(
            $createLineBreakNode(),
            $createLineBreakNode(),
          );
          newParentKey = newParent.__key;
          parent.replace(newParent, true);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        expect(sel.anchor.key).toBe(newParentKey);
        expect(sel.anchor.type).toBe('element');
        // prevSize = 2 (two line breaks pre-transfer)
        expect(sel.anchor.offset).toBe(2 + 1);
        expect(sel.focus.key).toBe(newParentKey);
        expect(sel.focus.type).toBe('element');
        expect(sel.focus.offset).toBe(2 + 3);
      });
    });

    test('text-anchored selection inside transferred children is unaffected', () => {
      const {editor} = testEnv;
      let textKey = '';
      editor.update(
        () => {
          const parent = $createParagraphNode();
          const t1 = $createTextNode('hello');
          parent.append(t1);
          $getRoot().clear().append(parent);
          textKey = t1.__key;
          t1.select(2, 2);
          // Receiver has a LineBreakNode (atomic, no text adjacency) so
          // `t1` doesn't get merged into a sibling text on transfer; the
          // text point's key and offset must follow `t1` as-is.
          const newParent = $createParagraphNode().append(
            $createLineBreakNode(),
          );
          parent.replace(newParent, true);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        // The TextNode's key did not change across the transfer; the text
        // point follows the node into newParent without remapping.
        expect(sel.anchor.key).toBe(textKey);
        expect(sel.anchor.type).toBe('text');
        expect(sel.anchor.offset).toBe(2);
      });
    });

    test('replace without includeChildren falls back to the legacy moveSelectionPointToEnd', () => {
      const {editor} = testEnv;
      let newParentKey = '';
      let prefixKey = '';
      editor.update(
        () => {
          const parent = $createParagraphNode().append(
            $createLineBreakNode(),
            $createLineBreakNode(),
          );
          $getRoot().clear().append(parent);
          parent.select(1, 1);
          const prefix = $createTextNode('prefix');
          const newParent = $createParagraphNode().append(prefix);
          newParentKey = newParent.__key;
          prefixKey = prefix.__key;
          parent.replace(newParent, false);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        // !includeChildren takes the legacy `$moveSelectionPointToEnd`
        // branch — selection ends up as a text point on the receiver's last
        // descendant. The exact text offset is `$moveSelectionPointToEnd`'s
        // own (offset preserved from the source point) and is not the
        // contract we're pinning; what matters is that the new prevSize+
        // mapping is NOT taken (anchor isn't element-anchored on newParent).
        expect(sel.anchor.type).toBe('text');
        expect(sel.anchor.key).toBe(prefixKey);
        expect(sel.anchor.getNode().getParentOrThrow().__key).toBe(
          newParentKey,
        );
      });
    });

    test('$setBlocksType-style pattern (prevSize=0 fresh receiver) preserves original offset', () => {
      const {editor} = testEnv;
      let newParentKey = '';
      editor.update(
        () => {
          const parent = $createParagraphNode().append(
            $createLineBreakNode(),
            $createLineBreakNode(),
            $createLineBreakNode(),
          );
          $getRoot().clear().append(parent);
          parent.select(2, 2);
          const newParent = $createParagraphNode();
          newParentKey = newParent.__key;
          parent.replace(newParent, true);
        },
        {discrete: true},
      );
      editor.read(() => {
        const sel = $getSelection();
        invariant($isRangeSelection(sel));
        // prevSize=0 → offset preserved as the original 2. This matches the
        // override that `$setBlocksType` used to apply after replace; with
        // the native mapping in place, the override is now redundant.
        expect(sel.anchor.key).toBe(newParentKey);
        expect(sel.anchor.type).toBe('element');
        expect(sel.anchor.offset).toBe(2);
      });
    });
  });
});

// These are outside of the above suite because of the
// LexicalNode getType mock which ruins it
describe('LexicalNode.$config() without registration', () => {
  test('static getType() before registration', () => {
    class IncorrectCustomDecoratorNode extends DecoratorNode<null> {
      decorate(editor: LexicalEditor, config: EditorConfig): null {
        return null;
      }
    }
    class CorrectCustomDecoratorNode extends DecoratorNode<null> {
      decorate(editor: LexicalEditor, config: EditorConfig): null {
        return null;
      }
      $config() {
        return this.config('correct-custom-decorator', {});
      }
    }
    // Run twice to make sure that getStaticNodeConfig doesn't cache the wrong thing
    for (let i = 0; i < 2; i++) {
      expect(() => IncorrectCustomDecoratorNode.getType()).toThrow(
        /does not implement \.getType/,
      );
      expect(CorrectCustomDecoratorNode.getType()).toEqual(
        'correct-custom-decorator',
      );
    }
  });

  test('subclass static getType() is not shadowed by a superclass synthesized getType', () => {
    // Regression for the $config() protocol (#8640): getStaticNodeConfig
    // synthesizes `klass.getType = () => ownNodeType` for a class that derives
    // its type from $config(). If the superclass is resolved first, that
    // synthesized closure lives as an *own* static on the superclass. A
    // subclass that has not yet had its own getType synthesized then *inherits*
    // that closure via the prototype chain and returns the SUPERCLASS's
    // hardcoded type. In an editor this makes the subclass register under the
    // superclass's type and collide with it (e.g. CodeHighlightNode/HashtagNode
    // resolving to 'text' and clashing with the registered TextNode).
    class ParentConfigNode extends TextNode {
      $config() {
        return this.config('parent-config-node', {extends: TextNode});
      }
    }
    class ChildConfigNode extends ParentConfigNode {
      $config() {
        return this.config('child-config-node', {extends: ParentConfigNode});
      }
    }
    class SiblingConfigNode extends ParentConfigNode {
      $config() {
        return this.config('sibling-config-node', {extends: ParentConfigNode});
      }
    }

    // Resolve the parent FIRST so its getType() is synthesized as an own
    // static, then read the subclasses (which would otherwise inherit it).
    expect(ParentConfigNode.getType()).toBe('parent-config-node');
    expect(ChildConfigNode.getType()).toBe('child-config-node');
    expect(SiblingConfigNode.getType()).toBe('sibling-config-node');

    // Idempotent: repeated reads keep returning each class's own type, and
    // reading the parent again does not get poisoned by the children.
    expect(ParentConfigNode.getType()).toBe('parent-config-node');
    expect(ChildConfigNode.getType()).toBe('child-config-node');
  });

  test('subclass static getType() resolves correctly when read before the superclass', () => {
    // The reverse ordering of the regression above: reading the subclass first
    // must also stay correct and must not poison the superclass.
    class OuterConfigNode extends TextNode {
      $config() {
        return this.config('outer-config-node', {extends: TextNode});
      }
    }
    class InnerConfigNode extends OuterConfigNode {
      $config() {
        return this.config('inner-config-node', {extends: OuterConfigNode});
      }
    }

    expect(InnerConfigNode.getType()).toBe('inner-config-node');
    expect(OuterConfigNode.getType()).toBe('outer-config-node');
    expect(InnerConfigNode.getType()).toBe('inner-config-node');
  });

  test('synthesized getType() inherited as an own static on a subclass does not recurse (#8867 follow-up)', () => {
    // Regression for a stack-overflow that only reproduces under *compiled*
    // class output (e.g. Meta's www bundle), where a superclass's synthesized
    // getType() closure can end up as an *own* static on a subclass whose
    // identity differs from the closure's captured `synthesizedForKlass`.
    //
    // Pre-fix cycle:
    //   getStaticNodeConfig(Sub)  -> calls Sub.getType() (own, synthesized)
    //     -> closure sees `this !== synthesizedForKlass` -> LexicalNode.getType.call(Sub)
    //       -> getStaticNodeConfig(Sub) -> ... RangeError: Maximum call stack size exceeded
    //
    // Native ES classes don't inherit statics as own properties, so this must
    // be constructed explicitly to mirror the compiled shape.
    class ParentSynthNode extends TextNode {
      $config() {
        return this.config('parent-synth-node', {extends: TextNode});
      }
    }
    class ChildSynthNode extends ParentSynthNode {
      $config() {
        return this.config('child-synth-node', {extends: ParentSynthNode});
      }
    }

    // Force the parent's getType() to be synthesized as an own static.
    expect(ParentSynthNode.getType()).toBe('parent-synth-node');
    const parentSynthesizedGetType = Object.getOwnPropertyDescriptor(
      ParentSynthNode,
      'getType',
    );
    expect(parentSynthesizedGetType).toBeDefined();

    // Simulate the compiled bundle copying that synthesized closure down onto
    // the subclass as an OWN static (its captured `synthesizedForKlass` is
    // still ParentSynthNode, not ChildSynthNode).
    Object.defineProperty(ChildSynthNode, 'getType', {
      configurable: true,
      value: (parentSynthesizedGetType as PropertyDescriptor).value,
      writable: true,
    });

    // Must not recurse; must resolve the child's own $config-derived type.
    expect(() => ChildSynthNode.getType()).not.toThrow();
    expect(ChildSynthNode.getType()).toBe('child-synth-node');
  });

  test('abstract base class declares shared $config under a Symbol key', () => {
    // An abstract base class has no concrete node `type`, so it publishes the
    // configuration it shares with its subclasses (here a $transform) under a
    // well-known symbol rather than a string key. getStaticNodeConfig must
    // resolve that symbol-keyed config so the transform is collected for the
    // concrete subclass.
    const transformed: string[] = [];
    class AbstractBaseNode extends ElementNode {
      $config() {
        return this.config(Symbol.for('AbstractBaseNode'), {
          $transform: (node: AbstractBaseNode) => {
            transformed.push(node.getType());
          },
        });
      }
    }
    class ConcreteChildNode extends AbstractBaseNode {
      $config() {
        return this.config('concrete-child-node', {extends: AbstractBaseNode});
      }
      createDOM(): HTMLElement {
        return document.createElement('div');
      }
    }
    // The abstract base must not be assigned a concrete type or static methods.
    expect(() => AbstractBaseNode.getType()).toThrow(
      /does not implement \.getType/,
    );

    const editor = createEditor({
      nodes: [ConcreteChildNode],
      onError(err) {
        throw err;
      },
    });
    editor.update(
      () => {
        $getRoot().append(new ConcreteChildNode());
      },
      {discrete: true},
    );

    expect(ConcreteChildNode.getType()).toEqual('concrete-child-node');
    expect(transformed).toEqual(['concrete-child-node']);
  });

  test('a structurally-identical subclass stays narrowable', () => {
    // TabNode adds nothing structural over TextNode (it only overrides methods
    // with identical signatures). The $config protocol accumulates a node's own
    // type under STATIC_NODE_TYPE, which keeps the two distinct so $isTabNode()
    // narrows a TextNode correctly instead of collapsing the negative branch to
    // `never` (which TypeScript would do if the base were assignable back to the
    // subclass).
    const $narrowFromTextNode = (node: TextNode): string => {
      if ($isTabNode(node)) {
        expectTypeOf(node).toEqualTypeOf<TabNode>();
        return node.getType();
      }
      // This assertion fails to compile if the negative branch collapsed to
      // `never` instead of staying `TextNode`.
      expectTypeOf(node).toEqualTypeOf<TextNode>();
      return node.getType();
    };

    const editor = createEditor({
      onError(err) {
        throw err;
      },
    });
    editor.update(
      () => {
        const tab = $createTabNode();
        const text = $createTextNode('x');
        expect($isTabNode(tab)).toBe(true);
        expect($isTabNode(text)).toBe(false);
        expect($narrowFromTextNode(text)).toBe('text');
        expect($narrowFromTextNode(tab)).toBe('tab');
      },
      {discrete: true},
    );
  });

  test('traversal methods return base node types unless explicitly cast', () => {
    // The type parameters on the traversal methods are deprecated unchecked
    // casts. Calls without a type argument must resolve to the base node
    // types rather than inferring the type parameter from context.
    const $checkTraversalTypes = (node: LexicalNode, element: ElementNode) => {
      expectTypeOf(node.getParent()).toEqualTypeOf<ElementNode | null>();
      expectTypeOf(node.getParentOrThrow()).toEqualTypeOf<ElementNode>();
      expectTypeOf(
        node.getPreviousSibling(),
      ).toEqualTypeOf<LexicalNode | null>();
      expectTypeOf(node.getNextSibling()).toEqualTypeOf<LexicalNode | null>();
      expectTypeOf(node.getPreviousSiblings()).toEqualTypeOf<LexicalNode[]>();
      expectTypeOf(node.getNextSiblings()).toEqualTypeOf<LexicalNode[]>();
      expectTypeOf(element.getChildren()).toEqualTypeOf<LexicalNode[]>();
      expectTypeOf(
        element.getChildAtIndex(0),
      ).toEqualTypeOf<LexicalNode | null>();
      expectTypeOf(element.getFirstChild()).toEqualTypeOf<LexicalNode | null>();
      expectTypeOf(element.getFirstChildOrThrow()).toEqualTypeOf<LexicalNode>();
      expectTypeOf(element.getLastChild()).toEqualTypeOf<LexicalNode | null>();
      expectTypeOf(element.getLastChildOrThrow()).toEqualTypeOf<LexicalNode>();
      expectTypeOf(
        element.getFirstDescendant(),
      ).toEqualTypeOf<LexicalNode | null>();
      expectTypeOf(
        element.getLastDescendant(),
      ).toEqualTypeOf<LexicalNode | null>();
      expectTypeOf(
        element.getDescendantByIndex(0),
      ).toEqualTypeOf<LexicalNode | null>();
      expectTypeOf(
        $getNodeByKey(node.getKey()),
      ).toEqualTypeOf<LexicalNode | null>();
      expectTypeOf(
        $getNodeByKeyOrThrow(node.getKey()),
      ).toEqualTypeOf<LexicalNode>();
      // The deprecated generic overloads remain callable so that existing
      // code continues to compile during migration.
      expectTypeOf(
        node.getParent<ParagraphNode>(),
      ).toEqualTypeOf<ParagraphNode | null>();
      expectTypeOf(
        element.getFirstChild<TextNode>(),
      ).toEqualTypeOf<TextNode | null>();
      expectTypeOf(
        $getNodeByKey<TextNode>(node.getKey()),
      ).toEqualTypeOf<TextNode | null>();
      expectTypeOf(
        $getNodeByKeyOrThrow<TextNode>(node.getKey()),
      ).toEqualTypeOf<TextNode>();
      // The type parameter is no longer inferred from the contextual type,
      // so this implicit unchecked cast is a compile error.
      // @ts-expect-error - getFirstChild() returns LexicalNode | null
      const child: TextNode | null = element.getFirstChild();
      return child;
    };

    const editor = createEditor({
      onError(err) {
        throw err;
      },
    });
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        const text = $createTextNode('x');
        paragraph.append(text);
        $getRoot().append(paragraph);
        expect($checkTraversalTypes(text, paragraph)).toBe(text);
      },
      {discrete: true},
    );
  });
});
