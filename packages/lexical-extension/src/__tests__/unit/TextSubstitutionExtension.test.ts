/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode, CodeExtension} from '@lexical/code';
import {
  buildEditorFromExtensions,
  configExtension,
  TextSubstitutionExtension,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  defineExtension,
  DELETE_CHARACTER_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// RichTextExtension's delete handler needs a mounted root element (a
// headless editor has no window), and jsdom's Selection has no modify()
// method, which Lexical uses to measure a character boundary — without
// it a plain Backspace is a deliberate no-op. Polyfill modify() for the
// single-text-node case used by these tests, so the RichText delete path
// actually runs here instead of silently doing nothing.
const SelectionCtor = (globalThis as unknown as {Selection?: typeof Selection})
  .Selection;
if (
  SelectionCtor !== undefined &&
  typeof SelectionCtor.prototype.modify !== 'function'
) {
  SelectionCtor.prototype.modify = function (
    this: Selection,
    alter: string,
    direction: string,
    granularity: string,
  ) {
    if (granularity !== 'character' || this.rangeCount === 0) {
      return;
    }
    const range = this.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== 3) {
      return;
    }
    const text = node.textContent ?? '';
    const offset =
      direction === 'backward'
        ? Math.max(0, range.startOffset - 1)
        : Math.min(text.length, range.startOffset + 1);
    if (alter === 'move') {
      this.setBaseAndExtent(node, offset, node, offset);
    } else if (alter === 'extend') {
      this.extend(node, offset);
    }
  } as Selection['modify'];
}

function setUpEditor(
  options: {
    substitutions?: Readonly<Record<string, string>>;
    withHistory?: boolean;
    withRichText?: boolean;
  } = {},
) {
  const {substitutions, withHistory = false, withRichText = false} = options;
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      dependencies: [
        ...(substitutions !== undefined
          ? [configExtension(TextSubstitutionExtension, {substitutions})]
          : [TextSubstitutionExtension]),
        ...(withRichText ? [RichTextExtension] : []),
        ...(withHistory
          ? [
              configExtension(HistoryExtension, {
                delay: 1000,
                disabled: false,
                now: () => 0,
              }),
            ]
          : []),
      ],
      name: 'text-substitution-test',
    }),
  );
  if (withRichText) {
    // RichText's delete handler reads the DOM selection, which needs
    // a mounted root element (a headless editor has no window).
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    editor.setRootElement(root);
  }
  return editor;
}

function $type(text: string): void {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) {
    selection.insertText(text);
  }
}

async function typeText(
  editor: ReturnType<typeof setUpEditor>,
  text: string,
): Promise<void> {
  for (const char of text) {
    editor.update(() => $type(char), {discrete: true});
    // The substitution runs in a follow-up update triggered by the
    // update listener; let it commit before the next character.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  await new Promise(resolve => setTimeout(resolve, 0));
}

function getText(editor: ReturnType<typeof setUpEditor>): string {
  return editor.read(() => $getRoot().getTextContent());
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

function moveCaret(
  editor: ReturnType<typeof setUpEditor>,
  offset: number,
): void {
  editor.update(
    () => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        const node = selection.anchor.getNode();
        if ($isTextNode(node)) {
          node.select(offset, offset);
        }
      }
    },
    {discrete: true},
  );
}

function setTextAndCaret(
  editor: ReturnType<typeof setUpEditor>,
  text: string,
  offset: number,
): void {
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
      const node = $createTextNode(text);
      paragraph.append(node);
      node.select(offset, offset);
    },
    {discrete: true},
  );
}

