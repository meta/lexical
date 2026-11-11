/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {PlainTextExtension} from '@lexical/plain-text';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isRangeSelection,
  $setState,
  COMMAND_PRIORITY_CRITICAL,
  COMPOSITION_END_TAG,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  createState,
  HISTORY_PUSH_TAG,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test, vi} from 'vitest';

// Exercise Safari's DOM event handlers in CI's Chromium as well as WebKit.
// These are synthetic event replays, not a substitute for a system IME test.
vi.mock('lexical/src/environment', async importOriginal => ({
  ...(await importOriginal<typeof import('lexical/src/environment')>()),
  IS_APPLE: true,
  IS_APPLE_WEBKIT: true,
  IS_CHROME: false,
  IS_FIREFOX: false,
  IS_IOS: false,
  IS_SAFARI: true,
}));

class CustomTextNode extends TextNode {
  $config() {
    return this.config('custom-text', {extends: TextNode});
  }
}

const historyNoteState = createState('safari-history-note', {
  parse: value => (typeof value === 'string' ? value : ''),
});

function mount(
  richText: boolean,
  initialize: () => void,
  options: {history?: boolean} = {},
) {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  const editor = buildEditorFromExtensions({
    dependencies: [
      richText ? RichTextExtension : PlainTextExtension,
      ...(options.history ? [HistoryExtension] : []),
    ],
    name: 'safari-composition-test',
    nodes: [CustomTextNode],
  });
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.dispose();
    root.remove();
  });
  root.focus();
  editor.update(
    () => {
      $getRoot().clear();
      initialize();
    },
    {discrete: true},
  );
  const commands: string[] = [];
  editor.registerCommand(
    KEY_ENTER_COMMAND,
    event => {
      event?.preventDefault();
      commands.push('enter');
      return true;
    },
    COMMAND_PRIORITY_CRITICAL,
  );
  editor.registerCommand(
    KEY_BACKSPACE_COMMAND,
    () => {
      commands.push('backspace');
      return false;
    },
    COMMAND_PRIORITY_CRITICAL,
  );
  const tags: string[] = [];
  editor.registerUpdateListener(update => tags.push(...update.tags));
  const keyDown = (key: string, keyCode: number) =>
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key,
        keyCode,
      }),
    );
  const composition = (type: string, data = '') =>
    root.dispatchEvent(new CompositionEvent(type, {bubbles: true, data}));
  const dispatchInput = (
    type: 'input' | 'beforeinput',
    inputType: string,
    data: string | null,
  ) => {
    const event = new InputEvent(type, {
      bubbles: true,
      cancelable: type === 'beforeinput',
      data,
      inputType,
      isComposing: inputType === 'insertCompositionText',
    });
    // Chromium normalizes Safari-only input types to the empty string.
    Object.defineProperty(event, 'inputType', {value: inputType});
    root.dispatchEvent(event);
  };
  const input = (inputType: string, data: string | null) =>
    dispatchInput('input', inputType, data);
  const beforeInput = (inputType: string, data: string | null) =>
    dispatchInput('beforeinput', inputType, data);
  const setDOMText = (text: string, offset: number) => {
    const domSelection = document.getSelection();
    assert(domSelection);
    const textDOM = domSelection.anchorNode;
    assert(textDOM instanceof Text && root.contains(textDOM));
    textDOM.data = text;
    domSelection.setBaseAndExtent(textDOM, offset, textDOM, offset);
  };
  const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  const composeText = async (
    data: string,
    text: string,
    offset: number,
    key: string,
  ) => {
    composition('compositionupdate', data);
    beforeInput('insertCompositionText', data);
    setDOMText(text, offset);
    input('insertCompositionText', data);
    await flush();
    keyDown(key, 229);
  };
  const expectText = (text: string) => {
    expect(editor.read(() => $getRoot().getTextContent())).toBe(text);
    expect(root.textContent).toBe(text);
  };
  const selectedNodeKey = () =>
    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      return selection.anchor.key;
    });
  return {
    beforeInput,
    commands,
    composeText,
    composition,
    editor,
    expectText,
    flush,
    input,
    keyDown,
    root,
    selectedNodeKey,
    setDOMText,
    tags,
  };
}

function $paragraph(text: string, start = text.length, end = start) {
  const node = $createTextNode(text);
  $getRoot().append($createParagraphNode().append(node));
  node.select(start, end);
}

