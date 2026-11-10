/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {AriaLiveRegionExtension} from '@lexical/a11y';
import {
  buildEditorFromExtensions,
  defineExtension,
  getExtensionDependencyFromEditor,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $createAutoLinkNode,
  $createLinkNode,
  $isAutoLinkNode,
  $toggleLink,
  AutoLinkAnnounceExtension,
  AutoLinkExtension,
  autoLinkUrlMatcher,
} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  configExtension,
  type ElementNode,
  HISTORY_PUSH_TAG,
  UNDO_COMMAND,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {afterEach, describe, expect, onTestFinished, test} from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
});

function mountRoot(editor: LexicalEditorWithDispose): void {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  onTestFinished(() => root.remove());
}

function readLiveRegion(): string {
  // A repeat announcement gets a trailing zero-width space so the DOM registers
  // a change; strip it so assertions read naturally.
  return (
    document.body.querySelector('[aria-live]')!.textContent ?? ''
  ).replace(/\u200B/g, '');
}

function clearLiveRegion(): void {
  const region = document.body.querySelector('[aria-live]');
  if (region) {
    region.textContent = '';
  }
}

/**
 * Without matchers the transform unmakes the node it was just given, which is
 * a different scenario from typing an address.
 */
const withMatchers = configExtension(AutoLinkExtension, {
  matchers: [autoLinkUrlMatcher],
});

function buildEditor(): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension, withMatchers],
      name: '[root]',
    }),
  );
  mountRoot(editor);
  return editor;
}

/** Put a paragraph holding one automatic link into the document. */
function addAutoLink(
  editor: LexicalEditorWithDispose,
  url = 'https://example.com',
): void {
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      const link = $createAutoLinkNode(url);
      link.append($createTextNode(url));
      paragraph.append(link);
      $getRoot().append(paragraph);
    },
    {discrete: true},
  );
}

function $onlyLink(): ElementNode {
  return $assertNodeType(
    $assertNodeType($getRoot().getLastChild(), $isElementNode).getFirstChild(),
    $isElementNode,
  );
}

