/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// $toggleLink(url) inside an AutoLinkNode sets the autolink's URL in place
// and leaves it an AutoLinkNode, whose URL AutoLinkExtension re-derives from
// its text on the next transform of its text node: the URL the user set is
// lost (https://github.com/meta/lexical/issues/9821). It now makes the
// autolink a LinkNode with the same children.

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $createLinkNode,
  $isAutoLinkNode,
  $isLinkNode,
  $toggleLink,
  AutoLinkExtension,
  createLinkMatcherWithRegExp,
  LinkExtension,
  type LinkNode,
} from '@lexical/link';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isTextNode,
  $setSelection,
  configExtension,
  defineExtension,
} from 'lexical';
import {assert, describe, expect, test} from 'vitest';

const matcher = createLinkMatcherWithRegExp(
  /t\d+z/,
  text => `https://al.test/${text}`,
);

function buildEditor() {
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        LinkExtension,
        configExtension(AutoLinkExtension, {matchers: [matcher]}),
      ],
      name: 'toggle-link-on-autolink-host',
    }),
  );
}

function $link(): LinkNode {
  const paragraph = $getRoot().getFirstChild();
  assert($isElementNode(paragraph), 'expected a paragraph');
  const link = paragraph.getChildren().find($isLinkNode);
  assert(link !== undefined, 'expected a link');
  return link;
}

describe('$toggleLink inside an autolink', () => {
  test('keeps the URL it set after an edit of the text', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('see t30z now')),
          );
      },
      {discrete: true},
    );
    expect(editor.read(() => $isAutoLinkNode($link()))).toBe(true);
    editor.update(
      () => {
        const text = $link().getFirstChild();
        assert($isTextNode(text), 'expected a TextNode');
        text.select(0, 4);
        $toggleLink('https://u1.test');
      },
      {discrete: true},
    );
    expect(editor.read(() => $link().getURL())).toBe('https://u1.test');
    expect(editor.read(() => $isAutoLinkNode($link()))).toBe(false);
    expect(editor.read(() => $link().getTextContent())).toBe('t30z');
    // The next transform of the link's text (an edit; a load).
    editor.update(
      () => {
        $link().getFirstChildOrThrow().markDirty();
      },
      {discrete: true},
    );
    expect(editor.read(() => $link().getURL())).toBe('https://u1.test');
    // And AutoLink does not make an autolink of its text again.
    expect(
      editor.read(() =>
        $link()
          .getChildren()
          .every(n => $isTextNode(n)),
      ),
    ).toBe(true);
  });

  test('keeps the target and title of the autolink unless it sets them', () => {
    const withAttrs = createLinkMatcherWithRegExp(
      /t\d+z/,
      text => `https://al.test/${text}`,
    );
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          LinkExtension,
          configExtension(AutoLinkExtension, {
            matchers: [
              (text: string) => {
                const match = withAttrs(text);
                return match === null
                  ? null
                  : {...match, attributes: {target: '_blank', title: 'Match'}};
              },
            ],
          }),
        ],
        name: 'toggle-link-on-autolink-attrs-host',
      }),
    );
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('see t30z now')),
          );
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const text = $link().getFirstChild();
        assert($isTextNode(text), 'expected a TextNode');
        text.select(0, 4);
        $toggleLink('https://u1.test');
      },
      {discrete: true},
    );
    expect(
      editor.read(() => {
        const link = $link();
        return [link.getURL(), link.getTarget(), link.getTitle()];
      }),
    ).toEqual(['https://u1.test', '_blank', 'Match']);
    editor.update(
      () => {
        const text = $link().getFirstChild();
        assert($isTextNode(text), 'expected a TextNode');
        text.select(0, 4);
        $toggleLink('https://u2.test', {target: null, title: 'Mine'});
      },
      {discrete: true},
    );
    expect(
      editor.read(() => {
        const link = $link();
        return [link.getURL(), link.getTarget(), link.getTitle()];
      }),
    ).toEqual(['https://u2.test', null, 'Mine']);
  });

  test('with the autolink itself selected, keeps what it holds selected', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('see t30z now')),
          );
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const selection = $createNodeSelection();
        selection.add($link().getKey());
        $setSelection(selection);
        $toggleLink('https://u1.test');
      },
      {discrete: true},
    );
    expect(
      editor.read(() => {
        const link = $link();
        const selection = $getSelection();
        return [
          $isAutoLinkNode(link),
          link.getURL(),
          selection === null ? null : selection.getTextContent(),
        ];
      }),
    ).toEqual([false, 'https://u1.test', 't30z']);
  });

  test('with the autolink itself selected next to the same link, keeps its text selected', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              // The attributes $toggleLink gives, so the links merge.
              $createLinkNode('https://u1.test', {rel: 'noreferrer'}).append(
                $createTextNode('see '),
              ),
              $createTextNode('t30z now'),
            ),
          );
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChild();
        assert($isElementNode(paragraph), 'expected a paragraph');
        const auto = paragraph.getChildren().find($isAutoLinkNode);
        assert(auto !== undefined, 'expected an autolink');
        const selection = $createNodeSelection();
        selection.add(auto.getKey());
        $setSelection(selection);
        $toggleLink('https://u1.test');
      },
      {discrete: true},
    );
    expect(
      editor.read(() => {
        const paragraph = $getRoot().getFirstChild();
        assert($isElementNode(paragraph), 'expected a paragraph');
        const selection = $getSelection();
        return [
          paragraph.getChildren().filter($isLinkNode).length,
          paragraph.getTextContent(),
          selection === null ? null : selection.getTextContent(),
        ];
      }),
    ).toEqual([1, 'see t30z now', 't30z']);
  });
});
