/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getClipboardDataFromSelection,
  $handlePlainTextDrop,
  $handleRichTextDrop,
  $writeDragSourceToDataTransfer,
  setLexicalClipboardDataTransfer,
} from '@lexical/clipboard';
import {registerRichText} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isDecoratorNode,
  $isElementNode,
  $isRangeSelection,
  $setSelection,
  DecoratorNode,
  type ElementDOMSlot,
  ElementNode,
  type LexicalEditor,
  type RangeSelection,
  TextNode,
} from 'lexical';
import {
  $createTestDecoratorNode,
  $createTestInlineElementNode,
  createTestEditor,
  initializeUnitTest,
  invariant,
} from 'lexical/src/__tests__/utils';
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  type Mock,
  test,
  vi,
} from 'vitest';

const caretFromPointState = vi.hoisted(() => ({
  current: (_x: number, _y: number): null | {node: Node; offset: number} =>
    null,
}));

// `$handleRichTextDrop` (in @lexical/clipboard) resolves the drop caret via
// `./caretFromPoint`, which jsdom can't hit-test. Mock that exact module via
// its `@lexical/clipboard/src/caretFromPoint` test alias.
vi.mock('@lexical/clipboard/src/caretFromPoint', () => ({
  caretFromPoint: (x: number, y: number) => caretFromPointState.current(x, y),
}));

function setCaretFromPoint(node: Node, offset: number): void {
  caretFromPointState.current = () => ({node, offset});
}

function createDropEvent(): {
  event: DragEvent;
  dataTransfer: DataTransfer;
  preventDefault: Mock<() => void>;
} {
  const dataTransfer = new DataTransfer();
  const event = new DragEvent('drop', {
    clientX: 0,
    clientY: 0,
    dataTransfer,
  });
  const preventDefault = vi.fn(() => {});
  Object.defineProperty(event, 'preventDefault', {
    enumerable: false,
    value: preventDefault,
  });
  return {dataTransfer, event, preventDefault};
}

function getParagraphTextDOM(editor: LexicalEditor, textKey: string): Text {
  const span = editor.getElementByKey(textKey);
  invariant(span !== null, 'span is null');
  const textNode = span.firstChild;
  invariant(
    textNode !== null && textNode.nodeType === Node.TEXT_NODE,
    'expected DOM text node',
  );
  return textNode as Text;
}

function $markActiveSelectionAsDragSource(
  dataTransfer: DataTransfer,
  editor: LexicalEditor,
): void {
  const sel = $getSelection();
  if ($isRangeSelection(sel) && !sel.isCollapsed()) {
    $writeDragSourceToDataTransfer(dataTransfer, editor);
  }
}

