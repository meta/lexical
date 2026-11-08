/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {AriaLiveRegionExtension, HistoryAnnounceExtension} from '@lexical/a11y';
import {
  buildEditorFromExtensions,
  defineExtension,
  getExtensionDependencyFromEditor,
  getPeerDependencyFromEditor,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {PlainTextExtension} from '@lexical/plain-text';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isQuoteNode,
  HeadingAnnounceExtension,
  QuoteAnnounceExtension,
  RichTextExtension,
} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  configExtension,
  REDO_COMMAND,
  UNDO_COMMAND,
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

function buildEditor(): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [RichTextExtension],
      name: '[root]',
    }),
  );
  mountRoot(editor);
  return editor;
}

/** Append a quote holding one line of text, and put the caret inside it. */
function addQuote(editor: LexicalEditorWithDispose, text = 'quoted'): void {
  editor.update(
    () => {
      const quote = $createQuoteNode();
      const paragraphText = $createTextNode(text);
      quote.append(paragraphText);
      $getRoot().append(quote);
      paragraphText.selectEnd();
    },
    {discrete: true},
  );
}

describe('QuoteAnnounceExtension', () => {
  test('announces a block becoming a quote', () => {
    using editor = buildEditor();
    addQuote(editor);

    expect(readLiveRegion()).toBe('Block quote');
  });

  test('announces a quote being removed', () => {
    using editor = buildEditor();
    addQuote(editor);
    clearLiveRegion();

    editor.update(() => void $getRoot().getLastChild()?.remove(), {
      discrete: true,
    });

    expect(readLiveRegion()).toBe('Block quote removed');
  });

  test('stays silent when a quote is created away from the caret', () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('here'));
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      {discrete: true},
    );
    clearLiveRegion();

    // A quote added at the end of the document while the caret stays put.
    // Another person's edit, or a paste that did not land in the quote.
    editor.update(
      () => {
        const quote = $createQuoteNode();
        quote.append($createTextNode('elsewhere'));
        $getRoot().append(quote);
      },
      {discrete: true},
    );

    expect(readLiveRegion()).toBe('');
  });

  test('stays silent when a quote is removed away from the caret', () => {
    using editor = buildEditor();
    addQuote(editor, 'elsewhere');
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('here'));
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      {discrete: true},
    );
    clearLiveRegion();

    editor.update(() => void $getRoot().getFirstChild()?.remove(), {
      discrete: true,
    });

    expect(readLiveRegion()).toBe('');
  });

  test('stays silent while typing inside a quote', () => {
    using editor = buildEditor();
    addQuote(editor);
    clearLiveRegion();

    editor.update(
      () => {
        const quote = $getRoot().getLastChild();
        if (quote !== null && 'append' in quote) {
          (quote as ReturnType<typeof $createQuoteNode>).append(
            $createTextNode(' more'),
          );
        }
      },
      {discrete: true},
    );

    expect(readLiveRegion()).toBe('');
  });

  test('announces leaving when the block after the quote is new', () => {
    using editor = buildEditor();
    addQuote(editor);
    clearLiveRegion();

    // What pressing Enter at the end of a quote does: the paragraph the caret
    // lands in is made by the same update that moves the caret.
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      {discrete: true},
    );

    expect(readLiveRegion()).toBe('Exiting block quote');
  });

  test('stays silent when the caret only moves across the edge', () => {
    using editor = buildEditor();
    addQuote(editor);
    editor.update(() => void $getRoot().append($createParagraphNode()), {
      discrete: true,
    });
    clearLiveRegion();

    // What the arrow keys do: both blocks are already there, so the screen
    // reader reports the boundary itself.
    editor.update(() => void $getRoot().getLastChild()?.selectEnd(), {
      discrete: true,
    });
    expect(readLiveRegion()).toBe('');

    editor.update(() => void $getRoot().getFirstChild()?.selectEnd(), {
      discrete: true,
    });
    expect(readLiveRegion()).toBe('');
  });

  test('announces entering when the block the caret came from goes away', () => {
    using editor = buildEditor();
    addQuote(editor);
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      {discrete: true},
    );
    clearLiveRegion();

    // What backspacing at the start of that paragraph does.
    editor.update(
      () => {
        const root = $getRoot();
        root.getLastChild()?.remove();
        root.getLastChild()?.selectEnd();
      },
      {discrete: true},
    );

    expect(readLiveRegion()).toBe('Block quote');
  });

  test('says both the removal and where the caret landed', () => {
    using editor = buildEditor();
    addQuote(editor, 'first');
    addQuote(editor, 'second');
    clearLiveRegion();

    // Backspacing out of the lower of two quotes. A quote went away, and the
    // caret is now inside the one above — the user needs to be told both.
    editor.update(
      () => {
        const root = $getRoot();
        root.getLastChild()?.remove();
        root.getLastChild()?.selectEnd();
      },
      {discrete: true},
    );

    expect(readLiveRegion()).toBe('Block quote removed, in block quote');
  });

  test('lets the new block speak when a quote becomes another block type', async () => {
    using editor = buildEditor();
    addQuote(editor);
    clearLiveRegion();

    const region = document.body.querySelector('[aria-live]')!;
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      seen.push((region.textContent ?? '').replace(/\u200B/g, ''));
    });
    observer.observe(region, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    editor.update(
      () => $setBlocksType($getSelection(), () => $createHeadingNode('h2')),
      {discrete: true},
    );
    await Promise.resolve();
    observer.disconnect();

    // Where the caret landed first, then the quote that was removed. The
    // heading announcer writes "Heading level 2" first and this extension
    // replaces it in the same task, so only the combined line is left.
    expect({final: readLiveRegion(), seen}).toEqual({
      final: 'Heading level 2, block quote removed',
      seen: ['Heading level 2, block quote removed'],
    });
  });

  test('lets the quote speak when a heading becomes a quote', async () => {
    using editor = buildEditor();
    editor.update(
      () => {
        const heading = $createHeadingNode('h2');
        const text = $createTextNode('title');
        heading.append(text);
        $getRoot().append(heading);
        text.selectEnd();
      },
      {discrete: true},
    );
    clearLiveRegion();

    const region = document.body.querySelector('[aria-live]')!;
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      seen.push((region.textContent ?? '').replace(/\u200B/g, ''));
    });
    observer.observe(region, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    editor.update(
      () => $setBlocksType($getSelection(), () => $createQuoteNode()),
      {discrete: true},
    );
    await Promise.resolve();
    observer.disconnect();

    // Where the caret landed first, then the heading that was removed.
    // The heading removal is not written on its own.
    expect({final: readLiveRegion(), seen}).toEqual({
      final: 'Block quote, heading level 2 removed',
      seen: ['Block quote, heading level 2 removed'],
    });
  });

  test('still reports removal when a quote becomes a plain paragraph', () => {
    using editor = buildEditor();
    addQuote(editor);
    clearLiveRegion();

    editor.update(
      () => $setBlocksType($getSelection(), () => $createParagraphNode()),
      {discrete: true},
    );

    // Nothing announces a paragraph, so this is the only report there is.
    expect(readLiveRegion()).toBe('Block quote removed');
  });

  test('still reports removal when the heading announcer is off', () => {
    using editor = buildEditor();
    getExtensionDependencyFromEditor(
      editor,
      HeadingAnnounceExtension,
    ).output.disabled.value = true;
    addQuote(editor);
    clearLiveRegion();

    editor.update(
      () => $setBlocksType($getSelection(), () => $createHeadingNode('h2')),
      {discrete: true},
    );

    // Nothing else speaks for the new block, so the removal does.
    expect(readLiveRegion()).toBe('Block quote removed');
  });

  test('does not throw when the caret is in a text node directly under a shadow root', () => {
    using editor = buildEditor();
    const updates: string[] = [];
    editor.registerUpdateListener(() => void updates.push('later listener'));

    // Without the transforms that would wrap it, the text node sits straight
    // under the quote, which is a shadow root. getTopLevelElement() throws
    // for that state.
    editor.update(
      () => {
        const quote = $createQuoteNode({shadowRoot: true});
        const text = $createTextNode('inside');
        quote.append(text);
        $getRoot().clear().append(quote);
        text.select();
      },
      {discrete: true, skipTransforms: true},
    );

    expect(updates).toEqual(['later listener']);
  });

  test('says what undo and redo actually changed', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          HistoryExtension,
          HistoryAnnounceExtension,
        ],
        name: '[root]',
      }),
    );
    mountRoot(editor);
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        const text = $createTextNode('text');
        paragraph.append(text);
        $getRoot().append(paragraph);
        text.selectEnd();
      },
      {discrete: true},
    );
    editor.update(
      () => $setBlocksType($getSelection(), () => $createQuoteNode()),
      {discrete: true},
    );
    const quoteCount = () =>
      editor.read(() => $getRoot().getChildren().filter($isQuoteNode).length);
    expect(quoteCount()).toBe(1);

    // "Undone" alone does not say what was undone. The merged heading
    // announcer already reports the change itself rather than the fact of an
    // undo, so quotes match it.
    clearLiveRegion();
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    expect(quoteCount()).toBe(0);
    expect(readLiveRegion()).toBe('Block quote removed');

    clearLiveRegion();
    editor.dispatchCommand(REDO_COMMAND, undefined);
    expect(quoteCount()).toBe(1);
    expect(readLiveRegion()).toBe('Block quote');
  });

  test('honours a configured message', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          configExtension(QuoteAnnounceExtension, {
            created: 'Quote',
          }),
        ],
        name: '[root]',
      }),
    );
    mountRoot(editor);

    addQuote(editor);
    expect(readLiveRegion()).toBe('Quote');
  });

  test('says nothing when disabled', () => {
    using editor = buildEditor();
    const {disabled} = getExtensionDependencyFromEditor(
      editor,
      QuoteAnnounceExtension,
    ).output;

    disabled.value = true;
    addQuote(editor);
    expect(readLiveRegion()).toBe('');

    disabled.value = false;
    addQuote(editor, 'second');
    expect(readLiveRegion()).toBe('Block quote');
  });

  test('leaves a plain text editor alone', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [AriaLiveRegionExtension, PlainTextExtension],
        name: '[root]',
      }),
    );
    mountRoot(editor);

    editor.update(() => void $getRoot().append($createParagraphNode()), {
      discrete: true,
    });

    // Plain text must not pull the quote announcer in. Its dependencies
    // register heading nodes, which a plain text editor does not have.
    expect(
      getPeerDependencyFromEditor(editor, QuoteAnnounceExtension.name),
    ).toBeUndefined();
    expect(readLiveRegion()).toBe('');
  });
});
