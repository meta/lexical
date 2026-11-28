/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$createCodeNode, CodeExtension, CodeNode} from '@lexical/code';
import {
  buildEditorFromExtensions,
  configExtension,
  DEFAULT_TEXT_SUBSTITUTIONS,
  getExtensionDependencyFromEditor,
  TextSubstitutionExtension,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
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
// method, which Lexical uses to measure a character boundary – without
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
    substitutions?: Readonly<Record<string, string | null>>;
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
    // '--' is a prefix of '-->', so it is held back one keystroke;
    // the following space confirms it stands on its own.
    await typeText(editor, 'hello-- ');
    expect(getText(editor)).toBe('hello– ');
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
    // A word alias is held back until the next character confirms a
    // word boundary, so a trailing space is typed here.
    await typeText(editor2, 'omw ');
    expect(getText(editor2)).toBe('on my way! ');
  });

  test('longest alias wins for overlapping aliases', async () => {
    using editor = setUpEditor();
    await typeText(editor, '-->');
    expect(getText(editor)).toBe('→');
  });

  test('substitutes in the middle of a word', async () => {
    using editor = setUpEditor();
    setTextAndCaret(editor, 'helloworld', 5);
    // '--' is held back one keystroke; the following space confirms
    // it stands on its own, so it substitutes in the middle of the
    // node.
    await typeText(editor, '-- ');
    expect(getText(editor)).toBe('hello– world');
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

  test('does not substitute inside a code block subclass with its own type', async () => {
    // A CodeNode subclass that overrides its type: it still carries the
    // __language property, so substitutions must stay off here too.
    class MyCodeNode extends CodeNode {
      $config() {
        return this.config('my-code', {extends: CodeNode});
      }
    }
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          const paragraph = $createParagraphNode();
          $getRoot().append(paragraph);
          paragraph.selectEnd();
        },
        dependencies: [TextSubstitutionExtension],
        name: 'text-substitution-code-subclass-test',
        nodes: [MyCodeNode],
      }),
    );
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        paragraph.remove();
        const code = $create(MyCodeNode);
        $getRoot().append(code);
        code.append($createTextNode('x'));
        code.selectEnd();
      },
      {discrete: true},
    );
    await typeText(editor, '--');
    expect(getText(editor)).toBe('x--');
  });

  test('excludeParents skips substitution inside a matching parent', async () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          const paragraph = $createParagraphNode();
          $getRoot().append(paragraph);
          paragraph.selectEnd();
        },
        dependencies: [
          configExtension(TextSubstitutionExtension, {
            excludeParents: [parent => parent.getType() === 'paragraph'],
          }),
        ],
        name: 'text-substitution-exclude-parents-test',
      }),
    );
    await typeText(editor, '--');
    expect(getText(editor)).toBe('--');
  });

  test('does not substitute -- at the start of a line so --- can form a horizontal rule', async () => {
    using editor = setUpEditor();
    await typeText(editor, '--');
    expect(getText(editor)).toBe('--');
    await typeText(editor, '-');
    expect(getText(editor)).toBe('---');
  });

  test('typing ----> produces an em dash and leaves -> as typed', async () => {
    using editor = setUpEditor();
    await typeText(editor, '---->');
    // The first three dashes become an em dash; '->' is not a
    // Google Docs default, so it stays as typed.
    expect(getText(editor)).toBe('—->');
  });

  test('typing --- followed by a space produces an em dash', async () => {
    using editor = setUpEditor();
    await typeText(editor, '--- ');
    expect(getText(editor)).toBe('— ');
  });

  test('typing -- followed by a space produces an en dash', async () => {
    using editor = setUpEditor();
    await typeText(editor, '-- ');
    expect(getText(editor)).toBe('– ');
  });

  test('replaces a fraction default', async () => {
    using editor = setUpEditor();
    // A fraction starts with a word character, so it is held back
    // until the next character confirms a word boundary.
    await typeText(editor, '1/2 ');
    expect(getText(editor)).toBe('½ ');
  });

  test('replaces an arrow default', async () => {
    using editor = setUpEditor();
    await typeText(editor, '<==');
    expect(getText(editor)).toBe('⇐');
  });

  test('a word alias fires when followed by a word boundary', async () => {
    using editor = setUpEditor({
      substitutions: {teh: 'the'},
    });
    await typeText(editor, 'teh ');
    expect(getText(editor)).toBe('the ');
  });

  test('a word alias does not fire when it starts a longer word', async () => {
    using editor = setUpEditor({
      substitutions: {teh: 'the'},
    });
    await typeText(editor, 'tehran');
    expect(getText(editor)).toBe('tehran');
  });

  test('a word alias does not fire inside another word', async () => {
    using editor = setUpEditor({
      substitutions: {teh: 'the'},
    });
    await typeText(editor, 'xteh');
    expect(getText(editor)).toBe('xteh');
  });

  test('an alias with regex characters matches literally, not as a pattern', async () => {
    using editor = setUpEditor({
      substitutions: {'a.b': 'DOT'},
    });
    // 'a.b' starts with a word character, so it is held back until
    // the next character confirms a word boundary.
    await typeText(editor, 'a.b ');
    expect(getText(editor)).toBe('DOT ');
    using editor2 = setUpEditor({
      substitutions: {'a.b': 'DOT'},
    });
    // The '.' is a literal dot, not a wildcard: 'axb' must not fire.
    await typeText(editor2, 'axb');
    expect(getText(editor2)).toBe('axb');
  });

  test('invalid entries are ignored: an empty alias and an alias mapping to itself', async () => {
    using editor = setUpEditor({
      substitutions: {'': 'X', '--': '--'},
    });
    await typeText(editor, '--');
    expect(getText(editor)).toBe('--');
  });

  test('mapping a default to null removes it while other defaults still work', async () => {
    using editor = setUpEditor({
      substitutions: {'--': null},
    });
    await typeText(editor, '--');
    expect(getText(editor)).toBe('--');
    await typeText(editor, ' (c)');
    expect(getText(editor)).toBe('-- ©');
  });

  test('a single undo reverts the substitution, restoring the alias', async () => {
    using editor = setUpEditor({withHistory: true});
    // '--' is held back one keystroke; the space confirms it stands.
    await typeText(editor, 'hello-- ');
    expect(getText(editor)).toBe('hello– ');
    editor.dispatchCommand(UNDO_COMMAND);
    expect(getText(editor)).toBe('hello-- ');
  });

  test('a single undo after a chained substitution restores the full alias', async () => {
    using editor = setUpEditor({withHistory: true});
    // '--' is held back, then '>' extends it into '-->', which is
    // substituted directly (no intermediate '--' -> '–' step).
    await typeText(editor, 'hello-->');
    expect(getText(editor)).toBe('hello→');
    editor.dispatchCommand(UNDO_COMMAND);
    expect(getText(editor)).toBe('hello-->');
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
    // '--' is held back one keystroke; the space confirms it stands,
    // so the caret sits after the space, not right after the
    // replacement. Backspace therefore deletes the space first.
    await typeText(editor, 'hello-- ');
    expect(getText(editor)).toBe('hello– ');
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    await tick();
    expect(getText(editor)).toBe('hello–');
    // The record is consumed by the caret move, so a second Backspace
    // is a plain delete of the replacement.
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    await tick();
    expect(getText(editor)).toBe('hello');
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
    expect(getText(editor)).toBe('hello–x');
    // The intervening edit clears the record, so RichText's delete
    // handler removes the 'x' instead of restoring '--'.
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    await tick();
    expect(getText(editor)).toBe('hello–');
  });

  test('Backspace after moving the caret away and back does not restore the alias', async () => {
    using editor = setUpEditor({withRichText: true});
    await typeText(editor, 'hello-- ');
    expect(getText(editor)).toBe('hello– ');
    moveCaret(editor, 5);
    await tick();
    moveCaret(editor, 7);
    await tick();
    // The caret moves clear the record, so Backspace deletes the
    // space instead of restoring '--'.
    editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
    await tick();
    expect(getText(editor)).toBe('hello–');
  });

  test('updating the substitutions signal at runtime changes what gets replaced', async () => {
    using editor = setUpEditor();
    await typeText(editor, 'hello-- ');
    expect(getText(editor)).toBe('hello– ');
    const substitutionsSignal = getExtensionDependencyFromEditor(
      editor,
      TextSubstitutionExtension,
    ).output.substitutions;
    // Replacing the map drops the defaults: a custom entry now fires
    // and '--' is left alone.
    substitutionsSignal.value = {':)': '::)'};
    await tick();
    // The text already ends with a space (from the '-- ' above), so
    // no leading space is typed here.
    await typeText(editor, ':)');
    expect(getText(editor)).toBe('hello– ::)');
    await typeText(editor, ' --');
    expect(getText(editor)).toBe('hello– ::) --');
  });

  test('overriding a default at runtime and restoring the defaults', async () => {
    using editor = setUpEditor();
    const substitutionsSignal = getExtensionDependencyFromEditor(
      editor,
      TextSubstitutionExtension,
    ).output.substitutions;
    substitutionsSignal.value = {
      ...DEFAULT_TEXT_SUBSTITUTIONS,
      '(c)': 'CUSTOM',
    };
    await tick();
    await typeText(editor, '(c)');
    expect(getText(editor)).toBe('CUSTOM');
    await typeText(editor, ' -- ');
    expect(getText(editor)).toBe('CUSTOM – ');
    substitutionsSignal.value = DEFAULT_TEXT_SUBSTITUTIONS;
    await tick();
    // The text already ends with a space, so no leading space here.
    await typeText(editor, '(c)');
    expect(getText(editor)).toBe('CUSTOM – ©');
  });
});
