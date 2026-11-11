/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {domOverride, DOMRenderExtension} from '@lexical/html';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  configExtension,
  defineExtension,
  getDOMSelection,
  isHTMLElement,
  LineBreakNode,
} from 'lexical';
import {
  afterEach,
  assert,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';

import {$internalCreateRangeSelection} from '../../LexicalSelection';

describe('Selection resolution for leaf nodes (resolveLeafPosition)', () => {
  const mountedRoots: HTMLElement[] = [];
  afterEach(() => {
    while (mountedRoots.length > 0) {
      const node = mountedRoots.pop();
      if (node && node.parentNode) {
        node.parentNode.removeChild(node);
      }
    }
  });

  function mountRoot(editor: LexicalEditorWithDispose) {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountedRoots.push(root);
    editor.setRootElement(root);
    return root;
  }

  test('DOM caret directly on a bare <br> at offset 0 resolves to "after" the LineBreakNode', () => {
    using editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: () => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('before'),
                $createLineBreakNode(),
                $createTextNode('after'),
              ),
            );
        },
        name: '[bare-leaf-resolve]',
      }),
    );
    mountRoot(editor);

    let linebreakKey = '';
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChildOrThrow();
        if ($isElementNode(paragraph)) {
          const br = paragraph.getChildAtIndex(1);
          assert(br !== null);
          linebreakKey = br.getKey();
        }
      },
      {discrete: true},
    );

    const brDOM = editor.getElementByKey(linebreakKey);
    assert(brDOM !== null);

    const domSelection = getDOMSelection(editor._window ?? window);
    const range = document.createRange();
    range.setStart(brDOM, 0);
    range.collapse(true);
    domSelection?.removeAllRanges();
    domSelection?.addRange(range);

    editor.update(
      () => {
        const selection = $internalCreateRangeSelection(
          $getSelection(),
          domSelection,
          editor,
          {type: 'selectionchange'} as Event,
        );
        assert(selection !== null);
        assert($isRangeSelection(selection));
        const paragraph = $getRoot().getFirstChildOrThrow();
        // Pre-PR behavior: caret on bare <br> at offset 0 resolves
        // to "after" the LineBreakNode, i.e. paragraph element
        // offset == linebreak.index + 1 (= 2 here: between LB and
        // the "after" TextNode).
        expect(selection.anchor.key).toBe(paragraph.getKey());
        expect(selection.anchor.type).toBe('element');
        expect(selection.anchor.offset).toBe(2);
      },
      {discrete: true},
    );
  });

  describe('wrap pattern via DOMRenderExtension override', () => {
    function buildWrapEditor() {
      return buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: () => {
            const paragraph = $createParagraphNode().append(
              $createTextNode('before'),
              $createLineBreakNode(),
              $createTextNode('after'),
            );
            $getRoot().clear().append(paragraph);
          },
          dependencies: [
            configExtension(DOMRenderExtension, {
              overrides: [
                domOverride([LineBreakNode], {
                  $createDOM: (_node, $next) => {
                    const inner = $next();
                    const wrapper = document.createElement('span');
                    wrapper.setAttribute('data-wrap', 'true');
                    wrapper.appendChild(inner);
                    return wrapper;
                  },
                  $getDOMSlot: (_node, dom, $next) => {
                    const br = dom.querySelector(':scope > br');
                    return isHTMLElement(br)
                      ? $next().withElement(br)
                      : $next();
                  },
                }),
              ],
            }),
          ],
          name: '[wrap-leaf-resolve]',
        }),
      );
    }

    function getLineBreakKey(editor: LexicalEditorWithDispose) {
      let lbKey = '';
      editor.update(
        () => {
          const paragraph = $getRoot().getFirstChildOrThrow();
          if ($isElementNode(paragraph)) {
            const br = paragraph.getChildAtIndex(1);
            if (br) {
              lbKey = br.getKey();
            }
          }
        },
        {discrete: true},
      );
      return lbKey;
    }

    test('DOM caret inside the wrap <span> at offset 0 (before the inner <br>) resolves to "before" the LineBreakNode', () => {
      using editor = buildWrapEditor();
      mountRoot(editor);
      const lbKey = getLineBreakKey(editor);
      const wrapDOM = editor.getElementByKey(lbKey);
      assert(wrapDOM !== null);
      // Sanity: the keyed DOM is the wrap span, not the <br>.
      expect(wrapDOM.tagName).toBe('SPAN');
      expect(wrapDOM.getAttribute('data-wrap')).toBe('true');

      const domSelection = getDOMSelection(editor._window ?? window);
      const range = document.createRange();
      range.setStart(wrapDOM, 0);
      range.collapse(true);
      domSelection?.removeAllRanges();
      domSelection?.addRange(range);

      editor.update(
        () => {
          const selection = $internalCreateRangeSelection(
            $getSelection(),
            domSelection,
            editor,
            {type: 'selectionchange'} as Event,
          );
          assert(selection !== null);
          assert($isRangeSelection(selection));
          const paragraph = $getRoot().getFirstChildOrThrow();
          expect(selection.anchor.key).toBe(paragraph.getKey());
          expect(selection.anchor.type).toBe('element');
          // "before" the LB → paragraph element offset == LB index (1).
          expect(selection.anchor.offset).toBe(1);
        },
        {discrete: true},
      );
    });

    test('DOM caret inside the wrap <span> at offset 1 (after the inner <br>) resolves to "after" the LineBreakNode', () => {
      using editor = buildWrapEditor();
      mountRoot(editor);
      const lbKey = getLineBreakKey(editor);
      const wrapDOM = editor.getElementByKey(lbKey);
      assert(wrapDOM !== null);

      const domSelection = getDOMSelection(editor._window ?? window);
      const range = document.createRange();
      range.setStart(wrapDOM, 1);
      range.collapse(true);
      domSelection?.removeAllRanges();
      domSelection?.addRange(range);

      editor.update(
        () => {
          const selection = $internalCreateRangeSelection(
            $getSelection(),
            domSelection,
            editor,
            {type: 'selectionchange'} as Event,
          );
          assert(selection !== null);
          assert($isRangeSelection(selection));
          const paragraph = $getRoot().getFirstChildOrThrow();
          expect(selection.anchor.key).toBe(paragraph.getKey());
          expect(selection.anchor.type).toBe('element');
          // "after" the LB → paragraph element offset == LB index + 1 (2).
          expect(selection.anchor.offset).toBe(2);
        },
        {discrete: true},
      );
    });

    test('a caret just before the wrapped line break is scrolled into view by the inner <br>, not the wrapper', () => {
      using editor = buildWrapEditor();
      const root = mountRoot(editor);
      const wrapDOM = editor.getElementByKey(getLineBreakKey(editor));
      assert(wrapDOM !== null);
      const br = wrapDOM.firstElementChild;
      assert(br !== null && br.tagName === 'BR');
      const paragraphDOM = root.firstElementChild;
      assert(isHTMLElement(paragraphDOM));
      onTestFinished(() => {
        vi.restoreAllMocks();
      });

      // The paragraph scrolls sideways. Its scrollport is 300px wide at x 0,
      // and it is scrolled 1000px in.
      paragraphDOM.style.overflowX = 'auto';
      for (const [name, value] of Object.entries({
        clientWidth: 300,
        scrollWidth: 5000,
      })) {
        Object.defineProperty(paragraphDOM, name, {configurable: true, value});
      }
      paragraphDOM.scrollLeft = 1000;
      vi.spyOn(paragraphDOM, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 0, 300, 100),
      );
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 0, 800, 600),
      );
      vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
      // The <br> ends the first line at x 400, just past the view. The
      // wrapper's rect also covers the start of the next line, 1000px left of
      // the view, as it does when the wrapper draws that line's number there.
      vi.spyOn(br, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(400, 10, 0, 20),
      );
      vi.spyOn(wrapDOM, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(-1000, 10, 1400, 40),
      );
      root.tabIndex = 0;
      root.focus();
      expect(document.activeElement).toBe(root);

      // The caret goes just before the line break, where insertLineBreak(true)
      // leaves it.
      editor.update(
        () => {
          const paragraph = $getRoot().getFirstChildOrThrow();
          assert($isElementNode(paragraph));
          paragraph.select(1, 1);
        },
        {discrete: true},
      );
      // The caret, painted 1px wide, ends at 401, which is 101px past the
      // view. Measuring the wrapper would scroll all the way back to 0.
      expect(paragraphDOM.scrollLeft).toBe(1101);
    });
  });
});
