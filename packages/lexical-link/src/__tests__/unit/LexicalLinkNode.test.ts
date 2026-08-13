/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createAutoLinkNode,
  $createLinkNode,
  $isLinkNode,
  $toggleLink,
  formatUrl,
  LinkExtension,
  type LinkNode,
  type SerializedLinkNode,
} from '@lexical/link';
import {$createMarkNode, $isMarkNode} from '@lexical/mark';
import {
  $createHeadingNode,
  $isHeadingNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $cloneWithProperties,
  $createLineBreakNode,
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $selectAll,
  $setSelection,
  type ParagraphNode,
  type RangeSelection,
  type SerializedParagraphNode,
  type TextNode,
} from 'lexical';
import {$assertNodeType, initializeUnitTest} from 'lexical/src/__tests__/utils';
import {assert, describe, expect, it, test} from 'vitest';

const editorConfig = Object.freeze({
  namespace: '',
  theme: {
    link: 'my-link-class',
    text: {
      bold: 'my-bold-class',
      code: 'my-code-class',
      hashtag: 'my-hashtag-class',
      italic: 'my-italic-class',
      strikethrough: 'my-strikethrough-class',
      underline: 'my-underline-class',
      underlineStrikethrough: 'my-underline-strikethrough-class',
    },
  },
});

