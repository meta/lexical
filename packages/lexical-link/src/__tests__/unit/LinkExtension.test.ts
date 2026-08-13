/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  $createCodeHighlightNode,
  $createCodeNode,
  $isCodeNode,
  CodeExtension,
} from '@lexical/code-core';
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createAutoLinkNode,
  $createLinkNode,
  $isLinkNode,
  $toggleLink,
  AutoLinkNode,
  LinkExtension,
  TOGGLE_LINK_COMMAND,
} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  configExtension,
  type LexicalEditorWithDispose,
  PASTE_COMMAND,
} from 'lexical';
import {assert, describe, expect, it} from 'vitest';

describe('Link', () => {
  const extension = defineExtension({
    $initialEditorState: () => {
      const p = $createParagraphNode();
      p.append($createTextNode('Hello'));
      $getRoot().append(p);
    },
    dependencies: [LinkExtension, RichTextExtension],
    name: '[root]',
  });
  it('can convert a text node to a link with $toggleLink', () => {
    using editor = buildEditorFromExtensions(extension);
    editor.update(
      () => {
        const textNode = $getRoot().getLastDescendant();
        assert($isTextNode(textNode), 'Expected a TextNode');
        textNode.select(0);
        expect($isLinkNode(textNode.getParent())).toBe(false);
        $toggleLink('https://lexical.dev/');
        expect($isLinkNode(textNode.getParent())).toBe(true);
        let linkNode = textNode.getParent();
        assert($isLinkNode(linkNode), 'Expected a LinkNode');
        expect(linkNode.getURL()).toBe('https://lexical.dev/');
        expect(linkNode.getTarget()).toBe(null);
        expect($getRoot().getTextContent()).toBe('Hello');
        $toggleLink(null);
        expect($getRoot().getTextContent()).toBe('Hello');
        expect($isLinkNode(textNode.getParent())).toBe(false);
        $toggleLink({
          rel: 'noopener',
          target: '_blank',
          title: 'title',
          url: 'https://lexical.dev/',
        });
        linkNode = textNode.getParent();
        assert($isLinkNode(linkNode), 'Expected a LinkNode');
        expect(linkNode.getURL()).toBe('https://lexical.dev/');
        expect(linkNode.getTarget()).toBe('_blank');
        expect(linkNode.getRel()).toBe('noopener');
        expect(linkNode.getTitle()).toBe('title');
      },
      {discrete: true},
    );
  });

  describe('merge adjacent LinkNodes', () => {
    it('merges adjacent LinkNodes with identical attributes', () => {
      using editor = buildEditorFromExtensions(extension);
      editor.update(
        () => {
          const p = $getRoot().getFirstChild();
          assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
          p.clear();
          const link1 = $createLinkNode('https://lexical.dev/', {
            rel: 'noreferrer',
            target: '_blank',
            title: 'Lexical',
          });
          link1.append($createTextNode('Hello '));
          const link2 = $createLinkNode('https://lexical.dev/', {
            rel: 'noreferrer',
            target: '_blank',
            title: 'Lexical',
          });
          link2.append($createTextNode('World'));
          p.append(link1, link2);
        },
        {discrete: true},
      );
      editor.read(() => {
        const p = $getRoot().getFirstChild();
        assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
        const children = p.getChildren();
        expect(children.length).toBe(1);
        const link = children[0];
        assert($isLinkNode(link), 'Expected a LinkNode');
        expect(link.getURL()).toBe('https://lexical.dev/');
        expect(link.getTarget()).toBe('_blank');
        expect(link.getRel()).toBe('noreferrer');
        expect(link.getTitle()).toBe('Lexical');
        expect(link.getTextContent()).toBe('Hello World');
      });
    });

    it('does not merge LinkNodes with different URLs', () => {
      using editor = buildEditorFromExtensions(extension);
      editor.update(
        () => {
          const p = $getRoot().getFirstChild();
          assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
          p.clear();
          const link1 = $createLinkNode('https://lexical.dev/');
          link1.append($createTextNode('Hello '));
          const link2 = $createLinkNode('https://other.dev/');
          link2.append($createTextNode('World'));
          p.append(link1, link2);
        },
        {discrete: true},
      );
      editor.read(() => {
        const p = $getRoot().getFirstChild();
        assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
        expect(p.getChildren().length).toBe(2);
      });
    });

    it('does not merge LinkNode with AutoLinkNode', () => {
      const autoLinkExtension = defineExtension({
        $initialEditorState: () => {
          const p = $createParagraphNode();
          p.append($createTextNode('Hello'));
          $getRoot().append(p);
        },
        dependencies: [LinkExtension, RichTextExtension],
        name: '[root-autolink]',
        nodes: () => [AutoLinkNode],
      });
      using editor = buildEditorFromExtensions(autoLinkExtension);
      editor.update(
        () => {
          const p = $getRoot().getFirstChild();
          assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
          p.clear();
          const link = $createLinkNode('https://lexical.dev/');
          link.append($createTextNode('Hello '));
          const autoLink = $createAutoLinkNode('https://lexical.dev/');
          autoLink.append($createTextNode('World'));
          p.append(link, autoLink);
        },
        {discrete: true},
      );
      editor.read(() => {
        const p = $getRoot().getFirstChild();
        assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
        expect(p.getChildren().length).toBe(2);
      });
    });

    it('does not merge LinkNodes with different rel', () => {
      using editor = buildEditorFromExtensions(extension);
      editor.update(
        () => {
          const p = $getRoot().getFirstChild();
          assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
          p.clear();
          const link1 = $createLinkNode('https://lexical.dev/', {
            rel: 'noreferrer',
          });
          link1.append($createTextNode('Hello '));
          const link2 = $createLinkNode('https://lexical.dev/', {
            rel: 'noopener',
          });
          link2.append($createTextNode('World'));
          p.append(link1, link2);
        },
        {discrete: true},
      );
      editor.read(() => {
        const p = $getRoot().getFirstChild();
        assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
        expect(p.getChildren().length).toBe(2);
      });
    });

    it('merges three adjacent identical links into one', () => {
      using editor = buildEditorFromExtensions(extension);
      editor.update(
        () => {
          const p = $getRoot().getFirstChild();
          assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
          p.clear();
          const link1 = $createLinkNode('https://lexical.dev/');
          link1.append($createTextNode('A'));
          const link2 = $createLinkNode('https://lexical.dev/');
          link2.append($createTextNode('B'));
          const link3 = $createLinkNode('https://lexical.dev/');
          link3.append($createTextNode('C'));
          p.append(link1, link2, link3);
        },
        {discrete: true},
      );
      editor.read(() => {
        const p = $getRoot().getFirstChild();
        assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
        const children = p.getChildren();
        expect(children.length).toBe(1);
        expect($isLinkNode(children[0])).toBe(true);
        expect(children[0].getTextContent()).toBe('ABC');
      });
    });

    it('preserves selection when cursor is in the second link during merge', () => {
      using editor = buildEditorFromExtensions(extension);
      editor.update(
        () => {
          const p = $getRoot().getFirstChild();
          assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
          p.clear();
          const link1 = $createLinkNode('https://lexical.dev/');
          link1.append($createTextNode('Hello '));
          const link2 = $createLinkNode('https://lexical.dev/');
          const text2 = $createTextNode('World');
          link2.append(text2);
          p.append(link1, link2);
          text2.select(2, 2);
        },
        {discrete: true},
      );
      editor.read(() => {
        const p = $getRoot().getFirstChild();
        assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
        const children = p.getChildren();
        expect(children.length).toBe(1);
        expect(children[0].getTextContent()).toBe('Hello World');
        const selection = $getSelection();
        expect($isRangeSelection(selection)).toBe(true);
        if ($isRangeSelection(selection)) {
          expect(selection.anchor.offset).toBe(8);
          expect(selection.anchor.getNode().getTextContent()).toBe(
            'Hello World',
          );
          expect($isLinkNode(selection.anchor.getNode().getParent())).toBe(
            true,
          );
        }
      });
    });

    it('merges when only the second link is changed to match the first', () => {
      using editor = buildEditorFromExtensions(extension);
      editor.update(
        () => {
          const p = $getRoot().getFirstChild();
          assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
          p.clear();
          const link1 = $createLinkNode('https://lexical.dev/');
          link1.append($createTextNode('Hello '));
          const link2 = $createLinkNode('https://other.dev/');
          link2.append($createTextNode('World'));
          p.append(link1, link2);
        },
        {discrete: true},
      );
      editor.read(() => {
        const p = $getRoot().getFirstChild();
        assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
        expect(p.getChildren().length).toBe(2);
      });
      editor.update(
        () => {
          const p = $getRoot().getFirstChild();
          assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
          const link2 = p.getChildren()[1];
          assert($isLinkNode(link2), 'Expected LinkNode');
          link2.setURL('https://lexical.dev/');
        },
        {discrete: true},
      );
      editor.read(() => {
        const p = $getRoot().getFirstChild();
        assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
        const children = p.getChildren();
        expect(children.length).toBe(1);
        expect($isLinkNode(children[0])).toBe(true);
        expect(children[0].getTextContent()).toBe('Hello World');
      });
    });

    it('preserves selection when cursor is in a link that merges into its left neighbor', () => {
      using editor = buildEditorFromExtensions(extension);
      editor.update(
        () => {
          const p = $getRoot().getFirstChild();
          assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
          p.clear();
          const link1 = $createLinkNode('https://lexical.dev/');
          link1.append($createTextNode('Hello '));
          const link2 = $createLinkNode('https://other.dev/');
          const text2 = $createTextNode('World');
          link2.append(text2);
          p.append(link1, link2);
          text2.select(2, 2);
        },
        {discrete: true},
      );
      editor.update(
        () => {
          const p = $getRoot().getFirstChild();
          assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
          const link2 = p.getChildren()[1];
          assert($isLinkNode(link2), 'Expected LinkNode');
          link2.setURL('https://lexical.dev/');
        },
        {discrete: true},
      );
      editor.read(() => {
        const p = $getRoot().getFirstChild();
        assert($isParagraphNode(p), 'Expecting a ParagraphNode in the root');
        const children = p.getChildren();
        expect(children.length).toBe(1);
        expect(children[0].getTextContent()).toBe('Hello World');
        const selection = $getSelection();
        expect($isRangeSelection(selection)).toBe(true);
        if ($isRangeSelection(selection)) {
          expect(selection.anchor.offset).toBe(8);
          expect(selection.anchor.getNode().getTextContent()).toBe(
            'Hello World',
          );
          expect($isLinkNode(selection.anchor.getNode().getParent())).toBe(
            true,
          );
        }
      });
    });
  });

  describe('PASTE_COMMAND with URLs', () => {
    const pasteUrl = 'https://lexical.dev/';

    function dispatchPaste(editor: LexicalEditorWithDispose) {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', pasteUrl);
      clipboardData.setData('text/html', pasteUrl);
      const event = new ClipboardEvent('paste', {clipboardData});
      editor.dispatchCommand(PASTE_COMMAND, event);
    }

    it('does not convert pasted URL to link inside a code block', () => {
      const codeExtension = defineExtension({
        $initialEditorState: () => {
          const code = $createCodeNode();
          code.append($createCodeHighlightNode('const x = 5;'));
          $getRoot().append(code);
        },
        dependencies: [
          configExtension(LinkExtension, {validateUrl: () => true}),
          RichTextExtension,
          CodeExtension,
        ],
        name: '[root-code]',
      });
      using editor = buildEditorFromExtensions(codeExtension);
      editor.update(
        () => {
          const codeHighlight = $getRoot().getFirstDescendant()!;
          assert($isTextNode(codeHighlight), 'Expected a TextNode');
          codeHighlight.select(0, 5);
          dispatchPaste(editor);
        },
        {discrete: true},
      );
      editor.read(() => {
        const code = $getRoot().getFirstChild()!;
        assert($isCodeNode(code), 'Expected a CodeNode');
        expect(code.getChildren().some($isLinkNode)).toBe(false);
      });
    });

    it('wraps selected plain text in a link when a URL is pasted', () => {
      const pasteExtension = defineExtension({
        $initialEditorState: () => {
          const p = $createParagraphNode();
          p.append($createTextNode('click here'));
          $getRoot().append(p);
        },
        dependencies: [
          configExtension(LinkExtension, {validateUrl: () => true}),
          RichTextExtension,
        ],
        name: '[root-paste]',
      });
      using editor = buildEditorFromExtensions(pasteExtension);
      editor.update(
        () => {
          const text = $getRoot().getFirstDescendant()!;
          assert($isTextNode(text), 'Expected a TextNode');
          text.select(0, text.getTextContentSize());
          dispatchPaste(editor);
        },
        {discrete: true},
      );
      editor.read(() => {
        const p = $getRoot().getFirstChild()!;
        assert($isParagraphNode(p), 'Expected a ParagraphNode');
        const link = p.getFirstChild();
        assert($isLinkNode(link), 'Expected a LinkNode');
        expect(link.getURL()).toBe(pasteUrl);
        expect(link.getTextContent()).toBe('click here');
      });
    });
  });

  describe('TOGGLE_LINK_COMMAND with configured attributes', () => {
    const configuredExtension = defineExtension({
      $initialEditorState: () => {
        const p = $createParagraphNode();
        p.append($createTextNode('Hello'));
        $getRoot().append(p);
      },
      dependencies: [
        configExtension(LinkExtension, {
          attributes: {
            rel: 'noopener',
            target: '_blank',
            title: 'Configured title',
          },
        }),
        RichTextExtension,
      ],
      name: '[root-attributes]',
    });

    function $selectHello() {
      const textNode = $getRoot().getLastDescendant();
      assert($isTextNode(textNode), 'Expected a TextNode');
      textNode.select(0, textNode.getTextContentSize());
    }

    function $getLink() {
      const p = $getRoot().getFirstChild();
      assert($isParagraphNode(p), 'Expected a ParagraphNode');
      const link = p.getFirstChild();
      assert($isLinkNode(link), 'Expected a LinkNode');
      return link;
    }

    it('applies the configured attributes for a string payload', () => {
      using editor = buildEditorFromExtensions(configuredExtension);
      editor.update(
        () => {
          $selectHello();
          editor.dispatchCommand(TOGGLE_LINK_COMMAND, 'https://lexical.dev/');
        },
        {discrete: true},
      );
      editor.read(() => {
        const link = $getLink();
        expect(link.getRel()).toBe('noopener');
        expect(link.getTarget()).toBe('_blank');
        expect(link.getTitle()).toBe('Configured title');
      });
    });

    it('applies the configured attributes for an object payload', () => {
      using editor = buildEditorFromExtensions(configuredExtension);
      editor.update(
        () => {
          $selectHello();
          editor.dispatchCommand(TOGGLE_LINK_COMMAND, {
            url: 'https://lexical.dev/',
          });
        },
        {discrete: true},
      );
      editor.read(() => {
        const link = $getLink();
        expect(link.getRel()).toBe('noopener');
        expect(link.getTarget()).toBe('_blank');
        expect(link.getTitle()).toBe('Configured title');
      });
    });

    it('lets the object payload override the configured attributes', () => {
      using editor = buildEditorFromExtensions(configuredExtension);
      editor.update(
        () => {
          $selectHello();
          editor.dispatchCommand(TOGGLE_LINK_COMMAND, {
            target: null,
            url: 'https://lexical.dev/',
          });
        },
        {discrete: true},
      );
      editor.read(() => {
        const link = $getLink();
        expect(link.getRel()).toBe('noopener');
        expect(link.getTarget()).toBe(null);
        expect(link.getTitle()).toBe('Configured title');
      });
    });
  });
});
