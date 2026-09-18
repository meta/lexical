/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {$generateHtmlFromNodes, $generateNodesFromDOM} from '@lexical/html';
import {$createLinkNode, $isLinkNode, type LinkNode} from '@lexical/link';
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {waitForReact} from '@lexical/react/src/__tests__/utils';
import {$createTextNode, $getRoot, ParagraphNode, TextNode} from 'lexical';
import {
  $assertNodeType,
  expectHtmlToBeEqual,
  html,
  initializeUnitTest,
} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, test} from 'vitest';

const editorConfig = Object.freeze({
  namespace: '',
  theme: {
    list: {
      ol: 'my-ol-list-class',
      olDepth: [
        'my-ol-list-class-1',
        'my-ol-list-class-2',
        'my-ol-list-class-3',
        'my-ol-list-class-4',
        'my-ol-list-class-5',
        'my-ol-list-class-6',
        'my-ol-list-class-7',
      ],
      ul: 'my-ul-list-class',
      ulDepth: [
        'my-ul-list-class-1',
        'my-ul-list-class-2',
        'my-ul-list-class-3',
        'my-ul-list-class-4',
        'my-ul-list-class-5',
        'my-ul-list-class-6',
        'my-ul-list-class-7',
      ],
    },
  },
});

describe('LexicalListNode tests', () => {
  initializeUnitTest(testEnv => {
    test('ListNode.constructor', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listNode = $createListNode('bullet', 1);
        expect(listNode.getType()).toBe('list');
        expect(listNode.getTag()).toBe('ul');
        expect(listNode.getTextContent()).toBe('');
      });
      await editor.update(() => {
        expect(() => $createListNode()).not.toThrow();
      });
    });

    test('ListNode.getTag()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const ulListNode = $createListNode('bullet', 1);
        expect(ulListNode.getTag()).toBe('ul');
        const olListNode = $createListNode('number', 1);
        expect(olListNode.getTag()).toBe('ol');
        const checkListNode = $createListNode('check', 1);
        expect(checkListNode.getTag()).toBe('ul');
      });
    });

    test('ListNode.createDOM()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listNode = $createListNode('bullet', 1);
        expect(listNode.createDOM(editorConfig).outerHTML).toBe(
          '<ul class="my-ul-list-class my-ul-list-class-1"></ul>',
        );
        expect(
          listNode.createDOM({
            namespace: '',
            theme: {
              list: {},
            },
          }).outerHTML,
        ).toBe('<ul></ul>');
        expect(
          listNode.createDOM({
            namespace: '',
            theme: {},
          }).outerHTML,
        ).toBe('<ul></ul>');
      });
    });

    test('ListNode.createDOM() correctly applies classes to a nested ListNode', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listNode1 = $createListNode('bullet');
        const listNode2 = $createListNode('bullet');
        const listNode3 = $createListNode('bullet');
        const listNode4 = $createListNode('bullet');
        const listNode5 = $createListNode('bullet');
        const listNode6 = $createListNode('bullet');
        const listNode7 = $createListNode('bullet');

        const listItem1 = $createListItemNode();
        const listItem2 = $createListItemNode();
        const listItem3 = $createListItemNode();
        const listItem4 = $createListItemNode();

        listNode1.append(listItem1);
        listItem1.append(listNode2);
        listNode2.append(listItem2);
        listItem2.append(listNode3);
        listNode3.append(listItem3);
        listItem3.append(listNode4);
        listNode4.append(listItem4);
        listNode4.append(listNode5);
        listNode5.append(listNode6);
        listNode6.append(listNode7);

        expect(listNode1.createDOM(editorConfig).outerHTML).toBe(
          '<ul class="my-ul-list-class my-ul-list-class-1"></ul>',
        );
        expect(
          listNode1.createDOM({
            namespace: '',
            theme: {
              list: {},
            },
          }).outerHTML,
        ).toBe('<ul></ul>');
        expect(
          listNode1.createDOM({
            namespace: '',
            theme: {},
          }).outerHTML,
        ).toBe('<ul></ul>');
        expect(listNode2.createDOM(editorConfig).outerHTML).toBe(
          '<ul class="my-ul-list-class my-ul-list-class-2"></ul>',
        );
        expect(listNode3.createDOM(editorConfig).outerHTML).toBe(
          '<ul class="my-ul-list-class my-ul-list-class-3"></ul>',
        );
        expect(listNode4.createDOM(editorConfig).outerHTML).toBe(
          '<ul class="my-ul-list-class my-ul-list-class-4"></ul>',
        );
        expect(listNode5.createDOM(editorConfig).outerHTML).toBe(
          '<ul class="my-ul-list-class my-ul-list-class-5"></ul>',
        );
        expect(listNode6.createDOM(editorConfig).outerHTML).toBe(
          '<ul class="my-ul-list-class my-ul-list-class-6"></ul>',
        );
        expect(listNode7.createDOM(editorConfig).outerHTML).toBe(
          '<ul class="my-ul-list-class my-ul-list-class-7"></ul>',
        );
        expect(
          listNode5.createDOM({
            namespace: '',
            theme: {
              list: {
                ...editorConfig.theme.list,
                ulDepth: [
                  'my-ul-list-class-1',
                  'my-ul-list-class-2',
                  'my-ul-list-class-3',
                ],
              },
            },
          }).outerHTML,
        ).toBe('<ul class="my-ul-list-class my-ul-list-class-2"></ul>');
      });
    });

    test('ListNode.updateDOM()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listNode = $createListNode('bullet', 1);
        const domElement = listNode.createDOM(editorConfig);

        expect(domElement.outerHTML).toBe(
          '<ul class="my-ul-list-class my-ul-list-class-1"></ul>',
        );

        const newListNode = $createListNode('number', 1);
        const result = newListNode.updateDOM(
          listNode,
          domElement,
          editorConfig,
        );

        expect(result).toBe(true);
        expect(domElement.outerHTML).toBe(
          '<ul class="my-ul-list-class my-ul-list-class-1"></ul>',
        );
      });
    });

    test('ListNode.exportDOM() round-trips the dir attribute', async () => {
      const {editor} = testEnv;

      const parser = new DOMParser();
      const input = html`
        <ul dir="rtl">
          <li dir="rtl">שלום</li>
        </ul>
      `;

      await editor.update(
        () => {
          const root = $getRoot();
          root.clear();
          root.append(
            ...$generateNodesFromDOM(
              editor,
              parser.parseFromString(input, 'text/html'),
            ),
          );
        },
        {discrete: true},
      );

      editor.read(() => {
        const listNode = $getRoot().getFirstChild();
        assert($isListNode(listNode), 'expected a ListNode at the root');
        // $convertListNode read it back off the <ul>
        expect(listNode.getDirection()).toBe('rtl');
        expect($generateHtmlFromNodes(editor)).toContain('<ul dir="rtl">');
      });
    });

    test('ListNode.append() should properly transform a ListItemNode', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listNode = new ListNode('bullet', 1);
        const listItemNode = new ListItemNode();
        const textNode = new TextNode('Hello');

        listItemNode.append(textNode);
        const nodesToAppend = [listItemNode];

        expect(listNode.append(...nodesToAppend)).toBe(listNode);
        expect(listNode.getFirstChild()).toBe(listItemNode);
        expect(listNode.getFirstChild()?.getTextContent()).toBe('Hello');
      });
    });

    test('ListNode.append() should properly transform a ListNode', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listNode = new ListNode('bullet', 1);
        const nestedListNode = new ListNode('bullet', 1);
        const listItemNode = new ListItemNode();
        const textNode = new TextNode('Hello');

        listItemNode.append(textNode);
        nestedListNode.append(listItemNode);

        const nodesToAppend = [nestedListNode];

        expect(listNode.append(...nodesToAppend)).toBe(listNode);
        expect($isListItemNode(listNode.getFirstChild())).toBe(true);
        expect(
          $assertNodeType(
            listNode.getFirstChild(),
            $isListItemNode,
          ).getFirstChild(),
        ).toBe(nestedListNode);
      });
    });

    test('ListNode.append() should properly transform a ParagraphNode', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listNode = new ListNode('bullet', 1);
        const paragraph = new ParagraphNode();
        const textNode = new TextNode('Hello');
        paragraph.append(textNode);
        const nodesToAppend = [paragraph];

        expect(listNode.append(...nodesToAppend)).toBe(listNode);
        expect($isListItemNode(listNode.getFirstChild())).toBe(true);
        expect(listNode.getFirstChild()?.getTextContent()).toBe('Hello');
      });
    });

    test('ListNode.append() should wrap an InlineNode in a ListItemNode without converting it to TextNode', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listNode = $createListNode('bullet', 1);
        const linkNode = $createLinkNode('https://lexical.dev/');

        listNode.append(linkNode);

        const root = $getRoot();
        root.append(listNode);
      });

      editor.read(() => {
        const root = $getRoot();

        const listNode = root.getFirstChild();
        expect(listNode).not.toBeNull();
        expect($isListNode(listNode)).toBe(true);

        if ($isListNode(listNode)) {
          const firstChild = listNode.getFirstChild();
          expect($isListItemNode(firstChild)).toBe(true);

          if ($isListItemNode(firstChild)) {
            const wrappedNode = firstChild?.getFirstChild();
            expect(wrappedNode).not.toBeNull();
            expect($isLinkNode(wrappedNode)).toBe(true);

            expect((wrappedNode as LinkNode).getURL()).toBe(
              'https://lexical.dev/',
            );
          } else {
            expect($isListItemNode(firstChild)).toBe(true);
          }
        }
      });
    });

    test('ListNode.splice() should wrap multiple non-ListItem nodes in individual ListItem nodes', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const list = $createListNode('bullet').append(
          $createListItemNode().append($createTextNode('A')),
          $createListItemNode().append($createTextNode('D')),
        );
        const root = $getRoot();
        root.append(list);

        const textA = $createTextNode('B');
        const textB = $createTextNode('C');

        list.splice(1, 0, [textA, textB]);
      });

      await editor.read(() => {
        const list = $getRoot().getFirstChild();
        assert($isListNode(list), 'First child must be a ListNode');

        const children = list.getChildren();
        expect(children).toHaveLength(4);

        // Each child must be its own ListItemNode, not the same instance
        expect($isListItemNode(children[1])).toBe(true);
        expect($isListItemNode(children[2])).toBe(true);
        expect(children[1]).not.toBe(children[2]);
        expect(children[1].getTextContent()).toBe('B');
        expect(children[2].getTextContent()).toBe('C');
      });
    });

    test('Should update list children when switching from checklist to bullet', async () => {
      const {editor} = testEnv;

      await waitForReact(() => {
        editor.update(() => {
          const root = $getRoot().clear();
          root.append($createListNode('check').append($createListItemNode()));
        });
      });

      expect(testEnv.innerHTML).toEqual(
        '<ul dir="auto"><li role="checkbox" tabindex="-1" aria-checked="false" value="1"><br data-lexical-managed-linebreak="true"></li></ul>',
      );

      await waitForReact(() => {
        editor.update(() => {
          const listNode = $assertNodeType(
            $getRoot().getFirstChild(),
            $isListNode,
          );
          listNode.setListType('bullet');
        });
      });

      expect(testEnv.innerHTML).toEqual(
        '<ul dir="auto"><li value="1"><br data-lexical-managed-linebreak="true"></li></ul>',
      );
    });

    test('Should clear checklist attributes when nesting lists', async () => {
      const {editor} = testEnv;

      await waitForReact(() => {
        editor.update(() => {
          const root = $getRoot().clear();
          root.append(
            $createListNode('check').append(
              $createListItemNode(),
              $createListItemNode(),
            ),
          );
        });
      });

      expectHtmlToBeEqual(
        testEnv.innerHTML,
        html`
          <ul dir="auto">
            <li role="checkbox" tabindex="-1" value="1" aria-checked="false">
              <br data-lexical-managed-linebreak="true" />
            </li>
            <li role="checkbox" tabindex="-1" value="2" aria-checked="false">
              <br data-lexical-managed-linebreak="true" />
            </li>
          </ul>
        `,
      );

      await waitForReact(() => {
        editor.update(() => {
          const listNode = $assertNodeType(
            $getRoot().getFirstChild(),
            $isListNode,
          );
          const listItemNode = $assertNodeType(
            listNode.getChildAtIndex(1),
            $isListItemNode,
          );
          listItemNode.append(
            $createListNode('bullet').append($createListItemNode()),
          );
        });
      });

      expectHtmlToBeEqual(
        testEnv.innerHTML,
        html`
          <ul dir="auto">
            <li role="checkbox" tabindex="-1" value="1" aria-checked="false">
              <br data-lexical-managed-linebreak="true" />
            </li>
            <li value="2">
              <ul>
                <li value="1">
                  <br data-lexical-managed-linebreak="true" />
                </li>
              </ul>
            </li>
          </ul>
        `,
      );
    });

    test('$createListNode()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listNode = $createListNode('bullet', 1);
        const createdListNode = $createListNode('bullet');

        expect(listNode.__type).toEqual(createdListNode.__type);
        expect(listNode.__parent).toEqual(createdListNode.__parent);
        expect(listNode.__tag).toEqual(createdListNode.__tag);
        expect(listNode.__key).not.toEqual(createdListNode.__key);
      });
    });

    test('$isListNode()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listNode = $createListNode('bullet', 1);

        expect($isListNode(listNode)).toBe(true);
      });
    });

    test('$createListNode() with tag name (backward compatibility)', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const numberList = $createListNode('number', 1);
        const bulletList = $createListNode('bullet', 1);
        expect(numberList.__listType).toBe('number');
        expect(bulletList.__listType).toBe('bullet');
      });
    });
  });
});