describe('LexicalLinkNode tests', () => {
  initializeUnitTest(testEnv => {
    test('LinkNode.constructor', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('/');

        expect(linkNode.__type).toBe('link');
        expect(linkNode.__url).toBe('/');
      });

      expect(() => $createLinkNode('')).toThrow();
    });

    test('LinkNode.clone()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('/');

        const linkNodeClone = $cloneWithProperties(linkNode);

        expect(linkNodeClone).not.toBe(linkNode);
        expect(linkNodeClone).toStrictEqual(linkNode);
      });
    });

    test('LinkNode.getURL()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo');

        expect(linkNode.getURL()).toBe('https://example.com/foo');
      });
    });

    test('LinkNode.setURL()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo');

        expect(linkNode.getURL()).toBe('https://example.com/foo');

        linkNode.setURL('https://example.com/bar');

        expect(linkNode.getURL()).toBe('https://example.com/bar');
      });
    });

    test('LinkNode.getTarget()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo', {
          target: '_blank',
        });

        expect(linkNode.getTarget()).toBe('_blank');
      });
    });

    test('LinkNode.setTarget()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo', {
          target: '_blank',
        });

        expect(linkNode.getTarget()).toBe('_blank');

        linkNode.setTarget('_self');

        expect(linkNode.getTarget()).toBe('_self');
      });
    });

    test('LinkNode.getRel()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo', {
          rel: 'noopener noreferrer',
          target: '_blank',
        });

        expect(linkNode.getRel()).toBe('noopener noreferrer');
      });
    });

    test('LinkNode.setRel()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo', {
          rel: 'noopener',
          target: '_blank',
        });

        expect(linkNode.getRel()).toBe('noopener');

        linkNode.setRel('noopener noreferrer');

        expect(linkNode.getRel()).toBe('noopener noreferrer');
      });
    });

    test('LinkNode.getTitle()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo', {
          title: 'Hello world',
        });

        expect(linkNode.getTitle()).toBe('Hello world');
      });
    });

    test('LinkNode.setTitle()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo', {
          title: 'Hello world',
        });

        expect(linkNode.getTitle()).toBe('Hello world');

        linkNode.setTitle('World hello');

        expect(linkNode.getTitle()).toBe('World hello');
      });
    });

    test('LinkNode.createDOM()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo');

        expect(linkNode.createDOM(editorConfig).outerHTML).toBe(
          '<a href="https://example.com/foo" class="my-link-class"></a>',
        );
        expect(
          linkNode.createDOM({
            namespace: '',
            theme: {},
          }).outerHTML,
        ).toBe('<a href="https://example.com/foo"></a>');
      });
    });

    test('LinkNode.createDOM() with target, rel and title', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo', {
          rel: 'noopener noreferrer',
          target: '_blank',
          title: 'Hello world',
        });

        expect(linkNode.createDOM(editorConfig).outerHTML).toBe(
          '<a href="https://example.com/foo" target="_blank" rel="noopener noreferrer" title="Hello world" class="my-link-class"></a>',
        );
        expect(
          linkNode.createDOM({
            namespace: '',
            theme: {},
          }).outerHTML,
        ).toBe(
          '<a href="https://example.com/foo" target="_blank" rel="noopener noreferrer" title="Hello world"></a>',
        );
      });
    });

    test('LinkNode.createDOM() sanitizes javascript: URLs', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        // eslint-disable-next-line no-script-url
        const linkNode = $createLinkNode('javascript:alert(0)');
        expect(linkNode.createDOM(editorConfig).outerHTML).toBe(
          '<a href="about:blank" class="my-link-class"></a>',
        );
      });
    });

    test('LinkNode.createDOM() fails closed on unparseable URLs', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        // A `javascript:` URL crafted so that `new URL()` throws (invalid
        // port). Previously `sanitizeUrl()` failed open and returned the
        // attacker-controlled value unchanged; some browsers will still
        // navigate it, allowing XSS. It must now be neutralized to
        // about:blank.
        const linkNode = $createLinkNode(
          // eslint-disable-next-line no-script-url
          'javascript://:99999999999/%0aalert(document.domain)',
        );
        expect(linkNode.createDOM(editorConfig).outerHTML).toBe(
          '<a href="about:blank" class="my-link-class"></a>',
        );
      });
    });

    test.each([
      // Control-character- and whitespace-obfuscated `javascript:` URLs that
      // throw in `new URL()` but are still navigated by some browsers. The
      // scheme must be recognized after normalization and neutralized.
      'java\u0000script:alert(document.domain)',
      'java\tscript:alert(document.domain)',
      '\u0001javascript:alert(document.domain)',
      'java\nscript:alert(document.domain)',
      'data:text/html,<script>alert(1)</script>',
    ])(
      'LinkNode.createDOM() neutralizes obfuscated dangerous scheme %j',
      async input => {
        const {editor} = testEnv;

        await editor.update(() => {
          const linkNode = $createLinkNode(input);
          expect(linkNode.createDOM(editorConfig).outerHTML).toBe(
            '<a href="about:blank" class="my-link-class"></a>',
          );
        });
      },
    );

    describe('LinkNode.createDOM() formats URLs', () => {
      [
        {input: 'https://example.com', output: 'https://example.com'},
        {input: 'https://www.example.com', output: 'https://www.example.com'},
        {input: 'example.com', output: 'https://example.com'},
        {input: 'www.example.com', output: 'https://www.example.com'},
        {input: 'mailto:user@example.com', output: 'mailto:user@example.com'},
        {input: 'user@example.com', output: 'mailto:user@example.com'},
        {input: '+1234567890', output: 'tel:+1234567890'},
      ].forEach(({input, output}) =>
        test(`${input} -> ${output}`, async () => {
          const {editor} = testEnv;

          await editor.update(() => {
            const linkNode = $createLinkNode(input);
            expect(linkNode.createDOM(editorConfig).outerHTML).toBe(
              `<a href="${output}" class="my-link-class"></a>`,
            );
          });
        }),
      );
    });

    test('LinkNode.updateDOM()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo');

        const domElement = linkNode.createDOM(editorConfig);

        expect(linkNode.createDOM(editorConfig).outerHTML).toBe(
          '<a href="https://example.com/foo" class="my-link-class"></a>',
        );

        const newLinkNode = $createLinkNode('https://example.com/bar');
        const result = newLinkNode.updateDOM(
          linkNode,
          domElement,
          editorConfig,
        );

        expect(result).toBe(false);
        expect(domElement.outerHTML).toBe(
          '<a href="https://example.com/bar" class="my-link-class"></a>',
        );
      });
    });

    test('LinkNode.updateDOM() with target, rel and title', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo', {
          rel: 'noopener noreferrer',
          target: '_blank',
          title: 'Hello world',
        });

        const domElement = linkNode.createDOM(editorConfig);

        expect(linkNode.createDOM(editorConfig).outerHTML).toBe(
          '<a href="https://example.com/foo" target="_blank" rel="noopener noreferrer" title="Hello world" class="my-link-class"></a>',
        );

        const newLinkNode = $createLinkNode('https://example.com/bar', {
          rel: 'noopener',
          target: '_self',
          title: 'World hello',
        });
        const result = newLinkNode.updateDOM(
          linkNode,
          domElement,
          editorConfig,
        );

        expect(result).toBe(false);
        expect(domElement.outerHTML).toBe(
          '<a href="https://example.com/bar" target="_self" rel="noopener" title="World hello" class="my-link-class"></a>',
        );
      });
    });

    test('LinkNode.updateDOM() with undefined target, undefined rel and undefined title', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo', {
          rel: 'noopener noreferrer',
          target: '_blank',
          title: 'Hello world',
        });

        const domElement = linkNode.createDOM(editorConfig);

        expect(linkNode.createDOM(editorConfig).outerHTML).toBe(
          '<a href="https://example.com/foo" target="_blank" rel="noopener noreferrer" title="Hello world" class="my-link-class"></a>',
        );

        const newLinkNode = $createLinkNode('https://example.com/bar');
        const result = newLinkNode.updateDOM(
          linkNode,
          domElement,
          editorConfig,
        );

        expect(result).toBe(false);
        expect(domElement.outerHTML).toBe(
          '<a href="https://example.com/bar" class="my-link-class"></a>',
        );
      });
    });

    test('LinkNode.canInsertTextBefore()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo');

        expect(linkNode.canInsertTextBefore()).toBe(false);
      });
    });

    test('LinkNode.canInsertTextAfter()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo');

        expect(linkNode.canInsertTextAfter()).toBe(false);
      });
    });

    test('$createLinkNode()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo');

        const createdLinkNode = $createLinkNode('https://example.com/foo');

        expect(linkNode.__type).toEqual(createdLinkNode.__type);
        expect(linkNode.__parent).toEqual(createdLinkNode.__parent);
        expect(linkNode.__url).toEqual(createdLinkNode.__url);
        expect(linkNode.__key).not.toEqual(createdLinkNode.__key);
      });
    });

    test('$createLinkNode() with target, rel and title', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('https://example.com/foo', {
          rel: 'noopener noreferrer',
          target: '_blank',
          title: 'Hello world',
        });

        const createdLinkNode = $createLinkNode('https://example.com/foo', {
          rel: 'noopener noreferrer',
          target: '_blank',
          title: 'Hello world',
        });

        expect(linkNode.__type).toEqual(createdLinkNode.__type);
        expect(linkNode.__parent).toEqual(createdLinkNode.__parent);
        expect(linkNode.__url).toEqual(createdLinkNode.__url);
        expect(linkNode.__target).toEqual(createdLinkNode.__target);
        expect(linkNode.__rel).toEqual(createdLinkNode.__rel);
        expect(linkNode.__title).toEqual(createdLinkNode.__title);
        expect(linkNode.__key).not.toEqual(createdLinkNode.__key);
      });
    });

    test('$isLinkNode()', async () => {
      const {editor} = testEnv;

      await editor.update(() => {
        const linkNode = $createLinkNode('');

        expect($isLinkNode(linkNode)).toBe(true);
      });
    });

    test('$toggleLink applies the title attribute when creating', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const p = $createParagraphNode();
        const textNode = $createTextNode('Some text');
        p.append(textNode);
        $getRoot().append(p);
        $selectAll();
        $toggleLink('https://lexical.dev/', {title: 'Lexical Website'});
        const linkNode = p.getFirstChild() as LinkNode;
        expect($isLinkNode(linkNode)).toBe(true);
        expect(linkNode.getTitle()).toBe('Lexical Website');
        const selection = $getSelection() as RangeSelection;
        expect($isRangeSelection(selection)).toBe(true);
        expect(selection.anchor).toMatchObject({
          key: textNode.getKey(),
          offset: 0,
          type: 'text',
        });
        expect(selection.focus).toMatchObject({
          key: textNode.getKey(),
          offset: textNode.getTextContentSize(),
          type: 'text',
        });
      });

      const paragraph = editor!.getEditorState().toJSON().root
        .children[0] as SerializedParagraphNode;
      const link = paragraph.children[0] as SerializedLinkNode;
      expect(link.title).toBe('Lexical Website');
    });

    test('$toggleLink correctly removes link when textnode has children(like marknode)', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const precedingText = $createTextNode('some '); // space after
        const textNode = $createTextNode('text');

        paragraph.append(precedingText, textNode);

        const linkNode = $createLinkNode('https://example.com/foo', {
          rel: 'noreferrer',
        });
        textNode.insertAfter(linkNode);
        linkNode.append(textNode);

        const markNode = $createMarkNode(['knetk']);
        textNode.insertBefore(markNode);
        markNode.append(textNode);
        $getRoot().append(paragraph);
      });

      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        const [textNode, linkNode] = paragraph.getChildren();

        // Check first text node
        expect(textNode.getTextContent()).toBe('some ');

        // Check link node and its nested structure
        expect($isLinkNode(linkNode)).toBe(true);
        if ($isLinkNode(linkNode)) {
          expect(linkNode.getURL()).toBe('https://example.com/foo');
          expect(linkNode.getRel()).toBe('noreferrer');

          // Check mark node nested inside link
          const markNode = linkNode.getFirstChild();
          if ($isMarkNode(markNode)) {
            expect(markNode.getType()).toBe('mark');
            expect(markNode.getIDs()).toEqual(['knetk']);
            expect(markNode.getTextContent()).toBe('text');
          }
        }
      });

      await editor.update(() => {
        $selectAll();
        $toggleLink(null);
      });

      // Verify structure after link removal
      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        const [textNode, markNode] = paragraph.getChildren();

        // Check text node remains unchanged
        expect(textNode.getTextContent()).toBe('some ');

        // Check mark node is preserved and moved up to paragraph level
        expect($isMarkNode(markNode)).toBe(true);
        if ($isMarkNode(markNode)) {
          expect(markNode.getType()).toBe('mark');
          expect(markNode.getIDs()).toEqual(['knetk']);
          expect(markNode.getTextContent()).toBe('text');
        }
      });
    });

    test('$toggleLink correctly removes link when link contains heading', async () => {
      // This tests the structure: link > heading > text
      const {editor} = testEnv;
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const linkNode = $createLinkNode('https://example.com/foo');
        const headingNode = $createHeadingNode('h3');
        const textNode = $createTextNode('Example Link');

        headingNode.append(textNode);
        linkNode.append(headingNode);
        paragraph.append(linkNode);
        $getRoot().append(paragraph);
      });

      // Verify initial structure: paragraph > link > heading > text
      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        const linkNode = paragraph.getFirstChild();

        expect($isLinkNode(linkNode)).toBe(true);
        if ($isLinkNode(linkNode)) {
          expect(linkNode.getURL()).toBe('https://example.com/foo');
          const headingNode = linkNode.getFirstChild();
          expect(headingNode?.getType()).toBe('heading');
          expect(headingNode?.getTextContent()).toBe('Example Link');
        }
      });

      // Select all and remove link
      await editor.update(() => {
        $selectAll();
        $toggleLink(null);
      });

      // Verify structure after link removal: paragraph > heading > text
      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        const children = paragraph.getChildren();

        // Link should be removed, heading should be moved up to paragraph level
        expect(children.length).toBe(1);
        const headingNode = children[0];
        expect(headingNode.getType()).toBe('heading');
        expect(headingNode.getTextContent()).toBe('Example Link');

        // Verify no link nodes remain
        expect($isLinkNode(headingNode)).toBe(false);
      });
    });

    test('$toggleLink adds link with embedded LineBreakNode', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const precedingText = $createTextNode('some '); // space after
        const textNode = $createTextNode('text');
        paragraph.append(precedingText, textNode, $createLineBreakNode());
        $getRoot().clear().append(paragraph);
        paragraph.select(1);
        $toggleLink('https://example.com/foo', {
          rel: 'noreferrer',
        });
      });

      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        const [precedingText, linkNode] = paragraph.getChildren();

        // Check first text node
        expect(precedingText.getTextContent()).toBe('some ');

        // Check link node and its nested structure
        expect($isLinkNode(linkNode)).toBe(true);
        if ($isLinkNode(linkNode)) {
          expect(linkNode.getURL()).toBe('https://example.com/foo');
          expect(linkNode.getRel()).toBe('noreferrer');
          expect(
            linkNode.getChildren().map(node => node.getTextContent()),
          ).toEqual(['text', '\n']);
          expect($getSelection()).toMatchObject({
            anchor: {
              key: linkNode.getFirstChildOrThrow().getKey(),
              offset: 0,
              type: 'text',
            },
            focus: {key: linkNode.getKey(), offset: 2, type: 'element'},
          });
        }
      });

      await editor.update(() => {
        $selectAll();
        $toggleLink(null);
      });

      // Verify structure after link removal
      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        const children = paragraph.getChildren();
        expect(children.map(node => node.getTextContent())).toEqual([
          'some text',
          '\n',
        ]);
        const [textNode, lineBreakNode] = children;
        expect($isTextNode(textNode)).toBe(true);
        expect($isLineBreakNode(lineBreakNode)).toBe(true);
      });
    });

    test('$toggleLink removes link from trailing space only', async () => {
      const {editor} = testEnv;
      let textNodeKey: string;

      // Create a link with text and a trailing space
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const textNode = $createTextNode('hello ');
        textNodeKey = textNode.getKey();
        const linkNode = $createLinkNode('https://example.com');
        linkNode.append(textNode);
        paragraph.append(linkNode);
        $getRoot().clear().append(paragraph);
      });

      // Verify initial structure
      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        const linkNode = paragraph.getFirstChild();
        expect($isLinkNode(linkNode)).toBe(true);
        if ($isLinkNode(linkNode)) {
          expect(linkNode.getTextContent()).toBe('hello ');
        }
      });

      // Select only the trailing space and remove the link from it
      await editor.update(() => {
        const textNode = $getNodeByKey(textNodeKey);
        if ($isTextNode(textNode)) {
          textNode.select(5, 6); // Select the trailing space
          $toggleLink(null);
        }
      });

      // Verify that the link was removed only from the space
      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        const children = paragraph.getChildren();

        // Should have two children: linkNode with 'hello' and a text node with ' '
        expect(children.length).toBe(2);

        const [linkNode, spaceNode] = children;

        // First child should still be a link containing 'hello'
        expect($isLinkNode(linkNode)).toBe(true);
        if ($isLinkNode(linkNode)) {
          expect(linkNode.getTextContent()).toBe('hello');
          expect(linkNode.getURL()).toBe('https://example.com');
        }

        // Second child should be a text node with just the space
        expect($isTextNode(spaceNode)).toBe(true);
        if ($isTextNode(spaceNode)) {
          expect(spaceNode.getTextContent()).toBe(' ');
        }
      });
    });

    test('$toggleLink removes link from leading space only', async () => {
      const {editor} = testEnv;
      let textNodeKey: string;

      // Create a link with a leading space and text
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const textNode = $createTextNode(' hello');
        textNodeKey = textNode.getKey();
        const linkNode = $createLinkNode('https://example.com');
        linkNode.append(textNode);
        paragraph.append(linkNode);
        $getRoot().clear().append(paragraph);
      });

      // Verify initial structure
      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        const linkNode = paragraph.getFirstChild();
        expect($isLinkNode(linkNode)).toBe(true);
        if ($isLinkNode(linkNode)) {
          expect(linkNode.getTextContent()).toBe(' hello');
        }
      });

      // Select only the leading space and remove the link from it
      await editor.update(() => {
        const textNode = $getNodeByKey(textNodeKey);
        if ($isTextNode(textNode)) {
          textNode.select(0, 1); // Select the leading space
          $toggleLink(null);
        }
      });

      // Verify that the link was removed only from the space
      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        const children = paragraph.getChildren();

        // Should have two children: a text node with ' ' and linkNode with 'hello'
        expect(children.length).toBe(2);

        const [spaceNode, linkNode] = children;

        // First child should be a text node with just the space
        expect($isTextNode(spaceNode)).toBe(true);
        if ($isTextNode(spaceNode)) {
          expect(spaceNode.getTextContent()).toBe(' ');
        }

        // Second child should still be a link containing 'hello'
        expect($isLinkNode(linkNode)).toBe(true);
        if ($isLinkNode(linkNode)) {
          expect(linkNode.getTextContent()).toBe('hello');
          expect(linkNode.getURL()).toBe('https://example.com');
        }
      });
    });

    test('$toggleLink removes link from middle word only, preserving surrounding spaces', async () => {
      const {editor} = testEnv;
      let textNodeKey: string;

      // Create a link with leading space, text, and trailing space
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const textNode = $createTextNode(' hello ');
        textNodeKey = textNode.getKey();
        const linkNode = $createLinkNode('https://example.com');
        linkNode.append(textNode);
        paragraph.append(linkNode);
        $getRoot().clear().append(paragraph);
      });

      // Verify initial structure
      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        const linkNode = paragraph.getFirstChild();
        expect($isLinkNode(linkNode)).toBe(true);
        if ($isLinkNode(linkNode)) {
          expect(linkNode.getTextContent()).toBe(' hello ');
        }
      });

      // Select only 'hello' (without spaces) and remove the link from it
      await editor.update(() => {
        const textNode = $getNodeByKey(textNodeKey);
        if ($isTextNode(textNode)) {
          textNode.select(1, 6); // Select 'hello'
          $toggleLink(null);
        }
      });

      // Verify that the link was removed only from 'hello'
      editor.read(() => {
        const paragraph = $assertNodeType(
          $getRoot().getFirstChild(),
          $isParagraphNode,
        );
        const children = paragraph.getChildren();

        // Should have three children: link with ' ', text with 'hello', link with ' '
        expect(children.length).toBe(3);

        const [leadingSpaceLink, middleText, trailingSpaceLink] = children;

        // First child should be a link with leading space
        expect($isLinkNode(leadingSpaceLink)).toBe(true);
        if ($isLinkNode(leadingSpaceLink)) {
          expect(leadingSpaceLink.getTextContent()).toBe(' ');
          expect(leadingSpaceLink.getURL()).toBe('https://example.com');
        }

        // Middle child should be plain text 'hello'
        expect($isTextNode(middleText)).toBe(true);
        if ($isTextNode(middleText)) {
          expect(middleText.getTextContent()).toBe('hello');
        }

        // Third child should be a link with trailing space
        expect($isLinkNode(trailingSpaceLink)).toBe(true);
        if ($isLinkNode(trailingSpaceLink)) {
          expect(trailingSpaceLink.getTextContent()).toBe(' ');
          expect(trailingSpaceLink.getURL()).toBe('https://example.com');
        }
      });
    });

    test('$toggleLink removes link when selection is collapsed', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const p = $createParagraphNode();
        const textNode = $createTextNode('textboldtext');
        p.append(textNode);
        $getRoot().append(p);
        $selectAll();
        $toggleLink('https://lexical.dev/', {title: 'Lexical Website'});

        const linkNode = p.getFirstChild() as LinkNode;
        textNode.select(4, 8).formatText('bold');
        const sel = $createRangeSelection();
        const key = linkNode.getChildAtIndex(1)!.getKey();
        sel.anchor.set(key, 4, 'text');
        sel.focus.set(key, 4, 'text');
        $setSelection(sel);
        $toggleLink(null);

        const children = p.getChildren();
        expect(children.length).toBe(3);
        children.forEach(child => expect($isTextNode(child)).toBe(true));
      });
    });
  });
});

