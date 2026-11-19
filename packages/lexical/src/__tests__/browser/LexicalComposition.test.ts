/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isParagraphNode,
  $isRangeSelection,
  $setState,
  COMPOSITION_END_COMMAND,
  COMPOSITION_END_TAG,
  COMPOSITION_START_TAG,
  createState,
  type LexicalEditor,
  type LexicalNodeConfig,
  TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';

import {$assertNodeType} from '../utils/assertNodeType';
import {compose, korean} from './utils/compose';

const IS_FIREFOX =
  typeof navigator !== 'undefined' && /Firefox/i.test(navigator.userAgent);

function createEditor(opts?: {
  initialState?: () => void;
  nodes?: LexicalNodeConfig[];
  withHistory?: boolean;
}): LexicalEditor {
  const {initialState, nodes, withHistory} = opts ?? {};
  const dependencies = withHistory
    ? [RichTextExtension, HistoryExtension]
    : [RichTextExtension];
  const editor = buildEditorFromExtensions({
    $initialEditorState:
      initialState ??
      (() => {
        $getRoot().append($createParagraphNode());
      }),
    dependencies,
    name: 'test',
    nodes,
  });
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.appendChild(root);
  editor.setRootElement(root);
  onTestFinished(() => {
    editor.setRootElement(null);
    document.body.removeChild(root);
  });
  return editor;
}

async function waitForRender(): Promise<void> {
  await new Promise(r => setTimeout(r, 0));
}

async function focusAtEnd(rootElement: HTMLElement): Promise<void> {
  await waitForRender();
  rootElement.focus();
  const textSpan = rootElement.querySelector('[data-lexical-text]');
  if (textSpan?.firstChild instanceof Text) {
    const sel = document.getSelection()!;
    sel.collapse(textSpan.firstChild, textSpan.firstChild.nodeValue!.length);
  }
}

async function focusAtStart(rootElement: HTMLElement): Promise<void> {
  await waitForRender();
  rootElement.focus();
  const p = rootElement.querySelector('p');
  if (p) {
    const sel = document.getSelection()!;
    sel.collapse(p, 0);
  }
}

