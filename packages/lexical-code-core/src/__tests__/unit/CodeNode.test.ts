/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createCodeNode,
  $isCodeNode,
  CodeNode,
  type SerializedCodeNode,
} from '@lexical/code-core';
import {$generateHtmlFromNodes, $generateNodesFromDOM} from '@lexical/html';
import {
  $createLineBreakNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  type EditorConfig,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';
import {initializeUnitTest} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, it} from 'vitest';

const editorConfig = {
  namespace: '',
  theme: {
    code: 'editor-code',
  },
} as EditorConfig;

const WORD_WRAP_ATTR = 'data-lexical-code-word-wrap';

/** A code block with two lines, "a" and "b", as the only root child. */
function appendTwoLineCode(editor: LexicalEditor): NodeKey {
  let key!: NodeKey;
  editor.update(
    () => {
      const code = $createCodeNode('javascript').append(
        $createTextNode('a'),
        $createLineBreakNode(),
        $createTextNode('b'),
      );
      $getRoot().clear().append(code);
      key = code.getKey();
    },
    {discrete: true},
  );
  return key;
}

function $importCodeJSON(json: SerializedCodeNode): CodeNode {
  const node = CodeNode.importJSON(json);
  assert($isCodeNode(node), 'expected a CodeNode');
  return node;
}

function setWordWrap(
  editor: LexicalEditor,
  key: NodeKey,
  wordWrap: boolean,
): void {
  editor.update(
    () => {
      const node = $getNodeByKey(key);
      assert($isCodeNode(node), 'expected a CodeNode');
      node.setWordWrap(wordWrap);
    },
    {discrete: true},
  );
}

