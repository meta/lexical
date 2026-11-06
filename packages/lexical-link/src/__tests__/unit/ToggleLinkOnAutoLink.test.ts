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
// lost (https://github.com/meta/lexical/issues/9821).

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $isAutoLinkNode,
  $isLinkNode,
  $toggleLink,
  AutoLinkExtension,
  createLinkMatcherWithRegExp,
  LinkExtension,
  type LinkNode,
} from '@lexical/link';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
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
  test.fails('keeps the URL it set after an edit of the text', () => {
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
    // The next transform of the link's text (an edit; a load).
    editor.update(
      () => {
        $link().getFirstChildOrThrow().markDirty();
      },
      {discrete: true},
    );
    expect(editor.read(() => $link().getURL())).toBe('https://u1.test');
  });
});