describe('compose() helper — browser composition tests', () => {
  test('Korean jamo composition produces correct text', async () => {
    const editor = createEditor();
    const rootElement = editor.getRootElement()!;
    await focusAtStart(rootElement);

    await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));

    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('한');
      const sel = $getSelection();
      assert($isRangeSelection(sel));
      expect(sel.isCollapsed()).toBe(true);
      expect(sel.anchor.offset).toBe(1);
    });
  });

  test('Korean two-syllable composition', async () => {
    const editor = createEditor();
    const rootElement = editor.getRootElement()!;
    await focusAtStart(rootElement);

    await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));
    await compose({editor, rootElement}, korean(['ㄱ', '그', '글']));

    const text = editor.read(() => $getRoot().getTextContent());
    expect(text).toBe('한글');
  });

  test('composition into existing text', async () => {
    const editor = createEditor({
      initialState: () => {
        const p = $createParagraphNode();
        p.append($createTextNode('hello '));
        $getRoot().append(p);
      },
    });
    const rootElement = editor.getRootElement()!;
    await focusAtEnd(rootElement);

    await compose(
      {editor, rootElement},
      korean(['ㅅ', '세', '셰', '셰ㄱ', '세계']),
    );

    const text = editor.read(() => $getRoot().getTextContent());
    expect(text).toBe('hello 세계');
  });

  test('cancelled composition reverts text', async () => {
    const editor = createEditor({
      initialState: () => {
        const p = $createParagraphNode();
        p.append($createTextNode('abc'));
        $getRoot().append(p);
      },
    });
    const rootElement = editor.getRootElement()!;
    await focusAtEnd(rootElement);

    await compose(
      {editor, rootElement},
      {
        cancel: true,
        steps: [{text: 'ㅎ'}, {text: '하'}],
      },
    );

    const text = editor.read(() => $getRoot().getTextContent());
    expect(text).toBe('abc');
  });

  test('composition on bold-formatted text', async () => {
    const editor = createEditor({
      initialState: () => {
        const p = $createParagraphNode();
        const bold = $createTextNode('bold').toggleFormat('bold');
        p.append(bold);
        $getRoot().append(p);
        bold.selectEnd();
      },
    });
    const rootElement = editor.getRootElement()!;
    await focusAtEnd(rootElement);

    await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));

    editor.read(() => {
      const text = $getRoot().getTextContent();
      expect(text).toBe('bold한');
    });
  });

  test('composition replaces selected text', async () => {
    const editor = createEditor({
      initialState: () => {
        const p = $createParagraphNode();
        const node = $createTextNode('hello');
        p.append(node);
        $getRoot().append(p);
        node.select(0, 5);
      },
    });
    const rootElement = editor.getRootElement()!;
    await waitForRender();
    // Place a real DOM selection over the text so compose() picks it up.
    const textSpan = rootElement.querySelector('[data-lexical-text]');
    if (textSpan?.firstChild instanceof Text) {
      document
        .getSelection()!
        .setBaseAndExtent(textSpan.firstChild, 0, textSpan.firstChild, 5);
    }

    await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));

    const text = editor.read(() => $getRoot().getTextContent());
    expect(text).toBe('한');
  });

  test('three consecutive compositions', async () => {
    const editor = createEditor();
    const rootElement = editor.getRootElement()!;
    await focusAtStart(rootElement);

    await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));
    await compose({editor, rootElement}, korean(['ㄱ', '그', '글']));
    await compose({editor, rootElement}, korean(['ㅇ', '이', '임']));

    const text = editor.read(() => $getRoot().getTextContent());
    expect(text).toBe('한글임');
  });

  test('composition at middle of text', async () => {
    const editor = createEditor({
      initialState: () => {
        const p = $createParagraphNode();
        const node = $createTextNode('helloworld');
        p.append(node);
        $getRoot().append(p);
      },
    });
    const rootElement = editor.getRootElement()!;
    await waitForRender();
    // Place cursor at offset 5 (between "hello" and "world").
    const textSpan = rootElement.querySelector('[data-lexical-text]');
    if (textSpan?.firstChild instanceof Text) {
      document.getSelection()!.collapse(textSpan.firstChild, 5);
    }

    await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));

    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('hello한world');
      const sel = $getSelection();
      assert($isRangeSelection(sel));
      expect(sel.isCollapsed()).toBe(true);
      expect(sel.anchor.offset).toBe(6);
    });
  });

  test('composition then undo reverts to previous state', async () => {
    const editor = createEditor({
      initialState: () => {
        const p = $createParagraphNode();
        p.append($createTextNode('abc'));
        $getRoot().append(p);
      },
      withHistory: true,
    });
    const rootElement = editor.getRootElement()!;
    await focusAtEnd(rootElement);

    await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));
    expect(editor.read(() => $getRoot().getTextContent())).toBe('abc한');

    editor.dispatchCommand(UNDO_COMMAND);
    await waitForRender();

    const text = editor.read(() => $getRoot().getTextContent());
    expect(text).toBe('abc');
  });

  test('Japanese romaji-to-hiragana composition', async () => {
    const editor = createEditor();
    const rootElement = editor.getRootElement()!;
    await focusAtStart(rootElement);

    await compose(
      {editor, rootElement},
      {
        commitText: 'すし',
        steps: [
          {text: 'ｓ'},
          {text: 'す'},
          {text: 'すｓ'},
          {text: 'すｓｈ'},
          {text: 'すし'},
        ],
      },
    );

    const text = editor.read(() => $getRoot().getTextContent());
    expect(text).toBe('すし');
  });

  test('composition after arrow navigation', async () => {
    const editor = createEditor({
      initialState: () => {
        const p = $createParagraphNode();
        p.append($createTextNode('ab'));
        $getRoot().append(p);
      },
    });
    const rootElement = editor.getRootElement()!;
    await focusAtEnd(rootElement);

    // Move cursor left once: "ab|" → "a|b"
    rootElement.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowLeft'}),
    );
    await waitForRender();
    // Manually adjust DOM selection to match (untrusted keydown doesn't move cursor).
    const textSpan = rootElement.querySelector('[data-lexical-text]');
    if (textSpan?.firstChild instanceof Text) {
      document.getSelection()!.collapse(textSpan.firstChild, 1);
    }

    await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));

    const text = editor.read(() => $getRoot().getTextContent());
    expect(text).toBe('a한b');
  });
});

