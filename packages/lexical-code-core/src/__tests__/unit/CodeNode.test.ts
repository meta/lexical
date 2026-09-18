/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode, $isCodeNode, CodeNode} from '@lexical/code-core';
import {$generateNodesFromDOM} from '@lexical/html';
import {$getRoot, type EditorConfig} from 'lexical';
import {initializeUnitTest} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, it} from 'vitest';

const editorConfig = {
  namespace: '',
  theme: {
    code: 'editor-code',
  },
} as EditorConfig;

describe('CodeNode', () => {
  initializeUnitTest(
    testEnv => {
      it('applies and replaces styles through DOM style properties', async () => {
        const {editor} = testEnv;

        let dom!: HTMLElement;
        let prevNode!: ReturnType<typeof $createCodeNode>;

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
    },
    {
      namespace: 'test',
      nodes: [CodeNode],
      theme: editorConfig.theme,
    },
  );
});