describe('formatUrl', () => {
  it('should not modify URLs with protocols', () => {
    expect(formatUrl('https://example.com')).toBe('https://example.com');
    expect(formatUrl('http://example.com')).toBe('http://example.com');
    expect(formatUrl('mailto:user@example.com')).toBe(
      'mailto:user@example.com',
    );
    expect(formatUrl('tel:+1234567890')).toBe('tel:+1234567890');
  });

  it('should not modify relative paths', () => {
    expect(formatUrl('/path/to/resource')).toBe('/path/to/resource');
    expect(formatUrl('/index.html')).toBe('/index.html');
  });

  it('should add mailto: to email addresses', () => {
    expect(formatUrl('user@example.com')).toBe('mailto:user@example.com');
    expect(formatUrl('name.lastname@domain.co.uk')).toBe(
      'mailto:name.lastname@domain.co.uk',
    );
  });

  it('should add tel: to phone numbers', () => {
    expect(formatUrl('+1234567890')).toBe('tel:+1234567890');
    expect(formatUrl('123-456-7890')).toBe('tel:123-456-7890');
  });

  it('should add https:// to URLs without protocols', () => {
    expect(formatUrl('www.example.com')).toBe('https://www.example.com');
    expect(formatUrl('example.com')).toBe('https://example.com');
    expect(formatUrl('subdomain.example.com/path')).toBe(
      'https://subdomain.example.com/path',
    );
  });
});

