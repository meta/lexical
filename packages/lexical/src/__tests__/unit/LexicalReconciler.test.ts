/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import invariant from '@lexical/internal/invariant';
import {$createLinkNode, LinkExtension} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $applyNodeReplacement,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isDecoratorNode,
  $isElementNode,
  $isParagraphNode,
  $isTextNode,
  type ElementDOMSlot,
  ElementNode,
  type NodeKey,
  type NodeMutation,
  ParagraphNode,
  type SerializedElementNode,
} from 'lexical';
import {afterEach, describe, expect, test, vi} from 'vitest';

import {$getReconciledDirection} from '../../LexicalReconciler';
import {
  $assertNodeType,
  $createTestDecoratorNode,
  $createTestElementNode,
  initializeUnitTest,
  TestDecoratorNode,
  TestElementNode,
} from '../utils';

describe('LexicalReconciler', () => {
  initializeUnitTest(testEnv => {
    test('Should set direction of root node children to auto if root node has no direction', async () => {
      const {editor} = testEnv;

      editor.update(() => {
        const root = $getRoot().clear();
        root.append(
          $createParagraphNode().append($createTextNode('فرعي')),
          $createParagraphNode().append($createTextNode('Hello')),
          $createParagraphNode().append($createLineBreakNode()),
        );
      });

      const directions = editor.read(() => {
        return $getRoot()
          .getChildren()
          .map(child =>
            $getReconciledDirection($assertNodeType(child, $isElementNode)),
          );
      });
      expect(directions).toEqual(['auto', 'auto', 'auto']);
    });

    test('Should not set direction of root node children if root node has direction', async () => {
      const {editor} = testEnv;

      editor.update(() => {
        const root = $getRoot().clear();
        root.setDirection('rtl');
        root.append(
          $createParagraphNode().append($createTextNode('فرعي')),
          $createParagraphNode().append($createTextNode('Hello')),
          $createParagraphNode().append($createLineBreakNode()),
        );
      });

      const directions = editor.read(() => {
        return $getRoot()
          .getChildren()
          .map(child =>
            $getReconciledDirection($assertNodeType(child, $isElementNode)),
          );
      });
      expect(directions).toEqual([null, null, null]);
    });

    test('Should allow overriding direction of root node children when root node has no direction', async () => {
      const {editor} = testEnv;

      editor.update(() => {
        const root = $getRoot().clear();
        root.append(
          $createParagraphNode()
            .setDirection('rtl')
            .append($createTextNode('فرعي')),
          $createParagraphNode()
            .setDirection('ltr')
            .append($createTextNode('فرعي')),
          $createParagraphNode()
            .setDirection('ltr')
            .append($createTextNode('Hello')),
          $createParagraphNode()
            .setDirection('rtl')
            .append($createLineBreakNode()),
          $createParagraphNode()
            .setDirection(null)
            .append($createLineBreakNode()),
        );
      });

      const directions = editor.read(() => {
        return $getRoot()
          .getChildren()
          .map(child =>
            $getReconciledDirection($assertNodeType(child, $isElementNode)),
          );
      });
      expect(directions).toEqual(['rtl', 'ltr', 'ltr', 'rtl', 'auto']);
    });

    test('Should allow overriding direction of root node children when root node has direction', async () => {
      const {editor} = testEnv;

      editor.update(() => {
        const root = $getRoot().clear();
        root.setDirection('rtl');
        root.append(
          $createParagraphNode()
            .setDirection('ltr')
            .append($createTextNode('فرعي')),
          $createParagraphNode().append($createTextNode('Hello')),
          $createParagraphNode().append($createLineBreakNode()),
        );
      });

      const directions = editor.read(() => {
        return $getRoot()
          .getChildren()
          .map(child =>
            $getReconciledDirection($assertNodeType(child, $isElementNode)),
          );
      });
      expect(directions).toEqual(['ltr', null, null]);
    });

    test('Should update root children when root node direction changes', async () => {
      const {editor} = testEnv;

      editor.update(() => {
        const root = $getRoot().clear();
        root.append(
          $createParagraphNode().append($createTextNode('فرعي')),
          $createParagraphNode()
            .setDirection('ltr')
            .append($createTextNode('Hello')),
        );
      });

      let directions = editor.read(() => {
        return $getRoot()
          .getChildren()
          .map(child =>
            $getReconciledDirection($assertNodeType(child, $isElementNode)),
          );
      });
      expect(directions).toEqual(['auto', 'ltr']);

      // Remove 'auto' from un-directioned children.
      editor.update(() => {
        $getRoot().setDirection('rtl');
      });

      directions = editor.read(() => {
        return $getRoot()
          .getChildren()
          .map(child =>
            $getReconciledDirection($assertNodeType(child, $isElementNode)),
          );
      });
      expect(directions).toEqual([null, 'ltr']);

      // Re-add 'auto' to children.
      editor.update(() => {
        $getRoot().setDirection(null);
      });

      directions = editor.read(() => {
        return $getRoot()
          .getChildren()
          .map(child =>
            $getReconciledDirection($assertNodeType(child, $isElementNode)),
          );
      });
      expect(directions).toEqual(['auto', 'ltr']);
    });

    describe('Cross-parent moves reuse DOM (regression #8420)', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      test('Decorator wrapped in another element reuses its DOM', async () => {
        const {editor} = testEnv;
        let decoratorKey = '';
        await editor.update(() => {
          const decorator = $createTestDecoratorNode();
          decoratorKey = decorator.getKey();
          $getRoot().clear().append($createParagraphNode().append(decorator));
        });

        const domBefore = editor.getElementByKey(decoratorKey);
        expect(domBefore).not.toBeNull();

        const mutations: NodeMutation[] = [];
        editor.registerMutationListener(
          TestDecoratorNode,
          nodes => {
            for (const m of nodes.values()) {
              mutations.push(m);
            }
          },
          {skipInitialization: true},
        );

        await editor.update(() => {
          const decorator = $assertNodeType(
            $assertNodeType(
              $getRoot().getFirstChild(),
              $isElementNode,
            ).getFirstChild(),
            $isDecoratorNode,
          );
          const wrapper = $createTestElementNode();
          decorator.insertBefore(wrapper);
          wrapper.append(decorator);
        });

        expect(editor.getElementByKey(decoratorKey)).toBe(domBefore);
        expect(domBefore?.parentElement?.tagName).toBe('DIV');
        expect(mutations).toEqual(['updated']);
      });

      test('Element subtree move preserves descendant DOM identities', async () => {
        const {editor} = testEnv;
        let elementKey = '';
        let textKey = '';
        await editor.update(() => {
          const element = $createTestElementNode();
          const text = $createTextNode('hello');
          elementKey = element.getKey();
          textKey = text.getKey();
          element.append(text);
          $getRoot().clear().append($createParagraphNode().append(element));
        });

        const elementDOMBefore = editor.getElementByKey(elementKey);
        const textDOMBefore = editor.getElementByKey(textKey);

        await editor.update(() => {
          const root = $getRoot();
          const newParagraph = $createParagraphNode();
          root.append(newParagraph);
          const element = $assertNodeType(
            $assertNodeType(
              root.getFirstChild(),
              $isElementNode,
            ).getFirstChild(),
            $isElementNode,
          );
          newParagraph.append(element);
        });

        expect(editor.getElementByKey(elementKey)).toBe(elementDOMBefore);
        expect(editor.getElementByKey(textKey)).toBe(textDOMBefore);
      });

      test('Multi-level nested subtree move preserves all descendant DOMs', async () => {
        const {editor} = testEnv;
        let outerKey = '';
        let innerKey = '';
        let leafKey = '';
        await editor.update(() => {
          const outer = $createTestElementNode();
          const inner = $createTestElementNode();
          const leaf = $createTextNode('leaf');
          outerKey = outer.getKey();
          innerKey = inner.getKey();
          leafKey = leaf.getKey();
          inner.append(leaf);
          outer.append(inner);
          $getRoot().clear().append($createParagraphNode().append(outer));
        });

        const outerDOMBefore = editor.getElementByKey(outerKey);
        const innerDOMBefore = editor.getElementByKey(innerKey);
        const leafDOMBefore = editor.getElementByKey(leafKey);

        await editor.update(() => {
          const root = $getRoot();
          const newParagraph = $createParagraphNode();
          root.append(newParagraph);
          const outer = $assertNodeType(
            $assertNodeType(
              root.getFirstChild(),
              $isElementNode,
            ).getFirstChild(),
            $isElementNode,
          );
          newParagraph.append(outer);
        });

        expect(editor.getElementByKey(outerKey)).toBe(outerDOMBefore);
        expect(editor.getElementByKey(innerKey)).toBe(innerDOMBefore);
        expect(editor.getElementByKey(leafKey)).toBe(leafDOMBefore);
      });

      test('Wrapping decorator emits a single "updated" listener event and re-decorates', async () => {
        const {editor} = testEnv;
        await editor.update(() => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTestDecoratorNode()));
        });

        const decorateSpy = vi.spyOn(TestDecoratorNode.prototype, 'decorate');
        const events: {klass: string; mutation: NodeMutation}[] = [];
        const recordMutations =
          (klass: string) => (nodes: Map<string, NodeMutation>) => {
            for (const m of nodes.values()) {
              events.push({klass, mutation: m});
            }
          };
        editor.registerMutationListener(
          TestDecoratorNode,
          recordMutations('decorator'),
          {skipInitialization: true},
        );
        editor.registerMutationListener(
          TestElementNode,
          recordMutations('element'),
          {skipInitialization: true},
        );

        await editor.update(() => {
          const decorator = $assertNodeType(
            $assertNodeType(
              $getRoot().getFirstChild(),
              $isElementNode,
            ).getFirstChild(),
            $isDecoratorNode,
          );
          const wrapper = $createTestElementNode();
          decorator.insertBefore(wrapper);
          wrapper.append(decorator);
        });

        expect(events.filter(e => e.klass === 'decorator')).toEqual([
          {klass: 'decorator', mutation: 'updated'},
        ]);
        expect(decorateSpy).toHaveBeenCalled();
      });

      test('Cross-parent swap with updateDOM=true does not throw', async () => {
        // Two single-child paragraphs swap their decorator children, and one
        // of the decorators also reports updateDOM=true (block flag flipped).
        // Without a slot guard in $createNode's reuse branch, the prev=1/
        // next=1 fast path would call $reconcileNode(key, null) and the
        // updateDOM=true replacement path would hit a parentDOM=null
        // invariant. With the guard, the reuse is skipped for slot=null
        // call sites and the move falls back to the regular create path.
        const {editor} = testEnv;
        let keyA = '';
        let keyB = '';
        await editor.update(() => {
          const a = $createTestDecoratorNode();
          const b = $createTestDecoratorNode();
          keyA = a.getKey();
          keyB = b.getKey();
          $getRoot()
            .clear()
            .append($createParagraphNode().append(a))
            .append($createParagraphNode().append(b));
        });

        // Should not throw — slot=null call sites fall back to the regular
        // create path when reuse would be unsafe.
        await editor.update(() => {
          const children = $getRoot().getChildren();
          const pX = $assertNodeType(children[0], $isElementNode);
          const pY = $assertNodeType(children[1], $isElementNode);
          const a = $assertNodeType(
            pX.getFirstChild(),
            (node): node is TestDecoratorNode =>
              node instanceof TestDecoratorNode,
          );
          const b = $assertNodeType(pY.getFirstChild(), $isDecoratorNode);
          a.setIsInline(false); // forces updateDOM=true on a
          pY.append(a);
          pX.append(b);
        });

        // Final structure: pX -> [b], pY -> [a (now block)]
        expect(editor.getElementByKey(keyA)?.tagName).toBe('DIV');
        expect(editor.getElementByKey(keyB)?.tagName).toBe('SPAN');
      });

      test('Same-parent reorder is unaffected by the reuse branch', async () => {
        // Reordering siblings goes through the slow-path "Move next" branch,
        // not $createNode. DOM identities for all reordered children must
        // survive, regardless of the new reuse logic.
        const {editor} = testEnv;
        let keyA = '';
        let keyB = '';
        let keyC = '';
        await editor.update(() => {
          const a = $createParagraphNode().append($createTextNode('a'));
          const b = $createParagraphNode().append($createTextNode('b'));
          const c = $createParagraphNode().append($createTextNode('c'));
          keyA = a.getKey();
          keyB = b.getKey();
          keyC = c.getKey();
          $getRoot().clear().append(a, b, c);
        });

        const domA = editor.getElementByKey(keyA);
        const domB = editor.getElementByKey(keyB);
        const domC = editor.getElementByKey(keyC);

        await editor.update(() => {
          const root = $getRoot();
          // Reorder [a, b, c] → [c, a, b] within the same parent.
          const c = $assertNodeType(root.getLastChild(), $isElementNode);
          c.remove();
          $assertNodeType(root.getFirstChild(), $isElementNode).insertBefore(c);
        });

        expect(editor.getElementByKey(keyA)).toBe(domA);
        expect(editor.getElementByKey(keyB)).toBe(domB);
        expect(editor.getElementByKey(keyC)).toBe(domC);
      });
    });
  });

  describe('Cross-parent moves preserve the source insertion anchor (regression #9273)', () => {
    for (const destinationSuffix of ['', 'b']) {
      for (const sourcePrefix of ['', 'c']) {
        test.each(['update', 'setEditorState'] as const)(
          `%s: move x from ${sourcePrefix}xy to a${destinationSuffix} and insert z before y`,
          method => {
            // Prepare snapshots without reconciling DOM so setEditorState is
            // exercised independently of the editor.update reconciliation path.
            using stateEditor = buildEditorFromExtensions({
              name: 'reconciler-move-state',
            });
            let aKey = '';
            let xKey = '';
            let yKey = '';
            stateEditor.update(
              () => {
                const a = $createTextNode('a').setMode('token');
                const x = $createTextNode('x').setMode('token');
                const y = $createTextNode('y').setMode('token');
                aKey = a.getKey();
                xKey = x.getKey();
                yKey = y.getKey();
                const destination = $createParagraphNode().append(a);
                if (destinationSuffix) {
                  destination.append(
                    $createTextNode(destinationSuffix).setMode('token'),
                  );
                }
                const source = $createParagraphNode();
                if (sourcePrefix) {
                  source.append($createTextNode(sourcePrefix).setMode('token'));
                }
                $getRoot().clear().append(destination, source.append(x, y));
              },
              {discrete: true},
            );
            const beforeState = stateEditor.getEditorState();
            const errors: Error[] = [];
            using editor = buildEditorFromExtensions({
              name: 'reconciler-move-dom',
              onError: error => errors.push(error),
            });
            const rootElement = document.createElement('div');
            editor.setRootElement(rootElement);
            editor.setEditorState(beforeState);
            const originalDOM = editor.read('latest', () =>
              $getRoot()
                .getChildren()
                .flatMap(node => [
                  node.getKey(),
                  ...$assertNodeType(node, $isElementNode).getChildrenKeys(),
                ])
                .map(key => [key, editor.getElementByKey(key)] as const),
            );
            const $moveAndInsert = () => {
              $getNodeByKey(aKey)!.insertAfter($getNodeByKey(xKey)!);
              $getNodeByKey(yKey)!.insertBefore(
                $createTextNode('z').setMode('token'),
              );
            };

            if (method === 'update') {
              editor.update($moveAndInsert, {discrete: true});
            } else {
              stateEditor.update($moveAndInsert, {discrete: true});
              editor.setEditorState(stateEditor.getEditorState());
            }

            expect(errors).toEqual([]);
            expect(
              Array.from(rootElement.children, element => element.textContent),
            ).toEqual([`ax${destinationSuffix}`, `${sourcePrefix}zy`]);
            expect(
              editor.read('latest', () =>
                $getRoot()
                  .getChildren()
                  .map(node => node.getTextContent()),
              ),
            ).toEqual([`ax${destinationSuffix}`, `${sourcePrefix}zy`]);
            // Error recovery can produce the right content by rebuilding the
            // entire editor. All existing paragraphs and text DOM must survive.
            for (const [key, dom] of originalDOM) {
              expect(editor.getElementByKey(key)).toBe(dom);
            }
          },
        );
      }
    }
  });

  describe('setElementIndent', () => {
    test('emits a CSS variable reference rather than a pre-resolved value', () => {
      using editor = buildEditorFromExtensions(
        RichTextExtension,
        defineExtension({
          $initialEditorState: () => {
            const para = $createParagraphNode().append(
              $createTextNode('hello'),
            );
            para.setIndent(3);
            $getRoot().clear().append(para);
          },
          name: 'set-element-indent-var',
        }),
      );
      editor.setRootElement(document.createElement('div'));

      editor.read(() => {
        const para = $assertNodeType(
          $getRoot().getFirstChild(),
          $isElementNode,
        );
        const dom = editor.getElementByKey(para.getKey());
        // The resolved CSS variable would only cascade after the element is
        // attached and styled. Emitting `var(...)` defers resolution to the
        // browser, so the inline style works regardless of where
        // `--lexical-indent-base-value` is defined or whether the element is
        // mounted at the time `setElementIndent` runs.
        expect(dom!.style.paddingInlineStart).toBe(
          'calc(3 * var(--lexical-indent-base-value, 40px))',
        );
      });
    });

    test('clears padding when indent returns to 0', () => {
      using editor = buildEditorFromExtensions(
        RichTextExtension,
        defineExtension({
          $initialEditorState: () => {
            const para = $createParagraphNode().append(
              $createTextNode('hello'),
            );
            para.setIndent(2);
            $getRoot().clear().append(para);
          },
          name: 'set-element-indent-clear',
        }),
      );
      editor.setRootElement(document.createElement('div'));

      editor.update(
        () => {
          const para = $assertNodeType(
            $getRoot().getFirstChild(),
            $isElementNode,
          );
          para.setIndent(0);
        },
        {discrete: true},
      );

      editor.read(() => {
        const para = $assertNodeType(
          $getRoot().getFirstChild(),
          $isElementNode,
        );
        const dom = editor.getElementByKey(para.getKey());
        expect(dom!.style.paddingInlineStart).toBe('');
      });
    });
  });

  describe('children fast path: contiguous-suffix incremental update', () => {
    function createReconcilerEditor() {
      const editor = buildEditorFromExtensions(
        RichTextExtension,
        defineExtension({name: 'reconciler-suffix-test'}),
      );
      editor.setRootElement(document.createElement('div'));
      return editor;
    }

    // Shared test node: a block ElementNode whose keyed DOM (outer <div>)
    // differs from its slot.element (inner <section>). Used by AUDIT-5
    // and AUDIT-5b to exercise the wrapping-parent code path in the
    // suffix size-delta helper. Mirrors the structure of nodes like
    // TableNode that wrap their keyed DOM in a scrollable container.
    class BlockWrapperElementNode extends ElementNode {
      $config() {
        return this.config('audit_block_wrapper', {extends: ElementNode});
      }
      createDOM(): HTMLElement {
        const el = document.createElement('div');
        el.className = 'block-wrapper';
        const inner = document.createElement('section');
        inner.className = 'inner-slot';
        el.appendChild(inner);
        return el;
      }
      updateDOM(): boolean {
        return false;
      }
      getDOMSlot(dom: HTMLElement): ElementDOMSlot {
        return super.getDOMSlot(dom).withElement(dom.querySelector('section')!);
      }
    }
    function $createBlockWrapperElementNode(): BlockWrapperElementNode {
      return $applyNodeReplacement(new BlockWrapperElementNode());
    }

    test('typing at the end of the last paragraph keeps prefix DLB', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          for (const t of ['alpha', 'beta', 'gamma']) {
            root.append($createParagraphNode().append($createTextNode(t)));
          }
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().__cachedText).toBe('alpha\n\nbeta\n\ngamma');
      });

      editor.update(
        () => {
          const last = $getRoot().getLastChildOrThrow();
          invariant($isParagraphNode(last), 'last must be a ParagraphNode');
          const text = last.getFirstChildOrThrow();
          invariant($isTextNode(text), 'text must be a TextNode');
          text.setTextContent(text.getTextContent() + '!');
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().__cachedText).toBe('alpha\n\nbeta\n\ngamma!');
      });
    });

    test('multiple contiguous dirty children at the end', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          for (const t of ['a', 'b', 'c', 'd']) {
            root.append($createParagraphNode().append($createTextNode(t)));
          }
        },
        {discrete: true},
      );

      editor.update(
        () => {
          const root = $getRoot();
          const c = root.getChildAtIndex(2);
          const d = root.getChildAtIndex(3);
          invariant($isParagraphNode(c), 'c must be a ParagraphNode');
          invariant($isParagraphNode(d), 'd must be a ParagraphNode');
          const cText = c.getFirstChildOrThrow();
          const dText = d.getFirstChildOrThrow();
          invariant($isTextNode(cText), 'cText must be a TextNode');
          invariant($isTextNode(dText), 'dText must be a TextNode');
          cText.setTextContent('cc');
          dText.setTextContent('dd');
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().__cachedText).toBe('a\n\nb\n\ncc\n\ndd');
      });
    });

    test('non-contiguous dirty children take the existing fast path', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          for (const t of ['x', 'y', 'z']) {
            root.append($createParagraphNode().append($createTextNode(t)));
          }
        },
        {discrete: true},
      );

      editor.update(
        () => {
          const root = $getRoot();
          const first = root.getChildAtIndex(0);
          const third = root.getChildAtIndex(2);
          invariant($isParagraphNode(first), 'first must be a ParagraphNode');
          invariant($isParagraphNode(third), 'third must be a ParagraphNode');
          const firstText = first.getFirstChildOrThrow();
          const thirdText = third.getFirstChildOrThrow();
          invariant($isTextNode(firstText), 'firstText must be a TextNode');
          invariant($isTextNode(thirdText), 'thirdText must be a TextNode');
          firstText.setTextContent('xx');
          thirdText.setTextContent('zz');
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().__cachedText).toBe('xx\n\ny\n\nzz');
      });
    });

    test('format toggle on the last paragraph propagates to __textFormat', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          for (const t of ['head', 'foot']) {
            root.append($createParagraphNode().append($createTextNode(t)));
          }
        },
        {discrete: true},
      );

      editor.update(
        () => {
          const last = $getRoot().getLastChildOrThrow();
          invariant($isParagraphNode(last), 'last must be a ParagraphNode');
          const text = last.getFirstChildOrThrow();
          invariant($isTextNode(text), 'text must be a TextNode');
          text.toggleFormat('bold');
        },
        {discrete: true},
      );

      editor.read(() => {
        const root = $getRoot();
        const head = root.getFirstChildOrThrow();
        const foot = root.getLastChildOrThrow();
        invariant($isParagraphNode(head), 'head must be a ParagraphNode');
        invariant($isParagraphNode(foot), 'foot must be a ParagraphNode');
        // Each paragraph's __textFormat is sourced from its own first text
        // descendant — head is unchanged (its first text is plain), foot now
        // reflects the toggled bold flag.
        expect(head.getTextFormat()).toBe(0);
        expect(foot.getTextFormat()).not.toBe(0);
        expect(root.__cachedText).toBe('head\n\nfoot');
      });
    });

    test('empty trailing paragraph contributes zero length', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          root.append(
            $createParagraphNode().append($createTextNode('hello')),
            $createParagraphNode(),
          );
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().__cachedText).toBe('hello\n\n');
      });

      editor.update(
        () => {
          const last = $getRoot().getLastChildOrThrow();
          invariant($isParagraphNode(last), 'last must be a ParagraphNode');
          last.append($createTextNode('world'));
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().__cachedText).toBe('hello\n\nworld');
      });
    });

    test('linebreak-bounded text nodes update suffix without extra DLB', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          const para = $createParagraphNode();
          para.append(
            $createTextNode('top'),
            $createLineBreakNode(),
            $createTextNode('bottom'),
          );
          root.append(para);
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().__cachedText).toBe('top\nbottom');
      });

      editor.update(
        () => {
          const para = $getRoot().getFirstChildOrThrow();
          invariant($isParagraphNode(para), 'para must be a ParagraphNode');
          const text = para.getLastChildOrThrow();
          invariant($isTextNode(text), 'text must be a TextNode');
          text.setTextContent('BOTTOM!');
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().__cachedText).toBe('top\nBOTTOM!');
      });
    });

    // Regression: prev-state size must come from the cached label on the
    // previous-state node instance. Going through `getTextContent()` would
    // resolve via `getLatest()` -> next state and miscompute oldSuffixLength
    // when the dirty tail TextNode's length actually changed.
    test('TextNode-direct-child suffix with length change: prefix preserved', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          const para = $createParagraphNode();
          para.append(
            $createTextNode('hello '),
            $createTextNode('world').toggleFormat('bold'),
          );
          root.append(para);
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().__cachedText).toBe('hello world');
      });

      editor.update(
        () => {
          const para = $getRoot().getFirstChildOrThrow();
          invariant($isParagraphNode(para), 'para must be a ParagraphNode');
          const text = para.getLastChildOrThrow();
          invariant($isTextNode(text), 'text must be a TextNode');
          text.setTextContent('world!!');
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().__cachedText).toBe('hello world!!');
      });
    });

    // Verifies the cached-text-size invariant under sustained typing on the
    // same paragraph. The paragraph instance is propagated-dirty (not cloned)
    // across cycles, so any cache mechanism that can't refresh on a frozen-
    // from-prev-cycle instance — e.g. Symbol-keyed property + skip-if-frozen —
    // would read a stale cycle-0 size in cycle 2+ and produce a wrong splice.
    // Append a new paragraph at the end of a multi-paragraph root: root
    // children grow by 1, with the previous last paragraph cloned for its
    // `__next` link update and the appended paragraph dirty as new — so the
    // root's reconcile sees `sizeDelta=+1` and `K=2` dirty children at the
    // suffix. Verifies the generalized suffix path correctly destroys nothing,
    // reconciles the formerly-last paragraph, creates the new one, and
    // splices the cached text.
    test('append paragraph at end of multi-paragraph root (size+1, K=2)', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          for (const t of ['a', 'b', 'c', 'd', 'e']) {
            root.append($createParagraphNode().append($createTextNode(t)));
          }
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().__cachedText).toBe('a\n\nb\n\nc\n\nd\n\ne');
      });

      editor.update(
        () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('f')),
          );
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().__cachedText).toBe('a\n\nb\n\nc\n\nd\n\ne\n\nf');
      });
    });

    // Remove the last paragraph from a multi-paragraph root: root children
    // shrink by 1, with the new last paragraph cloned for its `__next` link
    // update and the removed paragraph absent from next — so the root's
    // reconcile sees `sizeDelta=-1` and `K=1` dirty child at the suffix.
    // Verifies the generalized suffix path destroys the removed paragraph,
    // reconciles the new last, and splices the cached text.
    test('remove last paragraph of multi-paragraph root (size-1, K=1)', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          for (const t of ['a', 'b', 'c', 'd', 'e']) {
            root.append($createParagraphNode().append($createTextNode(t)));
          }
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().__cachedText).toBe('a\n\nb\n\nc\n\nd\n\ne');
      });

      editor.update(
        () => {
          $getRoot().getLastChildOrThrow().remove();
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().__cachedText).toBe('a\n\nb\n\nc\n\nd');
      });
    });

    test('sustained typing on the same paragraph stays correct (cache freshness)', () => {
      using editor = createReconcilerEditor();
      let textKey = '';

      // Multi-paragraph layout so the root-level suffix path actually fires
      // (K=1 dirty child of root, parent.__size=3 — suffix detection passes,
      // unlike a single-child root which falls through to Layer 1+2).
      editor.update(
        () => {
          const root = $getRoot().clear();
          root.append(
            $createParagraphNode().append($createTextNode('alpha')),
            $createParagraphNode().append($createTextNode('beta')),
          );
          const para = $createParagraphNode();
          const text = $createTextNode('x');
          textKey = text.getKey();
          para.append(text);
          root.append(para);
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().__cachedText).toBe('alpha\n\nbeta\n\nx');
      });

      for (const next of ['xy', 'xyz', 'xyzz']) {
        editor.update(
          () => {
            const text = $getNodeByKey(textKey);
            invariant($isTextNode(text), 'text must be a TextNode');
            text.setTextContent(next);
          },
          {discrete: true},
        );
        editor.read(() => {
          expect($getRoot().__cachedText).toBe(`alpha\n\nbeta\n\n${next}`);
        });
      }
    });

    // Sustained appends: each cycle exercises the size+1 / K=2 branch on
    // the root reconcile (the previous last paragraph is cloned for its
    // `__next` link update, the appended one is dirty as new). Verifies
    // that the root cached text stays accurate across many cycles, the
    // way the corresponding sustained-typing test does for the same-size
    // branch.
    test('sustained appends stay correct across cycles (cache freshness, size+1)', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          for (const t of ['a', 'b', 'c', 'd']) {
            root.append($createParagraphNode().append($createTextNode(t)));
          }
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().__cachedText).toBe('a\n\nb\n\nc\n\nd');
      });

      const labels = ['e', 'f', 'g', 'h', 'i'];
      let expectedText = 'a\n\nb\n\nc\n\nd';
      for (const label of labels) {
        editor.update(
          () => {
            $getRoot().append(
              $createParagraphNode().append($createTextNode(label)),
            );
          },
          {discrete: true},
        );
        expectedText = `${expectedText}\n\n${label}`;
        editor.read(() => {
          expect($getRoot().__cachedText).toBe(expectedText);
        });
      }
    });

    // Sustained removes: each cycle exercises the size-1 / K=1 branch on
    // the root reconcile (the new last paragraph is cloned for its
    // `__next` link update, the removed one is gone in next). Same
    // freshness assertion as the append counterpart.
    test('sustained removes stay correct across cycles (cache freshness, size-1)', () => {
      using editor = createReconcilerEditor();

      const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
      editor.update(
        () => {
          const root = $getRoot().clear();
          for (const t of labels) {
            root.append($createParagraphNode().append($createTextNode(t)));
          }
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().__cachedText).toBe(labels.join('\n\n'));
      });

      // Remove 3 trailing paragraphs one cycle at a time. Stop while the
      // root still has 4 children so the MIN gate keeps the fast path
      // engaged the whole time.
      const remaining = labels.slice();
      for (let i = 0; i < 3; i++) {
        editor.update(
          () => {
            $getRoot().getLastChildOrThrow().remove();
          },
          {discrete: true},
        );
        remaining.pop();
        editor.read(() => {
          expect($getRoot().__cachedText).toBe(remaining.join('\n\n'));
        });
      }
    });

    // Reconcile intentionally does NOT propagate textFormat / textStyle
    // to RootNode / ShadowRootNode — `LexicalElementNode.exportJSON`
    // already excludes them (#7968) and selection inheritance only reads
    // element format/style for non-root anchors. The
    // `$reconcileChildrenWithDirection` gate skips the calls entirely so
    // root never picks up format from a descendant, regardless of which
    // children fast path runs.
    test('AUDIT-1: root __textFormat is not propagated from descendants', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          // Three empty paragraphs (no text descendants in the prefix) +
          // one paragraph with plain text. Total 4 children, which clears
          // MIN_FAST_PATH_CHILDREN=4 so the suffix path engages.
          root.append(
            $createParagraphNode(),
            $createParagraphNode(),
            $createParagraphNode(),
            $createParagraphNode().append($createTextNode('x')),
          );
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().getTextFormat()).toBe(0);
      });

      editor.update(
        () => {
          const last = $getRoot().getLastChildOrThrow();
          invariant($isParagraphNode(last), 'last must be a ParagraphNode');
          const text = last.getFirstChildOrThrow();
          invariant($isTextNode(text), 'text must be a TextNode');
          text.toggleFormat('bold');
        },
        {discrete: true},
      );

      editor.read(() => {
        const root = $getRoot();
        const last = root.getLastChildOrThrow();
        invariant($isParagraphNode(last), 'last must be a ParagraphNode');
        // Inner reconcile of the last paragraph still updates its own
        // __textFormat — paragraphs are not gated.
        expect(last.getTextFormat()).not.toBe(0);
        // Root is intentionally NOT updated — the gate suppresses it.
        expect(root.getTextFormat()).toBe(0);
      });
    });

    // Companion / sanity test: when the prefix DOES have a text
    // descendant, the suffix-path clear is correct (the parent's
    // __textFormat is sourced from the prefix and shouldn't change). This
    // documents what the clear is protecting against, and locks in the
    // expected behavior so a fix to #1 doesn't regress this case.
    test('AUDIT-1 control: prefix with text keeps parent __textFormat stable', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          for (const t of ['a', 'b', 'c', 'd']) {
            root.append($createParagraphNode().append($createTextNode(t)));
          }
        },
        {discrete: true},
      );

      editor.read(() => {
        expect($getRoot().getTextFormat()).toBe(0);
      });

      editor.update(
        () => {
          const last = $getRoot().getLastChildOrThrow();
          invariant($isParagraphNode(last), 'last must be a ParagraphNode');
          const text = last.getFirstChildOrThrow();
          invariant($isTextNode(text), 'text must be a TextNode');
          text.toggleFormat('bold');
        },
        {discrete: true},
      );

      editor.read(() => {
        const root = $getRoot();
        const last = root.getLastChildOrThrow();
        invariant($isParagraphNode(last), 'last must be a ParagraphNode');
        expect(last.getTextFormat()).not.toBe(0);
        // First text descendant of root is 'a' in the prefix — plain.
        // root.__textFormat must NOT pick up the suffix's bold.
        expect(root.getTextFormat()).toBe(0);
      });
    });

    // Companion to AUDIT-1 (non-root): when the prefix DOES carry the
    // canonical first text descendant, the suffix path must NOT bubble
    // the suffix's format up to the parent. The cached __lexicalFirstTextKey
    // identifies the prefix child as authoritative via the dirty-set probe.
    test('AUDIT-1 (non-root) control: prefix with text keeps paragraph __textFormat stable', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          const para = $createParagraphNode();
          // Plain text first, then 3 line breaks, then a final text. The
          // first text descendant is the plain "head" — paragraph's
          // __textFormat must reflect 0 even after the trailing text is
          // bolded.
          para.append(
            $createTextNode('head'),
            $createLineBreakNode(),
            $createLineBreakNode(),
            $createTextNode('tail'),
          );
          root.append(para);
        },
        {discrete: true},
      );

      editor.read(() => {
        const para = $getRoot().getFirstChildOrThrow();
        invariant($isParagraphNode(para), 'para must be a ParagraphNode');
        expect(para.getTextFormat()).toBe(0);
      });

      editor.update(
        () => {
          const para = $getRoot().getFirstChildOrThrow();
          invariant($isParagraphNode(para), 'para must be a ParagraphNode');
          const tail = para.getLastChildOrThrow();
          invariant($isTextNode(tail), 'tail must be a TextNode');
          tail.toggleFormat('bold');
        },
        {discrete: true},
      );

      editor.read(() => {
        const para = $getRoot().getFirstChildOrThrow();
        invariant($isParagraphNode(para), 'para must be a ParagraphNode');
        // First text descendant ("head") is in the non-dirty prefix, so
        // its format (0) wins. The bolded "tail" is in the suffix and
        // must NOT bubble to the parent.
        expect(para.getTextFormat()).toBe(0);
      });
    });

    // Audit finding #1 (non-root variant): the same bug reproduces on a
    // *paragraph* whose prefix has no text descendants — e.g. line breaks
    // followed by a text node. Skipping `reconcileTextFormat` for
    // `$isRootOrShadowRoot` would not fix this case, since the paragraph's
    // own __textFormat is read by selection logic and JSON serialization.
    test('AUDIT-1 (non-root): paragraph with linebreak-only prefix leaks stale __textFormat', () => {
      using editor = createReconcilerEditor();

      editor.update(
        () => {
          const root = $getRoot().clear();
          const para = $createParagraphNode();
          // Three line breaks (non-text leaves, no text descendants in the
          // prefix) + a final text node "x". 4 inline children total, so
          // MIN_FAST_PATH_CHILDREN=4 is met when this paragraph is the
          // reconcile parent.
          para.append(
            $createLineBreakNode(),
            $createLineBreakNode(),
            $createLineBreakNode(),
            $createTextNode('x'),
          );
          root.append(para);
        },
        {discrete: true},
      );

      editor.read(() => {
        const para = $getRoot().getFirstChildOrThrow();
        invariant($isParagraphNode(para), 'para must be a ParagraphNode');
        expect(para.getTextFormat()).toBe(0);
      });

      editor.update(
        () => {
          const para = $getRoot().getFirstChildOrThrow();
          invariant($isParagraphNode(para), 'para must be a ParagraphNode');
          const text = para.getLastChildOrThrow();
          invariant($isTextNode(text), 'text must be a TextNode');
          text.toggleFormat('bold');
        },
        {discrete: true},
      );

      editor.read(() => {
        const para = $getRoot().getFirstChildOrThrow();
        invariant($isParagraphNode(para), 'para must be a ParagraphNode');
        // First (and only) text descendant of the paragraph is the bold
        // "x". paragraph.__textFormat must reflect that — it's used by
        // selection inheritance and JSON serialization.
        expect(para.getTextFormat()).not.toBe(0);
      });
    });

    function createReconcilerEditorWithLink() {
      const editor = buildEditorFromExtensions(
        RichTextExtension,
        LinkExtension,
        defineExtension({name: 'reconciler-suffix-test-with-link'}),
      );
      editor.setRootElement(document.createElement('div'));
      return editor;
    }

    // Regression: the general same-size walk (taken when the parent has many
    // children but suffix-incremental can't fire because no contiguous tail
    // is preserved) must capture both the format/style and the key of the
    // first direct TextNode child, so `dom.__lexicalFirstTextKey` is written
    // for the next cycle's `$resolveSuffixPathFormat` to find. If the key is
    // missing, the next cycle's helper takes the "no prefix text descendant"
    // branch and propagates the wrong text's format to the parent.
    test('general same-size walk caches first-text key on the parent DOM', () => {
      using editor = createReconcilerEditor();

      // 4 direct TextNode children with *distinct* formats so lexical's
      // TextNode normalization doesn't merge them after the cycle-2
      // style sweep. Without this, the 4 children collapse to 1 and
      // `paragraph.__size` drops below MIN_FAST_PATH_CHILDREN — the wrong
      // path for this regression. First child 'a' stays format-0 so the
      // assertion (`paragraph.__textFormat === 0`) reflects 'a's format.
      editor.update(
        () => {
          const root = $getRoot().clear();
          const para = $createParagraphNode();
          para.append(
            $createTextNode('a'),
            $createTextNode('b').toggleFormat('bold'),
            $createTextNode('c').toggleFormat('italic'),
            $createTextNode('d').toggleFormat('code'),
          );
          root.append(para);
        },
        {discrete: true},
      );

      // Cycle 2: re-style every child. All 4 children dirty → suffix-
      // incremental bails (`$suffixStartIfContiguous` returns null when
      // dirty.size >= parent.__size) → general same-size walk runs →
      // `dom.__lexicalFirstTextKey` must be written from the post-walk
      // module state. The C1 fix is exactly this capture site.
      editor.update(
        () => {
          const para = $getRoot().getFirstChildOrThrow();
          invariant($isParagraphNode(para), 'para must be a ParagraphNode');
          for (const child of para.getChildren()) {
            invariant($isTextNode(child), 'child must be a TextNode');
            child.setStyle('color: red');
          }
        },
        {discrete: true},
      );

      editor.read(() => {
        const para = $getRoot().getFirstChildOrThrow();
        invariant($isParagraphNode(para), 'para must be a ParagraphNode');
        // Confirm normalization didn't merge the children.
        expect(para.getChildren()).toHaveLength(4);
        const firstChildKey = para.getFirstChildOrThrow().__key;
        const dom = editor.getElementByKey(para.__key) as
          | (HTMLElement & {__lexicalFirstTextKey?: unknown})
          | null;
        expect(dom?.__lexicalFirstTextKey).toBe(firstChildKey);
        expect(para.getTextFormat()).toBe(0);
      });

      // Cycle 3: format-toggle only the last child. 1 dirty child + 4-child
      // parent → suffix-incremental fires → `$resolveSuffixPathFormat`
      // reads the cached first-text key from cycle 2. If C1's capture were
      // missing, that key would be null and the helper would take the
      // "no prefix text" branch, propagating the last child's format up.
      editor.update(
        () => {
          const para = $getRoot().getFirstChildOrThrow();
          invariant($isParagraphNode(para), 'para must be a ParagraphNode');
          const last = para.getLastChildOrThrow();
          invariant($isTextNode(last), 'last must be a TextNode');
          last.toggleFormat('underline');
        },
        {discrete: true},
      );

      editor.read(() => {
        const para = $getRoot().getFirstChildOrThrow();
        invariant($isParagraphNode(para), 'para must be a ParagraphNode');
        // First text descendant 'a' is still format 0 — parent must reflect
        // that, not 'd's (code | underline).
        expect(para.getTextFormat()).toBe(0);
      });
    });

    // Regression: the suffix walks (both the same-size loop in
    // `$reconcileChildren` and the ops loop in `$tryReconcileSuffixWithSizeDelta`)
    // recursively reconcile element children, and `$reconcileChildrenWithDirection`
    // resets the module state at entry. Without save/restore, each iteration
    // clobbers the previous one and the walk ends with the *last* suffix
    // element child's first-text descendant, not the first. When the prefix
    // has no text descendant, the parent then gets the wrong text's format
    // propagated up.
    test('suffix walk keeps the leftmost first-text descriptor across element-child iterations', () => {
      using editor = createReconcilerEditorWithLink();

      editor.update(
        () => {
          const root = $getRoot().clear();
          const para = $createParagraphNode();
          // Prefix has no text descendants (3 line breaks). Suffix has two
          // links carrying text — X bold, Y italic. Total 5 inline children
          // ≥ MIN_FAST_PATH_CHILDREN.
          const linkX = $createLinkNode('https://x.example');
          linkX.append($createTextNode('X').toggleFormat('bold'));
          const linkY = $createLinkNode('https://y.example');
          linkY.append($createTextNode('Y').toggleFormat('italic'));
          para.append(
            $createLineBreakNode(),
            $createLineBreakNode(),
            $createLineBreakNode(),
            linkX,
            linkY,
          );
          root.append(para);
        },
        {discrete: true},
      );

      editor.update(
        () => {
          const para = $getRoot().getFirstChildOrThrow();
          invariant($isParagraphNode(para), 'para must be a ParagraphNode');
          // Dirty the text inside both links by re-styling. Dirty propagation
          // marks the parent link (and paragraph) as dirty too, so each link
          // goes through the suffix walk's recursive reconcile — that's where
          // the previous-iteration module state would get clobbered.
          for (const child of para.getChildren()) {
            if ($isElementNode(child)) {
              const innerText = child.getFirstChild();
              if (innerText !== null && $isTextNode(innerText)) {
                innerText.setStyle('color: red');
              }
            }
          }
        },
        {discrete: true},
      );

      editor.read(() => {
        const para = $getRoot().getFirstChildOrThrow();
        invariant($isParagraphNode(para), 'para must be a ParagraphNode');
        // First text descendant in DFS order is X (bold). Parent must
        // reflect X's format, not Y's.
        const TEXT_FORMAT_BOLD = 1;
        expect(para.getTextFormat()).toBe(TEXT_FORMAT_BOLD);
      });
    });

    // AUDIT-2: when the suffix attempt bails (non-contiguous dirty) and
    // the Layer 2 same-size general walk fires, each dirty ElementNode
    // child's recursive reconcile resets the module state at entry and
    // overwrites whatever earlier non-dirty children's caches would
    // contribute. Layer 2 has no save/restore (unlike the suffix walks
    // fixed in commit 9207234), so the parent ends up reflecting the
    // *middle* dirty child's first-text descendant instead of the
    // leftmost. The leftmost prefix child carries the canonical first
    // text descendant in DFS order and should win.
    test('AUDIT-2: Layer 2 walk writes wrong __lexicalFirstTextKey when middle child is dirty', () => {
      using editor = createReconcilerEditorWithLink();

      editor.update(
        () => {
          const root = $getRoot().clear();
          const para = $createParagraphNode();
          const linkA = $createLinkNode('https://a.example');
          // textA carries bold so the post-cycle-2 assertion
          // distinguishes leftmost-wins (paragraph reflects bold) from
          // both "no propagation" (would stay at construct default 0)
          // and "later-dirty wins" (would reflect textC's code).
          linkA.append($createTextNode('a').toggleFormat('bold'));
          const linkB = $createLinkNode('https://b.example');
          linkB.append($createTextNode('b').toggleFormat('italic'));
          const linkC = $createLinkNode('https://c.example');
          linkC.append($createTextNode('c').toggleFormat('code'));
          const linkD = $createLinkNode('https://d.example');
          linkD.append($createTextNode('d').toggleFormat('underline'));
          para.append(linkA, linkB, linkC, linkD);
          root.append(para);
        },
        {discrete: true},
      );

      editor.read(() => {
        const para = $getRoot().getFirstChildOrThrow();
        invariant($isParagraphNode(para), 'para must be a ParagraphNode');
        // Initial render via $createNode doesn't go through
        // reconcileTextFormat, so __textFormat stays at the constructor
        // default (0). This is pre-existing behavior independent of the
        // bug under test.
        expect(para.getTextFormat()).toBe(0);
      });

      // Cycle 2: re-style only the third link's text (textC, code format).
      // textC is dirty, propagates to linkC and P. dirtyChildren_map for
      // P = {linkC}. Non-contiguous suffix → suffix attempt bails →
      // Layer 2 same-size walk fires.
      const TEXT_FORMAT_CODE = 16;
      editor.update(
        () => {
          const para = $getRoot().getFirstChildOrThrow();
          invariant($isParagraphNode(para), 'para must be a ParagraphNode');
          const linkC = para.getChildAtIndex(2);
          invariant($isElementNode(linkC), 'linkC must be element');
          const textC = linkC.getFirstChildOrThrow();
          invariant($isTextNode(textC), 'textC must be text');
          textC.setStyle('color: red');
        },
        {discrete: true},
      );

      editor.read(() => {
        const para = $getRoot().getFirstChildOrThrow();
        invariant($isParagraphNode(para), 'para must be a ParagraphNode');
        const dom = editor.getElementByKey(para.__key) as
          | (HTMLElement & {__lexicalFirstTextKey?: unknown})
          | null;
        const linkA = para.getChildAtIndex(0);
        invariant($isElementNode(linkA), 'linkA must be element');
        const textAKey = linkA.getFirstChildOrThrow().__key;
        // Bug shape: Layer 2 walks all 4 link children, only linkC
        // recurses. linkC's reset+capture leaks textC's format/key to
        // the parent scope. After the walk:
        //   - subTreeFirstTextKey = textC_key, NOT textA_key.
        //   - reconcileTextFormat(P) sets P.__textFormat to textC's
        //     format (code), even though the first DFS text descendant
        //     (textA, bold) didn't change.
        //
        // Expected with the leftmost-wins fix:
        //   - dom.__lexicalFirstTextKey === textAKey.
        //   - para.getTextFormat() === BOLD (textA's format).
        const TEXT_FORMAT_BOLD = 1;
        expect(dom?.__lexicalFirstTextKey).toBe(textAKey);
        expect(para.getTextFormat()).toBe(TEXT_FORMAT_BOLD);
        void TEXT_FORMAT_CODE;
      });
    });

    // AUDIT-3: same bug pattern in $reconcileNodeChildren (the general
    // two-pointer walk for cases like middle-insert that the fast paths
    // can't handle). Each recursive `$reconcileNode` for an element
    // child runs through `$reconcileChildrenWithDirection`'s reset.
    // Without save/restore around the call, only the *last* iteration's
    // first-text descriptor survives — `dom.__lexicalFirstTextKey` is
    // written incorrectly and `reconcileTextFormat` propagates the
    // wrong child's format.
    test('AUDIT-3: $reconcileNodeChildren writes wrong cache after middle-insert', () => {
      using editor = createReconcilerEditorWithLink();

      editor.update(
        () => {
          const root = $getRoot().clear();
          const para = $createParagraphNode();
          const linkA = $createLinkNode('https://a.example');
          linkA.append($createTextNode('a').toggleFormat('bold'));
          const linkB = $createLinkNode('https://b.example');
          linkB.append($createTextNode('b').toggleFormat('italic'));
          const linkD = $createLinkNode('https://d.example');
          linkD.append($createTextNode('d').toggleFormat('underline'));
          para.append(linkA, linkB, linkD);
          root.append(para);
        },
        {discrete: true},
      );

      // Cycle 2: insert linkC between B and D. sizeDelta=+1 (3 → 4) but
      // suffix-incremental fast path bails because prevChildrenSize=3 is
      // below MIN_FAST_PATH_CHILDREN=4. Falls to $reconcileNodeChildren.
      editor.update(
        () => {
          const para = $getRoot().getFirstChildOrThrow();
          invariant($isParagraphNode(para), 'para must be a ParagraphNode');
          const linkD = para.getChildAtIndex(2);
          invariant($isElementNode(linkD), 'linkD must be element');
          const linkC = $createLinkNode('https://c.example');
          linkC.append($createTextNode('c').toggleFormat('code'));
          linkD.insertBefore(linkC);
        },
        {discrete: true},
      );

      editor.read(() => {
        const para = $getRoot().getFirstChildOrThrow();
        invariant($isParagraphNode(para), 'para must be a ParagraphNode');
        const linkA = para.getChildAtIndex(0);
        invariant($isElementNode(linkA), 'linkA must be element');
        const textAKey = linkA.getFirstChildOrThrow().__key;
        const dom = editor.getElementByKey(para.__key) as
          | (HTMLElement & {__lexicalFirstTextKey?: unknown})
          | null;
        // The parent's first DFS text descendant didn't change (still
        // textA, format 0). `__lexicalFirstTextKey` should reflect that.
        // Bug: $reconcileNodeChildren's last reconciled element child's
        // first-text key wins.
        expect(dom?.__lexicalFirstTextKey).toBe(textAKey);
      });
    });

    // AUDIT-4: when an ElementNode wraps its keyed DOM in an outer element
    // (TableNode wraps a <table> in a scrollable <div>; this test uses a
    // simpler `<main><section>...</section></main>` wrapper to keep
    // setup self-contained), the cache is written to the slot.element
    // (inner `<section>`), not the keyed DOM (outer `<main>`).
    //
    // `$bubbleChildFirstText(dom)` in `$reconcileNode`'s !isDirty branches
    // reads `dom.__lexicalFirstTextKey` directly off the keyed DOM. For
    // wrapper elements the keyed DOM has no cache, so the bubble silently
    // skips and the parent's first-text capture loses this child.
    //
    // When the wrapper element is the leftmost child carrying the
    // canonical first text descendant, this means the parent's
    // `__lexicalFirstTextKey` is wrong, and `reconcileTextFormat` picks
    // up a later dirty sibling's format instead.
    test('AUDIT-4: $bubbleChildFirstText misses cache on elements with wrapping DOM', () => {
      class WrapperElementNode extends ElementNode {
        $config() {
          return this.config('audit_wrapper', {extends: ElementNode});
        }
        createDOM(): HTMLElement {
          const el = document.createElement('main');
          el.appendChild(document.createElement('section'));
          return el;
        }
        updateDOM(): boolean {
          return false;
        }
        getDOMSlot(dom: HTMLElement): ElementDOMSlot {
          return super
            .getDOMSlot(dom)
            .withElement(dom.querySelector('section')!);
        }
        isInline(): boolean {
          return true;
        }
        exportJSON(): SerializedElementNode {
          throw new Error('Not implemented');
        }
      }
      function $createWrapperElementNode(): WrapperElementNode {
        return $applyNodeReplacement(new WrapperElementNode());
      }

      const editor = buildEditorFromExtensions(
        RichTextExtension,
        LinkExtension,
        defineExtension({
          name: 'wrapper-audit',
          nodes: [WrapperElementNode],
        }),
      );
      editor.setRootElement(document.createElement('div'));

      try {
        editor.update(
          () => {
            const root = $getRoot().clear();
            const para = $createParagraphNode();
            // Wrapper element (with internal slot != keyed DOM) at the
            // head, carrying the canonical first text descendant (textA,
            // bold). 4 inline children → Layer 2 walk on para in cycle 2.
            const wrapper = $createWrapperElementNode();
            wrapper.append($createTextNode('a').toggleFormat('bold'));
            const linkB = $createLinkNode('https://b.example');
            linkB.append($createTextNode('b').toggleFormat('italic'));
            const linkC = $createLinkNode('https://c.example');
            linkC.append($createTextNode('c').toggleFormat('code'));
            const linkD = $createLinkNode('https://d.example');
            linkD.append($createTextNode('d').toggleFormat('underline'));
            para.append(wrapper, linkB, linkC, linkD);
            root.append(para);
          },
          {discrete: true},
        );

        // Cycle 2: dirty only the middle link's text. Suffix attempt
        // bails (non-contiguous). Layer 2 walks. The wrapper element is
        // non-dirty: `$bubbleChildFirstText(wrapper.keyedDOM)` should
        // pick up the cached first-text key from the wrapper's section
        // (inner slot), but reads keyed DOM (outer main) which has no
        // cache.
        editor.update(
          () => {
            const para = $getRoot().getFirstChildOrThrow();
            invariant($isParagraphNode(para), 'para must be a ParagraphNode');
            const linkC = para.getChildAtIndex(2);
            invariant($isElementNode(linkC), 'linkC must be element');
            const textC = linkC.getFirstChildOrThrow();
            invariant($isTextNode(textC), 'textC must be text');
            textC.setStyle('color: red');
          },
          {discrete: true},
        );

        editor.read(() => {
          const para = $getRoot().getFirstChildOrThrow();
          invariant($isParagraphNode(para), 'para must be a ParagraphNode');
          const wrapper = para.getChildAtIndex(0);
          invariant($isElementNode(wrapper), 'wrapper must be element');
          const textAKey = wrapper.getFirstChildOrThrow().__key;
          const TEXT_FORMAT_BOLD = 1;
          // First DFS text descendant is textA inside the wrapper. The
          // parent's __textFormat must reflect bold.
          expect(para.getTextFormat()).toBe(TEXT_FORMAT_BOLD);
          // The keyed DOM (outer main) has no cache. We verify the bug
          // shape by reading the parent's __lexicalFirstTextKey: it
          // should be textA's key (from wrapper) but is the dirty child's
          // text key because the bubble silently skipped the wrapper.
          const paraDom = editor.getElementByKey(para.__key) as
            | (HTMLElement & {__lexicalFirstTextKey?: unknown})
            | null;
          expect(paraDom?.__lexicalFirstTextKey).toBe(textAKey);
        });
      } finally {
        editor.dispose();
      }
    });

    // AUDIT-5: when a wrapping ElementNode (keyed DOM != slot.element) is
    // the *parent* whose children mutate via the suffix size-delta fast
    // path, the helper's `$reconcileNode` / `$destroyNode` calls must
    // target `slot.element` (the actual DOM parent of the children), not
    // the outer keyed DOM where the text-content cache lives.
    //
    // Pre-fix, the helper received only `cacheDom` and routed it to both
    // roles. For wrapping parents the child's `parentNode` is the inner
    // slot, so `$destroyNode`'s `dom.parentNode === parentDOM` guard
    // failed silently and the orphan stayed in the DOM (size-delta=-1).
    // The `$reconcileNode` path's `parentDOM.replaceChild` would throw on
    // any `$updateDOM`-returning-true reconcile for the same reason.
    test('AUDIT-5: size-delta suffix routes DOM ops to slot.element on wrapping parents', () => {
      const editor = buildEditorFromExtensions(
        RichTextExtension,
        defineExtension({
          name: 'block-wrapper-audit',
          nodes: [BlockWrapperElementNode],
        }),
      );
      editor.setRootElement(document.createElement('div'));

      try {
        // Cycle 1: wrapper with 4 paragraph children (>= MIN_FAST_PATH_CHILDREN).
        editor.update(
          () => {
            const root = $getRoot().clear();
            const wrapper = $createBlockWrapperElementNode();
            for (let i = 0; i < 4; i++) {
              wrapper.append(
                $createParagraphNode().append($createTextNode(`p${i}`)),
              );
            }
            root.append(wrapper);
          },
          {discrete: true},
        );

        editor.read(() => {
          const wrapper = $getRoot().getFirstChildOrThrow();
          invariant($isElementNode(wrapper), 'wrapper');
          const outerDom = editor.getElementByKey(wrapper.__key)!;
          const innerSlot = outerDom.querySelector('section')!;
          expect(innerSlot.children.length).toBe(4);
          expect(outerDom.children.length).toBe(1);
        });

        // Cycle 2: append a 5th paragraph at the end (sizeDelta=+1, K=2).
        // The suffix size-delta helper fires; pre-fix this routed
        // $createNode through the helper's own $getDOMSlot call (still
        // correct), but in the mixed reconcile/create ops case the
        // $reconcileNode call would also fire with the wrong parent.
        editor.update(
          () => {
            const wrapper = $getRoot().getFirstChildOrThrow();
            invariant($isElementNode(wrapper), 'wrapper');
            wrapper.append(
              $createParagraphNode().append($createTextNode('p4')),
            );
          },
          {discrete: true},
        );

        editor.read(() => {
          const wrapper = $getRoot().getFirstChildOrThrow();
          invariant($isElementNode(wrapper), 'wrapper');
          const outerDom = editor.getElementByKey(wrapper.__key)!;
          const innerSlot = outerDom.querySelector('section')!;
          expect(innerSlot.children.length).toBe(5);
          expect(innerSlot.textContent).toBe('p0p1p2p3p4');
          expect(outerDom.children.length).toBe(1);
        });

        // Cycle 3: remove the last paragraph (sizeDelta=-1, K=1).
        // The destroy op fires. Pre-fix, $destroyNode(op.key, cacheDom)
        // was called with the outer `<div>`; the removed paragraph's
        // parentNode is the inner `<section>`, so the guard at
        // `dom.parentNode === parentDOM` failed silently — the
        // `<p>` stayed in the DOM as an unmapped orphan. Post-fix,
        // slot.element (= inner `<section>`) is passed; removeChild
        // succeeds and the DOM child count matches the node count.
        editor.update(
          () => {
            const wrapper = $getRoot().getFirstChildOrThrow();
            invariant($isElementNode(wrapper), 'wrapper');
            wrapper.getLastChildOrThrow().remove();
          },
          {discrete: true},
        );

        editor.read(() => {
          const wrapper = $getRoot().getFirstChildOrThrow();
          invariant($isElementNode(wrapper), 'wrapper');
          const outerDom = editor.getElementByKey(wrapper.__key)!;
          const innerSlot = outerDom.querySelector('section')!;
          expect(innerSlot.children.length).toBe(4);
          expect(innerSlot.textContent).toBe('p0p1p2p3');
          expect(outerDom.children.length).toBe(1);
        });
      } finally {
        editor.dispose();
      }
    });

    // AUDIT-5b: covers the `$reconcileNode` arm of the AUDIT-5 fix. The
    // AUDIT-5 test exercises only the `$destroyNode` path because
    // ParagraphNode's `updateDOM` returns false — `$reconcileNode`'s
    // `parentDOM.replaceChild` branch never fires there. Use a paragraph
    // subclass that forces `updateDOM` to return true so the replaceChild
    // path runs against a wrapping parent. Pre-fix this threw
    // `NotFoundError` because the outer wrapper is not the direct DOM
    // parent of the existing child.
    test('AUDIT-5b: size-delta suffix routes $reconcileNode replaceChild through slot.element on wrapping parents', () => {
      class RerenderParagraphNode extends ParagraphNode {
        $config() {
          return this.config('audit_rerender_paragraph', {
            extends: ParagraphNode,
          });
        }
        updateDOM(): boolean {
          return true;
        }
      }
      function $createRerenderParagraphNode(): RerenderParagraphNode {
        return $applyNodeReplacement(new RerenderParagraphNode());
      }

      const editor = buildEditorFromExtensions(
        RichTextExtension,
        defineExtension({
          name: 'block-wrapper-audit-b',
          nodes: [BlockWrapperElementNode, RerenderParagraphNode],
        }),
      );
      editor.setRootElement(document.createElement('div'));

      try {
        const plainParaKeys: NodeKey[] = [];
        let rerenderKey: NodeKey = '';

        // Cycle 1: wrapper with 3 plain paragraphs + 1 RerenderParagraph
        // at the end. Size 4 hits MIN_FAST_PATH_CHILDREN.
        editor.update(
          () => {
            const root = $getRoot().clear();
            const wrapper = $createBlockWrapperElementNode();
            for (let i = 0; i < 3; i++) {
              const p = $createParagraphNode().append($createTextNode(`p${i}`));
              wrapper.append(p);
              plainParaKeys.push(p.__key);
            }
            const rN = $createRerenderParagraphNode().append(
              $createTextNode('pR'),
            );
            wrapper.append(rN);
            rerenderKey = rN.__key;
            root.append(wrapper);
          },
          {discrete: true},
        );

        // Snapshot the post-cycle-1 DOMs. The reconciler must preserve
        // identity for the non-dirty prefix children across cycle 2; only
        // the reconciled RerenderParagraph gets a fresh DOM via
        // replaceChild. Pre-fix the replaceChild fails (parentDOM mismatch
        // in jsdom throws a `DOMException`, which Lexical recovers from
        // via `resetEditor` + `FULL_RECONCILE` — rebuilding every child
        // DOM from scratch, so the plain prefix loses identity.
        const plainPreDoms = plainParaKeys.map(
          k => editor.getElementByKey(k) as HTMLElement | null,
        );
        const rerenderPreDom = editor.getElementByKey(
          rerenderKey,
        ) as HTMLElement | null;

        // Cycle 2: append a 5th plain paragraph. sizeDelta=+1, K=2 — the
        // helper's ops are [reconcile RerenderParagraph, create newP]. The
        // reconcile takes the replaceChild branch via $updateDOM=true.
        editor.update(
          () => {
            const wrapper = $getRoot().getFirstChildOrThrow();
            invariant($isElementNode(wrapper), 'wrapper');
            wrapper.append(
              $createParagraphNode().append($createTextNode('pNew')),
            );
          },
          {discrete: true},
        );

        editor.read(() => {
          const wrapper = $getRoot().getFirstChildOrThrow();
          invariant($isElementNode(wrapper), 'wrapper');
          const outerDom = editor.getElementByKey(wrapper.__key)!;
          const innerSlot = outerDom.querySelector('section')!;

          // DOM shape stays correct after cycle 2 even pre-fix because
          // Lexical recovers from the throw with a full re-render. The
          // load-bearing assertion is below — identity survival of the
          // non-dirty prefix.
          expect(innerSlot.children.length).toBe(5);
          expect(innerSlot.textContent).toBe('p0p1p2pRpNew');
          expect(outerDom.children.length).toBe(1);

          // Identity survival: the plain prefix children are non-dirty in
          // cycle 2; the reconciler must keep their DOMs intact. Pre-fix,
          // the recovery path creates fresh DOMs for every child — these
          // identity comparisons fail.
          for (let i = 0; i < plainParaKeys.length; i++) {
            const post = editor.getElementByKey(plainParaKeys[i]);
            expect(post).toBe(plainPreDoms[i]);
          }

          // The RerenderParagraph went through replaceChild — its DOM
          // identity must differ from cycle 1's. Pre-fix recovery also
          // gives a new DOM, so this single assertion alone wouldn't
          // discriminate; paired with the prefix-identity check above it
          // confirms the targeted-replace happened rather than the
          // full-rebuild fallback.
          const postRerender = editor.getElementByKey(rerenderKey);
          expect(postRerender).not.toBe(rerenderPreDom);
        });
      } finally {
        editor.dispose();
      }
    });

    // AUDIT-6: same-size suffix newSuffix builder must read each
    // reconciled child's cache from the CURRENT keyed-DOM map, not the
    // prev-state snapshot. When a dirty child's `$updateDOM` returns
    // true, `$reconcileNode`'s `parentDOM.replaceChild` detaches the old
    // DOM and stores a new one in `_keyToDOMMap`. The prev snapshot
    // still points at the detached old DOM whose `__lexicalTextContent`
    // is the previous cycle's text — stale. Reading from the prev map
    // (pre-fix) writes a stale value into the parent's
    // `__lexicalTextContent`, which then propagates up the cache chain.
    test('AUDIT-6: same-size suffix reads current-state cache after $updateDOM=true', () => {
      class RerenderParagraphNode extends ParagraphNode {
        $config() {
          return this.config('audit_rerender_paragraph_same_size', {
            extends: ParagraphNode,
          });
        }
        updateDOM(): boolean {
          return true;
        }
      }
      function $createRerenderParagraphNode(): RerenderParagraphNode {
        return $applyNodeReplacement(new RerenderParagraphNode());
      }

      const editor = buildEditorFromExtensions(
        RichTextExtension,
        defineExtension({
          name: 'same-size-rerender-audit',
          nodes: [RerenderParagraphNode],
        }),
      );
      editor.setRootElement(document.createElement('div'));

      try {
        let rN1Key: NodeKey = '';
        let rN2Key: NodeKey = '';

        // Cycle 1: root has 4 block children — 2 plain paragraphs + 2
        // RerenderParagraphs as the contiguous suffix. Size 4 hits
        // MIN_FAST_PATH_CHILDREN.
        editor.update(
          () => {
            const root = $getRoot().clear();
            root.append(
              $createParagraphNode().append($createTextNode('p0')),
              $createParagraphNode().append($createTextNode('p1')),
            );
            const rN1 = $createRerenderParagraphNode().append(
              $createTextNode('pR1'),
            );
            const rN2 = $createRerenderParagraphNode().append(
              $createTextNode('pR2'),
            );
            root.append(rN1, rN2);
            rN1Key = rN1.__key;
            rN2Key = rN2.__key;
          },
          {discrete: true},
        );

        // Cycle 2: mutate text in both RerenderParagraphs. sizeDelta=0,
        // K=2 contiguous suffix → same-size suffix path fires. Both
        // children's `$updateDOM` returns true → replaceChild swaps each
        // DOM in `_keyToDOMMap`. The prev snapshot still references the
        // old detached DOMs whose cached `__lexicalTextContent` is from
        // cycle 1 ("pR1", "pR2"). Reading from the prev map would
        // produce a stale parent cache.
        editor.update(
          () => {
            const rN1 = $getNodeByKey(rN1Key);
            const rN2 = $getNodeByKey(rN2Key);
            invariant(
              $isElementNode(rN1) && $isElementNode(rN2),
              'rN1/rN2 are elements',
            );
            const t1 = rN1.getFirstChildOrThrow();
            const t2 = rN2.getFirstChildOrThrow();
            invariant($isTextNode(t1) && $isTextNode(t2), 'texts');
            t1.setTextContent('NEW_R1');
            t2.setTextContent('NEW_R2');
          },
          {discrete: true},
        );

        editor.read(() => {
          const root = $getRoot();
          const expected = ['p0', 'p1', 'NEW_R1', 'NEW_R2'].join('\n\n');
          expect(root.getTextContent()).toBe(expected);
          const rootDom = editor.getElementByKey(root.__key) as
            | (HTMLElement & {__lexicalTextContent?: string})
            | null;
          // The load-bearing check: pre-fix, this returns the stale
          // 'p0\n\np1\n\npR1\n\npR2' string because the newSuffix builder
          // read each reconciled child's `__lexicalTextContent` off the
          // detached prev-state DOM.
          expect(rootDom?.__lexicalTextContent).toBe(expected);
        });
      } finally {
        editor.dispose();
      }
    });

    // AUDIT-7: the suffix size-delta helper hardcodes expectedK = 2 for
    // sizeDelta=+1 and 1 for sizeDelta=-1, bailing on anything else.
    // This test sets up a K=3 contiguous suffix with sizeDelta=+1 so the
    // K check at line 724 fires, the helper bails, and the general path
    // rebuilds the cache. The test pins the OUTPUT (`__lexicalTextContent`
    // matches the walked text) — note that the helper's splice math
    // happens to also produce the correct output for this specific
    // K=3/sizeDelta=+1 case (since `kPrime = k - sizeDelta = 2`), so if
    // the K check were ever loosened to allow K=3 through, this test
    // wouldn't fail. The output sentinel still catches a broken splice
    // (e.g. wrong `oldSuffixLength`, off-by-one boundary).
    test('AUDIT-7: K=3 contiguous suffix with sizeDelta=+1 — output sentinel after helper bail', () => {
      const editor = buildEditorFromExtensions(RichTextExtension);
      editor.setRootElement(document.createElement('div'));

      try {
        let paraCKey: NodeKey | null = null;
        let paraDKey: NodeKey | null = null;
        editor.update(
          () => {
            const root = $getRoot().clear();
            const labels = ['pA', 'pB', 'pC', 'pD'];
            for (const label of labels) {
              const p = $createParagraphNode();
              p.append($createTextNode(label));
              root.append(p);
              if (label === 'pC') {
                paraCKey = p.__key;
              } else if (label === 'pD') {
                paraDKey = p.__key;
              }
            }
          },
          {discrete: true},
        );

        // Mutate pC and pD (contiguous suffix), append pE. Dirty set:
        // {pC, pD, pE} forms a K=3 contiguous suffix of the next state.
        // sizeDelta=+1, expectedK=2 → helper bails at the K check (line
        // 724), caller falls through to $reconcileNodeChildren.
        editor.update(
          () => {
            invariant(paraCKey !== null && paraDKey !== null, 'keys set');
            const paraC = $getNodeByKey(paraCKey);
            const paraD = $getNodeByKey(paraDKey);
            invariant(
              $isParagraphNode(paraC) && $isParagraphNode(paraD),
              'paraC/paraD are paragraphs',
            );
            const tC = paraC.getFirstChildOrThrow();
            const tD = paraD.getFirstChildOrThrow();
            invariant($isTextNode(tC) && $isTextNode(tD), 'texts');
            tC.setTextContent('CHANGED_C');
            tD.setTextContent('CHANGED_D');
            const root = $getRoot();
            root.append($createParagraphNode().append($createTextNode('pE')));
          },
          {discrete: true},
        );

        editor.read(() => {
          const root = $getRoot();
          const expected = ['pA', 'pB', 'CHANGED_C', 'CHANGED_D', 'pE'].join(
            '\n\n',
          );
          expect(root.getTextContent()).toBe(expected);
          const rootDom = editor.getElementByKey(root.__key) as
            | (HTMLElement & {__lexicalTextContent?: string})
            | null;
          // Cached parent text must match the freshly computed text. If
          // the K check were ever loosened to let K=3 through the helper
          // with the current splice math (which assumes expectedK=2),
          // `__lexicalTextContent` here would diverge from the walked
          // value.
          expect(rootDom?.__lexicalTextContent).toBe(expected);
        });
      } finally {
        editor.dispose();
      }
    });
  });
});