describe('Composition edge cases', () => {
  test('composition in empty paragraph (element anchor ZWSP path)', async () => {
    const editor = createEditor();
    const rootElement = editor.getRootElement()!;
    await focusAtStart(rootElement);

    // Empty paragraph has no text spans before composition.
    expect(rootElement.querySelector('[data-lexical-text]')).toBeNull();

    await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));

    const text = editor.read(() => $getRoot().getTextContent());
    expect(text).toBe('한');
    // ZWSP path must have created a text node; verify it exists post-compose.
    expect(rootElement.querySelector('[data-lexical-text]')).not.toBeNull();
  });

  test('composition on token node redirects to sibling', async () => {
    const editor = createEditor({
      initialState: () => {
        const p = $createParagraphNode();
        const token = $createTextNode('code').setMode('token');
        p.append(token);
        $getRoot().append(p);
        token.selectEnd();
      },
    });
    const rootElement = editor.getRootElement()!;
    await focusAtEnd(rootElement);

    await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));

    const text = editor.read(() => $getRoot().getTextContent());
    expect(text).toBe('code한');
  });

  test('backspace-all composition ends with empty data', async () => {
    const editor = createEditor({
      initialState: () => {
        const p = $createParagraphNode();
        p.append($createTextNode('abc'));
        $getRoot().append(p);
      },
    });
    const rootElement = editor.getRootElement()!;
    await focusAtEnd(rootElement);

    // Simulate typing then backspacing all composed text.
    await compose(
      {editor, rootElement},
      {
        commitText: '',
        steps: [{text: 'ㅎ'}, {text: '하'}, {text: 'ㅎ'}, {text: ''}],
      },
    );

    const text = editor.read(() => $getRoot().getTextContent());
    expect(text).toBe('abc');
  });

  test('composition with newline commit creates new paragraph', async () => {
    const editor = createEditor();
    const rootElement = editor.getRootElement()!;
    await focusAtStart(rootElement);

    await compose(
      {editor, rootElement},
      {
        commitText: '確定\n',
        steps: [{text: '確'}, {text: '確定'}],
      },
    );

    editor.read(() => {
      const children = $getRoot().getChildren();
      expect(children.length).toBe(2);
    });
  });

  test('latin text before and after composition', async () => {
    const editor = createEditor({
      initialState: () => {
        const p = $createParagraphNode();
        p.append($createTextNode('abc'));
        $getRoot().append(p);
      },
    });
    const rootElement = editor.getRootElement()!;
    await focusAtEnd(rootElement);

    await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));

    editor.update(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel)) {
        sel.insertText('def');
      }
    });
    await waitForRender();

    const text = editor.read(() => $getRoot().getTextContent());
    expect(text).toBe('abc한def');
  });

  test('composition with explicit selection range', async () => {
    const editor = createEditor();
    const rootElement = editor.getRootElement()!;
    await focusAtStart(rootElement);

    await compose(
      {editor, rootElement},
      {
        commitText: 'かん',
        steps: [
          {selectionEnd: 1, selectionStart: 0, text: 'か'},
          {selectionEnd: 2, selectionStart: 0, text: 'かん'},
        ],
      },
    );

    const text = editor.read(() => $getRoot().getTextContent());
    expect(text).toBe('かん');
  });
});