describe('LinkNode transform (Regression #8083)', () => {
  const transformExtension = defineExtension({
    dependencies: [LinkExtension, RichTextExtension],
    name: '[test-link-transform]',
  });

  test('extracts block child (HeadingNode) from link', () => {
    using editor = buildEditorFromExtensions(transformExtension);
    let textKey: string;
    editor.update(
      () => {
        const root = $getRoot();
        const text = $createTextNode('Lexical');
        textKey = text.getKey();
        const heading = $createHeadingNode('h1');
        heading.append(text);
        const link = $createLinkNode('https://lexical.dev');
        link.append(heading);
        const paragraph = $createParagraphNode();
        paragraph.append(link);
        root.clear().append(paragraph);
        text.select(3, 3);
      },
      {discrete: true},
    );
    editor.read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      expect(children.length).toBe(1);
      const heading = children[0];
      assert($isHeadingNode(heading), 'First child must be a HeadingNode');
      expect(heading.getChildrenSize()).toBe(1);
      const headingChild = heading.getFirstChild();
      assert($isLinkNode(headingChild), 'Heading child must be a LinkNode');
      expect(headingChild.getTextContent()).toBe('Lexical');
      const selection = $getSelection();
      assert(
        $isRangeSelection(selection),
        'Selection must be a RangeSelection',
      );
      expect(selection.anchor.type).toBe('text');
      expect(selection.anchor.key).toBe(textKey);
      expect(selection.anchor.offset).toBe(3);
    });
  });

  test('extracts block child (ParagraphNode) from link', () => {
    using editor = buildEditorFromExtensions(transformExtension);
    let textKey: string;
    editor.update(
      () => {
        const root = $getRoot();
        const text = $createTextNode('Lexical');
        textKey = text.getKey();
        const innerParagraph = $createParagraphNode();
        innerParagraph.append(text);
        const link = $createLinkNode('https://lexical.dev');
        link.append(innerParagraph);
        const outerParagraph = $createParagraphNode();
        outerParagraph.append(link);
        root.clear().append(outerParagraph);
        text.select(0, 7);
      },
      {discrete: true},
    );
    editor.read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      expect(children.length).toBe(1);
      const para = children[0];
      assert($isParagraphNode(para), 'First child must be a ParagraphNode');
      expect(para.getChildrenSize()).toBe(1);
      const paraChild = para.getFirstChild();
      assert($isLinkNode(paraChild), 'Paragraph child must be a LinkNode');
      expect(paraChild.getTextContent()).toBe('Lexical');
      const selection = $getSelection();
      assert(
        $isRangeSelection(selection),
        'Selection must be a RangeSelection',
      );
      expect(selection.anchor.type).toBe('text');
      expect(selection.anchor.key).toBe(textKey);
      expect(selection.anchor.offset).toBe(0);
      expect(selection.focus.type).toBe('text');
      expect(selection.focus.key).toBe(textKey);
      expect(selection.focus.offset).toBe(7);
    });
  });

  test('handles siblings after block child', () => {
    using editor = buildEditorFromExtensions(transformExtension);
    let afterTextKey: string;
    editor.update(
      () => {
        const root = $getRoot();
        const headingText = $createTextNode('Heading');
        const heading = $createHeadingNode('h1');
        heading.append(headingText);
        const afterText = $createTextNode(' after');
        afterTextKey = afterText.getKey();
        const link = $createLinkNode('https://lexical.dev');
        link.append(heading, afterText);
        const paragraph = $createParagraphNode();
        paragraph.append(link);
        root.clear().append(paragraph);
        afterText.select(2, 5);
      },
      {discrete: true},
    );
    editor.read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      expect(children.length).toBe(2);
      const heading = children[0];
      assert($isHeadingNode(heading), 'First child must be a HeadingNode');
      const headingLink = heading.getFirstChild();
      assert($isLinkNode(headingLink), 'Heading child must be a LinkNode');
      expect(headingLink.getTextContent()).toBe('Heading');
      const trailingPara = children[1];
      assert(
        $isParagraphNode(trailingPara),
        'Second child must be a ParagraphNode',
      );
      const trailingLink = trailingPara.getFirstChild();
      assert(
        $isLinkNode(trailingLink),
        'Trailing paragraph child must be a LinkNode',
      );
      expect(trailingLink.getTextContent()).toBe(' after');
      const selection = $getSelection();
      assert(
        $isRangeSelection(selection),
        'Selection must be a RangeSelection',
      );
      expect(selection.anchor.type).toBe('text');
      expect(selection.anchor.key).toBe(afterTextKey);
      expect(selection.anchor.offset).toBe(2);
      expect(selection.focus.type).toBe('text');
      expect(selection.focus.key).toBe(afterTextKey);
      expect(selection.focus.offset).toBe(5);
    });
  });

  test('fixes element selection in paragraph split to the right of LinkNode', () => {
    using editor = buildEditorFromExtensions(transformExtension);
    let afterTextKey: string;
    editor.update(
      () => {
        const root = $getRoot();
        const textBefore = $createTextNode('before');
        const headingText = $createTextNode('Heading');
        const heading = $createHeadingNode('h1');
        heading.append(headingText);
        const link = $createLinkNode('https://lexical.dev');
        link.append(heading);
        const textAfter = $createTextNode('after');
        afterTextKey = textAfter.getKey();
        const paragraph = $createParagraphNode();
        paragraph.append(textBefore, link, textAfter);
        root.clear().append(paragraph);
        paragraph.select(2, 2);
      },
      {discrete: true},
    );
    editor.read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      expect(children.length).toBe(3);
      expect(children[2].getTextContent()).toBe('after');
      const selection = $getSelection();
      assert(
        $isRangeSelection(selection),
        'Selection must be a RangeSelection',
      );
      expect(selection.anchor.type).toBe('text');
      expect(selection.anchor.key).toBe(afterTextKey);
      expect(selection.anchor.offset).toBe(0);
    });
  });

  test('fixes element selection in LinkNode to the right of non-inline node', () => {
    using editor = buildEditorFromExtensions(transformExtension);
    let afterTextKey: string;
    editor.update(
      () => {
        const root = $getRoot();
        const headingText = $createTextNode('Heading');
        const heading = $createHeadingNode('h1');
        heading.append(headingText);
        const afterText = $createTextNode(' after');
        afterTextKey = afterText.getKey();
        const link = $createLinkNode('https://lexical.dev');
        link.append(heading, afterText);
        const paragraph = $createParagraphNode();
        paragraph.append(link);
        root.clear().append(paragraph);
        link.select(1, 1);
      },
      {discrete: true},
    );
    editor.read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      expect(children.length).toBe(2);
      const trailingPara = children[1];
      assert(
        $isParagraphNode(trailingPara),
        'Second child must be a ParagraphNode',
      );
      const trailingLink = trailingPara.getFirstChild();
      assert(
        $isLinkNode(trailingLink),
        'Trailing paragraph child must be a LinkNode',
      );
      const selection = $getSelection();
      assert(
        $isRangeSelection(selection),
        'Selection must be a RangeSelection',
      );
      expect(selection.anchor.type).toBe('text');
      expect(selection.anchor.key).toBe(afterTextKey);
      expect(selection.anchor.offset).toBe(0);
    });
  });

  test('fixes element selection with multiple non-inline siblings', () => {
    using editor = buildEditorFromExtensions(transformExtension);
    let heading2TextKey: string;
    editor.update(
      () => {
        const root = $getRoot();
        const heading1Text = $createTextNode('First');
        const heading1 = $createHeadingNode('h1');
        heading1.append(heading1Text);
        const heading2Text = $createTextNode('Second');
        heading2TextKey = heading2Text.getKey();
        const heading2 = $createHeadingNode('h2');
        heading2.append(heading2Text);
        const link = $createLinkNode('https://lexical.dev');
        link.append(heading1, heading2);
        const paragraph = $createParagraphNode();
        paragraph.append(link);
        root.clear().append(paragraph);
        link.select(1, 1);
      },
      {discrete: true},
    );
    editor.read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      expect(children.length).toBe(2);
      const first = children[0];
      assert($isHeadingNode(first), 'First child must be a HeadingNode');
      expect(first.getTextContent()).toBe('First');
      const second = children[1];
      assert($isHeadingNode(second), 'Second child must be a HeadingNode');
      expect(second.getTextContent()).toBe('Second');
      const selection = $getSelection();
      assert(
        $isRangeSelection(selection),
        'Selection must be a RangeSelection',
      );
      expect(selection.anchor.type).toBe('text');
      expect(selection.anchor.key).toBe(heading2TextKey);
      expect(selection.anchor.offset).toBe(0);
    });
  });

  test('fixes element selection when no siblings to the right of LinkNode', () => {
    using editor = buildEditorFromExtensions(transformExtension);
    editor.update(
      () => {
        const root = $getRoot();
        const headingText = $createTextNode('Heading');
        const heading = $createHeadingNode('h1');
        heading.append(headingText);
        const link = $createLinkNode('https://lexical.dev');
        link.append(heading);
        const paragraph = $createParagraphNode();
        paragraph.append(link);
        root.clear().append(paragraph);
        paragraph.select(1, 1);
      },
      {discrete: true},
    );
    editor.read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      expect(children.length).toBe(1);
      const heading = children[0];
      assert($isHeadingNode(heading), 'First child must be a HeadingNode');
      const headingChild = heading.getFirstChild();
      assert($isLinkNode(headingChild), 'Heading child must be a LinkNode');
      expect(headingChild.getTextContent()).toBe('Heading');
      const selection = $getSelection();
      assert(
        $isRangeSelection(selection),
        'Selection must be a RangeSelection',
      );
    });
  });

  test('selection in paragraph right of link with trailing text in link', () => {
    using editor = buildEditorFromExtensions(transformExtension);
    let afterTextKey: string;
    editor.update(
      () => {
        const root = $getRoot();
        const before = $createTextNode('before');
        const headingText = $createTextNode('Heading');
        const heading = $createHeadingNode('h1');
        heading.append(headingText);
        const trailingText = $createTextNode(' trailing');
        const link = $createLinkNode('https://lexical.dev');
        link.append(heading, trailingText);
        const after = $createTextNode('after');
        afterTextKey = after.getKey();
        const paragraph = $createParagraphNode();
        paragraph.append(before, link, after);
        root.clear().append(paragraph);
        paragraph.select(2, 2);
      },
      {discrete: true},
    );
    editor.read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      expect(children.length).toBe(3);
      const selection = $getSelection();
      assert(
        $isRangeSelection(selection),
        'Selection must be a RangeSelection',
      );
      expect(selection.anchor.type).toBe('text');
      expect(selection.anchor.key).toBe(afterTextKey);
      expect(selection.anchor.offset).toBe(0);
    });
  });

  test('selection at end of link with heading only child', () => {
    using editor = buildEditorFromExtensions(transformExtension);
    let headingTextKey: string;
    editor.update(
      () => {
        const root = $getRoot();
        const headingText = $createTextNode('Heading');
        headingTextKey = headingText.getKey();
        const heading = $createHeadingNode('h1');
        heading.append(headingText);
        const link = $createLinkNode('https://lexical.dev');
        link.append(heading);
        const paragraph = $createParagraphNode();
        paragraph.append(link);
        root.clear().append(paragraph);
        link.select(1, 1);
      },
      {discrete: true},
    );
    editor.read(() => {
      const root = $getRoot();
      const children = root.getChildren();
      expect(children.length).toBe(1);
      const heading = children[0];
      assert($isHeadingNode(heading), 'First child must be a HeadingNode');
      const selection = $getSelection();
      assert(
        $isRangeSelection(selection),
        'Selection must be a RangeSelection',
      );
      expect(selection.anchor.type).toBe('text');
      expect(selection.anchor.key).toBe(headingTextKey);
      expect(selection.anchor.offset).toBe(7);
    });
  });

  // Regression #8305: All five visually-equivalent cursor positions at the
  // boundary between two adjacent identical links must resolve to the merge
  // boundary (textA at offset 5) after the links merge.
  type MergeScenarioNodes = {
    linkA: LinkNode;
    linkB: LinkNode;
    paragraph: ParagraphNode;
    textA: TextNode;
    textB: TextNode;
  };
  const mergeBoundaryScenarios: [
    string,
    ($nodes: MergeScenarioNodes) => void,
  ][] = [
    ['text point at end of first link text', ({textA}) => textA.select(5, 5)],
    [
      'text point at start of second link text',
      ({textB}) => textB.select(0, 0),
    ],
    [
      'element point at last child of first link',
      ({linkA}) => linkA.select(1, 1),
    ],
    [
      'element point between the two links',
      ({paragraph}) => paragraph.select(1, 1),
    ],
    [
      'element point at first child of second link',
      ({linkB}) => linkB.select(0, 0),
    ],
  ];

  test.each(mergeBoundaryScenarios)(
    '#8305 cursor at merge boundary: %s',
    (_desc, $setSelectionAtBoundary) => {
      using editor = buildEditorFromExtensions(transformExtension);
      let textAKey: string;
      editor.update(
        () => {
          const textA = $createTextNode('link1');
          textAKey = textA.getKey();
          const textB = $createTextNode('link2');
          const linkA = $createLinkNode('https://lexical.dev').append(textA);
          const linkB = $createLinkNode('https://lexical.dev').append(textB);
          const paragraph = $createParagraphNode().append(linkA, linkB);
          $getRoot().clear().append(paragraph);
          $setSelectionAtBoundary({linkA, linkB, paragraph, textA, textB});
        },
        {discrete: true},
      );
      editor.read(() => {
        const paragraph = $getRoot().getFirstChild();
        assert($isParagraphNode(paragraph), 'Expected ParagraphNode');
        expect(paragraph.getChildrenSize()).toBe(1);
        const mergedLink = paragraph.getFirstChild();
        assert($isLinkNode(mergedLink), 'Expected LinkNode');
        expect(mergedLink.getTextContent()).toBe('link1link2');
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        expect(selection.isCollapsed()).toBe(true);
        expect(selection.anchor.type).toBe('text');
        expect(selection.anchor.key).toBe(textAKey);
        expect(selection.anchor.offset).toBe(5);
      });
    },
  );

  test('#8305 edge case: second link starts with LineBreakNode', () => {
    using editor = buildEditorFromExtensions(transformExtension);
    let textAKey: string;
    editor.update(
      () => {
        const textA = $createTextNode('link1');
        textAKey = textA.getKey();
        const paragraph = $createParagraphNode().append(
          $createLinkNode('https://lexical.dev').append(textA),
          $createLinkNode('https://lexical.dev').append(
            $createLineBreakNode(),
            $createTextNode('link2'),
          ),
        );
        $getRoot().clear().append(paragraph);
        paragraph.select(1, 1);
      },
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $getRoot().getFirstChild();
      assert($isParagraphNode(paragraph), 'Expected ParagraphNode');
      expect(paragraph.getChildrenSize()).toBe(1);
      const mergedLink = paragraph.getFirstChild();
      assert($isLinkNode(mergedLink), 'Expected LinkNode');
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected RangeSelection');
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.type).toBe('text');
      expect(selection.anchor.key).toBe(textAKey);
      expect(selection.anchor.offset).toBe(5);
    });
  });

  test('#8305 edge case: first link ends with LineBreakNode', () => {
    using editor = buildEditorFromExtensions(transformExtension);
    editor.update(
      () => {
        const paragraph = $createParagraphNode().append(
          $createLinkNode('https://lexical.dev').append(
            $createTextNode('link1'),
            $createLineBreakNode(),
          ),
          $createLinkNode('https://lexical.dev').append(
            $createTextNode('link2'),
          ),
        );
        $getRoot().clear().append(paragraph);
        paragraph.select(1, 1);
      },
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $getRoot().getFirstChild();
      assert($isParagraphNode(paragraph), 'Expected ParagraphNode');
      expect(paragraph.getChildrenSize()).toBe(1);
      const mergedLink = paragraph.getFirstChild();
      assert($isLinkNode(mergedLink), 'Expected LinkNode');
      const selection = $getSelection();
      assert($isRangeSelection(selection), 'Expected RangeSelection');
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.type).toBe('text');
      expect(selection.anchor.offset).toBe(0);
    });
  });
});