describe('LexicalListNode subclassing tests ($config)', () => {
  class ListNodeConfig extends ListNode {
    $config() {
      return this.config('list-$config', {extends: ListNode});
    }
  }
  function $initialState($createListNodeFn = $createListNode) {
    $getRoot()
      .clear()
      .append(
        $createListNodeFn().append(
          $createListItemNode().append($createTextNode('first')),
          $createListItemNode().append($createTextNode('second')),
        ),
      );
  }
  function $getListItemValues() {
    return $getRoot()
      .getAllTextNodes()
      .map(node => {
        const parent = node.getParent();
        return parent && $isListItemNode(parent) ? parent.getValue() : null;
      });
  }
  class ListNodeSubclass extends ListNode {
    $config() {
      return this.config('list-subclass', {extends: ListNode});
    }
  }
  describe('ListNode as-is', () =>
    initializeUnitTest(
      testEnv => {
        test('applies transform', () => {
          const {editor} = testEnv;
          editor.update(
            () => {
              $initialState($createListNode);
              expect($getListItemValues()).toEqual([1, 1]);
            },
            {discrete: true},
          );
          editor.read(() => {
            expect($getListItemValues()).toEqual([1, 2]);
          });
        });
      },
      {nodes: []},
    ));
  describe('ListNodeConfig (no replacement)', () =>
    initializeUnitTest(
      testEnv => {
        test('applies transform', () => {
          const {editor} = testEnv;
          editor.update(
            () => {
              $initialState(() => new ListNodeConfig());
              expect($getListItemValues()).toEqual([1, 1]);
            },
            {discrete: true},
          );
          editor.read(() => {
            expect($getListItemValues()).toEqual([1, 2]);
          });
        });
      },
      {nodes: [ListNodeConfig]},
    ));
  describe('ListNodeSubclass (no replacement)', () =>
    initializeUnitTest(
      testEnv => {
        test('applies transform', () => {
          const {editor} = testEnv;
          editor.update(
            () => {
              $initialState(() => new ListNodeSubclass());
              expect($getListItemValues()).toEqual([1, 1]);
            },
            {discrete: true},
          );
          editor.read(() => {
            expect($getListItemValues()).toEqual([1, 2]);
          });
        });
      },
      {nodes: [ListNodeSubclass]},
    ));
});
