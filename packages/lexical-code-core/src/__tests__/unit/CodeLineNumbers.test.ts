/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getClipboardDataFromSelection,
  $insertDataTransferForRichText,
} from '@lexical/clipboard';
import {
  $createCodeHighlightNode,
  $createCodeNode,
  $isCodeNode,
  CodeExtension,
  CodeLineNumbersExtension,
  type CodeNode,
} from '@lexical/code-core';
import {CodePrismExtension} from '@lexical/code-prism';
import {
  CodeShikiExtension,
  loadCodeLanguage,
  loadCodeTheme,
} from '@lexical/code-shiki';
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $generateHtmlFromNodes,
  domOverride,
  DOMRenderExtension,
  type DOMRenderMatchConfig,
} from '@lexical/html';
import {RichTextExtension} from '@lexical/rich-text';
import {$setBlocksType} from '@lexical/selection';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getDOMSlot,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  $splitNode,
  type AnyLexicalExtensionArgument,
  configExtension,
  defineExtension,
  getDOMSelection,
  INSERT_PARAGRAPH_COMMAND,
  isHTMLElement,
  type LexicalEditor,
  type LexicalNode,
  LineBreakNode,
  type NodeKey,
  type PointType,
  REDO_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {$internalCreateRangeSelection} from 'lexical/src/LexicalSelection';
import {afterEach, assert, beforeAll, describe, expect, test} from 'vitest';

const LINE_NUMBERS_ATTR = 'data-lexical-code-line-numbers';
const LINE_BREAK_ATTR = 'data-lexical-code-line-break';
const WORD_WRAP_ATTR = 'data-lexical-code-word-wrap';

const OnlyWordWrappedLineNumbers = configExtension(CodeLineNumbersExtension, {
  onlyWordWrapped: true,
});

const mountedRoots: HTMLElement[] = [];
afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    root.remove();
  }
});

function mount(editor: LexicalEditor): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mountedRoots.push(root);
  editor.setRootElement(root);
  return root;
}

/** One CodeHighlightNode per non empty line, a LineBreakNode between. */
function $createCodeFromLines(lines: readonly string[]): CodeNode {
  const code = $createCodeNode('javascript');
  lines.forEach((line, i) => {
    if (i > 0) {
      code.append($createLineBreakNode());
    }
    if (line !== '') {
      code.append($createCodeHighlightNode(line));
    }
  });
  return code;
}

function $appendCode(lines: readonly string[]): void {
  $getRoot().clear().append($createCodeFromLines(lines));
}

function createEditor(
  $initialEditorState: () => void,
  dependencies: AnyLexicalExtensionArgument[] = [CodeLineNumbersExtension],
): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState,
      dependencies: [RichTextExtension, ...dependencies],
      name: '[code-line-numbers-test]',
    }),
  );
  mount(editor);
  return editor;
}

function getRootElement(editor: LexicalEditor): HTMLElement {
  const root = editor.getRootElement();
  assert(root !== null, 'expected a mounted editor');
  return root;
}

function getCodeElement(editor: LexicalEditor): HTMLElement {
  const code = getRootElement(editor).querySelector('code');
  assert(isHTMLElement(code), 'expected a rendered code block');
  return code;
}

/** The first code block in the document. */
function $getCode(): CodeNode {
  return $assertNodeType(
    $getRoot().getChildren().find($isCodeNode),
    $isCodeNode,
  );
}

/** The code blocks in the document, in order. */
function $getCodes(): CodeNode[] {
  return $getRoot().getChildren().filter($isCodeNode);
}

function getCodeElements(editor: LexicalEditor): HTMLElement[] {
  return Array.from(
    getRootElement(editor).querySelectorAll<HTMLElement>('code'),
  );
}

function setWordWrap(editor: LexicalEditor, wordWrap: boolean, index = 0) {
  editor.update(() => $getCodes()[index].setWordWrap(wordWrap), {
    discrete: true,
  });
}

function getLineBreakKeys(editor: LexicalEditor): NodeKey[] {
  return editor.read(() =>
    $getCode()
      .getChildren()
      .filter($isLineBreakNode)
      .map(node => node.getKey()),
  );
}

function getWrappers(editor: LexicalEditor): HTMLElement[] {
  return Array.from(
    getRootElement(editor).querySelectorAll<HTMLElement>(
      `[${LINE_BREAK_ATTR}]`,
    ),
  );
}

/**
 * Every LineBreakNode of the (first) code block renders as a wrapper span
 * holding only its <br>, and the wrappers are direct children of the code
 * element in model order.
 */
function expectWrappedLineBreaks(
  editor: LexicalEditor,
  lineBreakCount: number,
): HTMLElement[] {
  const codeElement = getCodeElement(editor);
  expect(codeElement.getAttribute(LINE_NUMBERS_ATTR)).toBe('true');
  const keys = getLineBreakKeys(editor);
  expect(keys).toHaveLength(lineBreakCount);
  const wrappers = getWrappers(editor);
  expect(wrappers).toHaveLength(lineBreakCount);
  keys.forEach((key, i) => {
    const dom = editor.getElementByKey(key);
    expect(dom).toBe(wrappers[i]);
    assert(dom !== null);
    expect(dom.tagName).toBe('SPAN');
    expect(dom.parentElement).toBe(codeElement);
    expect(dom.childNodes).toHaveLength(1);
    expect(dom.firstChild?.nodeName).toBe('BR');
  });
  return wrappers;
}

