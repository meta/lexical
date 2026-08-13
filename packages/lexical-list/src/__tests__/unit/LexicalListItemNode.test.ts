/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {$generateNodesFromDOM} from '@lexical/html';
import {
  $createListItemNode,
  $createListNode,
  $handleListInsertParagraph,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list';
import {
  $createTableCellNode,
  $createTableNode,
  $createTableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  TextNode,
} from 'lexical';
import {
  expectHtmlToBeEqual,
  html,
  initializeUnitTest,
} from 'lexical/src/__tests__/utils';
import {assert, beforeEach, describe, expect, it, test} from 'vitest';

import {$handleIndent} from '../../formatList';

const editorConfig = Object.freeze({
  namespace: '',
  theme: {
    list: {
      listitem: 'my-listItem-item-class',
      nested: {
        listitem: 'my-nested-list-listItem-class',
      },
    },
  },
});

describe('LexicalListItemNode tests', () => {
  initializeUnitTest(testEnv => {
    test('ListItemNode.constructor', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listItemNode = new ListItemNode();

        expect(listItemNode.getType()).toBe('listitem');

        expect(listItemNode.getTextContent()).toBe('');
      });

      expect(() => new ListItemNode()).toThrow();
    });

    test('ListItemNode.createDOM()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listItemNode = new ListItemNode();

        expectHtmlToBeEqual(
          listItemNode.createDOM(editorConfig).outerHTML,
          html`
            <li class="my-listItem-item-class" value="1"></li>
          `,
        );

        expectHtmlToBeEqual(
          listItemNode.createDOM({
            namespace: '',
            theme: {},
          }).outerHTML,
          html`
            <li value="1"></li>
          `,
        );
      });
    });

    describe('ListItemNode.updateDOM()', () => {
      test('base', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const listItemNode = new ListItemNode();

          const domElement = listItemNode.createDOM(editorConfig);

          expectHtmlToBeEqual(
            domElement.outerHTML,
            html`
              <li class="my-listItem-item-class" value="1"></li>
            `,
          );
          const newListItemNode = new ListItemNode();

          const result = newListItemNode.updateDOM(
            listItemNode,
            domElement,
            editorConfig,
          );

          expect(result).toBe(false);

          expectHtmlToBeEqual(
            domElement.outerHTML,
            html`
              <li class="my-listItem-item-class" value="1"></li>
            `,
          );
        });
      });

      test('nested list', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const parentListNode = new ListNode('bullet', 1);
          const parentlistItemNode = new ListItemNode();

          parentListNode.append(parentlistItemNode);
          const domElement = parentlistItemNode.createDOM(editorConfig);

          expectHtmlToBeEqual(
            domElement.outerHTML,
            html`
              <li class="my-listItem-item-class" value="1"></li>
            `,
          );
          const nestedListNode = new ListNode('bullet', 1);
          nestedListNode.append(new ListItemNode());
          parentlistItemNode.append(nestedListNode);
          const result = parentlistItemNode.updateDOM(
            parentlistItemNode,
            domElement,
            editorConfig,
          );

          expect(result).toBe(false);

          expectHtmlToBeEqual(
            domElement.outerHTML,
            html`
              <li
                class="my-listItem-item-class my-nested-list-listItem-class"
                value="1"></li>
            `,
          );
        });
      });
    });

    describe('ListItemNode.replace()', () => {
      let listNode: ListNode;
      let listItemNode1: ListItemNode;
      let listItemNode2: ListItemNode;
      let listItemNode3: ListItemNode;

      beforeEach(async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const root = $getRoot();
          listNode = new ListNode('bullet', 1);
          listItemNode1 = new ListItemNode();

          listItemNode1.append(new TextNode('one'));
          listItemNode2 = new ListItemNode();

          listItemNode2.append(new TextNode('two'));
          listItemNode3 = new ListItemNode();

          listItemNode3.append(new TextNode('three'));
          root.append(listNode);
          listNode.append(listItemNode1, listItemNode2, listItemNode3);
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">one</span>
                </li>
                <li value="2">
                  <span data-lexical-text="true">two</span>
                </li>
                <li value="3">
                  <span data-lexical-text="true">three</span>
                </li>
              </ul>
            </div>
          `,
        );
      });

      test('another list item node', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const newListItemNode = new ListItemNode();

          newListItemNode.append(new TextNode('bar'));
          listItemNode1.replace(newListItemNode);
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">bar</span>
                </li>
                <li value="2">
                  <span data-lexical-text="true">two</span>
                </li>
                <li value="3">
                  <span data-lexical-text="true">three</span>
                </li>
              </ul>
            </div>
          `,
        );
      });

      test('first list item with a non list item node', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          return;
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">one</span>
                </li>
                <li value="2">
                  <span data-lexical-text="true">two</span>
                </li>
                <li value="3">
                  <span data-lexical-text="true">three</span>
                </li>
              </ul>
            </div>
          `,
        );

        await editor.update(() => {
          const paragraphNode = $createParagraphNode();
          listItemNode1.replace(paragraphNode);
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">two</span>
                </li>
                <li value="2">
                  <span data-lexical-text="true">three</span>
                </li>
              </ul>
            </div>
          `,
        );
      });

      test('last list item with a non list item node', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const paragraphNode = $createParagraphNode();
          listItemNode3.replace(paragraphNode);
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">one</span>
                </li>
                <li value="2">
                  <span data-lexical-text="true">two</span>
                </li>
              </ul>
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </div>
          `,
        );
      });

      test('middle list item with a non list item node', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const paragraphNode = $createParagraphNode();
          listItemNode2.replace(paragraphNode);
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">one</span>
                </li>
              </ul>
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">three</span>
                </li>
              </ul>
            </div>
          `,
        );
      });

      test('the only list item with a non list item node', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          listItemNode2.remove();
          listItemNode3.remove();
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">one</span>
                </li>
              </ul>
            </div>
          `,
        );

        await editor.update(() => {
          const paragraphNode = $createParagraphNode();
          listItemNode1.replace(paragraphNode);
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <p dir="auto"><br data-lexical-managed-linebreak="true" /></p>
            </div>
          `,
        );
      });
    });

    describe('ListItemNode.remove()', () => {
      // - A
      // - x
      // - B
      test('siblings are not nested', async () => {
        const {editor} = testEnv;
        let x: ListItemNode;

        await editor.update(() => {
          const root = $getRoot();
          const parent = new ListNode('bullet', 1);

          const A_listItem = new ListItemNode();
          A_listItem.append(new TextNode('A'));

          x = new ListItemNode();
          x.append(new TextNode('x'));

          const B_listItem = new ListItemNode();
          B_listItem.append(new TextNode('B'));

          parent.append(A_listItem, x, B_listItem);
          root.append(parent);
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">A</span>
                </li>
                <li value="2">
                  <span data-lexical-text="true">x</span>
                </li>
                <li value="3">
                  <span data-lexical-text="true">B</span>
                </li>
              </ul>
            </div>
          `,
        );

        await editor.update(() => x.remove());

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">A</span>
                </li>
                <li value="2">
                  <span data-lexical-text="true">B</span>
                </li>
              </ul>
            </div>
          `,
        );
      });

      //   - A
      // - x
      // - B
      test('the previous sibling is nested', async () => {
        const {editor} = testEnv;
        let x: ListItemNode;

        await editor.update(() => {
          const root = $getRoot();
          const parent = new ListNode('bullet', 1);

          const A_listItem = new ListItemNode();
          const A_nestedList = new ListNode('bullet', 1);
          const A_nestedListItem = new ListItemNode();
          A_listItem.append(A_nestedList);
          A_nestedList.append(A_nestedListItem);
          A_nestedListItem.append(new TextNode('A'));

          x = new ListItemNode();
          x.append(new TextNode('x'));

          const B_listItem = new ListItemNode();
          B_listItem.append(new TextNode('B'));

          parent.append(A_listItem, x, B_listItem);
          root.append(parent);
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">A</span>
                    </li>
                  </ul>
                </li>
                <li value="1">
                  <span data-lexical-text="true">x</span>
                </li>
                <li value="2">
                  <span data-lexical-text="true">B</span>
                </li>
              </ul>
            </div>
          `,
        );

        await editor.update(() => x.remove());

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">A</span>
                    </li>
                  </ul>
                </li>
                <li value="1">
                  <span data-lexical-text="true">B</span>
                </li>
              </ul>
            </div>
          `,
        );
      });

      // - A
      // - x
      //   - B
      test('the next sibling is nested', async () => {
        const {editor} = testEnv;
        let x: ListItemNode;

        await editor.update(() => {
          const root = $getRoot();
          const parent = new ListNode('bullet', 1);

          const A_listItem = new ListItemNode();
          A_listItem.append(new TextNode('A'));

          x = new ListItemNode();
          x.append(new TextNode('x'));

          const B_listItem = new ListItemNode();
          const B_nestedList = new ListNode('bullet', 1);
          const B_nestedListItem = new ListItemNode();
          B_listItem.append(B_nestedList);
          B_nestedList.append(B_nestedListItem);
          B_nestedListItem.append(new TextNode('B'));

          parent.append(A_listItem, x, B_listItem);
          root.append(parent);
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">A</span>
                </li>
                <li value="2">
                  <span data-lexical-text="true">x</span>
                </li>
                <li value="3">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">B</span>
                    </li>
                  </ul>
                </li>
              </ul>
            </div>
          `,
        );

        await editor.update(() => x.remove());

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">A</span>
                </li>
                <li value="2">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">B</span>
                    </li>
                  </ul>
                </li>
              </ul>
            </div>
          `,
        );
      });

      //   - A
      // - x
      //   - B
      test('both siblings are nested', async () => {
        const {editor} = testEnv;
        let x: ListItemNode;

        await editor.update(() => {
          const root = $getRoot();
          const parent = new ListNode('bullet', 1);

          const A_listItem = new ListItemNode();
          const A_nestedList = new ListNode('bullet', 1);
          const A_nestedListItem = new ListItemNode();
          A_listItem.append(A_nestedList);
          A_nestedList.append(A_nestedListItem);
          A_nestedListItem.append(new TextNode('A'));

          x = new ListItemNode();
          x.append(new TextNode('x'));

          const B_listItem = new ListItemNode();
          const B_nestedList = new ListNode('bullet', 1);
          const B_nestedListItem = new ListItemNode();
          B_listItem.append(B_nestedList);
          B_nestedList.append(B_nestedListItem);
          B_nestedListItem.append(new TextNode('B'));

          parent.append(A_listItem, x, B_listItem);
          root.append(parent);
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">A</span>
                    </li>
                  </ul>
                </li>
                <li value="1">
                  <span data-lexical-text="true">x</span>
                </li>
                <li value="2">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">B</span>
                    </li>
                  </ul>
                </li>
              </ul>
            </div>
          `,
        );

        await editor.update(() => x.remove());

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">A</span>
                    </li>
                    <li value="2">
                      <span data-lexical-text="true">B</span>
                    </li>
                  </ul>
                </li>
              </ul>
            </div>
          `,
        );
      });

      //  - A1
      //     - A2
      // - x
      //   - B
      test('the previous sibling is nested deeper than the next sibling', async () => {
        const {editor} = testEnv;
        let x: ListItemNode;

        await editor.update(() => {
          const root = $getRoot();
          const parent = new ListNode('bullet', 1);

          const A_listItem = new ListItemNode();
          const A_nestedList = new ListNode('bullet', 1);
          const A_nestedListItem1 = new ListItemNode();
          const A_nestedListItem2 = new ListItemNode();
          const A_deeplyNestedList = new ListNode('bullet', 1);
          const A_deeplyNestedListItem = new ListItemNode();
          A_listItem.append(A_nestedList);
          A_nestedList.append(A_nestedListItem1);
          A_nestedList.append(A_nestedListItem2);
          A_nestedListItem1.append(new TextNode('A1'));
          A_nestedListItem2.append(A_deeplyNestedList);
          A_deeplyNestedList.append(A_deeplyNestedListItem);
          A_deeplyNestedListItem.append(new TextNode('A2'));

          x = new ListItemNode();
          x.append(new TextNode('x'));

          const B_listItem = new ListItemNode();
          const B_nestedList = new ListNode('bullet', 1);
          const B_nestedlistItem = new ListItemNode();
          B_listItem.append(B_nestedList);
          B_nestedList.append(B_nestedlistItem);
          B_nestedlistItem.append(new TextNode('B'));

          parent.append(A_listItem, x, B_listItem);
          root.append(parent);
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">A1</span>
                    </li>
                    <li value="2">
                      <ul>
                        <li value="1">
                          <span data-lexical-text="true">A2</span>
                        </li>
                      </ul>
                    </li>
                  </ul>
                </li>
                <li value="1">
                  <span data-lexical-text="true">x</span>
                </li>
                <li value="2">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">B</span>
                    </li>
                  </ul>
                </li>
              </ul>
            </div>
          `,
        );

        await editor.update(() => x.remove());

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">A1</span>
                    </li>
                    <li value="2">
                      <ul>
                        <li value="1">
                          <span data-lexical-text="true">A2</span>
                        </li>
                      </ul>
                    </li>
                    <li value="2">
                      <span data-lexical-text="true">B</span>
                    </li>
                  </ul>
                </li>
              </ul>
            </div>
          `,
        );
      });

      //   - A
      // - x
      //     - B1
      //   - B2
      test('the next sibling is nested deeper than the previous sibling', async () => {
        const {editor} = testEnv;
        let x: ListItemNode;

        await editor.update(() => {
          const root = $getRoot();
          const parent = new ListNode('bullet', 1);

          const A_listItem = new ListItemNode();
          const A_nestedList = new ListNode('bullet', 1);
          const A_nestedListItem = new ListItemNode();
          A_listItem.append(A_nestedList);
          A_nestedList.append(A_nestedListItem);
          A_nestedListItem.append(new TextNode('A'));

          x = new ListItemNode();
          x.append(new TextNode('x'));

          const B_listItem = new ListItemNode();
          const B_nestedList = new ListNode('bullet', 1);
          const B_nestedListItem1 = new ListItemNode();
          const B_nestedListItem2 = new ListItemNode();
          const B_deeplyNestedList = new ListNode('bullet', 1);
          const B_deeplyNestedListItem = new ListItemNode();
          B_listItem.append(B_nestedList);
          B_nestedList.append(B_nestedListItem1);
          B_nestedList.append(B_nestedListItem2);
          B_nestedListItem1.append(B_deeplyNestedList);
          B_nestedListItem2.append(new TextNode('B2'));
          B_deeplyNestedList.append(B_deeplyNestedListItem);
          B_deeplyNestedListItem.append(new TextNode('B1'));

          parent.append(A_listItem, x, B_listItem);
          root.append(parent);
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">A</span>
                    </li>
                  </ul>
                </li>
                <li value="1">
                  <span data-lexical-text="true">x</span>
                </li>
                <li value="2">
                  <ul>
                    <li value="1">
                      <ul>
                        <li value="1">
                          <span data-lexical-text="true">B1</span>
                        </li>
                      </ul>
                    </li>
                    <li value="1">
                      <span data-lexical-text="true">B2</span>
                    </li>
                  </ul>
                </li>
              </ul>
            </div>
          `,
        );

        await editor.update(() => x.remove());

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">A</span>
                    </li>
                    <li value="2">
                      <ul>
                        <li value="1">
                          <span data-lexical-text="true">B1</span>
                        </li>
                      </ul>
                    </li>
                    <li value="2">
                      <span data-lexical-text="true">B2</span>
                    </li>
                  </ul>
                </li>
              </ul>
            </div>
          `,
        );
      });

      //   - A1
      //     - A2
      // - x
      //     - B1
      //   - B2
      test('both siblings are deeply nested', async () => {
        const {editor} = testEnv;
        let x: ListItemNode;

        await editor.update(() => {
          const root = $getRoot();
          const parent = new ListNode('bullet', 1);

          const A_listItem = new ListItemNode();
          const A_nestedList = new ListNode('bullet', 1);
          const A_nestedListItem1 = new ListItemNode();
          const A_nestedListItem2 = new ListItemNode();
          const A_deeplyNestedList = new ListNode('bullet', 1);
          const A_deeplyNestedListItem = new ListItemNode();
          A_listItem.append(A_nestedList);
          A_nestedList.append(A_nestedListItem1);
          A_nestedList.append(A_nestedListItem2);
          A_nestedListItem1.append(new TextNode('A1'));
          A_nestedListItem2.append(A_deeplyNestedList);
          A_deeplyNestedList.append(A_deeplyNestedListItem);
          A_deeplyNestedListItem.append(new TextNode('A2'));

          x = new ListItemNode();
          x.append(new TextNode('x'));

          const B_listItem = new ListItemNode();
          const B_nestedList = new ListNode('bullet', 1);
          const B_nestedListItem1 = new ListItemNode();
          const B_nestedListItem2 = new ListItemNode();
          const B_deeplyNestedList = new ListNode('bullet', 1);
          const B_deeplyNestedListItem = new ListItemNode();
          B_listItem.append(B_nestedList);
          B_nestedList.append(B_nestedListItem1);
          B_nestedList.append(B_nestedListItem2);
          B_nestedListItem1.append(B_deeplyNestedList);
          B_nestedListItem2.append(new TextNode('B2'));
          B_deeplyNestedList.append(B_deeplyNestedListItem);
          B_deeplyNestedListItem.append(new TextNode('B1'));

          parent.append(A_listItem, x, B_listItem);
          root.append(parent);
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">A1</span>
                    </li>
                    <li value="2">
                      <ul>
                        <li value="1">
                          <span data-lexical-text="true">A2</span>
                        </li>
                      </ul>
                    </li>
                  </ul>
                </li>
                <li value="1">
                  <span data-lexical-text="true">x</span>
                </li>
                <li value="2">
                  <ul>
                    <li value="1">
                      <ul>
                        <li value="1">
                          <span data-lexical-text="true">B1</span>
                        </li>
                      </ul>
                    </li>
                    <li value="1">
                      <span data-lexical-text="true">B2</span>
                    </li>
                  </ul>
                </li>
              </ul>
            </div>
          `,
        );

        await editor.update(() => x.remove());

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <ul>
                    <li value="1">
                      <span data-lexical-text="true">A1</span>
                    </li>
                    <li value="2">
                      <ul>
                        <li value="1">
                          <span data-lexical-text="true">A2</span>
                        </li>
                        <li value="2">
                          <span data-lexical-text="true">B1</span>
                        </li>
                      </ul>
                    </li>
                    <li value="2">
                      <span data-lexical-text="true">B2</span>
                    </li>
                  </ul>
                </li>
              </ul>
            </div>
          `,
        );
      });
    });

    describe('ListItemNode.insertNewAfter(): non-empty list items', () => {
      let listNode: ListNode;
      let listItemNode1: ListItemNode;
      let listItemNode2: ListItemNode;
      let listItemNode3: ListItemNode;

      beforeEach(async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const root = $getRoot();
          listNode = new ListNode('bullet', 1);
          listItemNode1 = new ListItemNode();

          listItemNode2 = new ListItemNode();

          listItemNode3 = new ListItemNode();

          root.append(listNode);
          listNode.append(listItemNode1, listItemNode2, listItemNode3);
          listItemNode1.append(new TextNode('one'));
          listItemNode2.append(new TextNode('two'));
          listItemNode3.append(new TextNode('three'));
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">one</span>
                </li>
                <li value="2">
                  <span data-lexical-text="true">two</span>
                </li>
                <li value="3">
                  <span data-lexical-text="true">three</span>
                </li>
              </ul>
            </div>
          `,
        );
      });

      test('first list item', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          listItemNode1.insertNewAfter($createRangeSelection());
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">one</span>
                </li>
                <li value="2"><br data-lexical-managed-linebreak="true" /></li>
                <li value="3">
                  <span data-lexical-text="true">two</span>
                </li>
                <li value="4">
                  <span data-lexical-text="true">three</span>
                </li>
              </ul>
            </div>
          `,
        );
      });

      test('last list item', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          listItemNode3.insertNewAfter($createRangeSelection());
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">one</span>
                </li>
                <li value="2">
                  <span data-lexical-text="true">two</span>
                </li>
                <li value="3">
                  <span data-lexical-text="true">three</span>
                </li>
                <li value="4"><br data-lexical-managed-linebreak="true" /></li>
              </ul>
            </div>
          `,
        );
      });

      test('middle list item', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          listItemNode3.insertNewAfter($createRangeSelection());
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">one</span>
                </li>
                <li value="2">
                  <span data-lexical-text="true">two</span>
                </li>
                <li value="3">
                  <span data-lexical-text="true">three</span>
                </li>
                <li value="4"><br data-lexical-managed-linebreak="true" /></li>
              </ul>
            </div>
          `,
        );
      });

      test('the only list item', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          listItemNode2.remove();
          listItemNode3.remove();
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">one</span>
                </li>
              </ul>
            </div>
          `,
        );

        await editor.update(() => {
          listItemNode1.insertNewAfter($createRangeSelection());
        });

        expectHtmlToBeEqual(
          testEnv.outerHTML,
          html`
            <div
              contenteditable="true"
              style="user-select: text; white-space: pre-wrap; word-break: break-word;"
              data-lexical-editor="true">
              <ul dir="auto">
                <li value="1">
                  <span data-lexical-text="true">one</span>
                </li>
                <li value="2"><br data-lexical-managed-linebreak="true" /></li>
              </ul>
            </div>
          `,
        );
      });
    });

    test('$createListItemNode()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listItemNode = new ListItemNode();

        const createdListItemNode = $createListItemNode();

        expect(listItemNode.__type).toEqual(createdListItemNode.__type);
        expect(listItemNode.__parent).toEqual(createdListItemNode.__parent);
        expect(listItemNode.__key).not.toEqual(createdListItemNode.__key);
      });
    });

    test('$isListItemNode()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const listItemNode = new ListItemNode();

        expect($isListItemNode(listItemNode)).toBe(true);
      });
    });

    describe('ListItemNode.setIndent()', () => {
      let listNode: ListNode;
      let listItemNode1: ListItemNode;
      let listItemNode2: ListItemNode;

      beforeEach(async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          const root = $getRoot();
          listNode = new ListNode('bullet', 1);
          listItemNode1 = new ListItemNode();

          listItemNode2 = new ListItemNode();

          root.append(listNode);
          listNode.append(listItemNode1, listItemNode2);
          listItemNode1.append(new TextNode('one'));
          listItemNode2.append(new TextNode('two'));
        });
      });
      it('indents and outdents list item', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          listItemNode1.setIndent(3);
        });

        await editor.update(() => {
          expect(listItemNode1.getIndent()).toBe(3);
        });

        expectHtmlToBeEqual(
          editor.getRootElement()!.innerHTML,
          html`
            <ul dir="auto">
              <li value="1">
                <ul>
                  <li value="1">
                    <ul>
                      <li value="1">
                        <ul>
                          <li value="1">
                            <span data-lexical-text="true">one</span>
                          </li>
                        </ul>
                      </li>
                    </ul>
                  </li>
                </ul>
              </li>
              <li value="1">
                <span data-lexical-text="true">two</span>
              </li>
            </ul>
          `,
        );

        await editor.update(() => {
          listItemNode1.setIndent(0);
        });

        await editor.update(() => {
          expect(listItemNode1.getIndent()).toBe(0);
        });

        expectHtmlToBeEqual(
          editor.getRootElement()!.innerHTML,
          html`
            <ul dir="auto">
              <li value="1">
                <span data-lexical-text="true">one</span>
              </li>
              <li value="2">
                <span data-lexical-text="true">two</span>
              </li>
            </ul>
          `,
        );
      });

      it('handles fractional indent values', async () => {
        const {editor} = testEnv;

        await editor.update(() => {
          listItemNode1.setIndent(0.5);
        });

        await editor.update(() => {
          expect(listItemNode1.getIndent()).toBe(0);
        });
      });
    });

    test('Can serialize a node that is not attached', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const listItemNode = $createListItemNode();
        const listNode = $createListNode();
        listNode.append(listItemNode);
        expect(listItemNode.exportJSON()).toEqual({
          checked: undefined,
          children: [],
          direction: null,
          format: '',
          indent: 0,
          type: 'listitem',
          value: 1,
          version: 1,
        });
      });
    });

    test('ListItemNode marker style inheritance on indent', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const root = $getRoot();
        const listNode = $createListNode('bullet');
        const listItem1 = $createListItemNode();
        const listItem2 = $createListItemNode();

        // Set marker style on listItem2
        listItem2.setTextStyle('font-size: 19px;');

        listNode.append(listItem1, listItem2);
        root.append(listNode);

        // Indent listItem2
        $handleIndent(listItem2);

        // Get the parent list item after indent
        const parentListItem = listItem2.getParentOrThrow().getParentOrThrow();
        expect($isListItemNode(parentListItem)).toBe(true);

        // Check if marker style was inherited
        expect(parentListItem.getTextStyle()).toBe('font-size: 19px;');
      });
    });

    test('Default: Splitting a list resets numbering to 1 (Backward Compatibility)', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const root = $getRoot();
        const list = $createListNode('number');
        const item1 = $createListItemNode();
        const item2 = $createListItemNode();
        const emptyItem = $createListItemNode();
        const item3 = $createListItemNode();

        item1.append($createTextNode('A'));
        item2.append($createTextNode('B'));
        // emptyItem has NO text
        item3.append($createTextNode('C'));

        list.append(item1, item2, emptyItem, item3);
        root.append(list);

        emptyItem.select();
      });

      await editor.update(() => {
        $handleListInsertParagraph();
      });

      // Expectation: List 1 (A, B) -> Paragraph -> List 2 (C) starting at 1
      expect(testEnv.container.innerHTML).toBe(
        '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true">' +
          '<ol dir="auto">' +
          '<li value="1"><span data-lexical-text="true">A</span></li>' +
          '<li value="2"><span data-lexical-text="true">B</span></li>' +
          '</ol>' +
          '<p dir="auto"><br data-lexical-managed-linebreak="true"></p>' +
          '<ol dir="auto">' + // Reset to 1 (Default)
          '<li value="1"><span data-lexical-text="true">C</span></li>' +
          '</ol>' +
          '</div>',
      );
    });

    test('Option Enabled: Splitting a list preserves numbering (Smart Behavior)', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const root = $getRoot();
        const list = $createListNode('number');
        const item1 = $createListItemNode();
        const item2 = $createListItemNode();
        const emptyItem = $createListItemNode();
        const item3 = $createListItemNode();

        item1.append($createTextNode('A'));
        item2.append($createTextNode('B'));
        item3.append($createTextNode('C'));

        list.append(item1, item2, emptyItem, item3);
        root.append(list);

        emptyItem.select();
      });

      await editor.update(() => {
        $handleListInsertParagraph(true);
      });

      // Expectation: List 1 (A, B) -> Paragraph -> List 2 (C) starting at 3
      expect(testEnv.container.innerHTML).toBe(
        '<div contenteditable="true" style="user-select: text; white-space: pre-wrap; word-break: break-word;" data-lexical-editor="true">' +
          '<ol dir="auto">' +
          '<li value="1"><span data-lexical-text="true">A</span></li>' +
          '<li value="2"><span data-lexical-text="true">B</span></li>' +
          '</ol>' +
          '<p dir="auto"><br data-lexical-managed-linebreak="true"></p>' +
          '<ol start="3" dir="auto">' +
          '<li value="3"><span data-lexical-text="true">C</span></li>' +
          '</ol>' +
          '</div>',
      );
    });

    test('Option Enabled: Preserves numbering when a nested sublist precedes the split', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const root = $getRoot();
        const list = $createListNode('number');
        const item1 = $createListItemNode();
        item1.append($createTextNode('A'));

        // A nested sublist lives inside its own wrapper <li>, which renders no
        // marker of its own and so does not consume a number.
        const nestedHolder = $createListItemNode();
        const nested = $createListNode('bullet');
        const nestedItem = $createListItemNode();
        nestedItem.append($createTextNode('A.1'));
        nested.append(nestedItem);
        nestedHolder.append(nested);

        const item2 = $createListItemNode();
        item2.append($createTextNode('B'));
        const emptyItem = $createListItemNode();
        const item3 = $createListItemNode();
        item3.append($createTextNode('C'));

        list.append(item1, nestedHolder, item2, emptyItem, item3);
        root.append(list);

        emptyItem.select();
      });

      await editor.update(() => {
        $handleListInsertParagraph(true);
      });

      editor.read('latest', () => {
        // A is 1 and B is 2, so the removed empty item was 3 and the split-off
        // list has to continue from 3 -- the same rule the flat case follows.
        const [firstList, paragraph, secondList] = $getRoot().getChildren();
        expect($isListNode(firstList)).toBe(true);
        expect($isParagraphNode(paragraph)).toBe(true);
        expect($isListNode(secondList)).toBe(true);
        expect((secondList as ListNode).getStart()).toBe(3);
        const firstItem = (secondList as ListNode).getFirstChild();
        expect($isListItemNode(firstItem)).toBe(true);
        expect((firstItem as ListItemNode).getValue()).toBe(3);
      });
    });

    describe('ListItemNode $transform wraps orphan ListItemNodes', () => {
      test('wraps a single orphan ListItemNode under root in a ListNode', () => {
        const {editor} = testEnv;

        editor.update(
          () => {
            $getRoot().append(
              $createListItemNode().append($createTextNode('orphan')),
            );
          },
          {discrete: true},
        );

        editor.read(() => {
          const wrapper = $getRoot().getFirstChild();
          assert($isListNode(wrapper), 'orphan <li> should be wrapped in list');
          expect(wrapper.getListType()).toBe('bullet');
        });

        expectHtmlToBeEqual(
          testEnv.innerHTML,
          html`
            <ul dir="auto">
              <li value="1">
                <span data-lexical-text="true">orphan</span>
              </li>
            </ul>
          `,
        );
      });

      test('wraps adjacent orphan ListItemNodes in a single ListNode', () => {
        const {editor} = testEnv;

        editor.update(
          () => {
            $getRoot().append(
              $createListItemNode().append($createTextNode('a')),
              $createListItemNode().append($createTextNode('b')),
              $createListItemNode().append($createTextNode('c')),
            );
          },
          {discrete: true},
        );

        expectHtmlToBeEqual(
          testEnv.innerHTML,
          html`
            <ul dir="auto">
              <li value="1"><span data-lexical-text="true">a</span></li>
              <li value="2"><span data-lexical-text="true">b</span></li>
              <li value="3"><span data-lexical-text="true">c</span></li>
            </ul>
          `,
        );
      });

      test('does not merge orphan ListItemNodes separated by a ParagraphNode', () => {
        const {editor} = testEnv;

        editor.update(
          () => {
            $getRoot().append(
              $createListItemNode().append($createTextNode('a')),
              $createParagraphNode().append($createTextNode('middle')),
              $createListItemNode().append($createTextNode('b')),
            );
          },
          {discrete: true},
        );

        expectHtmlToBeEqual(
          testEnv.innerHTML,
          html`
            <ul dir="auto">
              <li value="1"><span data-lexical-text="true">a</span></li>
            </ul>
            <p dir="auto"><span data-lexical-text="true">middle</span></p>
            <ul dir="auto">
              <li value="1"><span data-lexical-text="true">b</span></li>
            </ul>
          `,
        );
      });

      test('parses HTML with orphan <li> outside of <ul>', () => {
        const {editor} = testEnv;
        const parser = new DOMParser();
        const input = html`
          <div>
            <ul>
              <li>test</li>
              <li>test</li>
              <li>test</li>
            </ul>
            hello world
            <li>test</li>
          </div>
        `;

        editor.update(
          () => {
            $getRoot().clear().select();
            const dom = parser.parseFromString(input, 'text/html');
            $insertNodes($generateNodesFromDOM(editor, dom));
          },
          {discrete: true},
        );

        expectHtmlToBeEqual(
          testEnv.innerHTML,
          html`
            <ul dir="auto">
              <li value="1"><span data-lexical-text="true">test</span></li>
              <li value="2"><span data-lexical-text="true">test</span></li>
              <li value="3"><span data-lexical-text="true">test</span></li>
            </ul>
            <p dir="auto">
              <span data-lexical-text="true">hello world</span>
            </p>
            <ul dir="auto">
              <li value="1"><span data-lexical-text="true">test</span></li>
            </ul>
          `,
        );
      });

      test('preserves the selection on the orphan when it is wrapped', () => {
        const {editor} = testEnv;

        editor.update(
          () => {
            const text = $createTextNode('orphan');
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append($createTextNode('hello world')),
                $createListItemNode().append(text),
              );
            text.select(2, 4);
          },
          {discrete: true},
        );

        editor.read(() => {
          const selection = $getSelection();
          assert(
            $isRangeSelection(selection),
            'selection should be a RangeSelection',
          );
          const {anchor, focus} = selection;
          expect(anchor.getNode().getTextContent()).toBe('orphan');
          expect(anchor.offset).toBe(2);
          expect(focus.getNode().getTextContent()).toBe('orphan');
          expect(focus.offset).toBe(4);
        });
      });

      test('preserves a selection anchored outside the orphan', () => {
        const {editor} = testEnv;

        editor.update(
          () => {
            const helloText = $createTextNode('hello world');
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append(helloText),
                $createListItemNode().append($createTextNode('orphan')),
              );
            helloText.select(3, 5);
          },
          {discrete: true},
        );

        editor.read(() => {
          const selection = $getSelection();
          assert(
            $isRangeSelection(selection),
            'selection should be a RangeSelection',
          );
          const {anchor, focus} = selection;
          expect(anchor.getNode().getTextContent()).toBe('hello world');
          expect(anchor.offset).toBe(3);
          expect(focus.getNode().getTextContent()).toBe('hello world');
          expect(focus.offset).toBe(5);
        });
      });

      test('wraps orphan ListItemNode inside a paragraph with no siblings', () => {
        const {editor} = testEnv;

        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append(
                  $createListItemNode().append($createTextNode('item')),
                ),
              );
          },
          {discrete: true},
        );
        editor.read(() => {
          const root = $getRoot();
          expect(root.getChildrenSize()).toBe(1);
          const [list] = root.getChildren();
          assert($isListNode(list));
          expect(list.getChildrenSize()).toBe(1);
          const [listItem] = list.getChildren();
          assert($isListItemNode(listItem));
          expect(listItem.getTextContent()).toBe('item');
        });
      });

      test('wraps orphan ListItemNode inside a paragraph with prev siblings', () => {
        const {editor} = testEnv;

        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append(
                  $createTextNode('before'),
                  $createListItemNode().append($createTextNode('item')),
                ),
              );
          },
          {discrete: true},
        );
        editor.read(() => {
          const root = $getRoot();
          expect(root.getChildrenSize()).toBe(2);
          const [p, list] = root.getChildren();
          assert($isParagraphNode(p));
          expect(p.getTextContent()).toBe('before');
          assert($isListNode(list));
          expect(list.getChildrenSize()).toBe(1);
          const [listItem] = list.getChildren();
          assert($isListItemNode(listItem));
          expect(listItem.getTextContent()).toBe('item');
        });
      });

      test('wraps orphan ListItemNode inside a paragraph with next siblings', () => {
        const {editor} = testEnv;

        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append(
                  $createListItemNode().append($createTextNode('item')),
                  $createTextNode('after'),
                ),
              );
          },
          {discrete: true},
        );
        editor.read(() => {
          const root = $getRoot();
          expect(root.getChildrenSize()).toBe(2);
          const [list, p] = root.getChildren();
          assert($isParagraphNode(p));
          expect(p.getTextContent()).toBe('after');
          assert($isListNode(list));
          expect(list.getChildrenSize()).toBe(1);
          const [listItem] = list.getChildren();
          assert($isListItemNode(listItem));
          expect(listItem.getTextContent()).toBe('item');
        });
      });

      test('wraps orphan ListItemNode inside a paragraph with both siblings', () => {
        const {editor} = testEnv;

        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append(
                  $createTextNode('before'),
                  $createListItemNode().append($createTextNode('item')),
                  $createTextNode('after'),
                ),
              );
          },
          {discrete: true},
        );
        editor.read(() => {
          const root = $getRoot();
          expect(root.getChildrenSize()).toBe(3);
          const [p0, list, p1] = root.getChildren();
          assert($isParagraphNode(p0));
          expect(p0.getTextContent()).toBe('before');
          assert($isParagraphNode(p1));
          expect(p1.getTextContent()).toBe('after');
          assert($isListNode(list));
          expect(list.getChildrenSize()).toBe(1);
          const [listItem] = list.getChildren();
          assert($isListItemNode(listItem));
          expect(listItem.getTextContent()).toBe('item');
        });
      });

      test('wraps orphan ListItemNode inside a shadow-root table cell', () => {
        const {editor} = testEnv;

        editor.update(
          () => {
            const cell = $createTableCellNode().append(
              $createListItemNode().append($createTextNode('orphan')),
            );
            $getRoot()
              .clear()
              .append(
                $createTableNode().append($createTableRowNode().append(cell)),
              );
          },
          {discrete: true},
        );

        editor.read(() => {
          const table = $getRoot().getFirstChild();
          assert($isElementNode(table), 'root first child is an element');
          const row = table.getFirstChild();
          assert($isElementNode(row), 'table first child is an element');
          const cell = row.getFirstChild();
          assert($isElementNode(cell), 'row first child is an element');
          expect(cell.getChildrenSize()).toBe(1);
          const wrapper = cell.getFirstChild();
          assert(
            $isListNode(wrapper),
            'orphan <li> should be wrapped inside the table cell',
          );
          expect(wrapper.getChildrenSize()).toBe(1);
          expect(wrapper.getFirstChildOrThrow().getTextContent()).toBe(
            'orphan',
          );
        });
      });
    });
  });
});