describe.each([false, true])('Safari composition (richText=%s)', richText => {
  test.each([
    {backward: false, nbsp: false},
    {backward: true, nbsp: false},
    {backward: false, nbsp: true},
    {backward: true, nbsp: true},
  ])(
    'cancellation keeps the unselected text across paragraphs (%j)',
    async options => {
      const t = mount(richText, () => {
        const first = $createTextNode(options.nbsp ? 'a\u00a0bc' : 'abcd');
        const last = $createTextNode(options.nbsp ? 'DEF\u00a0Z' : 'DEFZ');
        $getRoot().append(
          $createParagraphNode().append(first),
          $createParagraphNode().append(last),
        );
        const selection = first.select();
        selection.setTextNodeRange(
          options.backward ? last : first,
          options.backward ? 3 : 2,
          options.backward ? first : last,
          options.backward ? 2 : 3,
        );
      });
      t.composition('compositionstart');
      await t.flush();
      // Normalization has merged the unselected suffix into the composing node.
      const expected = options.nbsp ? 'a\u00a0\u00a0Z' : 'abZ';
      t.composition('compositionend');
      await t.flush();
      t.expectText(expected);
      expect(t.editor.isComposing()).toBe(false);
      t.keyDown('Enter', 13);
      expect(t.commands).toEqual(['enter']);
    },
  );

  test.each(['Backspace', 'Escape'])(
    'an empty native compositionend after %s releases the next Enter',
    async cancelKey => {
      const t = mount(richText, () => $paragraph('abc'));
      // Safari starts composition before the Process keydown.
      t.composition('compositionstart');
      await t.flush();
      await t.composeText('n', 'abcn\u00a0', 4, 'n');
      await t.composeText('ni', 'abcni\u00a0', 5, 'i');
      expect(t.editor.isComposing()).toBe(true);

      // Cancellation has deleteCompositionText and no insertFromComposition.
      if (cancelKey === 'Backspace') {
        await t.composeText('n', 'abcn\u00a0', 4, 'Backspace');
      }
      t.beforeInput('deleteCompositionText', null);
      t.setDOMText('abc\u00a0', 3);
      t.input('deleteCompositionText', null);
      t.composition('compositionend');
      // WebKit can deliver the key consumed by the IME after compositionend.
      t.keyDown(cancelKey, 229);
      await t.flush();

      expect(t.commands).toEqual([]);
      t.keyDown('Enter', 13);
      expect(t.commands).toEqual(['enter']);
      expect(t.editor.isComposing()).toBe(false);
      t.expectText('abc');
      expect(t.tags).toContain(COMPOSITION_END_TAG);
      t.keyDown('Backspace', 8);
      await t.flush();
      expect(t.commands).toEqual(['enter', 'backspace']);
      t.expectText('ab');
    },
  );

  test('normal confirmation consumes the IME Enter but handles a later Backspace', async () => {
    const t = mount(richText, () => $paragraph('abc'));
    t.composition('compositionstart');
    await t.flush();
    await t.composeText('ni', 'abcni\u00a0', 5, 'i');
    t.beforeInput('deleteCompositionText', null);
    t.setDOMText('abc\u00a0', 3);
    t.input('deleteCompositionText', null);
    // Real WebKit commits via beforeinput before reporting compositionend.
    t.beforeInput('insertFromComposition', '你');
    await t.flush();
    t.composition('compositionend', '你');
    t.keyDown('Enter', 229);
    await t.flush();
    expect(t.commands).toEqual([]);
    t.expectText('abc你');
    t.keyDown('Backspace', 8);
    await t.flush();
    expect(t.commands).toEqual(['backspace']);
    t.expectText('abc');
    t.keyDown('Enter', 13);
    expect(t.commands).toEqual(['backspace', 'enter']);
  });

  test.each(['a\u00a0b\u00a0', '\u00a0\u00a0'])(
    'cancellation preserves real NBSP in %j',
    async text => {
      const t = mount(richText, () => $paragraph(text));
      t.composition('compositionstart');
      await t.flush();
      t.setDOMText(text + 'ni\u00a0', text.length + 2);
      t.input('insertCompositionText', 'ni');
      await t.flush();
      t.setDOMText(text + '\u00a0', text.length);
      t.input('deleteCompositionText', null);
      t.composition('compositionend');
      await t.flush();
      t.expectText(text);
      t.editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(selection.anchor.offset).toBe(text.length);
      });
      t.keyDown('Enter', 229);
      expect(t.commands).toEqual([]);
      t.keyDown('Enter', 13);
      expect(t.commands).toEqual(['enter']);
    },
  );

  test.each(['empty', 'format', 'token'])(
    'an empty target survives DOM readback and selection normalization (%s)',
    async kind => {
      const t = mount(richText, () => {
        if (kind === 'empty') {
          $getRoot().append($createParagraphNode()).selectEnd();
        } else {
          $paragraph('abc', 1);
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          if (kind === 'format') {
            selection.format = 1;
          } else {
            const node = selection.anchor.getNode();
            assert(node instanceof TextNode);
            node.setMode('token').selectEnd();
          }
        }
      });
      const expected = kind === 'empty' ? '' : 'abc';
      t.composition('compositionstart');
      await t.flush();
      const key = t.selectedNodeKey();
      expect(t.editor.isComposing()).toBe(true);
      t.setDOMText('\u00a0', 0);
      t.input('deleteCompositionText', null);
      document.dispatchEvent(new Event('selectionchange'));
      await t.flush();
      t.editor.update(
        () => {
          // Dirty both sides so normalization cannot remove the empty target
          // while processing a neighboring text node.
          for (const node of $getRoot().getAllTextNodes()) {
            node.markDirty();
          }
        },
        {discrete: true},
      );
      expect(t.editor.isComposing()).toBe(true);
      expect(t.selectedNodeKey()).toBe(key);
      expect(t.editor.read(() => $getRoot().getTextContent())).toBe(expected);
      t.editor.read(() => {
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        expect(selection.anchor.key).toBe(key);
      });
      t.composition('compositionend');
      await t.flush();
      t.expectText(expected);
      expect(t.editor.isComposing()).toBe(false);
      expect(
        t.editor.read(() =>
          $getRoot()
            .getAllTextNodes()
            .some(node => node.getTextContent() === ''),
        ),
      ).toBe(false);
    },
  );

  test('browser editing replaces the DOM suffix in the prepared formatted target', async () => {
    const t = mount(richText, () => {
      $paragraph('abc', 1);
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      selection.format = 1;
    });
    t.composition('compositionstart');
    await t.flush();
    const key = t.selectedNodeKey();
    const selection = document.getSelection();
    assert(selection);
    // The model has a collapsed caret in empty text. The browser must replace
    // the rendered suffix, rather than insert into the previous text node.
    expect(selection.getRangeAt(0).toString()).toBe('\u00a0');
    document.execCommand('insertText', false, 'n');
    await t.flush();
    expect(t.editor.isComposing()).toBe(true);
    expect(t.selectedNodeKey()).toBe(key);
    t.editor.read(() => {
      const node = $getRoot()
        .getAllTextNodes()
        .find(text => text.getKey() === key);
      assert(node);
      expect(node.getTextContent()).toBe('n');
      expect(node.hasFormat('bold')).toBe(true);
    });
    t.setDOMText('\u00a0', 0);
    t.input('deleteCompositionText', null);
    t.composition('compositionend');
    await t.flush();
    t.expectText('abc');
  });

  test.each(['selection', 'root', 'state', 'repeat'])(
    'an empty composition target is released after %s changes',
    async kind => {
      const t = mount(richText, () => {
        $paragraph('abc', 1);
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        selection.format = 1;
      });
      const initial = t.editor.getEditorState();
      t.composition('compositionstart');
      await t.flush();
      if (kind === 'selection') {
        t.editor.update(
          () => $getRoot().getAllTextNodes().at(-1)!.selectEnd(),
          {discrete: true},
        );
      } else if (kind === 'root') {
        t.editor.setRootElement(null);
        t.editor.setRootElement(t.root);
        // Root remount reconciles existing nodes without normalizing them.
        // The next normalization must no longer reserve the old target.
        t.editor.update(
          () => {
            for (const node of $getRoot().getAllTextNodes()) {
              node.markDirty();
            }
          },
          {discrete: true},
        );
      } else if (kind === 'state') {
        t.editor.setEditorState(initial);
      }
      t.composition('compositionend');
      await t.flush();
      if (kind === 'repeat') {
        t.composition('compositionstart');
        await t.flush();
        t.composition('compositionend');
        await t.flush();
      }
      t.expectText('abc');
      expect(t.editor.isComposing()).toBe(false);
      expect(
        t.editor.read(() =>
          $getRoot()
            .getAllTextNodes()
            .some(node => node.getTextContent() === ''),
        ),
      ).toBe(false);
      t.keyDown('Enter', 13);
      expect(t.commands).toEqual(['enter']);
    },
  );

  test.each(['', 'a\u00a0b\u00a0'])(
    'confirmation preserves document text and creates one undo step (%j)',
    async text => {
      const t = mount(richText, () => $paragraph(text), {history: true});
      t.composition('compositionstart');
      await t.flush();
      await t.composeText('ni', text + 'ni\u00a0', text.length + 2, 'i');
      t.beforeInput('deleteCompositionText', null);
      t.setDOMText(text + '\u00a0', text.length);
      t.input('deleteCompositionText', null);
      t.beforeInput('insertFromComposition', '你');
      await t.flush();
      t.composition('compositionend', '你');
      t.keyDown('Enter', 229);
      await t.flush();
      t.expectText(text + '你');
      expect(t.commands).toEqual([]);
      t.editor.dispatchCommand(UNDO_COMMAND, undefined);
      await t.flush();
      t.expectText(text);
      expect(t.editor.isComposing()).toBe(false);
    },
  );

  test.each([
    'empty',
    'selection',
    'backward-selection',
    'format',
    'token',
    'subclass',
    'segmented-subclass',
  ])(
    'composition prepares a DOM target without changing document text (%s)',
    async kind => {
      const t = mount(richText, () => {
        if (kind === 'empty') {
          $getRoot().append($createParagraphNode()).selectEnd();
        } else if (kind === 'subclass' || kind === 'segmented-subclass') {
          const node = $create(CustomTextNode).setTextContent('abc');
          $getRoot().append($createParagraphNode().append(node));
          if (kind === 'segmented-subclass') {
            node.setMode('segmented').select(1, 1);
          } else {
            node.selectEnd();
          }
        } else {
          $paragraph(
            'a\u00a0bc',
            kind === 'selection' ? 2 : 4,
            kind === 'backward-selection' ? 2 : 4,
          );
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          if (kind === 'format') {
            selection.format = 1;
          } else if (kind === 'token') {
            const node = selection.anchor.getNode();
            assert(node instanceof TextNode);
            node.setMode('token');
          }
        }
      });
      const expected =
        kind === 'empty'
          ? ''
          : kind === 'selection' || kind === 'backward-selection'
            ? 'a\u00a0'
            : kind === 'subclass' || kind === 'segmented-subclass'
              ? 'abc'
              : 'a\u00a0bc';
      t.composition('compositionstart');
      await t.flush();
      expect(t.editor.read(() => $getRoot().getTextContent())).toBe(expected);
      const key = t.selectedNodeKey();
      expect(t.editor.isComposing()).toBe(true);
      expect(t.editor.getElementByKey(key)?.textContent).toBe(
        t.editor.read(() => {
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          return selection.anchor.getNode().getTextContent() + '\u00a0';
        }),
      );
      t.composition('compositionend');
      t.keyDown('Escape', 229);
      await t.flush();
      expect(t.editor.isComposing()).toBe(false);
      t.expectText(expected);
      if (kind === 'subclass' || kind === 'segmented-subclass') {
        expect(
          t.editor.read(() => $getRoot().getAllTextNodes()[0].getType()),
        ).toBe(kind === 'subclass' ? 'custom-text' : 'text');
      }
    },
  );
  test.each(
    ['insertText', 'insertRawText', 'insertNodes'].flatMap(method =>
      [false, true].map(withInput => ({method, withInput})),
    ),
  )(
    'preparation does not insert through application handlers (%j)',
    async ({method, withInput}) => {
      const t = mount(richText, () => {
        $paragraph('abc', 1);
        const selection = $getSelection();
        assert($isRangeSelection(selection));
        selection.format = 1;
      });
      const payloads: string[] = [];
      t.editor.registerCommand(
        CONTROLLED_TEXT_INSERTION_COMMAND,
        payload => {
          if (typeof payload !== 'string') return false;
          payloads.push(payload);
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          if (method === 'insertText') selection.insertText(payload);
          else if (method === 'insertRawText') selection.insertRawText(payload);
          else selection.insertNodes([$createTextNode(payload)]);
          return true;
        },
        COMMAND_PRIORITY_CRITICAL,
      );
      t.composition('compositionstart');
      await t.flush();
      if (withInput) {
        await t.composeText('ni', 'ni\u00a0', 2, 'i');
        t.beforeInput('deleteCompositionText', null);
        t.setDOMText('\u00a0', 0);
        t.input('deleteCompositionText', null);
        await t.flush();
      }
      t.composition('compositionend');
      await t.flush();
      t.expectText('abc');
      expect(payloads).toEqual([]);
      expect(t.editor.isComposing()).toBe(false);
      // Ordinary document text still goes through the application's handler.
      t.editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, 'X');
      await t.flush();
      expect(payloads).toEqual(['X']);
      t.expectText('aXbc');
    },
  );

  test.each([
    {composed: '', nativeText: ''},
    {composed: '', nativeText: '語'},
    {composed: 'ni', nativeText: ''},
  ])(
    'cancelling a formatted target has the right undo boundary (%j)',
    async ({composed, nativeText}) => {
      const t = mount(richText, () => $paragraph('abc'), {history: true});
      const serialize = vi.spyOn(
        Object.getPrototypeOf(t.editor.getEditorState()),
        'toJSON',
      );
      onTestFinished(() => serialize.mockRestore());
      t.editor.update(
        () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          selection.insertText('X');
        },
        {discrete: true, tag: HISTORY_PUSH_TAG},
      );
      t.editor.update(
        () => {
          const selection = $getRoot().getAllTextNodes()[0].select(1, 1);
          selection.format = 1;
        },
        {discrete: true},
      );
      t.composition('compositionstart');
      await t.flush();
      if (composed) {
        t.composition('compositionupdate', composed);
        t.beforeInput('insertCompositionText', composed);
        t.setDOMText(composed + '\u00a0', composed.length);
        t.input('insertCompositionText', composed);
        await t.flush();
        expect(t.editor.read(() => $getRoot().getTextContent())).toBe('anibcX');
        t.beforeInput('deleteCompositionText', null);
        t.setDOMText('\u00a0', 0);
        t.input('deleteCompositionText', null);
        await t.flush();
        expect(t.editor.read(() => $getRoot().getTextContent())).toBe('abcX');
      }
      if (nativeText) t.setDOMText(nativeText, nativeText.length);
      t.composition('compositionend');
      await t.flush();
      t.expectText(nativeText ? 'a語bcX' : 'abcX');
      expect(serialize).not.toHaveBeenCalled();
      t.editor.dispatchCommand(UNDO_COMMAND, undefined);
      await t.flush();
      t.expectText(nativeText ? 'abcX' : 'abc');
    },
  );

  test('cancelling a composition over selected text keeps its deletion undoable', async () => {
    const t = mount(richText, () => $paragraph('abcd', 1, 3), {history: true});
    t.composition('compositionstart');
    await t.flush();
    t.composition('compositionend');
    await t.flush();
    t.expectText('ad');
    t.editor.dispatchCommand(UNDO_COMMAND, undefined);
    await t.flush();
    t.expectText('abcd');
  });
  test.each(['format', 'state', 'indent'])(
    'composition retains undo for a document %s change with identical plain text',
    async change => {
      const t = mount(richText, () => $paragraph('abc'), {history: true});
      t.editor.update(
        () => {
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          selection.insertText('X');
        },
        {discrete: true, tag: HISTORY_PUSH_TAG},
      );
      t.editor.update(
        () => {
          const selection = $getRoot().getAllTextNodes()[0].select(1, 1);
          selection.format = 1;
        },
        {discrete: true},
      );
      t.composition('compositionstart');
      await t.flush();
      t.editor.update(
        () => {
          const node = $getRoot().getAllTextNodes()[0];
          if (change === 'format') node.setFormat('bold');
          else if (change === 'state')
            $setState(node, historyNoteState, 'changed');
          else node.getParentOrThrow().setIndent(1);
        },
        {discrete: true},
      );
      t.composition('compositionend');
      await t.flush();
      t.expectText('abcX');
      t.editor.dispatchCommand(UNDO_COMMAND, undefined);
      await t.flush();
      t.expectText('abcX');
      t.editor.read(() => {
        for (const node of $getRoot().getAllTextNodes()) {
          expect(node.hasFormat('bold')).toBe(false);
          expect($getState(node, historyNoteState)).toBe('');
          expect(node.getParentOrThrow().getIndent()).toBe(0);
        }
      });
      t.editor.dispatchCommand(UNDO_COMMAND, undefined);
      await t.flush();
      t.expectText('abc');
    },
  );
});
