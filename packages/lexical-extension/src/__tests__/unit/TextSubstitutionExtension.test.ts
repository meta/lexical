/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {$createCodeNode, CodeExtension} from '@lexical/code';
import {
  buildEditorFromExtensions,
  configExtension,
  TextSubstitutionExtension,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  defineExtension,
  DELETE_CHARACTER_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, test} from 'vitest';

function setUpEditor(
  options: {
    substitutions?: Readonly<Record<string, string>>;
    withHistory?: boolean;
  } = {},
) {
  const {substitutions, withHistory = false} = options;
  return buildEditorFromExtensions(
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

  test('Backspace immediately after a substitution restores the alias', async () => {
    using editor = setUpEditor();
    await typeText(editor, 'hello--');
    expect(getText(editor)).toBe('hello—');
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    expect(getText(editor)).toBe('hello--');
  });

  test('Backspace after another edit does not revert the substitution', async () => {
    using editor = setUpEditor();
    await typeText(editor, 'hello--');
    await typeText(editor, 'x');
    expect(getText(editor)).toBe('hello—x');
    // In a headless editor there is no default delete handler, so the
    // assertion here is the property this extension owns: Backspace must
    // NOT restore the alias once another edit has intervened.
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    expect(getText(editor)).toBe('hello—x');
  });
});