describe('LinkNode.extractWithChild (Issue #5046 — preserve link wrap across browsers)', () => {
  initializeUnitTest(testEnv => {
    function $setupLinkInParagraph() {
      const root = $getRoot();
      const paragraph = $createParagraphNode();
      const linkNode = $createLinkNode('https://example.com');
      const textNode = $createTextNode('hello link');
      linkNode.append(textNode);
      paragraph.append(linkNode);
      root.append(paragraph);
      return {linkNode, paragraph, textNode};
    }

    test('Chrome-like — anchor/focus both on inner TextNode', () => {
      const {editor} = testEnv;
      editor.update(
        () => {
          const {linkNode, textNode} = $setupLinkInParagraph();
          const selection = textNode.select(0, 10);
          expect(linkNode.extractWithChild(textNode, selection, 'clone')).toBe(
            true,
          );
        },
        {discrete: true},
      );
    });

    test('Firefox-like — anchor/focus both on LinkNode itself (element point)', () => {
      const {editor} = testEnv;
      editor.update(
        () => {
          const {linkNode, textNode} = $setupLinkInParagraph();
          // 0,1 (asymmetric offsets) keeps select() in the element-point
          // branch — 0,0 / undefined,undefined would redirect into the
          // first/last child because LinkNode.canBeEmpty() is false.
          const selection = linkNode.select(0, 1);
          expect(linkNode.extractWithChild(textNode, selection, 'clone')).toBe(
            true,
          );
        },
        {discrete: true},
      );
    });

    test('Safari-like — asymmetric (anchor on LinkNode, focus on inner TextNode)', () => {
      const {editor} = testEnv;
      editor.update(
        () => {
          const {linkNode, textNode} = $setupLinkInParagraph();
          const selection = linkNode.select(0, 1);
          selection.focus.set(textNode.getKey(), 10, 'text');
          expect(linkNode.extractWithChild(textNode, selection, 'clone')).toBe(
            true,
          );
        },
        {discrete: true},
      );
    });

    test('selection entirely outside the link returns false', () => {
      const {editor} = testEnv;
      editor.update(
        () => {
          const root = $getRoot();
          const paragraph = $createParagraphNode();
          const linkNode = $createLinkNode('https://example.com');
          const textNode = $createTextNode('hello link');
          linkNode.append(textNode);
          const outsideText = $createTextNode('outside');
          paragraph.append(linkNode);
          paragraph.append(outsideText);
          root.append(paragraph);
          const selection = outsideText.select(0, 7);
          expect(linkNode.extractWithChild(textNode, selection, 'clone')).toBe(
            false,
          );
        },
        {discrete: true},
      );
    });

    test('collapsed (zero-length) selection inside the link returns false', () => {
      const {editor} = testEnv;
      editor.update(
        () => {
          const {linkNode, textNode} = $setupLinkInParagraph();
          const selection = textNode.select(5, 5);
          expect(linkNode.extractWithChild(textNode, selection, 'clone')).toBe(
            false,
          );
        },
        {discrete: true},
      );
    });

    test('AutoLinkNode (LinkNode subclass) inherits the Firefox-like fix', () => {
      const {editor} = testEnv;
      editor.update(
        () => {
          const root = $getRoot();
          const paragraph = $createParagraphNode();
          const autoLink = $createAutoLinkNode('https://example.com');
          const textNode = $createTextNode('https://example.com');
          autoLink.append(textNode);
          paragraph.append(autoLink);
          root.append(paragraph);
          const selection = autoLink.select(0, 1);
          expect(autoLink.extractWithChild(textNode, selection, 'clone')).toBe(
            true,
          );
        },
        {discrete: true},
      );
    });

    test('partial text selection inside link with Firefox-like element anchor still preserves wrap', () => {
      const {editor} = testEnv;
      editor.update(
        () => {
          const {linkNode, textNode} = $setupLinkInParagraph();
          // anchor on LinkNode (element), focus partway through inner text
          const selection = linkNode.select(0, 1);
          selection.focus.set(textNode.getKey(), 4, 'text');
          expect(linkNode.extractWithChild(textNode, selection, 'clone')).toBe(
            true,
          );
        },
        {discrete: true},
      );
    });

    test('selecting one of two adjacent links does not pull in the other', () => {
      const {editor} = testEnv;
      editor.update(
        () => {
          const root = $getRoot();
          const paragraph = $createParagraphNode();
          const link1 = $createLinkNode('https://first.example');
          const text1 = $createTextNode('first');
          link1.append(text1);
          const between = $createTextNode(' and ');
          const link2 = $createLinkNode('https://second.example');
          const text2 = $createTextNode('second');
          link2.append(text2);
          paragraph.append(link1);
          paragraph.append(between);
          paragraph.append(link2);
          root.append(paragraph);
          // Firefox-like selection that wraps link1 entirely
          const selection = link1.select(0, 1);
          // link1 includes its own child, link2 does not
          expect(link1.extractWithChild(text1, selection, 'clone')).toBe(true);
          expect(link2.extractWithChild(text2, selection, 'clone')).toBe(false);
        },
        {discrete: true},
      );
    });
  });
});