describe('TextSubstitutionExtension', () => {
  test('replaces a default substitution as its final character is typed', async () => {
    using editor = setUpEditor();
    await typeText(editor, 'hello--');
    expect(getText(editor)).toBe('hello—');
  });

  test('replaces parenthesised defaults', async () => {
    using editor = setUpEditor();
    await typeText(editor, '(c)');
    expect(getText(editor)).toBe('©');
  });

  test('applies a custom substitution and lets it override a default', async () => {
    using editor = setUpEditor({
      substitutions: {'(c)': 'CUSTOM', omw: 'on my way!'},
    });
    await typeText(editor, '(c)');
    expect(getText(editor)).toBe('CUSTOM');
    using editor2 = setUpEditor({
      substitutions: {omw: 'on my way!'},
    });
    await typeText(editor2, 'omw');
    expect(getText(editor2)).toBe('on my way!');
  });

  test('longest alias wins for overlapping aliases', async () => {
    using editor = setUpEditor();
    await typeText(editor, '-->');
    expect(getText(editor)).toBe('→');
  });

  test('does not substitute when typing in the middle of a word', async () => {
    using editor = setUpEditor();
    setTextAndCaret(editor, 'helloworld', 5);
    await typeText(editor, '--');
    expect(getText(editor)).toBe('hello--world');
  });

  test('does not substitute inside a code block', async () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          const paragraph = $createParagraphNode();
          $getRoot().append(paragraph);
          paragraph.selectEnd();
        },
        dependencies: [TextSubstitutionExtension, CodeExtension],
        name: 'text-substitution-code-test',
      }),
    );
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        paragraph.remove();
        const code = $createCodeNode();
        $getRoot().append(code);
        code.append($createTextNode('x'));
        code.selectEnd();
      },
      {discrete: true},
    );
    await typeText(editor, '--');
    expect(getText(editor)).toBe('x--');
  });

  test('a single undo reverts the substitution, restoring the alias', async () => {
    using editor = setUpEditor({withHistory: true});
    await typeText(editor, 'hello--');
    expect(getText(editor)).toBe('hello—');
    editor.dispatchCommand(UNDO_COMMAND);
    expect(getText(editor)).toBe('hello--');
  });

  test('a single undo after a chained substitution restores the full alias', async () => {
    using editor = setUpEditor({withHistory: true});
    await typeText(editor, 'hello-->');
    expect(getText(editor)).toBe('hello→');
    // The chained rewrite is split across a merge-tagged update and
    // its onUpdate; let both commit before undoing.
    await tick();
    await tick();
    editor.dispatchCommand(UNDO_COMMAND);
    expect(getText(editor)).toBe('hello-->');
    editor.dispatchCommand(UNDO_COMMAND);
    expect(getText(editor)).toBe('hello—');
  });

  test('a single undo after a chained <-- substitution restores the full alias', async () => {
    using editor = setUpEditor({withHistory: true});
    await typeText(editor, 'hello<--');
    expect(getText(editor)).toBe('hello←');
    await tick();
    await tick();
    editor.dispatchCommand(UNDO_COMMAND);
    expect(getText(editor)).toBe('hello<--');
  });

  test('Backspace immediately after a substitution restores the alias (RichText)', async () => {
    using editor = setUpEditor({withRichText: true});
    await typeText(editor, 'hello--');
    expect(getText(editor)).toBe('hello—');
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    // Await the follow-up update before asserting: the old test read
    // the text before the queued revert committed, which hid the bug
    // where RichText deleted the replacement instead.
    await tick();
    expect(getText(editor)).toBe('hello--');
    // The record is consumed, so a second Backspace is a plain delete.
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    await tick();
    expect(getText(editor)).toBe('hello-');
  });

  test('Backspace immediately after a (c) substitution restores the alias (RichText)', async () => {
    using editor = setUpEditor({withRichText: true});
    await typeText(editor, '(c)');
    expect(getText(editor)).toBe('©');
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    await tick();
    expect(getText(editor)).toBe('(c)');
  });

  test('Backspace after a chained substitution restores the full alias and does not re-substitute', async () => {
    using editor = setUpEditor({withRichText: true});
    await typeText(editor, 'hello-->');
    expect(getText(editor)).toBe('hello→');
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    await tick();
    expect(getText(editor)).toBe('hello-->');
  });

  test('a custom substitution whose replacement ends with its alias does not loop', async () => {
    using editor = setUpEditor({
      substitutions: {':)': '::)'},
      withRichText: true,
    });
    await typeText(editor, ':)');
    expect(getText(editor)).toBe('::)');
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    await tick();
    expect(getText(editor)).toBe(':)');
  });

  test('Backspace after another edit does not revert the substitution (RichText)', async () => {
    using editor = setUpEditor({withRichText: true});
    await typeText(editor, 'hello--');
    await typeText(editor, 'x');
    expect(getText(editor)).toBe('hello—x');
    // The intervening edit clears the record, so RichText's delete
    // handler removes the 'x' instead of restoring '--'.
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    await tick();
    expect(getText(editor)).toBe('hello—');
  });

  test('Backspace after moving the caret away and back does not restore the alias', async () => {
    using editor = setUpEditor({withRichText: true});
    await typeText(editor, 'hello--');
    expect(getText(editor)).toBe('hello—');
    moveCaret(editor, 5);
    await tick();
    moveCaret(editor, 6);
    await tick();
    // The caret moves clear the record, so Backspace deletes the '—'
    // instead of restoring '--'.
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    await tick();
    expect(getText(editor)).toBe('hello');
  });
});