describe('CodeNode', () => {
  initializeUnitTest(
    testEnv => {
      it('applies and replaces styles through DOM style properties', async () => {
        const {editor} = testEnv;

        let dom!: HTMLElement;
        let prevNode!: CodeNode;

        await editor.update(() => {
          const codeNode = $createCodeNode('javascript');
          codeNode.setStyle('color: red; margin: 0 !important;');
          prevNode = codeNode;
          dom = codeNode.createDOM(editorConfig);
        });

        expect(dom!.style.color).toBe('red');
        expect(dom!.style.getPropertyPriority('margin')).toBe('important');

        await editor.update(() => {
          const codeNode = $createCodeNode('javascript');
          codeNode.setStyle('padding: 1px; --custom: value;');

          expect(codeNode.updateDOM(prevNode, dom, editorConfig)).toBe(false);
        });

        expect(dom.style.color).toBe('');
        expect(dom.style.margin).toBe('');
        expect(dom.style.padding).toBe('1px');
        expect(dom.style.getPropertyValue('--custom')).toBe('value');
      });

      it('exports styles through DOM style properties', async () => {
        const {editor} = testEnv;

        let exportedElement: HTMLElement | null = null;

        await editor.update(() => {
          const codeNode = $createCodeNode('javascript');
          codeNode.setStyle('padding: 1px; color: blue;');
          $getRoot().append(codeNode);

          const {element} = codeNode.exportDOM(editor);
          exportedElement = element as HTMLElement;
        });

        expect(exportedElement).not.toBeNull();
        expect(exportedElement!.style.padding).toBe('1px');
        expect(exportedElement!.style.color).toBe('blue');
      });

      it('round-trips the theme through exportDOM/importDOM', async () => {
        const {editor} = testEnv;

        let exportedElement!: HTMLElement;

        await editor.update(() => {
          const codeNode = $createCodeNode('javascript', 'poimandres');
          $getRoot().append(codeNode);
          exportedElement = codeNode.exportDOM(editor).element as HTMLElement;
        });

        expect(exportedElement.getAttribute('data-language')).toBe(
          'javascript',
        );
        expect(exportedElement.getAttribute('data-theme')).toBe('poimandres');

        const doc = document.implementation.createHTMLDocument();
        doc.body.append(exportedElement);

        await editor.update(() => {
          const [node] = $generateNodesFromDOM(editor, doc);
          assert($isCodeNode(node), 'expected a CodeNode');
          expect(node.getLanguage()).toBe('javascript');
          expect(node.getTheme()).toBe('poimandres');
        });
      });

      describe('word wrap', () => {
        it('serializes wordWrap only while it is on', () => {
          testEnv.editor.update(
            () => {
              const node = $createCodeNode('javascript');
              expect(node.getWordWrap()).toBe(false);
              const off = node.exportJSON();
              expect(off.wordWrap).toBeUndefined();
              expect(JSON.stringify(off)).not.toContain('wordWrap');
              expect(node.exportJSON(true)).not.toHaveProperty('wordWrap');

              node.setWordWrap(true);
              expect(node.getWordWrap()).toBe(true);
              expect(node.exportJSON()).toStrictEqual({...off, wordWrap: true});
              expect(node.exportJSON(true)).toMatchObject({wordWrap: true});
              expect(node.exportJSON(true)).not.toHaveProperty('$');

              node.setWordWrap(false);
              expect(node.exportJSON()).toStrictEqual(off);
            },
            {discrete: true},
          );
        });

        it('imports wordWrap', () => {
          testEnv.editor.update(
            () => {
              const off = $createCodeNode('javascript').exportJSON();
              const on = $importCodeJSON({...off, wordWrap: true});
              expect(on.getWordWrap()).toBe(true);
              expect(on.exportJSON()).toStrictEqual({...off, wordWrap: true});
              expect(
                $importCodeJSON({...off, wordWrap: false}).exportJSON(true),
              ).not.toHaveProperty('wordWrap');

              const invalid = $importCodeJSON({
                ...off,
                wordWrap: 'yes',
              } as unknown as SerializedCodeNode);
              expect(invalid.getWordWrap()).toBe(false);
            },
            {discrete: true},
          );
        });

        it('updateFromJSON without wordWrap turns it off', () => {
          testEnv.editor.update(
            () => {
              const off = $createCodeNode('javascript').exportJSON();
              const node = $createCodeNode('javascript').setWordWrap(true);
              expect(node.updateFromJSON(off).getWordWrap()).toBe(false);
            },
            {discrete: true},
          );
        });

        it('createDOM sets the attribute only when on', () => {
          testEnv.editor.update(
            () => {
              const node = $createCodeNode();
              expect(node.createDOM(editorConfig).outerHTML).toBe(
                '<code class="editor-code" spellcheck="false"></code>',
              );
              node.setWordWrap(true);
              expect(
                node.createDOM(editorConfig).getAttribute(WORD_WRAP_ATTR),
              ).toBe('true');
            },
            {discrete: true},
          );
        });

        it('toggling updates the attribute on the same element', () => {
          const {editor} = testEnv;
          const key = appendTwoLineCode(editor);
          const dom = editor.getElementByKey(key);
          assert(dom !== null, 'expected a rendered code block');
          expect(dom.hasAttribute(WORD_WRAP_ATTR)).toBe(false);

          setWordWrap(editor, key, true);
          expect(editor.getElementByKey(key)).toBe(dom);
          expect(dom.getAttribute(WORD_WRAP_ATTR)).toBe('true');
          editor.read(() => {
            const node = $getNodeByKey(key);
            assert($isCodeNode(node), 'expected a CodeNode');
            expect(node.getTextContent()).toBe('a\nb');
            expect(node.getChildrenSize()).toBe(3);
          });

          setWordWrap(editor, key, false);
          expect(editor.getElementByKey(key)).toBe(dom);
          expect(dom.hasAttribute(WORD_WRAP_ATTR)).toBe(false);
          expect(dom.textContent).toBe('ab');
        });

        it('round trips through exportDOM and importDOM', () => {
          const {editor} = testEnv;
          const key = appendTwoLineCode(editor);
          setWordWrap(editor, key, true);
          const html = editor.read(() => $generateHtmlFromNodes(editor, null));
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const pre = doc.querySelector('pre');
          assert(pre !== null, 'expected an exported <pre>');
          expect(pre.getAttribute(WORD_WRAP_ATTR)).toBe('true');

          editor.update(
            () => {
              const [node] = $generateNodesFromDOM(editor, doc);
              assert($isCodeNode(node), 'expected a CodeNode');
              expect(node.getWordWrap()).toBe(true);
              expect(node.getLanguage()).toBe('javascript');
              expect(node.getTextContent()).toBe('a\nb');
              expect(node.getChildrenSize()).toBe(3);
            },
            {discrete: true},
          );
        });

        it('imports a value of "false" as off', () => {
          const {editor} = testEnv;
          const doc = new DOMParser().parseFromString(
            `<pre ${WORD_WRAP_ATTR}="false">a</pre>`,
            'text/html',
          );
          editor.update(
            () => {
              const [node] = $generateNodesFromDOM(editor, doc);
              assert($isCodeNode(node), 'expected a CodeNode');
              expect(node.getWordWrap()).toBe(false);
              expect(node.exportJSON(true)).not.toHaveProperty('wordWrap');
            },
            {discrete: true},
          );
        });
      });
    },
    {
      namespace: 'test',
      nodes: [CodeNode],
      theme: editorConfig.theme,
    },
  );
});