describe('$toggleLink with a NodeSelection', () => {
  const extension = defineExtension({
    $initialEditorState: () => {
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createTextNode('hello')));
    },
    dependencies: [LinkExtension, RichTextExtension],
    name: '[root-node-selection]',
  });

  function $selectTheTextNode(): void {
    const textNode = $getRoot().getLastDescendant();
    assert($isTextNode(textNode), 'Expected a TextNode');
    const selection = $createNodeSelection();
    selection.add(textNode.getKey());
    $setSelection(selection);
  }

  function $getLink(): LinkNode {
    const paragraph = $getRoot().getFirstChild();
    assert($isParagraphNode(paragraph), 'Expected a ParagraphNode');
    const link = paragraph.getFirstChild();
    assert($isLinkNode(link), 'Expected a LinkNode');
    return link;
  }

  it('applies the title when creating a link', () => {
    using editor = buildEditorFromExtensions(extension);
    editor.update(
      () => {
        $selectTheTextNode();
        $toggleLink('https://lexical.dev/', {
          rel: 'noopener',
          target: '_blank',
          title: 'Lexical',
        });
      },
      {discrete: true},
    );
    editor.read(() => {
      const link = $getLink();
      expect(link.getURL()).toBe('https://lexical.dev/');
      expect(link.getRel()).toBe('noopener');
      expect(link.getTarget()).toBe('_blank');
      expect(link.getTitle()).toBe('Lexical');
    });
  });

  it('applies the title when updating an existing link', () => {
    using editor = buildEditorFromExtensions(extension);
    editor.update(
      () => {
        $selectTheTextNode();
        $toggleLink('https://lexical.dev/', {title: 'First'});
      },
      {discrete: true},
    );
    editor.update(
      () => {
        $selectTheTextNode();
        $toggleLink('https://lexical.dev/docs', {title: 'Second'});
      },
      {discrete: true},
    );
    editor.read(() => {
      const link = $getLink();
      expect(link.getURL()).toBe('https://lexical.dev/docs');
      expect(link.getTitle()).toBe('Second');
    });
  });

  it('leaves an existing title alone when none is supplied', () => {
    using editor = buildEditorFromExtensions(extension);
    editor.update(
      () => {
        $selectTheTextNode();
        $toggleLink('https://lexical.dev/', {title: 'Kept'});
      },
      {discrete: true},
    );
    editor.update(
      () => {
        $selectTheTextNode();
        $toggleLink('https://lexical.dev/docs');
      },
      {discrete: true},
    );
    editor.read(() => {
      const link = $getLink();
      expect(link.getURL()).toBe('https://lexical.dev/docs');
      expect(link.getTitle()).toBe('Kept');
    });
  });
});