describe('Composition state tracking', () => {
  test('editor.isComposing() is true during composition, false after', async () => {
    const editor = createEditor();
    const rootElement = editor.getRootElement()!;
    await focusAtStart(rootElement);

    expect(editor.isComposing()).toBe(false);

    // Start composition manually to check mid-composition state.
    rootElement.dispatchEvent(
      new CompositionEvent('compositionstart', {bubbles: true, data: ''}),
    );
    await waitForRender();
    expect(editor.isComposing()).toBe(true);

    // Dispatch COMPOSITION_END_COMMAND directly (bypasses platform deferral).
    editor.dispatchCommand(
      COMPOSITION_END_COMMAND,
      new CompositionEvent('compositionend', {bubbles: true, data: ''}),
    );
    await waitForRender();

    expect(editor.isComposing()).toBe(false);
  });

  test('composing text is visible in model before commit', async () => {
    const editor = createEditor();
    const rootElement = editor.getRootElement()!;
    await focusAtStart(rootElement);

    // Manually dispatch composition start + one step (no commit).
    rootElement.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Process',
        keyCode: 229,
      }),
    );
    rootElement.dispatchEvent(
      new CompositionEvent('compositionstart', {
        bubbles: true,
        cancelable: true,
        data: '',
      }),
    );
    await waitForRender();
    expect(editor.isComposing()).toBe(true);

    const composingStart = document.getSelection()?.focusOffset ?? 0;

    rootElement.dispatchEvent(
      new CompositionEvent('compositionupdate', {
        bubbles: true,
        cancelable: true,
        data: 'ㅎ',
      }),
    );

    // DOM mutation (untrusted events don't trigger real mutations).
    const sel = document.getSelection()!;
    let textNode: Text;
    if (sel.focusNode instanceof Text && rootElement.contains(sel.focusNode)) {
      textNode = sel.focusNode;
    } else if (
      sel.focusNode instanceof HTMLElement &&
      rootElement.contains(sel.focusNode)
    ) {
      const br = sel.focusNode.querySelector('br');
      if (br) {
        br.remove();
      }
      textNode = document.createTextNode('');
      sel.focusNode.appendChild(textNode);
    } else {
      throw new Error('no insertion point');
    }
    const v = textNode.nodeValue || '';
    textNode.nodeValue =
      v.slice(0, composingStart) + 'ㅎ' + v.slice(composingStart);
    sel.collapse(textNode, composingStart + 1);

    const bi = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: 'ㅎ',
      inputType: 'insertCompositionText',
    });
    Object.defineProperty(bi, 'getTargetRanges', {value: () => []});
    rootElement.dispatchEvent(bi);

    const inp = new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      data: 'ㅎ',
      inputType: 'insertCompositionText',
    });
    Object.defineProperty(inp, 'isComposing', {value: true});
    rootElement.dispatchEvent(inp);
    await waitForRender();

    // Model must reflect composing text while composition is still active.
    // ZWSP may be present (inserted at compositionstart for element anchors).
    expect(editor.read(() => $getRoot().getTextContent())).toContain('ㅎ');
    expect(editor.isComposing()).toBe(true);

    // Dispatch COMPOSITION_END_COMMAND directly (bypasses platform deferral).
    editor.dispatchCommand(
      COMPOSITION_END_COMMAND,
      new CompositionEvent('compositionend', {bubbles: true, data: 'ㅎ'}),
    );
    await waitForRender();
    expect(editor.isComposing()).toBe(false);
  });

  test('COMPOSITION_START_TAG and COMPOSITION_END_TAG appear in updates', async () => {
    const editor = createEditor();
    const rootElement = editor.getRootElement()!;
    await focusAtStart(rootElement);

    const observedTags: string[][] = [];
    editor.registerUpdateListener(({tags}) => {
      if (tags.size > 0) {
        observedTags.push(Array.from(tags));
      }
    });

    await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));

    expect(
      observedTags.some(tags => tags.includes(COMPOSITION_START_TAG)),
    ).toBe(true);
    expect(observedTags.some(tags => tags.includes(COMPOSITION_END_TAG))).toBe(
      true,
    );
  });
});

