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
import {
  $createAutoLinkNode,
  AutoLinkAnnounceExtension,
  AutoLinkExtension,
  autoLinkUrlMatcher,
} from '@lexical/link';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
  type ElementNode,
} from 'lexical';
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
  return $getRoot().getLastChild<ElementNode>()!.getFirstChild<ElementNode>()!;
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
        for (const paragraph of $getRoot().getChildren<ElementNode>()) {
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