describe('$handleTextDrop', () => {
  initializeUnitTest(testEnv => {
    beforeEach(() => {
      caretFromPointState.current = () => null;
    });

    test('moves a selected word later within the same TextNode', async () => {
      const {editor} = testEnv;
      let textKey = '';
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const text = $createTextNode('Hello foo world');
        paragraph.append(text);
        $getRoot().clear().append(paragraph);
        textKey = text.getKey();

        const selection = $createRangeSelection();
        selection.anchor.set(textKey, 6, 'text');
        selection.focus.set(textKey, 9, 'text');
        $setSelection(selection);
      });

      await editor.update(() => {
        const domText = getParagraphTextDOM(editor, textKey);
        // Drop position at offset 15 ("Hello foo world|"), past the source's end.
        setCaretFromPoint(domText, 15);
        const {dataTransfer, event, preventDefault} = createDropEvent();
        dataTransfer.setData('text/plain', 'foo');
        $markActiveSelectionAsDragSource(dataTransfer, editor);
        const handled = $handleRichTextDrop(event, editor);
        expect(handled).toBe(true);
        expect(preventDefault).toHaveBeenCalled();
      });

      await editor.read(() => {
        expect($getRoot().getTextContent()).toBe('Hello  worldfoo');
      });
    });

    test('moves a selected word earlier within the same TextNode', async () => {
      const {editor} = testEnv;
      let textKey = '';
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const text = $createTextNode('Hello foo world');
        paragraph.append(text);
        $getRoot().clear().append(paragraph);
        textKey = text.getKey();

        const selection = $createRangeSelection();
        selection.anchor.set(textKey, 6, 'text');
        selection.focus.set(textKey, 9, 'text');
        $setSelection(selection);
      });

      await editor.update(() => {
        const domText = getParagraphTextDOM(editor, textKey);
        // Drop position at offset 0 (before the source).
        setCaretFromPoint(domText, 0);
        const {dataTransfer, event} = createDropEvent();
        dataTransfer.setData('text/plain', 'foo');
        $markActiveSelectionAsDragSource(dataTransfer, editor);
        $handleRichTextDrop(event, editor);
      });

      await editor.read(() => {
        expect($getRoot().getTextContent()).toBe('fooHello  world');
      });
    });

    test('no-op when the drop point is inside the source range', async () => {
      const {editor} = testEnv;
      let textKey = '';
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const text = $createTextNode('Hello foo world');
        paragraph.append(text);
        $getRoot().clear().append(paragraph);
        textKey = text.getKey();

        const selection = $createRangeSelection();
        selection.anchor.set(textKey, 6, 'text');
        selection.focus.set(textKey, 9, 'text');
        $setSelection(selection);
      });

      await editor.update(() => {
        const domText = getParagraphTextDOM(editor, textKey);
        // Drop inside the selected "foo" range.
        setCaretFromPoint(domText, 7);
        const {dataTransfer, event, preventDefault} = createDropEvent();
        dataTransfer.setData('text/plain', 'foo');
        $markActiveSelectionAsDragSource(dataTransfer, editor);
        const handled = $handleRichTextDrop(event, editor);
        expect(handled).toBe(true);
        expect(preventDefault).toHaveBeenCalled();
      });

      await editor.read(() => {
        expect($getRoot().getTextContent()).toBe('Hello foo world');
      });
    });

    test('keeps the dragged text when dropped on the end edge of the source range', async () => {
      const {editor} = testEnv;
      let boldKey = '';
      let restKey = '';
      await editor.update(() => {
        const bold = $createTextNode('Hello').toggleFormat('bold');
        const rest = $createTextNode(' world');
        $getRoot().clear().append($createParagraphNode().append(bold, rest));
        boldKey = bold.getKey();
        restKey = rest.getKey();
        bold.select(0, 5);
      });

      // Drop at the end of "Hello", then at the start of " world".
      for (const [key, offset] of [
        [boldKey, 5],
        [restKey, 0],
      ] as const) {
        await editor.update(() => {
          setCaretFromPoint(getParagraphTextDOM(editor, key), offset);
          const {dataTransfer, event} = createDropEvent();
          dataTransfer.setData('text/plain', 'Hello');
          $markActiveSelectionAsDragSource(dataTransfer, editor);
          expect($handleRichTextDrop(event, editor)).toBe(true);
        });
        await editor.read(() => {
          expect($getRoot().getTextContent()).toBe('Hello world');
        });
      }
    });

    test('moves a selection across TextNodes in the same block', async () => {
      const {editor} = testEnv;
      let sourceKey = '';
      let destKey = '';
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const source = $createTextNode('source ').toggleFormat('bold');
        const dest = $createTextNode('destination');
        paragraph.append(source, dest);
        $getRoot().clear().append(paragraph);
        sourceKey = source.getKey();
        destKey = dest.getKey();

        const selection = $createRangeSelection();
        selection.anchor.set(sourceKey, 0, 'text');
        selection.focus.set(sourceKey, 6, 'text');
        $setSelection(selection);
      });

      await editor.update(() => {
        const domText = getParagraphTextDOM(editor, destKey);
        // Drop just after the "t" of "destination" (offset 4 into "destination").
        setCaretFromPoint(domText, 4);
        const {dataTransfer, event} = createDropEvent();
        dataTransfer.setData('text/plain', 'source');
        $markActiveSelectionAsDragSource(dataTransfer, editor);
        $handleRichTextDrop(event, editor);
      });

      await editor.read(() => {
        // " " from the source TextNode is preserved where it was, and "source"
        // is inserted into the destination TextNode at offset 4.
        expect($getRoot().getTextContent()).toBe(' destsourceination');
      });
    });

    test('returns false for an external drag (no marker), letting the browser handle it', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('Hello world'));
        $getRoot().clear().append(paragraph);
      });

      let handled = true;
      let preventDefault: Mock | null = null;
      await editor.update(() => {
        const {dataTransfer, event, preventDefault: pd} = createDropEvent();
        dataTransfer.setData('text/plain', 'brave ');
        // No drag-source marker — this represents an external drag. The
        // handler should bail so the browser's native drag-drop flow (which
        // fires beforeinput insertFromDrop on the destination) takes over.
        preventDefault = pd;
        handled = $handleRichTextDrop(event, editor);
      });
      expect(handled).toBe(false);
      expect(preventDefault).not.toBeNull();
      expect(preventDefault!).not.toHaveBeenCalled();
    });

    test('returns false when caretFromPoint cannot resolve a location', async () => {
      const {editor} = testEnv;
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('Hello'));
        $getRoot().clear().append(paragraph);
      });

      let handled = true;
      let preventDefault: Mock | null = null;
      await editor.update(() => {
        const {event, preventDefault: pd} = createDropEvent();
        preventDefault = pd;
        handled = $handleRichTextDrop(event, editor);
      });
      expect(handled).toBe(false);
      expect(preventDefault).not.toBeNull();
      expect(preventDefault!).not.toHaveBeenCalled();
    });

    test('handles a backward (right-to-left) source selection', async () => {
      const {editor} = testEnv;
      let textKey = '';
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const text = $createTextNode('Hello foo world');
        paragraph.append(text);
        $getRoot().clear().append(paragraph);
        textKey = text.getKey();

        // Backward selection: anchor > focus in "foo".
        const selection = $createRangeSelection();
        selection.anchor.set(textKey, 9, 'text');
        selection.focus.set(textKey, 6, 'text');
        $setSelection(selection);
        const current = $getSelection();
        invariant(
          $isRangeSelection(current) && current.isBackward(),
          'expected backward selection',
        );
      });

      await editor.update(() => {
        const domText = getParagraphTextDOM(editor, textKey);
        setCaretFromPoint(domText, 15);
        const {dataTransfer, event} = createDropEvent();
        dataTransfer.setData('text/plain', 'foo');
        $markActiveSelectionAsDragSource(dataTransfer, editor);
        $handleRichTextDrop(event, editor);
      });

      await editor.read(() => {
        expect($getRoot().getTextContent()).toBe('Hello  worldfoo');
      });
    });
    test('preserves DecoratorNodes in the source when moved to a new location', async () => {
      const {editor} = testEnv;
      let targetParagraphKey = '';
      await editor.update(() => {
        const root = $getRoot().clear();
        // Source paragraph: "before" + DecoratorNode + "after"
        const sourceParagraph = $createParagraphNode();
        const beforeText = $createTextNode('before');
        const decorator = $createTestDecoratorNode();
        const afterText = $createTextNode('after');
        sourceParagraph.append(beforeText, decorator, afterText);

        // Target paragraph (drop destination)
        const targetParagraph = $createParagraphNode();
        const targetText = $createTextNode('target');
        targetParagraph.append(targetText);
        targetParagraphKey = targetText.getKey();

        root.append(sourceParagraph, targetParagraph);

        // Select from start of "before" to end of "after" — covers the decorator.
        const selection = $createRangeSelection();
        selection.anchor.set(beforeText.getKey(), 0, 'text');
        selection.focus.set(afterText.getKey(), 5, 'text');
        $setSelection(selection);
      });

      // Populate the DataTransfer the same way DRAGSTART does — with Lexical's
      // own serialization so custom nodes survive the drop, plus a drag-source
      // marker so the handler treats it as a same-editor move.
      await editor.update(() => {
        const selection = $getSelection();
        invariant($isRangeSelection(selection), 'expected range selection');

        const domText = getParagraphTextDOM(editor, targetParagraphKey);
        setCaretFromPoint(domText, 6); // drop at end of "target"

        const {dataTransfer, event} = createDropEvent();
        setLexicalClipboardDataTransfer(
          dataTransfer,
          $getClipboardDataFromSelection(selection),
        );
        $writeDragSourceToDataTransfer(
          dataTransfer as unknown as DataTransfer,
          editor,
        );
        $handleRichTextDrop(event, editor);
      });

      await editor.read(() => {
        const root = $getRoot();
        const topLevelChildren = root.getChildren();
        // Two paragraphs at the top level: the (now-empty) source and the
        // target (now containing the moved content).
        expect(topLevelChildren.length).toBe(2);

        const allDecorators = topLevelChildren
          .flatMap(c =>
            'getChildren' in c && typeof c.getChildren === 'function'
              ? c.getChildren()
              : [],
          )
          .filter($isDecoratorNode);
        // Exactly one decorator in the whole tree (preserved, not duplicated).
        expect(allDecorators.length).toBe(1);

        // The decorator must live under the target paragraph, not the source.
        const sourceParagraph = topLevelChildren[0];
        const targetParagraph = topLevelChildren[1];
        invariant(
          'getChildren' in sourceParagraph &&
            typeof sourceParagraph.getChildren === 'function',
          'expected source paragraph',
        );
        invariant(
          'getChildren' in targetParagraph &&
            typeof targetParagraph.getChildren === 'function',
          'expected target paragraph',
        );
        const sourceDecorators = sourceParagraph
          .getChildren()
          .filter($isDecoratorNode);
        const targetDecorators = targetParagraph
          .getChildren()
          .filter($isDecoratorNode);
        expect(sourceDecorators.length).toBe(0);
        expect(targetDecorators.length).toBe(1);

        // Full text content should be "target" + "before" + decorator's text +
        // "after". TestDecoratorNode.getTextContent() is 'Hello world', so the
        // decorator appears between "before" and "after" in textContent.
        expect(sourceParagraph.getTextContent()).toBe('');
        expect(targetParagraph.getTextContent()).toBe(
          'targetbeforeHello worldafter',
        );
      });
    });

    test('no-op when drop is inside a multi-node source range', async () => {
      const {editor} = testEnv;
      let innerKey = '';
      await editor.update(() => {
        const paragraph = $createParagraphNode();
        const t1 = $createTextNode('one');
        const t2 = $createTextNode('two').toggleFormat('bold');
        const t3 = $createTextNode('three');
        paragraph.append(t1, t2, t3);
        $getRoot().clear().append(paragraph);
        innerKey = t2.getKey();

        // Selection spans t1..t3 (all three text nodes).
        const selection = $createRangeSelection();
        selection.anchor.set(t1.getKey(), 0, 'text');
        selection.focus.set(t3.getKey(), 5, 'text');
        $setSelection(selection);
      });

      await editor.update(() => {
        // Drop INSIDE the "two" text node, which is strictly between the
        // source's anchor and focus.
        const domText = getParagraphTextDOM(editor, innerKey);
        setCaretFromPoint(domText, 1);
        const {dataTransfer, event, preventDefault} = createDropEvent();
        dataTransfer.setData('text/plain', 'onetwothree');
        $markActiveSelectionAsDragSource(dataTransfer, editor);
        const handled = $handleRichTextDrop(event, editor);
        expect(handled).toBe(true);
        expect(preventDefault).toHaveBeenCalled();
      });

      await editor.read(() => {
        expect($getRoot().getTextContent()).toBe('onetwothree');
      });
    });
  });
});