describe('Firefox deferred compositionend', () => {
  test.skipIf(!IS_FIREFOX)(
    'COMPOSITION_END_TAG is emitted via deferred onInput path',
    async () => {
      const editor = createEditor({
        initialState: () => {
          const p = $createParagraphNode();
          p.append($createTextNode('-'));
          $getRoot().append(p);
        },
      });
      const rootElement = editor.getRootElement()!;
      await focusAtEnd(rootElement);

      const observedTags: string[][] = [];
      editor.registerUpdateListener(({tags}) => {
        observedTags.push(Array.from(tags));
      });

      await compose({editor, rootElement}, korean(['ㅎ', '하', '한']));

      expect(
        observedTags.some(tags => tags.includes(COMPOSITION_END_TAG)),
      ).toBe(true);
    },
  );
});

const idState = createState('id', {
  parse: value => (typeof value === 'string' ? value : ''),
});

class HighlightNode extends TextNode {
  $config() {
    return this.config('highlight', {extends: TextNode});
  }
}

function $createHighlightNode(text: string): HighlightNode {
  return $create(HighlightNode).setTextContent(text);
}

describe('Composition into a TextNode subclass (#9289)', () => {
  test.each([
    ['in the middle', 3, 'wor仮名ld'],
    ['at the end', 5, 'world仮名'],
  ])(
    'composing %s keeps its type, key and node state',
    async (_where, offset, expected) => {
      let key = '';
      const editor = createEditor({
        initialState: () => {
          const highlight = $createHighlightNode('world');
          $setState(highlight, idState, 'h1');
          key = highlight.getKey();
          $getRoot().append(
            $createParagraphNode().append($createTextNode('hello '), highlight),
          );
        },
        nodes: [HighlightNode],
      });
      const rootElement = editor.getRootElement()!;
      await waitForRender();
      const highlightText = editor.getElementByKey(key)!.firstChild;
      assert(highlightText instanceof Text);
      rootElement.focus();
      document.getSelection()!.collapse(highlightText, offset);

      await compose(
        {editor, rootElement},
        {
          commitText: '仮名',
          steps: [{text: 'か'}, {text: 'かな'}, {text: '仮名'}],
        },
      );

      editor.read(() => {
        const children = $assertNodeType(
          $getRoot().getFirstChildOrThrow(),
          $isParagraphNode,
        ).getChildren();
        expect(children.map(node => node.getType())).toEqual([
          'text',
          'highlight',
        ]);
        const composed = children[1];
        expect(composed.getKey()).toBe(key);
        expect(composed.getTextContent()).toBe(expected);
        expect($getState(composed, idState)).toBe('h1');
      });
    },
  );

  test('composing in the middle of a segmented subclass still ends as plain text', async () => {
    let key = '';
    const editor = createEditor({
      initialState: () => {
        const mention = $createHighlightNode('JohnSmith').setMode('segmented');
        key = mention.getKey();
        $getRoot().append($createParagraphNode().append(mention));
      },
      nodes: [HighlightNode],
    });
    const rootElement = editor.getRootElement()!;
    await waitForRender();
    const mentionText = editor.getElementByKey(key)!.firstChild;
    assert(mentionText instanceof Text);
    rootElement.focus();
    document.getSelection()!.collapse(mentionText, 4);

    await compose(
      {editor, rootElement},
      {
        commitText: '仮名',
        steps: [{text: 'か'}, {text: 'かな'}, {text: '仮名'}],
      },
    );

    editor.read(() => {
      const children = $assertNodeType(
        $getRoot().getFirstChildOrThrow(),
        $isParagraphNode,
      ).getChildren();
      expect(children.map(node => node.getType())).toEqual(['text']);
      expect(children[0].getTextContent()).toBe('John仮名Smith');
    });
  });
});
