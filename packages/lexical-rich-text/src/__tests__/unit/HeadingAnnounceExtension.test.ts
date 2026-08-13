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
import {PlainTextExtension} from '@lexical/plain-text';
import {
  $createHeadingNode,
  HeadingAnnounceExtension,
  type HeadingTagType,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  configExtension,
} from 'lexical';
import {afterEach, describe, expect, onTestFinished, test} from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
});

// The live region follows the editor's root document, so a mounted root is
// required for it to exist.
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

/**
 * Append a heading, as typing the markdown shortcut on a fresh block does.
 *
 * Deliberately appends rather than replacing the root: clearing would destroy
 * the previous heading in the same update, which is block-type conversion - a
 * different scenario from the one under test.
 */
function addHeading(
  editor: LexicalEditorWithDispose,
  tag: HeadingTagType,
  text = 'Title',
): void {
  editor.update(
    () => {
      const heading = $createHeadingNode(tag);
      heading.append($createTextNode(text));
      $getRoot().append(heading);
    },
    {discrete: true},
  );
}

/** Remove the last block, as backspacing a heading away does. */
function removeLastBlock(editor: LexicalEditorWithDispose): void {
  editor.update(() => void $getRoot().getLastChild()?.remove(), {
    discrete: true,
  });
}

describe('HeadingAnnounceExtension', () => {
  test('announces every heading level as it is created', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RichTextExtension],
        name: '[root]',
      }),
    );
    mountRoot(editor);

    const levels: HeadingTagType[] = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
    for (const tag of levels) {
      addHeading(editor, tag);
      expect(readLiveRegion()).toBe(`Heading level ${tag.slice(1)}`);
    }
  });

  test('announces the level a heading had when it is removed', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RichTextExtension],
        name: '[root]',
      }),
    );
    mountRoot(editor);

    addHeading(editor, 'h2');
    expect(readLiveRegion()).toBe('Heading level 2');

    removeLastBlock(editor);
    expect(readLiveRegion()).toBe('Heading level 2 removed');
  });

  test('stays silent while editing inside a heading', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RichTextExtension],
        name: '[root]',
      }),
    );
    mountRoot(editor);

    addHeading(editor, 'h3', 'Before');
    expect(readLiveRegion()).toBe('Heading level 3');

    // Announcing on every keystroke would make a heading impossible to type
    // into, so text changes within a surviving heading must not announce.
    document.body.querySelector('[aria-live]')!.textContent = '';
    editor.update(
      () => {
        const heading = $getRoot().getFirstChild()!;
        heading.selectEnd().insertText(' and after');
      },
      {discrete: true},
    );
    expect(readLiveRegion()).toBe('');
  });

  test('announces the new level when a heading changes level', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RichTextExtension],
        name: '[root]',
      }),
    );
    mountRoot(editor);

    // Typing '## ' straight after '# ' swaps the block's level: one node is
    // destroyed and another created in the same update. The useful thing to
    // hear is the level you are now in.
    editor.update(
      () => {
        $getRoot().clear().append($createHeadingNode('h1'));
      },
      {discrete: true},
    );
    expect(readLiveRegion()).toBe('Heading level 1');

    editor.update(
      () => {
        $getRoot().clear().append($createHeadingNode('h2'));
      },
      {discrete: true},
    );
    expect(readLiveRegion()).toBe('Heading level 2');
  });

  test('respects message overrides from configExtension', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          configExtension(HeadingAnnounceExtension, {
            created: 'Now an H%s',
            destroyed: 'H%s gone',
          }),
          RichTextExtension,
        ],
        name: '[root]',
      }),
    );
    mountRoot(editor);

    addHeading(editor, 'h4');
    expect(readLiveRegion()).toBe('Now an H4');

    removeLastBlock(editor);
    expect(readLiveRegion()).toBe('H4 gone');
  });

  test('reflects message signal changes at runtime', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RichTextExtension],
        name: '[root]',
      }),
    );
    mountRoot(editor);

    const {created} = getExtensionDependencyFromEditor(
      editor,
      HeadingAnnounceExtension,
    ).output;
    created.value = 'Section, depth %s';

    addHeading(editor, 'h2');
    expect(readLiveRegion()).toBe('Section, depth 2');
  });

  test('does not announce while disabled, and resumes when re-enabled', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [RichTextExtension],
        name: '[root]',
      }),
    );
    mountRoot(editor);

    const {disabled} = getExtensionDependencyFromEditor(
      editor,
      HeadingAnnounceExtension,
    ).output;

    disabled.value = true;
    addHeading(editor, 'h1');
    expect(readLiveRegion()).toBe('');

    disabled.value = false;
    addHeading(editor, 'h2');
    expect(readLiveRegion()).toBe('Heading level 2');
  });

  test('leaves a plain text editor alone', () => {
    // The announcer ships with rich text, so a plain text editor never gets
    // it. Guards the dependency direction: @lexical/a11y must stay usable
    // without @lexical/rich-text, or an editor built for plain text refuses
    // to build - "extension @lexical/plain-text conflicts with
    // @lexical/rich-text".
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [AriaLiveRegionExtension, PlainTextExtension],
        name: '[root]',
      }),
    );
    mountRoot(editor);

    // There are no headings to watch for, so there is nothing to say.
    editor.update(() => void $getRoot().append($createParagraphNode()), {
      discrete: true,
    });

    expect(readLiveRegion()).toBe('');
  });
});