function expectNoLineNumberDOM(editor: LexicalEditor): void {
  const root = getRootElement(editor);
  expect(root.querySelector(`[${LINE_BREAK_ATTR}]`)).toBeNull();
  expect(root.querySelector(`[${LINE_NUMBERS_ATTR}]`)).toBeNull();
}

/**
 * Every LineBreakNode in the document renders directly inside its parent's
 * DOM, wrapped when the parent is a CodeNode and a bare <br> otherwise, and
 * no wrapper is left behind by a line break that moved or was removed.
 * Returns how many line breaks are in code blocks and how many aren't.
 */
function expectLineBreaksMatchParents(editor: LexicalEditor): {
  inCode: number;
  outside: number;
} {
  const counts = {inCode: 0, outside: 0};
  editor.read(() => {
    for (const block of $getRoot().getChildren()) {
      assert($isElementNode(block));
      const blockDOM = editor.getElementByKey(block.getKey());
      for (const child of block.getChildren()) {
        if (!$isLineBreakNode(child)) {
          continue;
        }
        const dom = editor.getElementByKey(child.getKey());
        assert(dom !== null, 'expected every line break to be rendered');
        expect(dom.parentElement).toBe(blockDOM);
        if ($isCodeNode(block)) {
          counts.inCode++;
          expect(dom.getAttribute(LINE_BREAK_ATTR)).toBe('true');
          expect(dom.childNodes).toHaveLength(1);
          expect(dom.firstChild?.nodeName).toBe('BR');
        } else {
          counts.outside++;
          expect(dom.nodeName).toBe('BR');
        }
      }
    }
  });
  expect(getWrappers(editor)).toHaveLength(counts.inCode);
  return counts;
}

function setDOMCaret(node: Node, offset: number): Selection {
  const domSelection = getDOMSelection(window);
  assert(domSelection !== null);
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  domSelection.removeAllRanges();
  domSelection.addRange(range);
  return domSelection;
}

type ResolvedCaret = Pick<PointType, 'key' | 'offset' | 'type'> & {
  /** Whether the reconciler will write the DOM caret back. */
  dirty: boolean;
};

/** Resolve a DOM caret the way a selectionchange would. */
function resolveDOMCaret(
  editor: LexicalEditor,
  node: Node,
  offset: number,
): ResolvedCaret {
  const domSelection = setDOMCaret(node, offset);
  let point: ResolvedCaret | undefined;
  editor.update(
    () => {
      const selection = $internalCreateRangeSelection(
        $getSelection(),
        domSelection,
        editor,
        {type: 'selectionchange'} as Event,
      );
      assert($isRangeSelection(selection), 'expected a RangeSelection');
      const {key, offset: pointOffset, type} = selection.anchor;
      point = {dirty: selection.dirty, key, offset: pointOffset, type};
    },
    {discrete: true},
  );
  assert(point !== undefined);
  return point;
}

const $initialMixedContent = () => {
  $getRoot()
    .clear()
    .append(
      $createParagraphNode().append(
        $createTextNode('p'),
        $createLineBreakNode(),
        $createTextNode('q'),
      ),
      $createCodeFromLines(['a', '', 'b', '']),
      $createCodeNode('javascript'),
    );
};