describe.each([
  ['rich text', $handleRichTextDrop],
  ['plain text', $handlePlainTextDrop],
] as const)('%s drop boundaries', (_name, $handleDrop) => {
  initializeUnitTest(testEnv => {
    describe.each([false, true])('backward=%s', backward => {
      test.each([
        'text start',
        'text middle',
        'text end',
        'previous end',
        'next start',
        'element start',
        'element end',
      ])('keeps a token unchanged at %s', async position => {
        const {editor} = testEnv;
        let sourceKey = '';
        let beforeKey = '';
        let afterKey = '';
        let paragraphKey = '';
        await editor.update(() => {
          const before = $createTextNode('before ');
          const source = $createTextNode('Hello').setMode('token');
          const after = $createTextNode(' world');
          const paragraph = $createParagraphNode().append(
            before,
            source,
            after,
          );
          $getRoot().clear().append(paragraph);
          sourceKey = source.getKey();
          beforeKey = before.getKey();
          afterKey = after.getKey();
          paragraphKey = paragraph.getKey();
          source.select(backward ? 5 : 0, backward ? 0 : 5);
        });
        const original = editor.getEditorState();
        const selection = editor.read(() => $getSelection()!.clone());
        await editor.update(() => {
          const points: Record<string, [Node, number]> = {
            'element end': [editor.getElementByKey(paragraphKey)!, 2],
            'element start': [editor.getElementByKey(paragraphKey)!, 1],
            'next start': [getParagraphTextDOM(editor, afterKey), 0],
            'previous end': [getParagraphTextDOM(editor, beforeKey), 7],
            'text end': [getParagraphTextDOM(editor, sourceKey), 5],
            'text middle': [getParagraphTextDOM(editor, sourceKey), 2],
            'text start': [getParagraphTextDOM(editor, sourceKey), 0],
          };
          setCaretFromPoint(...points[position]);
          const {dataTransfer, event, preventDefault} = createDropEvent();
          setLexicalClipboardDataTransfer(
            dataTransfer,
            $getClipboardDataFromSelection(),
          );
          $writeDragSourceToDataTransfer(dataTransfer, editor);
          expect($handleDrop(event, editor)).toBe(true);
          expect(preventDefault).toHaveBeenCalledOnce();
        });
        expect(editor.getEditorState().toJSON()).toEqual(original.toJSON());
        editor.read(() => {
          expect($getSelection()!.is(selection)).toBe(true);
          for (const key of [paragraphKey, beforeKey, sourceKey, afterKey]) {
            expect($getNodeByKey(key)?.isAttached()).toBe(true);
          }
        });
      });

      test.each(['previous end', 'next start', 'element start', 'element end'])(
        'keeps nested inline wrappers unchanged at %s',
        async position => {
          const {editor} = testEnv;
          let beforeKey = '';
          let afterKey = '';
          let paragraphKey = '';
          let wrapperKeys: string[] = [];
          await editor.update(() => {
            const before = $createTextNode('before ');
            const source = $createTextNode('Hello');
            const after = $createTextNode(' world');
            const inner = $createTestInlineElementNode().append(source);
            const outer = $createTestInlineElementNode().append(inner);
            const paragraph = $createParagraphNode().append(
              before,
              outer,
              after,
            );
            $getRoot().clear().append(paragraph);
            beforeKey = before.getKey();
            afterKey = after.getKey();
            paragraphKey = paragraph.getKey();
            wrapperKeys = [inner.getKey(), outer.getKey()];
            source.select(backward ? 5 : 0, backward ? 0 : 5);
          });
          const original = editor.getEditorState();
          const selection = editor.read(() => $getSelection()!.clone());
          await editor.update(() => {
            const points: Record<string, [Node, number]> = {
              'element end': [editor.getElementByKey(paragraphKey)!, 2],
              'element start': [editor.getElementByKey(paragraphKey)!, 1],
              'next start': [getParagraphTextDOM(editor, afterKey), 0],
              'previous end': [getParagraphTextDOM(editor, beforeKey), 7],
            };
            setCaretFromPoint(...points[position]);
            const {dataTransfer, event} = createDropEvent();
            setLexicalClipboardDataTransfer(
              dataTransfer,
              $getClipboardDataFromSelection(),
            );
            $writeDragSourceToDataTransfer(dataTransfer, editor);
            expect($handleDrop(event, editor)).toBe(true);
          });
          expect(editor.getEditorState().toJSON()).toEqual(original.toJSON());
          editor.read(() => {
            expect($getSelection()!.is(selection)).toBe(true);
            for (const key of wrapperKeys) {
              expect($getNodeByKey(key)?.isAttached()).toBe(true);
            }
          });
        },
      );

      test('keeps a decorator in a multi-node range at the adjacent end edge', async () => {
        const {editor} = testEnv;
        let afterKey = '';
        let decoratorKey = '';
        await editor.update(() => {
          const first = $createTextNode('before');
          const decorator = $createTestDecoratorNode();
          const last = $createTextNode('after').setMode('token');
          const after = $createTextNode(' rest');
          afterKey = after.getKey();
          decoratorKey = decorator.getKey();
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(first, decorator, last, after),
            );
          const selection = $createRangeSelection();
          const start = backward ? selection.focus : selection.anchor;
          const end = backward ? selection.anchor : selection.focus;
          start.set(first.getKey(), 0, 'text');
          end.set(last.getKey(), 5, 'text');
          $setSelection(selection);
        });
        const original = editor.getEditorState();
        const selection = editor.read(() => $getSelection()!.clone());
        await editor.update(() => {
          setCaretFromPoint(getParagraphTextDOM(editor, afterKey), 0);
          const {dataTransfer, event} = createDropEvent();
          setLexicalClipboardDataTransfer(
            dataTransfer,
            $getClipboardDataFromSelection(),
          );
          $writeDragSourceToDataTransfer(dataTransfer, editor);
          expect($handleDrop(event, editor)).toBe(true);
        });
        expect(editor.getEditorState().toJSON()).toEqual(original.toJSON());
        editor.read(() => {
          expect($getSelection()!.is(selection)).toBe(true);
          expect($getNodeByKey(decoratorKey)?.isAttached()).toBe(true);
        });
      });

      test.each(['text', 'paragraph', 'root'])(
        'keeps a %s destination after a cross-paragraph deletion',
        async position => {
          const {editor} = testEnv;
          let lastKey = '';
          let paragraphKey = '';
          await editor.update(() => {
            const first = $createTextNode('abc');
            const last = $createTextNode('def');
            const paragraph = $createParagraphNode().append(last);
            lastKey = last.getKey();
            paragraphKey = paragraph.getKey();
            $getRoot()
              .clear()
              .append($createParagraphNode().append(first), paragraph);
            const selection = $createRangeSelection();
            const start = backward ? selection.focus : selection.anchor;
            const end = backward ? selection.anchor : selection.focus;
            start.set(first.getKey(), 1, 'text');
            end.set(last.getKey(), 2, 'text');
            $setSelection(selection);
          });
          await editor.update(() => {
            const points: Record<string, [Node, number]> = {
              paragraph: [editor.getElementByKey(paragraphKey)!, 1],
              root: [editor.getRootElement()!, 2],
              text: [getParagraphTextDOM(editor, lastKey), 3],
            };
            setCaretFromPoint(...points[position]);
            const {dataTransfer, event, preventDefault} = createDropEvent();
            setLexicalClipboardDataTransfer(
              dataTransfer,
              $getClipboardDataFromSelection(),
            );
            $writeDragSourceToDataTransfer(dataTransfer, editor);
            expect($handleDrop(event, editor)).toBe(true);
            expect(preventDefault).toHaveBeenCalledOnce();
          });
          editor.read(() => {
            // The unselected f must precede the moved bc/de, even when its
            // former paragraph was the destination caret's origin.
            expect($getRoot().getTextContent().replace(/\n/g, '')).toBe(
              'afbcde',
            );
            expect(($getSelection() as RangeSelection).isCollapsed()).toBe(
              true,
            );
            if (position !== 'root') {
              expect(
                $getRoot()
                  .getChildren()
                  .map(node => node.getTextContent()),
              ).toEqual(
                $handleDrop === $handleRichTextDrop
                  ? ['afbc', 'de']
                  : ['afbc\nde'],
              );
            }
          });
        },
      );
    });
  });
});
describe('$handleRichTextDrop across editors', () => {
  let sourceContainer: HTMLDivElement;
  let destContainer: HTMLDivElement;
  let sourceEditor: LexicalEditor;
  let destEditor: LexicalEditor;

  beforeEach(() => {
    caretFromPointState.current = () => null;

    sourceContainer = document.createElement('div');
    sourceContainer.setAttribute('data-lexical-editor', 'true');
    sourceContainer.contentEditable = 'true';
    document.body.appendChild(sourceContainer);
    sourceEditor = createTestEditor();
    sourceEditor.setRootElement(sourceContainer);

    destContainer = document.createElement('div');
    destContainer.setAttribute('data-lexical-editor', 'true');
    destContainer.contentEditable = 'true';
    document.body.appendChild(destContainer);
    destEditor = createTestEditor();
    destEditor.setRootElement(destContainer);
  });

  afterEach(() => {
    sourceEditor.setRootElement(null);
    destEditor.setRootElement(null);
    document.body.removeChild(sourceContainer);
    document.body.removeChild(destContainer);
  });

  test('inserts in the destination and dispatches deleteByDrag at the source root', async () => {
    let sourceTextKey = '';
    await sourceEditor.update(() => {
      const paragraph = $createParagraphNode();
      const text = $createTextNode('source-content');
      paragraph.append(text);
      $getRoot().clear().append(paragraph);
      sourceTextKey = text.getKey();

      const selection = $createRangeSelection();
      selection.anchor.set(sourceTextKey, 0, 'text');
      selection.focus.set(sourceTextKey, 6, 'text');
      $setSelection(selection);
    });

    let destTextKey = '';
    await destEditor.update(() => {
      const paragraph = $createParagraphNode();
      const text = $createTextNode('destination');
      paragraph.append(text);
      $getRoot().clear().append(paragraph);
      destTextKey = text.getKey();
    });

    const dataTransfer = new DataTransfer();
    await sourceEditor.update(() => {
      const selection = $getSelection();
      invariant($isRangeSelection(selection), 'expected source selection');
      setLexicalClipboardDataTransfer(
        dataTransfer,
        $getClipboardDataFromSelection(selection),
      );
      $writeDragSourceToDataTransfer(
        dataTransfer as unknown as DataTransfer,
        sourceEditor,
      );
    });

    // Capture the synthetic event dispatched at the source root. The source
    // editor's actual deletion runs through Lexical's beforeinput handler
    // which is only registered when CAN_USE_BEFORE_INPUT is true (jsdom does
    // not expose getTargetRanges on InputEvent), so we verify the dispatch
    // contract here — the end-to-end deletion is covered by the playground
    // browser repro.
    const observedDispatches: InputEvent[] = [];
    sourceContainer.addEventListener(
      'beforeinput',
      e => observedDispatches.push(e as InputEvent),
      true,
    );

    await destEditor.update(() => {
      const destSpan = destEditor.getElementByKey(destTextKey);
      invariant(destSpan !== null, 'dest span null');
      const domText = destSpan.firstChild;
      invariant(
        domText !== null && domText.nodeType === Node.TEXT_NODE,
        'dest dom text',
      );
      setCaretFromPoint(domText as Text, 11);

      const preventDefault = vi.fn();
      const event = {
        clientX: 0,
        clientY: 0,
        dataTransfer,
        preventDefault,
      } as unknown as DragEvent;

      const handled = $handleRichTextDrop(event, destEditor);
      expect(handled).toBe(true);
      expect(preventDefault).toHaveBeenCalled();
    });

    expect(observedDispatches.length).toBe(1);
    expect(observedDispatches[0].type).toBe('beforeinput');
    expect(observedDispatches[0].inputType).toBe('deleteByDrag');
    expect(observedDispatches[0].target).toBe(sourceContainer);

    await destEditor.read(() => {
      expect($getRoot().getTextContent()).toBe('destinationsource');
    });
  });

  test('cancelled cross-editor drag leaves both editors untouched', async () => {
    await sourceEditor.update(() => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode('source-content'));
      $getRoot().clear().append(paragraph);

      const text = paragraph.getFirstChildOrThrow();
      const selection = $createRangeSelection();
      selection.anchor.set(text.getKey(), 0, 'text');
      selection.focus.set(text.getKey(), 6, 'text');
      $setSelection(selection);
    });

    await destEditor.update(() => {
      const paragraph = $createParagraphNode();
      paragraph.append($createTextNode('destination'));
      $getRoot().clear().append(paragraph);
    });

    // No drop event ever fires — there is no DataTransfer to read, so the
    // marker-based design has nothing to act on. Both editors are unchanged.
    await sourceEditor.read(() => {
      expect($getRoot().getTextContent()).toBe('source-content');
    });
    await destEditor.read(() => {
      expect($getRoot().getTextContent()).toBe('destination');
    });
  });
});

class BlockDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test_drop_block_decorator', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): false {
    return false;
  }
  isInline(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

/**
 * A block that renders a non-editable marker ahead of its children, which its
 * DOM slot keeps them after.
 */
class LeadingMarkerElementNode extends ElementNode {
  $config() {
    return this.config('test_drop_leading_marker', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    const div = document.createElement('div');
    const marker = document.createElement('span');
    marker.setAttribute('data-marker', 'true');
    marker.contentEditable = 'false';
    marker.textContent = '§';
    div.appendChild(marker);
    return div;
  }
  updateDOM(): false {
    return false;
  }
  getDOMSlot(dom: HTMLElement): ElementDOMSlot<HTMLElement> {
    const marker = dom.querySelector(':scope > [data-marker]');
    assert(marker !== null, 'Expected the marker');
    return super.getDOMSlot(dom).withAfter(marker);
  }
}

describe('$handleRichTextDrop beside DOM the editor renders', () => {
  let container: HTMLDivElement;
  let editor: LexicalEditor;

  beforeEach(() => {
    caretFromPointState.current = () => null;
    container = document.createElement('div');
    container.contentEditable = 'true';
    document.body.appendChild(container);
    editor = createTestEditor({
      nodes: [BlockDecoratorNode, LeadingMarkerElementNode],
    });
    registerRichText(editor);
    editor.setRootElement(container);
  });

  afterEach(() => {
    editor.setRootElement(null);
    container.remove();
  });

  // A block decorator at the start of the root has a zero-size anchor before
  // it (#8922), so the DOM point before the decorator is (root, 1), which is
  // the Lexical point (root, 0).
  test('drops before the decorator at the DOM point before it', () => {
    editor.update(
      () => {
        const text = $createTextNode('Hello foo world');
        $getRoot()
          .clear()
          .append(
            $create(BlockDecoratorNode),
            $createParagraphNode().append(text),
          );
        text.select(6, 9);
      },
      {discrete: true},
    );
    expect(container.firstElementChild?.nodeName).toBe('IMG');
    editor.update(
      () => {
        setCaretFromPoint(container, 1);
        const {dataTransfer, event} = createDropEvent();
        setLexicalClipboardDataTransfer(
          dataTransfer,
          $getClipboardDataFromSelection(),
        );
        $writeDragSourceToDataTransfer(dataTransfer, editor);
        expect($handleRichTextDrop(event, editor)).toBe(true);
      },
      {discrete: true},
    );
    editor.read('latest', () => {
      expect(
        $getRoot()
          .getChildren()
          .map(node =>
            $isDecoratorNode(node) ? 'decorator' : node.getTextContent(),
          ),
      ).toEqual(['foo', 'decorator', 'Hello  world']);
    });
  });

  // The DOM point before the first child of an element whose children follow
  // a marker of its own is (element, 1), which is the Lexical point
  // (element, 0).
  test('drops before the first child of an element at the DOM point after its marker', () => {
    editor.update(
      () => {
        const text = $createTextNode('Hello foo world');
        $getRoot()
          .clear()
          .append(
            $create(LeadingMarkerElementNode).append(
              $createTestDecoratorNode(),
            ),
            $createParagraphNode().append(text),
          );
        text.select(6, 9);
      },
      {discrete: true},
    );
    const elementDOM = container.firstElementChild;
    assert(elementDOM !== null, 'Expected the element');
    expect(elementDOM.firstElementChild?.hasAttribute('data-marker')).toBe(
      true,
    );
    editor.update(
      () => {
        setCaretFromPoint(elementDOM, 1);
        const {dataTransfer, event} = createDropEvent();
        setLexicalClipboardDataTransfer(
          dataTransfer,
          $getClipboardDataFromSelection(),
        );
        $writeDragSourceToDataTransfer(dataTransfer, editor);
        expect($handleRichTextDrop(event, editor)).toBe(true);
      },
      {discrete: true},
    );
    editor.read('latest', () => {
      const element = $getRoot().getFirstChild();
      assert($isElementNode(element), 'Expected the element');
      expect(
        element
          .getChildren()
          .map(node =>
            $isDecoratorNode(node) ? 'decorator' : node.getTextContent(),
          ),
      ).toEqual(['foo', 'decorator']);
    });
  });
});

// Keep the TextNode import referenced for future cases.
void TextNode;