describe('AutoLinkAnnounceExtension', () => {
  test('announces a typed address becoming a link', () => {
    using editor = buildEditor();
    addAutoLink(editor);

    expect(readLiveRegion()).toBe('Link');
  });

  test('announces a link being removed', () => {
    using editor = buildEditor();
    addAutoLink(editor);
    clearLiveRegion();

    editor.update(() => void $onlyLink().remove(), {discrete: true});

    expect(readLiveRegion()).toBe('Link removed');
  });

  test('says how many links went when a selection takes several', () => {
    using editor = buildEditor();
    addAutoLink(editor, 'https://a.example');
    addAutoLink(editor, 'https://b.example');
    addAutoLink(editor, 'https://c.example');
    clearLiveRegion();

    editor.update(
      () => {
        for (const paragraph of $getRoot().getChildren()) {
          paragraph.remove();
        }
      },
      {discrete: true},
    );

    expect(readLiveRegion()).toBe('3 links removed');
  });

  test('says how many links arrived when several appear at once', () => {
    using editor = buildEditor();
    clearLiveRegion();

    // Two addresses on their own lines, arriving together as a paste would
    // bring them. Side by side in one paragraph they would run together into a
    // single address, which is a different thing entirely.
    editor.update(
      () => {
        for (const url of ['https://a.example', 'https://b.example']) {
          const paragraph = $createParagraphNode();
          const link = $createAutoLinkNode(url);
          link.append($createTextNode(url));
          paragraph.append(link);
          $getRoot().append(paragraph);
        }
      },
      {discrete: true},
    );

    expect(readLiveRegion()).toBe('2 links');
  });

  test('stays silent when a link is rebuilt in place', () => {
    using editor = buildEditor();
    addAutoLink(editor);
    clearLiveRegion();

    // What every keystroke does while an address is still being typed: the old
    // node is destroyed and a new one created in the same update. The link was
    // already there, so there is nothing to report.
    editor.update(
      () => {
        const replacement = $createAutoLinkNode('https://example.com/deeper');
        replacement.append($createTextNode('https://example.com/deeper'));
        $onlyLink().replace(replacement);
      },
      {discrete: true},
    );

    expect(readLiveRegion()).toBe('');
  });

  test('stays silent when $toggleLink makes the link a link of its own', () => {
    using editor = buildEditor();
    addAutoLink(editor);
    clearLiveRegion();

    // Setting a URL on an automatic link replaces it with a regular link
    // holding the same text: the text is still a link.
    editor.update(
      () => {
        $assertNodeType($onlyLink().getFirstChild(), $isTextNode).select(0, 5);
        $toggleLink('https://u1.test');
      },
      {discrete: true},
    );

    expect(editor.read(() => $isAutoLinkNode($onlyLink()))).toBe(false);
    expect(readLiveRegion()).toBe('');
  });

  test('stays silent when the link $toggleLink makes merges into its neighbour', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const url = 'https://example.com';
        $getRoot().append(
          $createParagraphNode().append(
            // The attributes $toggleLink gives, so the links merge.
            $createLinkNode('https://u1.test', {rel: 'noreferrer'}).append(
              $createTextNode('see '),
            ),
            $createAutoLinkNode(url).append($createTextNode(url)),
          ),
        );
      },
      {discrete: true},
    );
    clearLiveRegion();

    editor.update(
      () => {
        const paragraph = $assertNodeType(
          $getRoot().getLastChild(),
          $isElementNode,
        );
        const auto = $assertNodeType(paragraph.getLastChild(), $isAutoLinkNode);
        $assertNodeType(auto.getFirstChild(), $isTextNode).select(0, 5);
        $toggleLink('https://u1.test');
      },
      {discrete: true},
    );

    expect(
      editor.read(() =>
        $assertNodeType($getRoot().getLastChild(), $isElementNode)
          .getChildren()
          .map(n => n.getType()),
      ),
    ).toEqual(['link']);
    expect(readLiveRegion()).toBe('');
  });

  test('counts only the links removed when $toggleLink makes another a link', () => {
    using editor = buildEditor();
    addAutoLink(editor, 'https://a.example');
    addAutoLink(editor, 'https://b.example');
    addAutoLink(editor, 'https://c.example');
    clearLiveRegion();

    editor.update(
      () => {
        const links = $getRoot()
          .getChildren()
          .map(paragraph =>
            $assertNodeType(paragraph, $isElementNode).getFirstChild(),
          )
          .filter($isAutoLinkNode);
        const [link, ...rest] = links;
        for (const other of rest) {
          other.getParentOrThrow().remove();
        }
        $assertNodeType(link.getFirstChild(), $isTextNode).select(0, 5);
        $toggleLink('https://u1.test');
      },
      {discrete: true},
    );

    expect(readLiveRegion()).toBe('2 links removed');
  });

  test('still announces a link removed after its text moved into another link', () => {
    using editor = buildEditor();
    addAutoLink(editor);
    clearLiveRegion();

    editor.update(
      () => {
        const link = $onlyLink();
        const manual = $createLinkNode('https://u1.test');
        link.insertBefore(manual);
        manual.append(...link.getChildren());
        link.remove();
      },
      {discrete: true},
    );

    expect(readLiveRegion()).toBe('Link removed');
  });

  test('announces a link removed after an undo of $toggleLink brought it back', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RichTextExtension, withMatchers, HistoryExtension],
        name: '[root]',
      }),
    );
    mountRoot(editor);
    editor.update(
      () => {
        const url = 'https://example.com';
        $getRoot().append(
          $createParagraphNode().append(
            $createAutoLinkNode(url).append($createTextNode(url)),
          ),
        );
      },
      {discrete: true, tag: HISTORY_PUSH_TAG},
    );
    editor.update(
      () => {
        $assertNodeType($onlyLink().getFirstChild(), $isTextNode).select(0, 5);
        $toggleLink('https://u1.test');
      },
      {discrete: true, tag: HISTORY_PUSH_TAG},
    );
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(editor.read(() => $isAutoLinkNode($onlyLink()))).toBe(true);
    clearLiveRegion();

    editor.update(() => void $onlyLink().remove(), {
      discrete: true,
      tag: HISTORY_PUSH_TAG,
    });

    expect(readLiveRegion()).toBe('Link removed');
  });

  test('announces a link removed after an update that made it a link threw', () => {
    using editor = buildEditor();
    addAutoLink(editor);
    clearLiveRegion();

    expect(() =>
      editor.update(
        () => {
          $assertNodeType($onlyLink().getFirstChild(), $isTextNode).select(
            0,
            5,
          );
          $toggleLink('https://u1.test');
          throw new Error('discarded');
        },
        {discrete: true},
      ),
    ).toThrow('discarded');
    expect(editor.read(() => $isAutoLinkNode($onlyLink()))).toBe(true);

    editor.update(() => void $onlyLink().remove(), {discrete: true});

    expect(readLiveRegion()).toBe('Link removed');
  });

  test('stays silent while typing inside a link', () => {
    using editor = buildEditor();
    addAutoLink(editor);
    clearLiveRegion();

    editor.update(() => void $onlyLink().append($createTextNode('/more')), {
      discrete: true,
    });

    expect(readLiveRegion()).toBe('');
  });

  test('honours a configured message', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          withMatchers,
          configExtension(AutoLinkAnnounceExtension, {created: 'Linked'}),
        ],
        name: '[root]',
      }),
    );
    mountRoot(editor);

    addAutoLink(editor);
    expect(readLiveRegion()).toBe('Linked');
  });

  test('says nothing when disabled', () => {
    using editor = buildEditor();
    const {disabled} = getExtensionDependencyFromEditor(
      editor,
      AutoLinkAnnounceExtension,
    ).output;

    disabled.value = true;
    addAutoLink(editor);
    expect(readLiveRegion()).toBe('');

    disabled.value = false;
    addAutoLink(editor, 'https://second.example');
    expect(readLiveRegion()).toBe('Link');
  });

  test('leaves an editor without automatic links alone', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [AriaLiveRegionExtension, RichTextExtension],
        name: '[root]',
      }),
    );
    mountRoot(editor);

    editor.update(() => void $getRoot().append($createParagraphNode()), {
      discrete: true,
    });

    expect(readLiveRegion()).toBe('');
  });
});