describe('CodeLineNumbersExtension', () => {
  describe('DOM', () => {
    test('wraps the <br> of each code line break and marks the code element', () => {
      using editor = createEditor(() => $appendCode(['a', 'b', 'c']));
      const codeElement = getCodeElement(editor);
      expectWrappedLineBreaks(editor, 2);
      // No bare <br>: the last line isn't empty so there is no managed one.
      expect(codeElement.querySelector(':scope > br')).toBeNull();
      // The numbers are CSS generated content, nothing lands in the DOM text.
      expect(codeElement.textContent).toBe('abc');
      expect(editor.read(() => $getCode().getTextContent())).toBe('a\nb\nc');
    });

    test('exposes the inner <br> through $getDOMSlot', () => {
      using editor = createEditor(() => $appendCode(['a', 'b']));
      const [key] = getLineBreakKeys(editor);
      const wrapper = editor.getElementByKey(key);
      assert(wrapper !== null);
      editor.read(() => {
        const node = $getNodeByKey(key);
        assert(node !== null);
        const slot = $getDOMSlot(node, wrapper, editor);
        expect(slot.element).toBe(wrapper.firstChild);
        expect(slot.element.tagName).toBe('BR');
      });
    });

    test('gives empty lines and a trailing empty line their own wrapper', () => {
      using editor = createEditor(() => $appendCode(['a', '', 'b', '']));
      const codeElement = getCodeElement(editor);
      const wrappers = expectWrappedLineBreaks(editor, 3);
      // The empty second line sits between two adjacent wrappers.
      expect(wrappers[0].nextSibling).toBe(wrappers[1]);
      // The reconciler still adds its managed <br> after the final wrapper
      // so the trailing empty line has height.
      expect(codeElement.lastChild?.nodeName).toBe('BR');
      expect(codeElement.lastChild?.previousSibling).toBe(wrappers[2]);
    });

    test('marks an empty code block and keeps its managed <br>', () => {
      using editor = createEditor(() => {
        $getRoot().clear().append($createCodeNode('javascript'));
      });
      const codeElement = getCodeElement(editor);
      expect(codeElement.getAttribute(LINE_NUMBERS_ATTR)).toBe('true');
      expect(codeElement.childNodes).toHaveLength(1);
      expect(codeElement.firstChild?.nodeName).toBe('BR');
      expect(getWrappers(editor)).toHaveLength(0);
    });

    test('leaves line breaks outside of code blocks alone', () => {
      using editor = createEditor($initialMixedContent);
      const paragraph = getRootElement(editor).querySelector('p');
      assert(paragraph !== null);
      expect(paragraph.querySelector(`[${LINE_BREAK_ATTR}]`)).toBeNull();
      expect(paragraph.querySelector(':scope > br')).not.toBeNull();
      expect(getWrappers(editor)).toHaveLength(3);
    });
  });

  describe('default output', () => {
    test('is unchanged when the extension is configured as disabled', () => {
      using baseline = createEditor($initialMixedContent, [CodeExtension]);
      using disabled = createEditor($initialMixedContent, [
        configExtension(CodeLineNumbersExtension, {disabled: true}),
      ]);
      expectNoLineNumberDOM(disabled);
      expect(getRootElement(disabled).innerHTML).toBe(
        getRootElement(baseline).innerHTML,
      );
    });

    test('toggling off restores the default DOM and toggling on wraps again', () => {
      using baseline = createEditor($initialMixedContent, [CodeExtension]);
      using editor = createEditor($initialMixedContent);
      const {disabled} = getExtensionDependencyFromEditor(
        editor,
        CodeLineNumbersExtension,
      ).output;
      expect(getRootElement(editor).innerHTML).not.toBe(
        getRootElement(baseline).innerHTML,
      );

      disabled.value = true;
      expectNoLineNumberDOM(editor);
      expect(getRootElement(editor).innerHTML).toBe(
        getRootElement(baseline).innerHTML,
      );
      // The line breaks render as the bare <br> again.
      for (const key of getLineBreakKeys(editor)) {
        expect(editor.getElementByKey(key)?.nodeName).toBe('BR');
      }

      disabled.value = false;
      expectWrappedLineBreaks(editor, 3);
      expect(
        getRootElement(editor).querySelectorAll(`[${LINE_NUMBERS_ATTR}]`),
      ).toHaveLength(2);

      // Editing still works after a round trip.
      editor.update(
        () => {
          $getCode().append(
            $createLineBreakNode(),
            $createCodeHighlightNode('c'),
          );
        },
        {discrete: true},
      );
      expectWrappedLineBreaks(editor, 4);
    });
  });

  describe('HTML export', () => {
    /** An empty line in the middle and an empty last line. */
    const LINES = ['a', '', 'b', ''];

    const $initialCodeAndParagraph = () => {
      $appendCode(LINES);
      $getRoot().append($createParagraphNode().append($createTextNode('z')));
    };

    function createHeadlessEditor(
      dependencies: AnyLexicalExtensionArgument[],
    ): LexicalEditorWithDispose {
      return buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: $initialCodeAndParagraph,
          dependencies: [RichTextExtension, ...dependencies],
          name: '[code-line-numbers-headless]',
        }),
      );
    }

    function exportHTML(editor: LexicalEditor): string {
      return editor.read(() => $generateHtmlFromNodes(editor, null));
    }

    /** The text/html that copying the whole document puts on the clipboard. */
    function copyHTML(editor: LexicalEditor): string {
      let html: string | undefined;
      editor.update(
        () => {
          const root = $getRoot();
          root.select(0, root.getChildrenSize());
          html = $getClipboardDataFromSelection()['text/html'];
        },
        {discrete: true},
      );
      assert(html !== undefined, 'expected text/html on the clipboard');
      return html;
    }

    describe.each([
      ['every code block', CodeLineNumbersExtension],
      ['onlyWordWrapped', OnlyWordWrappedLineNumbers],
    ])('numbering %s', (_name, lineNumbers) => {
      test.each([false, true])(
        'exports and copies the same HTML as without the extension, mounted or not (word wrap %s)',
        wordWrap => {
          using baseline = createEditor($initialCodeAndParagraph, [
            CodeExtension,
          ]);
          using mounted = createEditor($initialCodeAndParagraph, [lineNumbers]);
          using headless = createHeadlessEditor([lineNumbers]);
          for (const editor of [baseline, mounted, headless]) {
            setWordWrap(editor, wordWrap);
          }
          // The block on screen has the wrappers whenever it is numbered.
          expect(getWrappers(mounted)).toHaveLength(
            wordWrap || lineNumbers === CodeLineNumbersExtension ? 3 : 0,
          );

          const expected = exportHTML(baseline);
          const doc = new DOMParser().parseFromString(expected, 'text/html');
          const pre = doc.querySelector('pre');
          assert(pre !== null, 'expected an exported <pre>');
          expect(pre.getAttribute(WORD_WRAP_ATTR)).toBe(
            wordWrap ? 'true' : null,
          );
          // A plain <br> for each of the three line breaks, and the managed
          // one after the last, all directly in the <pre>.
          expect(pre.querySelectorAll('br')).toHaveLength(4);
          expect(pre.querySelectorAll(':scope > br')).toHaveLength(4);
          expect(expected).not.toContain(LINE_BREAK_ATTR);
          expect(expected).not.toContain(LINE_NUMBERS_ATTR);
          expect(exportHTML(mounted)).toBe(expected);
          expect(exportHTML(headless)).toBe(expected);

          const copied = copyHTML(baseline);
          expect(copied).toContain('<pre');
          expect(copyHTML(mounted)).toBe(copied);
          expect(copyHTML(headless)).toBe(copied);
        },
      );
    });

    const MARK_ATTR = 'data-mark';
    const $mark: DOMRenderMatchConfig<LexicalNode>['$createDOM'] = (
      _node,
      $next,
    ) => {
      const dom = $next();
      dom.setAttribute(MARK_ATTR, 'true');
      return dom;
    };

    test.each([
      ['LineBreakNode', domOverride([LineBreakNode], {$createDOM: $mark})],
      ['wildcard', domOverride('*', {$createDOM: $mark})],
    ])(
      'export keeps what a later %s override does to the <br>',
      (_name, override) => {
        // Composed after the extension's overrides, so its $next() returns
        // the wrapper when the extension adds one.
        const Mark = defineExtension({
          dependencies: [
            configExtension(DOMRenderExtension, {overrides: [override]}),
          ],
          name: '[mark]',
        });
        using baseline = createEditor($initialCodeAndParagraph, [
          CodeExtension,
          Mark,
        ]);
        using mounted = createEditor($initialCodeAndParagraph, [
          CodeLineNumbersExtension,
          Mark,
        ]);
        using headless = createHeadlessEditor([CodeLineNumbersExtension, Mark]);
        // On screen the mark lands on the wrapper.
        const wrappers = getWrappers(mounted);
        expect(wrappers).toHaveLength(3);
        for (const wrapper of wrappers) {
          expect(wrapper.getAttribute(MARK_ATTR)).toBe('true');
        }

        const expected = exportHTML(baseline);
        const doc = new DOMParser().parseFromString(expected, 'text/html');
        expect(doc.querySelectorAll(`pre > br[${MARK_ATTR}]`)).toHaveLength(3);
        expect(exportHTML(mounted)).toBe(expected);
        expect(exportHTML(headless)).toBe(expected);

        const copied = copyHTML(baseline);
        expect(copyHTML(mounted)).toBe(copied);
        expect(copyHTML(headless)).toBe(copied);
      },
    );

    test('a copied block pastes back with all its lines and word wrap', () => {
      using source = createEditor($initialCodeAndParagraph);
      setWordWrap(source, true);
      const html = copyHTML(source);
      using target = createEditor(() => {
        $getRoot().clear().append($createParagraphNode());
      });
      target.update(
        () => {
          $getRoot().selectStart();
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          const dataTransfer = new DataTransfer();
          dataTransfer.setData('text/html', html);
          $insertDataTransferForRichText(dataTransfer, selection, target);
        },
        {discrete: true},
      );
      target.read(() => {
        expect($getCode().getTextContent()).toBe(LINES.join('\n'));
        expect($getCode().getWordWrap()).toBe(true);
      });
      expectWrappedLineBreaks(target, 3);
    });
  });

  describe('editing lines', () => {
    test('wraps a line break added with Enter', () => {
      using editor = createEditor(() => $appendCode(['a']));
      expectWrappedLineBreaks(editor, 0);
      editor.update(
        () => {
          $getCode().selectEnd();
          editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
        },
        {discrete: true},
      );
      expectWrappedLineBreaks(editor, 1);
    });

    test('drops the wrapper of a line break deleted with Backspace', () => {
      using editor = createEditor(() => $appendCode(['a', 'b', 'c']));
      const [, secondKey] = getLineBreakKeys(editor);
      editor.update(
        () => {
          const third = $getCode().getLastChild();
          assert($isTextNode(third));
          third.select(0, 0);
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          selection.deleteCharacter(true);
        },
        {discrete: true},
      );
      expect(editor.read(() => $getCode().getTextContent())).toBe('a\nbc');
      expectWrappedLineBreaks(editor, 1);
      expect(editor.getElementByKey(secondKey)).toBeNull();
    });

    test('wraps every line break of pasted text', () => {
      using editor = createEditor(() => $appendCode(['a']));
      editor.update(
        () => {
          $getCode().selectEnd();
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          const dataTransfer = new DataTransfer();
          dataTransfer.setData('text/plain', 'x\n\ny\n');
          $insertDataTransferForRichText(dataTransfer, selection, editor);
        },
        {discrete: true},
      );
      expect(editor.read(() => $getCode().getTextContent())).toBe('ax\n\ny\n');
      const wrappers = expectWrappedLineBreaks(editor, 3);
      const codeElement = getCodeElement(editor);
      expect(codeElement.lastChild?.nodeName).toBe('BR');
      expect(codeElement.lastChild?.previousSibling).toBe(wrappers[2]);
    });

    test('recreates a wrapper whose <br> the browser removed', async () => {
      using editor = createEditor(() => $appendCode(['a', 'b', 'c']));
      const [firstKey, secondKey] = getLineBreakKeys(editor);

      // Through the mutation observer, which only marks the node dirty.
      editor.getElementByKey(firstKey)?.firstChild?.remove();
      await new Promise(resolve => setTimeout(resolve, 0));
      expectWrappedLineBreaks(editor, 2);

      // And directly through a dirty reconcile.
      editor.getElementByKey(secondKey)?.firstChild?.remove();
      editor.update(() => $getNodeByKey(secondKey)?.markDirty(), {
        discrete: true,
      });
      expectWrappedLineBreaks(editor, 2);
    });
  });

  describe('code and paragraph conversion', () => {
    test('unwraps line breaks when a code block collapses into a paragraph', () => {
      using editor = createEditor(() => $appendCode(['a', 'b']));
      const [key] = getLineBreakKeys(editor);
      editor.update(() => $getCode().collapseAtStart(), {discrete: true});
      editor.read(() => {
        expect($isParagraphNode($getRoot().getFirstChild())).toBe(true);
      });
      expectNoLineNumberDOM(editor);
      const br = editor.getElementByKey(key);
      expect(br?.nodeName).toBe('BR');
      expect(br?.parentElement?.nodeName).toBe('P');
    });

    test('unwraps line breaks when a code block becomes a paragraph', () => {
      using editor = createEditor(() => $appendCode(['a', 'b']));
      editor.update(
        () => {
          $getCode().select(0, 0);
          $setBlocksType($getSelection(), () => $createParagraphNode());
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().getTextContent()).toBe('a\nb');
        expect($isParagraphNode($getRoot().getFirstChild())).toBe(true);
      });
      expectNoLineNumberDOM(editor);
      expect(getRootElement(editor).querySelector('p > br')).not.toBeNull();
    });

    test('wraps line breaks when a paragraph becomes a code block', () => {
      using editor = createEditor(() => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('a'),
              $createLineBreakNode(),
              $createLineBreakNode(),
              $createTextNode('b'),
            ),
          );
      });
      expectNoLineNumberDOM(editor);
      editor.update(
        () => {
          $getRoot().selectStart();
          $setBlocksType($getSelection(), () => $createCodeNode('javascript'));
        },
        {discrete: true},
      );
      expectWrappedLineBreaks(editor, 2);
    });
  });

  describe('moving line breaks between blocks', () => {
    test('keeps both halves wrapped when $splitNode splits a code block', () => {
      using editor = createEditor(() => $appendCode(['a', 'b', 'c', 'd']));
      editor.update(
        () => {
          // a LB b LB c LB d: split before "c".
          const [, right] = $splitNode($getCode(), 4);
          assert($isCodeNode(right));
        },
        {discrete: true},
      );
      editor.read(() => {
        expect(
          $getRoot()
            .getChildren()
            .map(node => node.getTextContent()),
        ).toEqual(['a\nb\n', 'c\nd']);
      });
      expect(expectLineBreaksMatchParents(editor)).toEqual({
        inCode: 3,
        outside: 0,
      });
      expect(
        getRootElement(editor).querySelectorAll(`[${LINE_NUMBERS_ATTR}]`),
      ).toHaveLength(2);
    });

    test('unwraps the line breaks a cross block delete moves into a paragraph', () => {
      using editor = createEditor(() => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append($createTextNode('x')),
            $createCodeFromLines(['a', 'b', 'c']),
          );
      });
      editor.update(
        () => {
          // From the end of "x" to the end of "a", so the rest of the code
          // block joins the paragraph.
          const paragraphText = $getRoot().getFirstDescendant();
          const codeText = $getCode().getFirstChild();
          assert($isTextNode(paragraphText) && $isTextNode(codeText));
          const selection = $createRangeSelection();
          selection.anchor.set(paragraphText.getKey(), 1, 'text');
          selection.focus.set(codeText.getKey(), 1, 'text');
          $setSelection(selection);
          selection.removeText();
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().getChildrenSize()).toBe(1);
        expect($isParagraphNode($getRoot().getFirstChild())).toBe(true);
        expect($getRoot().getTextContent()).toBe('x\nb\nc');
      });
      expect(expectLineBreaksMatchParents(editor)).toEqual({
        inCode: 0,
        outside: 2,
      });
      expectNoLineNumberDOM(editor);
    });

    test('wraps the line breaks a cross block delete moves into a code block', () => {
      using editor = createEditor(() => {
        $getRoot()
          .clear()
          .append(
            $createCodeFromLines(['a', 'b']),
            $createParagraphNode().append(
              $createTextNode('p'),
              $createLineBreakNode(),
              $createTextNode('q'),
            ),
          );
      });
      editor.update(
        () => {
          // From the end of "b" to the end of "p", so the rest of the
          // paragraph joins the code block.
          const codeText = $getCode().getLastChild();
          const paragraphText = $getRoot().getLastChildOrThrow();
          assert($isElementNode(paragraphText));
          const pText = paragraphText.getFirstChild();
          assert($isTextNode(codeText) && $isTextNode(pText));
          const selection = $createRangeSelection();
          selection.anchor.set(codeText.getKey(), 1, 'text');
          selection.focus.set(pText.getKey(), 1, 'text');
          $setSelection(selection);
          selection.removeText();
        },
        {discrete: true},
      );
      editor.read(() => {
        expect($getRoot().getChildrenSize()).toBe(1);
        expect($getRoot().getTextContent()).toBe('a\nb\nq');
      });
      expect(expectLineBreaksMatchParents(editor)).toEqual({
        inCode: 2,
        outside: 0,
      });
    });

    test('undo and redo of collapseAtStart wrap and unwrap the restored line breaks', () => {
      using editor = createEditor(
        () => $appendCode(['a', 'b', 'c']),
        [
          CodeLineNumbersExtension,
          configExtension(HistoryExtension, {delay: 0}),
        ],
      );
      const inCode = {inCode: 2, outside: 0};
      const inParagraph = {inCode: 0, outside: 2};
      editor.update(() => $getCode().collapseAtStart(), {discrete: true});
      expect(expectLineBreaksMatchParents(editor)).toEqual(inParagraph);
      expectNoLineNumberDOM(editor);

      editor.dispatchCommand(UNDO_COMMAND, undefined);
      expect(expectLineBreaksMatchParents(editor)).toEqual(inCode);
      expect(getCodeElement(editor).getAttribute(LINE_NUMBERS_ATTR)).toBe(
        'true',
      );

      editor.dispatchCommand(REDO_COMMAND, undefined);
      expect(expectLineBreaksMatchParents(editor)).toEqual(inParagraph);
      expectNoLineNumberDOM(editor);

      editor.dispatchCommand(UNDO_COMMAND, undefined);
      expect(expectLineBreaksMatchParents(editor)).toEqual(inCode);
    });
  });

  describe('selection', () => {
    // a, LB, LB, b: the second line is empty.
    function createSelectionEditor() {
      const editor = createEditor(() => $appendCode(['a', '', 'b']));
      const codeKey = editor.read(() => $getCode().getKey());
      const [first, second] = expectWrappedLineBreaks(editor, 2);
      return {codeKey, editor, first, second};
    }

    // The wrapper offsets on their own are pinned in lexical's
    // LexicalSelectionResolveLeafPosition tests.
    test('every DOM caret on an empty line resolves to the same point', () => {
      const {codeKey, editor, first, second} = createSelectionEditor();
      using _editor = editor;
      const emptyLine = {key: codeKey, offset: 2, type: 'element'};
      const codeElement = getCodeElement(editor);
      // After the first wrapper, between the wrappers, before the second
      // <br>. These carets are on keyed DOM, so they aren't dirty and the
      // DOM caret stays where the browser put it.
      expect(resolveDOMCaret(editor, first, 1)).toEqual({
        ...emptyLine,
        dirty: false,
      });
      expect(resolveDOMCaret(editor, codeElement, 2)).toEqual({
        ...emptyLine,
        dirty: false,
      });
      expect(resolveDOMCaret(editor, second, 0)).toEqual({
        ...emptyLine,
        dirty: false,
      });
      // A caret reported on the <br> itself counts as before the break. The
      // <br> has no key, so it's dirty and gets written back onto the code
      // element.
      const br = second.firstChild;
      assert(br !== null);
      expect(resolveDOMCaret(editor, br, 0)).toEqual({
        ...emptyLine,
        dirty: true,
      });
    });

    test('a caret in the text of a line is unchanged', () => {
      const {editor} = createSelectionEditor();
      using _editor = editor;
      const textKey = editor.read(() =>
        $getCode().getLastChildOrThrow().getKey(),
      );
      const textDOM = editor.getElementByKey(textKey)?.firstChild;
      assert(textDOM !== null && textDOM !== undefined);
      expect(resolveDOMCaret(editor, textDOM, 1)).toEqual({
        dirty: false,
        key: textKey,
        offset: 1,
        type: 'text',
      });
    });

    test('an element point is written between the wrappers, never inside one', () => {
      const {editor, second} = createSelectionEditor();
      using _editor = editor;
      const codeElement = getCodeElement(editor);
      getRootElement(editor).focus();
      editor.update(() => $getCode().select(2, 2), {discrete: true});
      const domSelection = getDOMSelection(window);
      assert(domSelection !== null);
      expect(domSelection.anchorNode).toBe(codeElement);
      expect(domSelection.anchorOffset).toBe(2);
      expect(codeElement.childNodes[domSelection.anchorOffset]).toBe(second);
    });
  });

  describe('onlyWordWrapped', () => {
    test('renders the default DOM while no block has word wrap on', () => {
      using baseline = createEditor($initialMixedContent, [CodeExtension]);
      using editor = createEditor($initialMixedContent, [
        OnlyWordWrappedLineNumbers,
      ]);
      expectNoLineNumberDOM(editor);
      expect(getRootElement(editor).innerHTML).toBe(
        getRootElement(baseline).innerHTML,
      );
    });

    test('numbers a block while its word wrap is on', () => {
      using baseline = createEditor($initialMixedContent, [CodeExtension]);
      using editor = createEditor($initialMixedContent, [
        OnlyWordWrappedLineNumbers,
      ]);
      const before = getCodeElement(editor);

      setWordWrap(editor, true);
      // The block was recreated with a wrapper on each of its line breaks.
      expect(getCodeElement(editor)).not.toBe(before);
      expectWrappedLineBreaks(editor, 3);
      const [first, second] = getCodeElements(editor);
      expect(first.getAttribute(WORD_WRAP_ATTR)).toBe('true');
      // The empty block has word wrap off, so it keeps the default DOM.
      expect(second.hasAttribute(LINE_NUMBERS_ATTR)).toBe(false);
      expect(editor.read(() => $getCode().getTextContent())).toBe('a\n\nb\n');

      setWordWrap(editor, false);
      expectNoLineNumberDOM(editor);
      expect(getRootElement(editor).innerHTML).toBe(
        getRootElement(baseline).innerHTML,
      );
    });

    test('undo and redo of word wrap unwrap and wrap the line breaks', () => {
      using baseline = createEditor($initialMixedContent, [CodeExtension]);
      using editor = createEditor($initialMixedContent, [
        OnlyWordWrappedLineNumbers,
        configExtension(HistoryExtension, {delay: 0}),
      ]);
      setWordWrap(editor, true);
      expectWrappedLineBreaks(editor, 3);

      // editor.read flushes the history update before the DOM is checked.
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      expect(editor.read(() => $getCode().getWordWrap())).toBe(false);
      expectNoLineNumberDOM(editor);
      expect(getRootElement(editor).innerHTML).toBe(
        getRootElement(baseline).innerHTML,
      );

      editor.dispatchCommand(REDO_COMMAND, undefined);
      expect(editor.read(() => $getCode().getWordWrap())).toBe(true);
      expectWrappedLineBreaks(editor, 3);
      expect(getCodeElement(editor).getAttribute(WORD_WRAP_ATTR)).toBe('true');
    });

    test('a caret in the block stays put when its DOM is recreated', () => {
      using editor = createEditor(
        () => $appendCode(['ab', 'cd']),
        [OnlyWordWrappedLineNumbers],
      );
      getRootElement(editor).focus();
      const textKey = editor.read(() =>
        $getCode().getLastChildOrThrow().getKey(),
      );
      editor.update(
        () => {
          const text = $getNodeByKey(textKey);
          assert($isTextNode(text));
          text.select(1, 1);
        },
        {discrete: true},
      );

      for (const wordWrap of [true, false]) {
        const before = getCodeElement(editor);
        setWordWrap(editor, wordWrap);
        const codeElement = getCodeElement(editor);
        expect(codeElement).not.toBe(before);
        editor.read(() => {
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          expect(selection.isCollapsed()).toBe(true);
          expect(selection.anchor.key).toBe(textKey);
          expect(selection.anchor.offset).toBe(1);
        });
        const domSelection = getDOMSelection(window);
        assert(domSelection !== null);
        const {anchorNode} = domSelection;
        assert(anchorNode !== null);
        expect(anchorNode.isConnected).toBe(true);
        expect(codeElement.contains(anchorNode)).toBe(true);
        expect(anchorNode).toBe(editor.getElementByKey(textKey)?.firstChild);
        expect(domSelection.anchorOffset).toBe(1);
      }
    });

    test('the onlyWordWrapped signal switches between the modes', () => {
      using editor = createEditor(() => {
        $getRoot()
          .clear()
          .append(
            $createCodeFromLines(['a', 'b']).setWordWrap(true),
            $createCodeFromLines(['c', 'd']),
          );
      });
      const {disabled, onlyWordWrapped} = getExtensionDependencyFromEditor(
        editor,
        CodeLineNumbersExtension,
      ).output;
      const expectNumbered = (numbered: boolean[]) => {
        const codeElements = getCodeElements(editor);
        expect(
          codeElements.map(code => code.hasAttribute(LINE_NUMBERS_ATTR)),
        ).toEqual(numbered);
        expect(
          codeElements.map(
            code => code.querySelectorAll(`[${LINE_BREAK_ATTR}]`).length,
          ),
        ).toEqual(numbered.map(isNumbered => (isNumbered ? 1 : 0)));
        expect(
          codeElements.map(code => code.querySelectorAll('br').length),
        ).toEqual([1, 1]);
      };
      expectNumbered([true, true]);

      onlyWordWrapped.value = true;
      expectNumbered([true, false]);

      // disabled wins over onlyWordWrapped.
      disabled.value = true;
      expectNoLineNumberDOM(editor);
      disabled.value = false;
      expectNumbered([true, false]);

      onlyWordWrapped.value = false;
      expectNumbered([true, true]);
    });

    test('a line break keeps a wrapper only while its block has word wrap on', () => {
      using editor = createEditor(() => {
        $getRoot()
          .clear()
          .append(
            $createCodeFromLines(['a', 'b']).setWordWrap(true),
            $createCodeFromLines(['c']),
          );
      }, [OnlyWordWrappedLineNumbers]);
      const [key] = getLineBreakKeys(editor);
      const moveLineBreak = (to: number) => {
        editor.update(
          () => {
            const lineBreak = $getNodeByKey(key);
            assert($isLineBreakNode(lineBreak));
            $getCodes()[to].append(lineBreak);
          },
          {discrete: true},
        );
        return editor.getElementByKey(key);
      };

      const inUnwrapped = moveLineBreak(1);
      expect(inUnwrapped?.nodeName).toBe('BR');
      expect(inUnwrapped?.parentElement).toBe(getCodeElements(editor)[1]);
      expect(getWrappers(editor)).toHaveLength(0);

      const inWrapped = moveLineBreak(0);
      expect(inWrapped?.getAttribute(LINE_BREAK_ATTR)).toBe('true');
      expect(inWrapped?.parentElement).toBe(getCodeElements(editor)[0]);
      expect(getWrappers(editor)).toHaveLength(1);
    });
  });

  describe.each([
    ['Prism', CodePrismExtension],
    ['Shiki', CodeShikiExtension],
  ] as const)('with %s highlighting', (_name, HighlighterExtension) => {
    const $initialCode = () => $appendCode(['const a = 1;', 'let b;']);

    beforeAll(async () => {
      // Shiki defers highlighting until the grammar and theme have loaded.
      await loadCodeLanguage('javascript');
      await loadCodeTheme('one-light');
      // Shiki compiles the grammar the first time it tokenizes with it, and
      // it stops splitting a line that takes longer than 500ms. On a busy
      // machine the first line of the first test could then stay one token.
      // Tokenize once here, so no test pays for that.
      using _warmUp = createEditor($initialCode, [HighlighterExtension]);
    });

    function getGutter(editor: LexicalEditor): string | null {
      return getCodeElement(editor).getAttribute('data-gutter');
    }

    test('renders the default DOM, data-gutter included, when disabled', () => {
      using baseline = createEditor($initialCode, [HighlighterExtension]);
      using disabled = createEditor($initialCode, [
        HighlighterExtension,
        configExtension(CodeLineNumbersExtension, {disabled: true}),
      ]);
      // Both blocks were split into tokens, the first line included, so the
      // comparison below covers the highlighter's DOM too.
      for (const editor of [baseline, disabled]) {
        expect(
          editor.read(() => $getCode().getFirstChildOrThrow().getTextContent()),
        ).toBe('const');
      }
      expect(getGutter(baseline)).toBe('1\n2');
      expectNoLineNumberDOM(disabled);
      expect(getRootElement(disabled).innerHTML).toBe(
        getRootElement(baseline).innerHTML,
      );
    });

    test('keeps the wrappers and data-gutter in step while retokenizing', () => {
      using editor = createEditor($initialCode, [
        HighlighterExtension,
        CodeLineNumbersExtension,
      ]);
      // Highlighting split the lines into tokens.
      expect(editor.read(() => $getCode().getChildrenSize())).toBeGreaterThan(
        3,
      );
      expectWrappedLineBreaks(editor, 1);
      expect(getGutter(editor)).toBe('1\n2');

      editor.update(
        () => {
          const code = $getCode();
          const lineBreak = code.getChildren().find($isLineBreakNode);
          assert(lineBreak !== undefined);
          const index = lineBreak.getIndexWithinParent();
          code.select(index, index);
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          selection.insertText(' // one');
        },
        {discrete: true},
      );
      expect(editor.read(() => $getCode().getTextContent())).toBe(
        'const a = 1; // one\nlet b;',
      );
      expectWrappedLineBreaks(editor, 1);
      expect(getGutter(editor)).toBe('1\n2');

      editor.update(
        () => {
          $getCode().selectEnd();
          editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
        },
        {discrete: true},
      );
      expectWrappedLineBreaks(editor, 2);
      expect(getGutter(editor)).toBe('1\n2\n3');
    });

    test('with onlyWordWrapped, a wrapped block keeps its wrappers and data-gutter in step', () => {
      using editor = createEditor($initialCode, [
        HighlighterExtension,
        OnlyWordWrappedLineNumbers,
      ]);
      expectNoLineNumberDOM(editor);
      expect(getGutter(editor)).toBe('1\n2');

      setWordWrap(editor, true);
      expectWrappedLineBreaks(editor, 1);
      expect(getCodeElement(editor).getAttribute(WORD_WRAP_ATTR)).toBe('true');
      expect(getGutter(editor)).toBe('1\n2');

      editor.update(
        () => {
          const code = $getCode();
          const lineBreak = code.getChildren().find($isLineBreakNode);
          assert(lineBreak !== undefined);
          const index = lineBreak.getIndexWithinParent();
          code.select(index, index);
          const selection = $getSelection();
          assert($isRangeSelection(selection));
          selection.insertText(' // one');
        },
        {discrete: true},
      );
      expect(editor.read(() => $getCode().getChildrenSize())).toBeGreaterThan(
        3,
      );
      expectWrappedLineBreaks(editor, 1);
      expect(getGutter(editor)).toBe('1\n2');

      editor.update(
        () => {
          $getCode().selectEnd();
          editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
        },
        {discrete: true},
      );
      expectWrappedLineBreaks(editor, 2);
      expect(getCodeElement(editor).getAttribute(WORD_WRAP_ATTR)).toBe('true');
      expect(getGutter(editor)).toBe('1\n2\n3');

      setWordWrap(editor, false);
      expectNoLineNumberDOM(editor);
      expect(getCodeElement(editor).hasAttribute(WORD_WRAP_ATTR)).toBe(false);
      expect(getGutter(editor)).toBe('1\n2\n3');
    });

    test('data-gutter is written again after toggling the extension', () => {
      using editor = createEditor($initialCode, [
        HighlighterExtension,
        CodeLineNumbersExtension,
      ]);
      const {disabled} = getExtensionDependencyFromEditor(
        editor,
        CodeLineNumbersExtension,
      ).output;
      const before = getCodeElement(editor);
      disabled.value = true;
      // The code element was recreated without the extension's attribute,
      // and the highlighter's mutation listener filled in its gutter.
      expect(getCodeElement(editor)).not.toBe(before);
      expectNoLineNumberDOM(editor);
      expect(getGutter(editor)).toBe('1\n2');
      disabled.value = false;
      expectWrappedLineBreaks(editor, 1);
      expect(getGutter(editor)).toBe('1\n2');
    });
  });
});
