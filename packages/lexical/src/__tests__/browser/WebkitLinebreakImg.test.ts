/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Characterization tests for the WebKit managed-linebreak img hack.
 *
 * On WebKit, when a block's last child is an *inline* DecoratorNode the
 * managed line break is rendered as an in-flow `<img>` followed by the usual
 * `<br>` (see `ElementDOMSlot.insertManagedLineBreak`'s `webkitHack`), giving
 * Safari an editable inline box between the `contenteditable=false` decorator
 * and the break. The user-visible symptom it fixes involves native Safari
 * caret behavior that headless Linux WebKit does not reproduce, so these
 * tests pin the *mechanism* — the DOM contract of
 * `setManagedLineBreak('decorator')` on each real engine — such that removing
 * or breaking the hack fails loudly instead of silently, as it otherwise
 * would (no other test exercises it).
 *
 * Running in browser mode means the real environment detection is live: the
 * webkit instance asserts the img+br shape and chromium / firefox assert the
 * plain-br shape, all from the same file.
 */

import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  DecoratorNode,
  IS_APPLE_WEBKIT,
  IS_IOS,
  IS_SAFARI,
  type ParagraphNode,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

// Matches the `webkitHack` gate in ElementDOMSlot.setManagedLineBreak.
const EXPECTS_IMG_HACK = IS_SAFARI || IS_IOS || IS_APPLE_WEBKIT;
const DECORATOR_LINEBREAK = EXPECTS_IMG_HACK ? ['img', 'br'] : ['br'];

class TestInlineDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_inline_decorator', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): false {
    return false;
  }
  isInline(): boolean {
    return true;
  }
  decorate(): null {
    return null;
  }
}

const ext = defineExtension({
  dependencies: [RichTextExtension],
  name: '[webkit-linebreak-img]',
  nodes: [TestInlineDecoratorNode],
});

function mountEditor() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const contentEditable = document.createElement('div');
  contentEditable.contentEditable = 'true';
  container.appendChild(contentEditable);

  const editor = buildEditorFromExtensions(ext);
  editor.setRootElement(contentEditable);

  onTestFinished(() => {
    editor.setRootElement(null);
    document.body.removeChild(container);
  });

  return {contentEditable, editor};
}

/** The managed-linebreak scaffold of the editor's blocks, as tag names. */
function linebreakScaffold(contentEditable: HTMLElement): string[] {
  return Array.from(
    contentEditable.querySelectorAll(
      'p [data-lexical-managed-linebreak="true"]',
    ),
    node => node.nodeName.toLowerCase(),
  );
}

describe('WebKit managed-linebreak img hack (inline decorator last child)', () => {
  test('a block ending with an inline decorator gets the engine-appropriate scaffold', () => {
    const {contentEditable, editor} = mountEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('text'),
              new TestInlineDecoratorNode(),
            ),
          );
      },
      {discrete: true},
    );

    // WebKit: an in-flow img gives Safari an editable inline box between the
    // contenteditable=false decorator and the break, and must precede the br
    // (the e2e selection utils rely on that order). Everywhere else: plain br.
    expect(linebreakScaffold(contentEditable)).toEqual(DECORATOR_LINEBREAK);
    const img = contentEditable.querySelector(
      'p img[data-lexical-managed-linebreak="true"]',
    ) as HTMLImageElement | null;
    if (EXPECTS_IMG_HACK) {
      // In-flow on purpose — unlike the absolute-positioned #8922 boundary
      // anchor, this one participates in the line box.
      expect(img).not.toBeNull();
      expect(img!.style.getPropertyValue('display')).toBe('inline');
      expect(img!.style.getPropertyValue('position')).toBe('');
    } else {
      expect(img).toBeNull();
    }
  });

  test('a block ending with a line break gets a plain br on every engine', () => {
    const {contentEditable, editor} = mountEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('text'),
              $createLineBreakNode(),
            ),
          );
      },
      {discrete: true},
    );

    // 'line-break' and 'empty' shapes never get the img — the hack is scoped
    // to the 'decorator' last-child kind. (The LineBreakNode's own <br> is a
    // keyed node, not managed scaffolding, so only the terminating <br>
    // carries the attribute.)
    expect(linebreakScaffold(contentEditable)).toEqual(['br']);
  });

  test('an empty block gets a plain br on every engine', () => {
    const {contentEditable, editor} = mountEditor();
    editor.update(
      () => {
        $getRoot().clear().append($createParagraphNode());
      },
      {discrete: true},
    );

    expect(linebreakScaffold(contentEditable)).toEqual(['br']);
  });

  test('the scaffold is dropped when the decorator stops being the last child', () => {
    const {contentEditable, editor} = mountEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('text'),
              new TestInlineDecoratorNode(),
            ),
          );
      },
      {discrete: true},
    );
    expect(linebreakScaffold(contentEditable)).toEqual(DECORATOR_LINEBREAK);

    editor.update(
      () => {
        $getRoot()
          .getFirstChildOrThrow<ParagraphNode>()
          .getLastChildOrThrow()
          .insertAfter($createTextNode('after'));
      },
      {discrete: true},
    );

    // Text now terminates the block: no managed line break at all.
    expect(linebreakScaffold(contentEditable)).toEqual([]);
  });

  test('the scaffold swaps to plain br when the decorator is replaced by a line break', () => {
    const {contentEditable, editor} = mountEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('text'),
              new TestInlineDecoratorNode(),
            ),
          );
      },
      {discrete: true},
    );
    expect(linebreakScaffold(contentEditable)).toEqual(DECORATOR_LINEBREAK);

    editor.update(
      () => {
        $getRoot()
          .getFirstChildOrThrow<ParagraphNode>()
          .getLastChildOrThrow()
          .replace($createLineBreakNode());
      },
      {discrete: true},
    );

    expect(linebreakScaffold(contentEditable)).toEqual(['br']);
  });
});
