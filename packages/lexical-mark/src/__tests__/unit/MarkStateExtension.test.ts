/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $generateJSONFromSelectedNodes,
  $generateNodesFromSerializedNodes,
  $insertGeneratedNodes,
} from '@lexical/clipboard';
import {
  buildEditorFromExtensions,
  DecoratorTextNode,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$createHashtagNode, HashtagExtension} from '@lexical/hashtag';
import {HistoryExtension} from '@lexical/history';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
  CoreImportExtension,
} from '@lexical/html';
import {$isLinkNode, $toggleLink, LinkExtension} from '@lexical/link';
import {
  $addMarkID,
  $createMarkNode,
  $getMarkIDsAtSelection,
  $getNodeMarkIDs,
  $migrateMarkNodesToMarkState,
  $removeMarkID,
  $wrapSelectionInMarkNode,
  DEFAULT_MARKABLE_NODES,
  MARK_STATE_IDS_ATTRIBUTE,
  MARK_STATE_KEY,
  type MarkableNodeMatch,
  MarkExtension,
  MarkNode,
  MarkStateExtension,
} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $addUpdateTag,
  $create,
  $createLineBreakNode,
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getSlot,
  $getWritableNodeState,
  $insertNodes,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setCompositionKey,
  $setSelection,
  $setSlot,
  CLEAR_HISTORY_COMMAND,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_HIGH,
  COMPOSITION_START_COMMAND,
  configExtension,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  DecoratorNode,
  defineExtension,
  DELETE_CHARACTER_COMMAND,
  DROP_COMMAND,
  ElementNode,
  HISTORIC_TAG,
  INSERT_PARAGRAPH_COMMAND,
  type LexicalEditor,
  type LexicalNode,
  LineBreakNode,
  ParagraphNode,
  PASTE_COMMAND,
  type RangeSelection,
  REDO_COMMAND,
  RootNode,
  type SerializedEditorState,
  TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import {describe, expect, onTestFinished, test} from 'vitest';

const P = 'Revenue grew 4% in Q3.';

class ChipNode extends DecoratorNode<null> {
  $config() {
    return this.config('test-chip', {extends: DecoratorNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
  isInline(): true {
    return true;
  }
  getTextContent(): string {
    return '@';
  }
}

/** A block decorator that hosts a `caption` slot */
class FigureNode extends DecoratorNode<null> {
  $config() {
    return this.config('test-figure', {extends: DecoratorNode});
  }
  isInline(): false {
    return false;
  }
  createDOM(): HTMLElement {
    return document.createElement('figure');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

/** A paragraph with a named slot (a title shown with it) */
class TitledParagraphNode extends ParagraphNode {
  $config() {
    return this.config('test-titled-paragraph', {
      extends: ParagraphNode,
      slots: ['title'],
    });
  }
}

/** An inline decorator without text (an inline image, say) */
class EmptyInlineDecoratorNode extends DecoratorNode<null> {
  $config() {
    return this.config('test-empty-inline-decorator', {
      extends: DecoratorNode,
    });
  }
  isInline(): true {
    return true;
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
}

/** An inline element that shows its text in brackets */
class BracketedInlineNode extends ElementNode {
  $config() {
    return this.config('test-bracketed-inline', {extends: ElementNode});
  }
  isInline(): true {
    return true;
  }
  createDOM(): HTMLElement {
    return document.createElement('span');
  }
  updateDOM(): false {
    return false;
  }
  getTextContent(): string {
    return '[' + super.getTextContent() + ']';
  }
}

class TestDecoratorTextNode extends DecoratorTextNode {
  $config() {
    return this.config('test-decorator-text', {extends: DecoratorTextNode});
  }
  updateDOM(): false {
    return false;
  }
  decorate(): null {
    return null;
  }
  getTextContent(): string {
    return '#';
  }
}

/** A token TextNode that a transform creates from text, like a mention */
class MentionNode extends TextNode {
  $config() {
    return this.config('test-mention', {extends: TextNode});
  }
}

class ReplacementTextNode extends TextNode {
  $config() {
    return this.config('test-replacement-text', {extends: TextNode});
  }
}

function $createMentionNode(text: string): MentionNode {
  return $create(MentionNode).setTextContent(text).setMode('token');
}

function $describeNode(node: LexicalNode): string {
  const ids = $getNodeMarkIDs(node);
  const tag = ids.length > 0 ? `[${ids.join(',')}]` : '';
  if ($isTextNode(node)) {
    return JSON.stringify(node.getTextContent()) + tag;
  }
  if ($isLineBreakNode(node)) {
    return 'br' + tag;
  }
  if ($isLinkNode(node)) {
    return `link(${node.getChildren().map($describeNode).join(' ')})`;
  }
  if (node instanceof MarkNode) {
    return `mark[${node.getIDs().join(',')}](${node
      .getChildren()
      .map($describeNode)
      .join(' ')})`;
  }
  if ($isElementNode(node)) {
    return `${node.getType()}(${node
      .getChildren()
      .map($describeNode)
      .join(' ')})`;
  }
  if (node instanceof FigureNode) {
    const caption = $getSlot(node, 'caption');
    return `${node.getType()}${tag}{${caption ? $describeNode(caption) : ''}}`;
  }
  return node.getType() + tag;
}

function $tree(): string {
  return $getRoot().getChildren().map($describeNode).join(' / ');
}

function $paragraph(index = 0): ElementNode {
  return $getRoot().getChildAtIndex(index) as ElementNode;
}

/** The text node and offset at a character offset of a paragraph */
function $locate(
  paragraph: ElementNode,
  offset: number,
  preferNext = false,
): [TextNode, number] {
  let acc = 0;
  const texts = paragraph.getAllTextNodes();
  for (let i = 0; i < texts.length; i++) {
    const node = texts[i];
    const size = node.getTextContentSize();
    if (
      offset < acc + size ||
      (offset === acc + size && (!preferNext || i === texts.length - 1))
    ) {
      return [node, offset - acc];
    }
    acc += size;
  }
  throw new Error(`offset ${offset} out of range`);
}

function $select(
  start: number,
  end: number = start,
  paragraph: ElementNode = $paragraph(),
) {
  const [startNode, startOffset] = $locate(paragraph, start, start !== end);
  const [endNode, endOffset] = $locate(paragraph, end);
  const selection = $createRangeSelection();
  selection.anchor.set(startNode.getKey(), startOffset, 'text');
  selection.focus.set(endNode.getKey(), endOffset, 'text');
  $setSelection(selection);
  return selection;
}

function $init(text = P) {
  $getRoot()
    .clear()
    .append($createParagraphNode().append($createTextNode(text)));
}

function createTestEditor(
  options: {
    disabled?: boolean;
    exportIDsToHTML?: boolean;
    isMarkIDShown?: (id: string) => boolean;
    markableNodes?: readonly MarkableNodeMatch[];
    withRoot?: boolean;
  } = {},
): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        RichTextExtension,
        LinkExtension,
        MarkExtension,
        CoreImportExtension,
        configExtension(MarkStateExtension, {
          disabled: options.disabled ?? false,
          exportIDsToHTML: options.exportIDsToHTML ?? false,
          ...(options.isMarkIDShown
            ? {isMarkIDShown: options.isMarkIDShown}
            : {}),
          markableNodes: options.markableNodes ?? DEFAULT_MARKABLE_NODES,
        }),
      ],
      name: '[root]',
      nodes: () => [
        ChipNode,
        FigureNode,
        BracketedInlineNode,
        EmptyInlineDecoratorNode,
        TestDecoratorTextNode,
        TitledParagraphNode,
      ],
      theme: {mark: 'mark', markOverlap: 'mark-overlap'},
    }),
  );
  if (options.withRoot) {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    editor.setRootElement(root);
    onTestFinished(() => {
      editor.setRootElement(null);
      root.remove();
    });
  }
  return editor;
}

function update(editor: LexicalEditor, fn: () => void) {
  editor.update(fn, {discrete: true});
}

function tree(editor: LexicalEditor): string {
  return editor.read($tree);
}

function mark(editor: LexicalEditor, start: number, end: number, id: string) {
  update(editor, () => {
    $addMarkID(id, $select(start, end));
  });
}

function markIDNodeKeys(editor: LexicalEditor) {
  return getExtensionDependencyFromEditor(editor, MarkStateExtension).output
    .markIDNodeKeys.value;
}

/** id -> text of the nodes that carry it, from the markIDNodeKeys output */
function registryText(editor: LexicalEditor): Record<string, string[]> {
  return editor.read(() => {
    const result: Record<string, string[]> = {};
    for (const [id, keys] of markIDNodeKeys(editor)) {
      result[id] = keys
        .map(key => $getNodeByKey(key))
        .map(node => (node ? node.getTextContent() : '<missing>'))
        .sort();
    }
    return result;
  });
}

function typeText(editor: LexicalEditor, text: string) {
  update(editor, () => {
    editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, text);
  });
}

/** Clipboard or drag data with `data` by MIME type */
function dataTransfer(data: Record<string, string>): DataTransfer {
  return {
    files: [],
    getData: (type: string) => data[type] || '',
    items: [],
    types: Object.keys(data),
  } as unknown as DataTransfer;
}

/**
 * A paste event with `text` as its plain text clipboard data, and `lexical`
 * as its Lexical data and `html` as its HTML when given
 */
function pasteEvent(
  text: string,
  lexical?: string,
  html?: string,
): ClipboardEvent {
  const event = new Event('paste', {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  const data: Record<string, string> = {'text/plain': text};
  if (lexical !== undefined) {
    data['application/x-lexical-editor'] = lexical;
  }
  if (html !== undefined) {
    data['text/html'] = html;
  }
  Object.defineProperty(event, 'clipboardData', {value: dataTransfer(data)});
  return event;
}

describe('MarkStateExtension', () => {
  describe('add, remove and query', () => {
    test('overlapping marks share TextNodes regardless of order', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      mark(editor, 12, 19, 'c2');
      const expected =
        'paragraph("Revenue " "grew"[c1] " 4%"[c1,c2] " in "[c2] "Q3.")';
      expect(tree(editor)).toBe(expected);

      const reversed = createTestEditor();
      update(reversed, () => $init());
      mark(reversed, 12, 19, 'c2');
      mark(reversed, 8, 15, 'c1');
      expect(tree(reversed)).toBe(expected);

      // One set-valued NodeState key, a sorted array in JSON
      const paragraph = (
        editor.getEditorState().toJSON() as SerializedEditorState
      ).root.children[0] as unknown as {children: {$?: object}[]};
      expect(paragraph.children.map(child => child.$)).toEqual([
        undefined,
        {markIds: ['c1']},
        {markIds: ['c1', 'c2']},
        {markIds: ['c2']},
        undefined,
      ]);
      expect(
        (reversed.getEditorState().toJSON() as SerializedEditorState).root
          .children[0],
      ).toEqual(paragraph);
      expect(registryText(editor)).toEqual({
        c1: [' 4%', 'grew'],
        c2: [' 4%', ' in '],
      });
    });

    test('the selection still covers the marked text', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID('c1', $select(8, 15));
        const selection = $getSelection();
        expect(selection && selection.getTextContent()).toBe('grew 4%');
      });
    });

    test('$getMarkIDsAtSelection', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      mark(editor, 12, 19, 'c2');
      update(editor, () => {
        expect($getMarkIDsAtSelection($select(3))).toEqual([]);
        expect($getMarkIDsAtSelection($select(10))).toEqual(['c1']);
        expect($getMarkIDsAtSelection($select(13))).toEqual(['c1', 'c2']);
        expect($getMarkIDsAtSelection($select(17))).toEqual(['c2']);
        // A caret right before a marked run (end of "Revenue ") is in it
        expect($getMarkIDsAtSelection($select(8))).toEqual(['c1']);
        // Defaults to the current selection
        $select(13);
        expect($getMarkIDsAtSelection()).toEqual(['c1', 'c2']);
        expect($getMarkIDsAtSelection($select(10, 17))).toEqual(['c1', 'c2']);
        expect($getMarkIDsAtSelection($select(10, 17), 'all')).toEqual([]);
        expect($getMarkIDsAtSelection($select(12, 15), 'all')).toEqual([
          'c1',
          'c2',
        ]);
        // Leaves the selection only touches at an edge do not count
        expect($getMarkIDsAtSelection($select(0, 8))).toEqual([]);
        expect($getMarkIDsAtSelection($select(19, 22))).toEqual([]);
      });
    });

    test('the helpers return new arrays that the caller may change', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      mark(editor, 12, 19, 'c2');
      update(editor, () => {
        const overlap = $getRoot()
          .getAllTextNodes()
          .find(node => node.getTextContent() === ' 4%');
        if (overlap === undefined) {
          throw new Error('expected the overlap');
        }
        const results = [
          $getNodeMarkIDs(overlap),
          $getMarkIDsAtSelection($select(13)),
          $getMarkIDsAtSelection($select(10, 17)),
          // One leaf: the result is not the stored value
          $getMarkIDsAtSelection($select(12, 15), 'all'),
        ];
        for (const ids of results) {
          expect(ids).toEqual(['c1', 'c2']);
          expect(Object.isFrozen(ids)).toBe(false);
          ids.push('x');
          ids.reverse();
        }
        expect($getNodeMarkIDs(overlap)).toEqual(['c1', 'c2']);
        expect($getMarkIDsAtSelection($select(12, 15), 'all')).toEqual([
          'c1',
          'c2',
        ]);
      });
      expect(registryText(editor)).toEqual({
        c1: [' 4%', 'grew'],
        c2: [' 4%', ' in '],
      });
    });

    test('removing an id merges the text back', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      mark(editor, 12, 19, 'c2');
      update(editor, () => $removeMarkID('c1'));
      expect(tree(editor)).toBe(
        'paragraph("Revenue grew" " 4% in "[c2] "Q3.")',
      );
      expect(registryText(editor)).toEqual({c2: [' 4% in ']});
      update(editor, () => $removeMarkID('c2'));
      expect(tree(editor)).toBe('paragraph("Revenue grew 4% in Q3.")');
      expect(markIDNodeKeys(editor).size).toBe(0);
      // No NodeState is left in the JSON
      expect(JSON.stringify(editor.getEditorState().toJSON())).not.toContain(
        '"$"',
      );
    });

    test('removing an id from part of its range', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 19, 'c1');
      update(editor, () => $removeMarkID('c1', $select(12, 15)));
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew"[c1] " 4%" " in "[c1] "Q3.")',
      );
      expect(registryText(editor)).toEqual({c1: [' in ', 'grew']});
    });

    test('removing an id without the active registry walks the document', () => {
      const editor = createTestEditor({disabled: true});
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      mark(editor, 12, 19, 'c2');
      update(editor, () => $removeMarkID('c1'));
      expect(tree(editor)).toBe(
        'paragraph("Revenue grew" " 4% in "[c2] "Q3.")',
      );
    });

    test('add and remove in the same update', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID('c1', $select(8, 15));
        $removeMarkID('c1');
      });
      expect(tree(editor)).toBe('paragraph("Revenue grew 4% in Q3.")');
      expect(markIDNodeKeys(editor).size).toBe(0);
    });

    test('line breaks, inline decorators and links', () => {
      const editor = createTestEditor();
      update(editor, () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('ab'),
              $createLineBreakNode(),
              $createTextNode('cd'),
              new ChipNode(),
              $createTextNode('ef'),
            ),
          );
      });
      update(editor, () => {
        const paragraph = $paragraph();
        const [first, , , , last] = paragraph.getChildren() as TextNode[];
        const selection = $createRangeSelection();
        selection.anchor.set(first.getKey(), 1, 'text');
        selection.focus.set(last.getKey(), 1, 'text');
        $addMarkID('c1', selection);
      });
      expect(tree(editor)).toBe(
        'paragraph("a" "b"[c1] br[c1] "cd"[c1] test-chip[c1] "e"[c1] "f")',
      );

      const linked = createTestEditor();
      update(linked, () => $init());
      update(linked, () => {
        $select(8, 15);
        $toggleLink('https://example.com');
      });
      mark(linked, 8, 19, 'c1');
      expect(tree(linked)).toBe(
        'paragraph("Revenue " link("grew 4%"[c1]) " in "[c1] "Q3.")',
      );
      // A comment on part of a link marks only that part
      mark(linked, 0, 10, 'c2');
      expect(tree(linked)).toBe(
        'paragraph("Revenue "[c2] link("gr"[c1,c2] "ew 4%"[c1]) " in "[c1] "Q3.")',
      );
      update(linked, () => {
        $select(8, 15);
        $toggleLink(null);
      });
      expect(tree(linked)).toBe(
        'paragraph("Revenue "[c2] "gr"[c1,c2] "ew 4% in "[c1] "Q3.")',
      );
    });
  });

  describe('structural edits', () => {
    test('Enter splits a marked run and Backspace joins it again', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      update(editor, () => {
        $select(12);
        editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
      });
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew"[c1]) / paragraph(" 4%"[c1] " in Q3.")',
      );
      expect(registryText(editor)).toEqual({c1: [' 4%', 'grew']});
      update(editor, () => {
        $paragraph(1).selectStart();
        editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
      });
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%"[c1] " in Q3.")',
      );
      expect(registryText(editor)).toEqual({c1: ['grew 4%']});
    });

    test('Enter at the edge of a run keeps it whole', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      update(editor, () => {
        $select(15);
        editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
      });
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%"[c1]) / paragraph(" in Q3.")',
      );
    });

    test('deleting across the boundaries of a run', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      // Delete "ue gr" across the start of the run
      update(editor, () => {
        $select(5, 10).removeText();
      });
      expect(tree(editor)).toBe('paragraph("Reven" "ew 4%"[c1] " in Q3.")');
      // Delete the last character of the run
      update(editor, () => {
        $select(9, 10).removeText();
      });
      expect(tree(editor)).toBe('paragraph("Reven" "ew 4"[c1] " in Q3.")');
      // Deleting the whole run removes the id
      update(editor, () => {
        $select(4, 11).removeText();
      });
      expect(tree(editor)).toBe('paragraph("Reven Q3.")');
      expect(markIDNodeKeys(editor).size).toBe(0);
    });

    test('marked and unmarked text do not merge, equal ids do', () => {
      const editor = createTestEditor();
      update(editor, () => $init('aabbcc'));
      mark(editor, 0, 2, 'x');
      mark(editor, 2, 4, 'y');
      expect(tree(editor)).toBe('paragraph("aa"[x] "bb"[y] "cc")');
      mark(editor, 4, 6, 'y');
      expect(tree(editor)).toBe('paragraph("aa"[x] "bbcc"[y])');
    });
  });

  describe('typing at the edges of a mark', () => {
    function setup() {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      return editor;
    }

    test('text typed at the end of a run is not marked', () => {
      const editor = setup();
      update(editor, () => $select(15));
      typeText(editor, 'X');
      typeText(editor, 'Y');
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%"[c1] "XY in Q3.")',
      );
      update(editor, () => {
        const selection = $getSelection();
        expect(
          $isRangeSelection(selection) &&
            selection.anchor.getNode().getTextContent().slice(0, 2),
        ).toBe('XY');
        expect($isRangeSelection(selection) && selection.anchor.offset).toBe(2);
      });
    });

    test('text typed at the start of a run is not marked', () => {
      const editor = setup();
      // The caret at the start of the marked node (not the end of "Revenue ")
      update(editor, () => {
        const [, marked] = $paragraph().getChildren() as TextNode[];
        marked.select(0, 0);
      });
      typeText(editor, 'X');
      expect(tree(editor)).toBe(
        'paragraph("Revenue X" "grew 4%"[c1] " in Q3.")',
      );
    });

    test('a run at the start of a paragraph', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 0, 7, 'c1');
      update(editor, () => $paragraph().selectStart());
      typeText(editor, 'X');
      expect(tree(editor)).toBe(
        'paragraph("X" "Revenue"[c1] " grew 4% in Q3.")',
      );
      // and at the end of a paragraph
      mark(editor, 20, 23, 'c2');
      update(editor, () => $paragraph().selectEnd());
      typeText(editor, 'Y');
      expect(tree(editor)).toBe(
        'paragraph("X" "Revenue"[c1] " grew 4% in " "Q3."[c2] "Y")',
      );
    });

    test('the class that replaces TextNode is split like TextNode, like MarkNode', () => {
      // With or without withKlass
      for (const withKlass of [true, false]) {
        for (const withMarkNode of [false, true]) {
          const editor = buildEditorFromExtensions(
            defineExtension({
              dependencies: [
                RichTextExtension,
                MarkExtension,
                ...(withMarkNode ? [] : [MarkStateExtension]),
              ],
              name: '[root]',
              nodes: () => [
                ReplacementTextNode,
                {
                  replace: TextNode,
                  with: (node: TextNode) =>
                    $create(ReplacementTextNode).setTextContent(
                      node.getTextContent(),
                    ),
                  ...(withKlass ? {withKlass: ReplacementTextNode} : {}),
                },
              ],
            }),
          );
          update(editor, () => $init('abcdef'));
          update(editor, () => {
            const selection = $select(0, 3);
            if (withMarkNode) {
              $wrapSelectionInMarkNode(selection, false, 'c1');
            } else {
              $addMarkID('c1', selection);
            }
          });
          update(editor, () => $select(3));
          typeText(editor, 'X');
          update(editor, () => {
            const [first] = $paragraph().getAllTextNodes();
            first.select(0, 0);
          });
          typeText(editor, 'Y');
          // The core does not merge TextNodes of another type
          expect(tree(editor)).toBe(
            withMarkNode
              ? 'paragraph("Y" mark[c1]("abc") "X" "def")'
              : 'paragraph("Y" "abc"[c1] "X" "def")',
          );
          expect(
            editor.read(() =>
              $paragraph()
                .getAllTextNodes()
                .every(node => node instanceof ReplacementTextNode),
            ),
          ).toBe(true);
        }
      }
    });

    test('text inserted after a marked hashtag is not marked, like MarkNode', () => {
      // The hashtag ends where the inserted text starts, and its transform
      // splits that text off with the ids of the hashtag: those are not the
      // inserted text's own, however it was inserted
      const cases: [string, string, string, string][] = [
        [
          'typed',
          ' ',
          'paragraph("see " "#foo"[c1] "  bar")',
          'paragraph("see " mark[c1]("#foo") "  bar")',
        ],
        [
          'pasted',
          ' tail',
          'paragraph("see " "#foo"[c1] " tail bar")',
          'paragraph("see " mark[c1]("#foo") " tail bar")',
        ],
        [
          'paste event',
          ', x',
          'paragraph("see " "#foo"[c1] ", x bar")',
          'paragraph("see " mark[c1]("#foo") ", x bar")',
        ],
        [
          'code',
          ', x #bar y',
          'paragraph("see " "#foo"[c1] ", x " "#bar" " y bar")',
          'paragraph("see " mark[c1]("#foo") ", x " "#bar" " y bar")',
        ],
      ];
      for (const [how, text, expected, expectedWithMarkNode] of cases) {
        for (const withMarkNode of [false, true]) {
          const editor = buildEditorFromExtensions(
            defineExtension({
              dependencies: [
                RichTextExtension,
                HashtagExtension,
                MarkExtension,
                ...(withMarkNode ? [] : [MarkStateExtension]),
              ],
              name: '[root]',
            }),
          );
          if (how === 'paste event') {
            const root = document.createElement('div');
            root.contentEditable = 'true';
            document.body.appendChild(root);
            editor.setRootElement(root);
            onTestFinished(() => {
              editor.setRootElement(null);
              root.remove();
            });
          }
          update(editor, () => $init('see #foo bar'));
          update(editor, () => {
            const selection = $select(4, 8);
            if (withMarkNode) {
              $wrapSelectionInMarkNode(selection, false, 'c1');
            } else {
              $addMarkID('c1', selection);
            }
          });
          update(editor, () => $select(8));
          if (how === 'typed') {
            typeText(editor, text);
          } else if (how === 'pasted') {
            editor.dispatchCommand(PASTE_COMMAND, pasteEvent(text));
          } else if (how === 'paste event') {
            editor.getRootElement()!.dispatchEvent(pasteEvent(text));
          } else {
            update(editor, () => $select(8).insertText(text));
          }
          expect([how, tree(editor)]).toEqual([
            how,
            withMarkNode ? expectedWithMarkNode : expected,
          ]);
        }
      }
    });

    test('pasted Lexical data keeps its ids after a marked hashtag', () => {
      // Pasted or inserted content with the same ids as the hashtag is not
      // taken for text split off it: its ids are a value of its own, not
      // the hashtag's
      for (const how of ['paste', 'code']) {
        const editor = buildEditorFromExtensions(
          defineExtension({
            dependencies: [
              RichTextExtension,
              HashtagExtension,
              MarkExtension,
              MarkStateExtension,
            ],
            name: '[root]',
          }),
        );
        update(editor, () => $init('see #foo bar'));
        mark(editor, 4, 12, 'c1');
        let json: null | ReturnType<typeof $generateJSONFromSelectedNodes> =
          null;
        update(editor, () => {
          json = $generateJSONFromSelectedNodes(editor, $select(8, 12));
          $removeMarkID('c1', $select(8, 12));
        });
        update(editor, () => $select(8));
        if (how === 'paste') {
          editor.dispatchCommand(
            PASTE_COMMAND,
            pasteEvent(' bar', JSON.stringify(json)),
          );
        } else {
          update(editor, () =>
            $insertGeneratedNodes(
              editor,
              $generateNodesFromSerializedNodes(json!.nodes),
              $getSelection()!,
            ),
          );
        }
        expect([how, tree(editor)]).toEqual([
          how,
          'paragraph("see " "#foo"[c1] " bar"[c1] " bar")',
        ]);
      }
    });

    test('a plain TextNode given the ids array of a marked hashtag is taken for a piece split off it', () => {
      // The documented limitation: NodeState copied without a round trip
      // through a string shares the array. Ids added with $addMarkID are a
      // value of the node's own.
      for (const how of ['copied state', '$addMarkID']) {
        const editor = buildEditorFromExtensions(
          defineExtension({
            dependencies: [
              RichTextExtension,
              HashtagExtension,
              MarkExtension,
              MarkStateExtension,
            ],
            name: '[root]',
          }),
        );
        update(editor, () => $init('see #foo bar'));
        mark(editor, 4, 8, 'c1');
        update(editor, () => {
          const [, hashtag] = $paragraph().getAllTextNodes();
          const node = $createTextNode(' more');
          if (how === 'copied state') {
            node.updateFromJSON({
              ...node.exportJSON(),
              $: hashtag.exportJSON().$,
            });
          }
          hashtag.select(4, 4);
          $insertNodes([node]);
          if (how === '$addMarkID') {
            const selection = $createRangeSelection();
            selection.anchor.set(node.getKey(), 0, 'text');
            selection.focus.set(node.getKey(), 5, 'text');
            $addMarkID('c1', selection);
            node.select(5, 5);
          }
        });
        expect([how, tree(editor)]).toEqual([
          how,
          how === 'copied state'
            ? 'paragraph("see " "#foo"[c1] " more bar")'
            : 'paragraph("see " "#foo"[c1] " more"[c1] " bar")',
        ]);
      }
    });

    test('text dropped from another editor after a marked hashtag keeps its ids, like MarkNode', () => {
      for (const withMarkNode of [false, true]) {
        const editor = buildEditorFromExtensions(
          defineExtension({
            dependencies: [
              RichTextExtension,
              HashtagExtension,
              MarkExtension,
              ...(withMarkNode ? [] : [MarkStateExtension]),
            ],
            name: '[root]',
          }),
        );
        const root = document.createElement('div');
        root.contentEditable = 'true';
        document.body.appendChild(root);
        editor.setRootElement(root);
        onTestFinished(() => {
          editor.setRootElement(null);
          root.remove();
        });
        const $mark = (selection: RangeSelection) => {
          if (withMarkNode) {
            $wrapSelectionInMarkNode(selection, false, 'c1');
          } else {
            $addMarkID('c1', selection);
          }
        };
        // " more"[c1] in another editor, as Lexical data
        update(editor, () => $init(' more'));
        update(editor, () => $mark($select(0, 5)));
        let json = '';
        update(editor, () => {
          json = JSON.stringify(
            $generateJSONFromSelectedNodes(editor, $select(0, 5)),
          );
        });
        update(editor, () => $init('see #foo bar'));
        update(editor, () => $mark($select(4, 8)));
        // Dropped at the end of the hashtag: a drop runs no paste command
        let hashtag: null | HTMLElement = null;
        editor.read(() => {
          const node = $paragraph()
            .getAllTextNodes()
            .find(text => text.getTextContent() === '#foo')!;
          hashtag = editor.getElementByKey(node.getKey());
        });
        let text: Node = hashtag!;
        while (text.nodeType !== Node.TEXT_NODE) {
          text = text.firstChild!;
        }
        Object.defineProperty(document, 'caretRangeFromPoint', {
          configurable: true,
          value: () => {
            const range = document.createRange();
            range.setStart(text, 4);
            return range;
          },
        });
        onTestFinished(() => {
          delete (document as {caretRangeFromPoint?: unknown})
            .caretRangeFromPoint;
        });
        const event = new Event('drop', {
          bubbles: true,
          cancelable: true,
        }) as DragEvent;
        Object.defineProperties(event, {
          clientX: {value: 1},
          clientY: {value: 1},
          dataTransfer: {
            value: dataTransfer({
              // Dragged from an editor that is not on the page
              'application/x-lexical-drag': JSON.stringify({
                editorKey: 'another-editor',
              }),
              'application/x-lexical-editor': json,
              'text/plain': ' more',
            }),
          },
        });
        expect(editor.dispatchCommand(DROP_COMMAND, event)).toBe(true);
        expect(tree(editor)).toBe(
          withMarkNode
            ? 'paragraph("see " mark[c1]("#foo") mark[c1](" more") " bar")'
            : 'paragraph("see " "#foo"[c1] " more"[c1] " bar")',
        );
      }
    });

    test('text that code inserts after a hashtag and marks in the same update keeps its ids', () => {
      // Marked together with the hashtag, like MarkNode
      for (const withMarkNode of [false, true]) {
        const editor = buildEditorFromExtensions(
          defineExtension({
            dependencies: [
              RichTextExtension,
              HashtagExtension,
              MarkExtension,
              ...(withMarkNode ? [] : [MarkStateExtension]),
            ],
            name: '[root]',
          }),
        );
        update(editor, () => $init('see #foo bar'));
        update(editor, () => {
          $select(8);
          $insertNodes([$createTextNode(' Q')]);
          if (withMarkNode) {
            $wrapSelectionInMarkNode($select(4, 10), false, 'c1');
          } else {
            $addMarkID('c1', $select(4, 10));
          }
          $select(10);
        });
        expect(tree(editor)).toBe(
          withMarkNode
            ? 'paragraph("see " mark[c1]("#foo" " Q") " bar")'
            : 'paragraph("see " "#foo"[c1] " Q"[c1] " bar")',
        );
      }
      // A run of nodes inserted after a marked hashtag, each marked by code
      const editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            RichTextExtension,
            HashtagExtension,
            MarkExtension,
            MarkStateExtension,
          ],
          name: '[root]',
        }),
      );
      update(editor, () => $init('see #foo'));
      mark(editor, 4, 8, 'c1');
      update(editor, () => {
        const nodes = [
          $createTextNode(' '),
          $createHashtagNode('#bar'),
          $createTextNode(' baz'),
        ];
        $select(8);
        $insertNodes(nodes);
        for (const node of nodes) {
          const selection = $createRangeSelection();
          selection.anchor.set(node.getKey(), 0, 'text');
          selection.focus.set(node.getKey(), node.getTextContentSize(), 'text');
          $addMarkID('c1', selection);
        }
      });
      expect(tree(editor)).toBe(
        'paragraph("see " "#foo"[c1] " "[c1] "#bar"[c1] " baz"[c1])',
      );
    });

    test('pasted text whose HTML is the same text is not marked after a marked hashtag, like MarkNode', () => {
      // The HTML import skips such HTML (iOS sends it with autocorrect), so
      // the text goes into the hashtag as plain text
      for (const how of ['paste', 'beforeinput']) {
        for (const withMarkNode of [false, true]) {
          const editor = buildEditorFromExtensions(
            defineExtension({
              dependencies: [
                RichTextExtension,
                HashtagExtension,
                MarkExtension,
                ...(withMarkNode ? [] : [MarkStateExtension]),
              ],
              name: '[root]',
            }),
          );
          update(editor, () => $init('see #foo bar'));
          update(editor, () => {
            const selection = $select(4, 8);
            if (withMarkNode) {
              $wrapSelectionInMarkNode(selection, false, 'c1');
            } else {
              $addMarkID('c1', selection);
            }
          });
          update(editor, () => $select(8));
          if (how === 'paste') {
            editor.dispatchCommand(
              PASTE_COMMAND,
              pasteEvent(', x', undefined, ', x'),
            );
          } else {
            const event = new InputEvent('beforeinput', {
              cancelable: true,
              inputType: 'insertReplacementText',
            });
            Object.defineProperty(event, 'dataTransfer', {
              value: dataTransfer({'text/html': ', x', 'text/plain': ', x'}),
            });
            editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, event);
          }
          expect([how, tree(editor)]).toEqual([
            how,
            withMarkNode
              ? 'paragraph("see " mark[c1]("#foo") ", x bar")'
              : 'paragraph("see " "#foo"[c1] ", x bar")',
          ]);
        }
      }
    });

    test('text typed inside a run is marked', () => {
      const editor = setup();
      update(editor, () => $select(11));
      typeText(editor, 'X');
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "greXw 4%"[c1] " in Q3.")',
      );
    });

    test('text replacing a selection inside a run is marked', () => {
      const editor = setup();
      update(editor, () => $select(9, 11));
      typeText(editor, 'X');
      expect(tree(editor)).toBe('paragraph("Revenue " "gXw 4%"[c1] " in Q3.")');
    });

    test('ids shared with the neighbor continue across the edge', () => {
      const editor = setup();
      mark(editor, 12, 19, 'c2');
      // Caret at the end of "grew"[c1], before " 4%"[c1,c2]
      update(editor, () => {
        const [, grew] = $paragraph().getChildren() as TextNode[];
        grew.select(4, 4);
      });
      typeText(editor, 'X');
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grewX"[c1] " 4%"[c1,c2] " in "[c2] "Q3.")',
      );
      // Caret at the end of " 4%"[c1,c2], before " in "[c2]: c1 ends here
      update(editor, () => {
        const [, , overlap] = $paragraph().getChildren() as TextNode[];
        overlap.select(3, 3);
      });
      typeText(editor, 'Y');
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grewX"[c1] " 4%"[c1,c2] "Y in "[c2] "Q3.")',
      );
    });

    test('text inserted natively into the DOM text', () => {
      // What the native beforeinput path ends up doing: the DOM text of the
      // marked node changes and is read back into it with the caret after it
      const editor = setup();
      update(editor, () => $select(15));
      update(editor, () => {
        const [, marked] = $paragraph().getChildren() as TextNode[];
        marked.setTextContent('grew 4%X');
        marked.select(8, 8);
      });
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%"[c1] "X in Q3.")',
      );
    });

    test('composition at the end of a run', () => {
      const editor = setup();
      update(editor, () => $select(15));
      update(editor, () => {
        editor.dispatchCommand(
          COMPOSITION_START_COMMAND,
          new CompositionEvent('compositionstart', {data: ''}),
        );
      });
      expect(editor.isComposing()).toBe(true);
      // The IME updates the DOM text of the composing node
      for (const composed of ['に', '日本']) {
        update(editor, () => {
          const [, marked] = $paragraph().getChildren() as TextNode[];
          expect(marked.isComposing()).toBe(true);
          marked.setTextContent('grew 4%' + composed);
          marked.select(7 + composed.length, 7 + composed.length);
        });
        // While composing the text stays in the node the IME writes to
        expect(tree(editor)).toBe(
          `paragraph("Revenue " "grew 4%${composed}"[c1] " in Q3.")`,
        );
      }
      update(editor, () => $setCompositionKey(null));
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%"[c1] "日本 in Q3.")',
      );
    });

    test('composition inside a run', () => {
      const editor = setup();
      update(editor, () => $select(11));
      update(editor, () => {
        editor.dispatchCommand(
          COMPOSITION_START_COMMAND,
          new CompositionEvent('compositionstart', {data: ''}),
        );
      });
      update(editor, () => {
        const [, marked] = $paragraph().getChildren() as TextNode[];
        marked.setTextContent('gre日w 4%');
        marked.select(4, 4);
      });
      update(editor, () => $setCompositionKey(null));
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "gre日w 4%"[c1] " in Q3.")',
      );
    });

    test('replayed and historic updates are left alone', () => {
      for (const tag of [COLLABORATION_TAG, HISTORIC_TAG]) {
        const editor = setup();
        update(editor, () => $select(15));
        update(editor, () => {
          $addUpdateTag(tag);
          const [, marked] = $paragraph().getChildren() as TextNode[];
          marked.setTextContent('grew 4%X');
          marked.select(8, 8);
        });
        expect(tree(editor)).toBe(
          'paragraph("Revenue " "grew 4%X"[c1] " in Q3.")',
        );
      }
    });

    test('a caret that was not at the edge does not split', () => {
      const editor = setup();
      update(editor, () => $select(3));
      // e.g. a programmatic append while the caret is elsewhere
      update(editor, () => {
        const [, marked] = $paragraph().getChildren() as TextNode[];
        marked.setTextContent('grew 4%X');
      });
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%X"[c1] " in Q3.")',
      );
    });

    test('pasting at the end of a run', () => {
      const editor = setup();
      update(editor, () => {
        $select(15);
        $insertNodes([$createTextNode('pasted')]);
      });
      expect(editor.read(() => $getNodeMarkIDsOfText('pasted'))).toEqual([]);
    });

    test('text typed with a different format inside a run is marked', () => {
      const editor = setup();
      update(editor, () => {
        $select(11);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.toggleFormat('bold');
        }
      });
      typeText(editor, 'X');
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "gre"[c1] "X"[c1] "w 4%"[c1] " in Q3.")',
      );
      expect(
        editor.read(() => $getRoot().getAllTextNodes()[2].hasFormat('bold')),
      ).toBe(true);
    });

    test('text pasted inside a run is marked', () => {
      const editor = setup();
      update(editor, () => {
        $select(11);
        $insertNodes([$createTextNode('pasted').toggleFormat('italic')]);
      });
      expect(editor.read(() => $getNodeMarkIDsOfText('pasted'))).toEqual([
        'c1',
      ]);
    });

    test('undo restores the marks and the output', () => {
      const editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            RichTextExtension,
            configExtension(HistoryExtension, {delay: 0}),
            MarkStateExtension,
          ],
          name: '[root]',
        }),
      );
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      expect(registryText(editor)).toEqual({c1: ['grew 4%']});
      update(editor, () => $select(15));
      typeText(editor, 'X');
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%"[c1] "X in Q3.")',
      );
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%"[c1] " in Q3.")',
      );
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      expect(tree(editor)).toBe('paragraph("Revenue grew 4% in Q3.")');
      expect(markIDNodeKeys(editor).size).toBe(0);
      editor.dispatchCommand(REDO_COMMAND, undefined);
      expect(registryText(editor)).toEqual({c1: ['grew 4%']});
    });

    test('disabled: typed text joins the run', () => {
      const editor = createTestEditor({disabled: true});
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      update(editor, () => $select(15));
      typeText(editor, 'X');
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%X"[c1] " in Q3.")',
      );
      expect(markIDNodeKeys(editor).size).toBe(0);
    });
  });

  describe('inserted text', () => {
    // The rule: inserted text gets the ids shared by the text right before
    // and right after the place it was inserted, plus, when it replaces a
    // selection, the ids all the replaced text had, plus its own ids (those
    // of pasted or otherwise inserted nodes). Typed text has no ids of its
    // own.

    function setupWithHistory() {
      const editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            RichTextExtension,
            configExtension(HistoryExtension, {delay: 0}),
            MarkStateExtension,
          ],
          name: '[root]',
        }),
      );
      // The reconciler is part of the repro: it syncs the paragraph's text
      // format during the undo, which dirties the paragraph
      const root = document.createElement('div');
      root.contentEditable = 'true';
      document.body.appendChild(root);
      editor.setRootElement(root);
      onTestFinished(() => {
        editor.setRootElement(null);
        root.remove();
      });
      return editor;
    }

    /** Copy a character range of the first paragraph */
    function copy(editor: LexicalEditor, start: number, end: number) {
      let json: null | ReturnType<typeof $generateJSONFromSelectedNodes> = null;
      update(editor, () => {
        json = $generateJSONFromSelectedNodes(editor, $select(start, end));
      });
      return json!;
    }

    function paste(
      editor: LexicalEditor,
      json: ReturnType<typeof $generateJSONFromSelectedNodes>,
      $selectTarget: () => void,
    ) {
      update(editor, () => $selectTarget());
      update(editor, () => {
        $insertGeneratedNodes(
          editor,
          $generateNodesFromSerializedNodes(json.nodes),
          $getSelection()!,
        );
      });
    }

    test('typing next to a gap in a mark does not spread the mark over the gap', () => {
      const editor = createTestEditor();
      update(editor, () => $init('kjisk'));
      mark(editor, 0, 5, 'c4');
      update(editor, () => $removeMarkID('c4', $select(1, 3)));
      expect(tree(editor)).toBe('paragraph("k"[c4] "ji" "sk"[c4])');
      update(editor, () =>
        $assertNodeType(
          $paragraph().getFirstChildOrThrow(),
          $isTextNode,
        ).select(1, 1),
      );
      typeText(editor, 'C');
      expect(tree(editor)).toBe('paragraph("k"[c4] "Cji" "sk"[c4])');
    });

    test('typing with a toggled format next to a gap in a mark', () => {
      const editor = createTestEditor();
      update(editor, () => $init('kjisk'));
      mark(editor, 0, 5, 'c4');
      update(editor, () => $removeMarkID('c4', $select(1, 3)));
      update(editor, () => {
        $select(3);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.toggleFormat('bold');
        }
      });
      typeText(editor, 'C');
      expect(tree(editor)).toBe('paragraph("k"[c4] "ji" "C" "sk"[c4])');
    });

    test('a caret set programmatically at the start of a run', () => {
      // The core moves a caret at offset 0 of a TextNode to the end of the
      // previous one before inserting: the text must still stay out of the
      // marks that start there
      // With a root element, as the core normalizes the caret as it does
      // for a caret read from the DOM
      const editor = createTestEditor({withRoot: true});
      update(editor, () => $init('aek'));
      mark(editor, 0, 1, 'c2');
      mark(editor, 0, 1, 'c3');
      mark(editor, 1, 3, 'c2');
      mark(editor, 1, 3, 'c5');
      expect(tree(editor)).toBe('paragraph("a"[c2,c3] "ek"[c2,c5])');
      for (const $place of [
        () =>
          $assertNodeType(
            $paragraph().getLastChildOrThrow(),
            $isTextNode,
          ).select(0, 0),
        () => $paragraph().getLastChildOrThrow().selectStart(),
      ]) {
        const copyEditor = createTestEditor({withRoot: true});
        copyEditor.setEditorState(
          copyEditor.parseEditorState(editor.getEditorState().toJSON()),
        );
        update(copyEditor, $place);
        typeText(copyEditor, 'B');
        expect(tree(copyEditor)).toBe(
          'paragraph("a"[c2,c3] "B"[c2] "ek"[c2,c5])',
        );
      }
      // And at the end of the first run
      update(editor, () =>
        $assertNodeType(
          $paragraph().getFirstChildOrThrow(),
          $isTextNode,
        ).select(1, 1),
      );
      typeText(editor, 'B');
      expect(tree(editor)).toBe('paragraph("a"[c2,c3] "B"[c2] "ek"[c2,c5])');
    });

    test('text inserted in the same update that moves the caret to an edge', () => {
      const editor = createTestEditor();
      update(editor, () => $init('abcdef'));
      mark(editor, 0, 3, 'c1');
      update(editor, () => $select(5));
      update(editor, () => {
        $assertNodeType(
          $paragraph().getFirstChildOrThrow(),
          $isTextNode,
        ).select(3, 3);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText('X');
        }
      });
      expect(tree(editor)).toBe('paragraph("abc"[c1] "Xdef")');
    });

    test('text replacing a whole marked run keeps its ids, text replacing across its edge does not', () => {
      const editor = setupEditorWithMark();
      update(editor, () => $select(8, 15));
      typeText(editor, 'X');
      expect(tree(editor)).toBe('paragraph("Revenue " "X"[c1] " in Q3.")');
      const across = setupEditorWithMark();
      update(across, () => $select(5, 11));
      typeText(across, 'X');
      expect(tree(across)).toBe('paragraph("RevenX" "w 4%"[c1] " in Q3.")');
    });

    function setupEditorWithMark() {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      return editor;
    }

    test('composition inside a run, in a new TextNode for a toggled format', () => {
      const editor = createTestEditor();
      update(editor, () => $init('abcdef'));
      mark(editor, 0, 6, 'c1');
      update(editor, () => {
        $select(3);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.toggleFormat('bold');
        }
      });
      update(editor, () => {
        editor.dispatchCommand(
          COMPOSITION_START_COMMAND,
          new CompositionEvent('compositionstart', {data: ''}),
        );
      });
      update(editor, () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          throw new Error('Expected a RangeSelection');
        }
        const node = selection.anchor.getNode() as TextNode;
        expect(node.isComposing()).toBe(true);
        node.setTextContent('日');
        node.select(1, 1);
      });
      update(editor, () => $setCompositionKey(null));
      expect(tree(editor)).toBe('paragraph("abc"[c1] "日"[c1] "def"[c1])');
      expect(
        editor.read(() => $getRoot().getAllTextNodes()[1].hasFormat('bold')),
      ).toBe(true);
    });

    test('pasting several nodes inside a run: all of them join it', () => {
      const editor = createTestEditor();
      update(editor, () => {
        $init('aaaa');
        $paragraph().append($createTextNode('bbbb'));
      });
      mark(editor, 1, 3, 'x');
      mark(editor, 4, 8, 'c1');
      expect(tree(editor)).toBe('paragraph("a" "aa"[x] "a" "bbbb"[c1])');
      const json = copy(editor, 1, 4);
      paste(editor, json, () => $select(6));
      expect(tree(editor)).toBe(
        'paragraph("a" "aa"[x] "a" "bb"[c1] "aa"[c1,x] "abb"[c1])',
      );
    });

    test('pasted text keeps its own ids at the edge of a run', () => {
      // The same ids as the run it is pasted at the end of
      const editor = createTestEditor();
      update(editor, () => {
        $init('abcd');
        $paragraph().append($createTextNode('zz').toggleFormat('bold'));
      });
      mark(editor, 0, 4, 'c1');
      paste(editor, copy(editor, 2, 4), () =>
        $assertNodeType(
          $paragraph().getFirstChildOrThrow(),
          $isTextNode,
        ).select(4, 4),
      );
      expect(tree(editor)).toBe('paragraph("abcdcd"[c1] "zz")');
      // Other ids, at the start of a run
      const other = createTestEditor();
      update(other, () => $init('xy abcd'));
      mark(other, 0, 2, 'c2');
      mark(other, 3, 7, 'c1');
      paste(other, copy(other, 0, 2), () =>
        $assertNodeType($paragraph().getLastChildOrThrow(), $isTextNode).select(
          0,
          0,
        ),
      );
      expect(tree(other)).toBe('paragraph("xy"[c2] " " "xy"[c2] "abcd"[c1])');
    });

    test('pasted marked text inside a run keeps its ids and joins the run', () => {
      const editor = createTestEditor();
      update(editor, () => $init('xy abcd'));
      mark(editor, 0, 2, 'c2');
      mark(editor, 3, 7, 'c1');
      paste(editor, copy(editor, 0, 2), () => $select(5));
      expect(tree(editor)).toBe(
        'paragraph("xy"[c2] " " "ab"[c1] "xy"[c1,c2] "cd"[c1])',
      );
    });

    test('text inserted with insertNodes keeps its own ids', () => {
      const editor = setupEditorWithMark();
      update(editor, () => {
        $select(15);
        const node = $createTextNode('new');
        $insertNodes([node]);
        $addMarkID('c1', node.select(0, 3));
      });
      // Equal ids at the edge: merged into the run, and kept
      update(editor, () => {
        $select(18);
        const node = $createTextNode('!').toggleFormat('bold');
        $insertNodes([node]);
      });
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%new"[c1] "!" " in Q3.")',
      );
    });

    test('undo after removing marked text restores the output', () => {
      // A history setEditorState that other transforms also dirty: the output
      // must not depend on the shape of its dirty sets
      for (const bold of [false, true]) {
        const editor = setupWithHistory();
        update(editor, () => {
          const node = $createTextNode('xqCm');
          $getRoot().clear().append($createParagraphNode().append(node));
          if (bold) {
            node.toggleFormat('bold');
          }
          $addMarkID('c2', node.select(0, 4));
        });
        editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
        update(editor, () =>
          $assertNodeType(
            $paragraph().getFirstChildOrThrow(),
            $isTextNode,
          ).select(3, 3),
        );
        update(editor, () => {
          editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
        });
        update(editor, () =>
          $assertNodeType(
            $paragraph(1).getFirstChildOrThrow(),
            $isTextNode,
          ).select(0, 1),
        );
        update(editor, () => {
          editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
        });
        editor.dispatchCommand(UNDO_COMMAND, undefined);
        expect(tree(editor)).toBe('paragraph("xqC"[c2]) / paragraph("m"[c2])');
        expect(registryText(editor)).toEqual({c2: ['m', 'xqC']});
        update(editor, () => $removeMarkID('c2'));
        expect(tree(editor)).toBe('paragraph("xqC") / paragraph("m")');
      }
    });

    test('a setEditorState of a state from elsewhere rescans the output', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      const marked = editor.getEditorState();
      update(editor, () => $removeMarkID('c1'));
      expect(markIDNodeKeys(editor).size).toBe(0);
      // A transform that dirties another node during the setEditorState
      const unregister = editor.registerNodeTransform(RootNode, root => {
        for (const node of root.getAllTextNodes()) {
          if (node.getTextContent() === ' in Q3.') {
            node.setTextContent(' in Q4.');
          }
        }
      });
      editor.setEditorState(marked);
      unregister();
      expect(registryText(editor)).toEqual({c1: ['grew 4%']});
    });
  });

  describe('replaced and re-created text', () => {
    /** The text of an autocorrection, as a beforeinput event carries it */
    function replacement(text: string) {
      return {
        data: null,
        dataTransfer: {
          getData: (type: string) => (type === 'text/plain' ? text : ''),
          types: ['text/plain'],
        },
        inputType: 'insertReplacementText',
      } as unknown as InputEvent;
    }

    /**
     * Mark `[markStart, markEnd)` of `text` with c1, as MarkState ids or as
     * a MarkNode, then replace `[start, end)` with `payload`. The selection
     * is committed first, as when the user selects the text, or set in the
     * same update, as a beforeinput event sets it from its target range.
     */
    function replaceText(
      withMarkNode: boolean,
      text: string,
      [markStart, markEnd]: [number, number],
      [start, end]: [number, number],
      payload: string | InputEvent,
      sameUpdate: boolean,
    ): string {
      const editor = createTestEditor();
      update(editor, () => $init(text));
      update(editor, () => {
        const selection = $select(markStart, markEnd);
        if (withMarkNode) {
          $wrapSelectionInMarkNode(selection, false, 'c1');
        } else {
          $addMarkID('c1', selection);
        }
      });
      if (!sameUpdate) {
        update(editor, () => $select(start, end));
      }
      update(editor, () => {
        if (sameUpdate) {
          $select(start, end);
        }
        editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, payload);
      });
      return tree(editor);
    }

    const cases: [
      string,
      string,
      [number, number],
      [number, number],
      string | InputEvent,
      string,
      string,
    ][] = [
      // label, text, marked, replaced, inserted, MarkState, MarkNode
      [
        'a word inside a run, by its first letter',
        'x teh y',
        [0, 7],
        [2, 5],
        't',
        'paragraph("x t y"[c1])',
        'paragraph(mark[c1]("x t y"))',
      ],
      [
        'a word inside a run, by its last letter',
        'x teh y',
        [0, 7],
        [2, 5],
        'h',
        'paragraph("x h y"[c1])',
        'paragraph(mark[c1]("x h y"))',
      ],
      [
        'a word inside a run, by the corrected word',
        'x teh y',
        [0, 7],
        [2, 5],
        'the',
        'paragraph("x the y"[c1])',
        'paragraph(mark[c1]("x the y"))',
      ],
      [
        'a word inside a run, by an autocorrection',
        'x teh y',
        [0, 7],
        [2, 5],
        replacement('the'),
        'paragraph("x the y"[c1])',
        'paragraph(mark[c1]("x the y"))',
      ],
      // MarkNode loses the mark when all of its text is replaced (the empty
      // MarkNode is removed); the ids are kept, so retyping a commented
      // word keeps the comment
      [
        'a whole run, by its first letter',
        'a grew b',
        [2, 6],
        [2, 6],
        'g',
        'paragraph("a " "g"[c1] " b")',
        'paragraph("a g b")',
      ],
      [
        'a whole run, by an autocorrection',
        'a recieve b',
        [2, 9],
        [2, 9],
        replacement('receive'),
        'paragraph("a " "receive"[c1] " b")',
        'paragraph("a receive b")',
      ],
      [
        'across the start of a run, by text that starts with the same letter',
        'abcde',
        [2, 5],
        [1, 3],
        'bX',
        'paragraph("abX" "de"[c1])',
        'paragraph("abX" mark[c1]("de"))',
      ],
    ];
    for (const [
      label,
      text,
      marked,
      range,
      payload,
      state,
      markNode,
    ] of cases) {
      test(`replacing ${label}`, () => {
        for (const sameUpdate of [false, true]) {
          expect(
            replaceText(false, text, marked, range, payload, sameUpdate),
          ).toBe(state);
          expect(
            replaceText(true, text, marked, range, payload, sameUpdate),
          ).toBe(markNode);
        }
      });
    }

    test('text replaced by code that dispatches no command keeps the letters it kept', () => {
      // Without the selection the insertion command replaced, the smallest
      // edit tells the kept letters from the inserted ones: "t" and "e" are
      // kept with their ids, "h" is inserted between them
      const editor = createTestEditor();
      update(editor, () => $init('x teh y'));
      mark(editor, 0, 7, 'c1');
      mark(editor, 2, 3, 'c2');
      expect(tree(editor)).toBe('paragraph("x "[c1] "t"[c1,c2] "eh y"[c1])');
      update(editor, () => $select(2, 5).insertText('the'));
      expect(tree(editor)).toBe('paragraph("x "[c1] "t"[c1,c2] "he y"[c1])');
      // The same edit through the command replaces the selection: the new
      // text gets the ids all of the replaced text had
      const typed = createTestEditor();
      update(typed, () => $init('x teh y'));
      mark(typed, 0, 7, 'c1');
      mark(typed, 2, 3, 'c2');
      update(typed, () => $select(2, 5));
      typeText(typed, 'the');
      expect(tree(typed)).toBe('paragraph("x the y"[c1])');
    });

    test('the replaced selection is known when the command is dispatched outside an update', async () => {
      // Each priority level of a command dispatched outside an update runs
      // in an update of its own, and the DOM paste event dispatches
      // PASTE_COMMAND that way
      const outsideCases: [
        string,
        [number, number],
        [number, number],
        string,
        string,
      ][] = [
        ['abcde', [2, 5], [1, 3], 'bX', 'paragraph("abX" "de"[c1])'],
        ['abcde', [0, 3], [2, 4], 'cX', 'paragraph("ab"[c1] "cXe")'],
        ['x teh y', [0, 7], [2, 5], 't', 'paragraph("x t y"[c1])'],
        ['a grew b', [2, 6], [2, 6], 'g', 'paragraph("a " "g"[c1] " b")'],
      ];
      for (const [
        text,
        marked,
        [start, end],
        payload,
        expected,
      ] of outsideCases) {
        for (const how of ['command', 'paste', 'paste event']) {
          const editor = createTestEditor({withRoot: how === 'paste event'});
          update(editor, () => $init(text));
          mark(editor, marked[0], marked[1], 'c1');
          update(editor, () => $select(start, end));
          if (how === 'command') {
            editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, payload);
          } else if (how === 'paste') {
            editor.dispatchCommand(PASTE_COMMAND, pasteEvent(payload));
          } else {
            editor.getRootElement()!.dispatchEvent(pasteEvent(payload));
          }
          await Promise.resolve();
          expect([how, tree(editor)]).toEqual([how, expected]);
        }
      }
    });

    test('the selection of a command that changed nothing is not used by a later update', async () => {
      const editor = createTestEditor();
      editor.registerCommand(
        CONTROLLED_TEXT_INSERTION_COMMAND,
        () => true,
        COMMAND_PRIORITY_HIGH,
      );
      update(editor, () => $init('abcde'));
      mark(editor, 2, 5, 'c1');
      update(editor, () => $select(1, 3));
      editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, 'bX');
      expect(tree(editor)).toBe('paragraph("ab" "cde"[c1])');
      await Promise.resolve();
      // Code that dispatches no command: the smallest edit
      update(editor, () => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.insertText('bX');
        }
      });
      expect(tree(editor)).toBe('paragraph("ab" "Xde"[c1])');
    });

    test('an id removed in the same update is not given back', () => {
      for (const range of [false, true]) {
        const editor = createEntityEditor(false);
        update(editor, () => $init('see foo bar'));
        markAll(editor, false);
        update(editor, () => $select(4));
        update(editor, () => {
          editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, '#');
          $removeMarkID('c1', range ? $select(4, 8) : null);
        });
        expect(tree(editor)).toBe(
          range
            ? 'paragraph("see "[c1] "#foo" " bar"[c1])'
            : 'paragraph("see " "#foo" " bar")',
        );
        expect(registryText(editor)).toEqual(
          range ? {c1: [' bar', 'see ']} : {},
        );
      }
      // Nor to text that replaces a selection, before or after the removal
      for (const removeFirst of [false, true]) {
        const editor = createTestEditor();
        update(editor, () => $init('x teh y'));
        mark(editor, 0, 7, 'c1');
        update(editor, () => {
          if (removeFirst) {
            $removeMarkID('c1');
          }
          $select(2, 5);
          editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, 'the');
          if (!removeFirst) {
            $removeMarkID('c1');
          }
        });
        expect(tree(editor)).toBe('paragraph("x the y")');
      }
    });

    test('a long TextNode is compared around the change', () => {
      const long = 'abcdefghij'.repeat(2000);
      const editor = createTestEditor();
      update(editor, () => $init(long));
      mark(editor, 10000, 10010, 'c1');
      // At either edge, inside, and a letter equal to the one after the edge
      for (const [at, text, run] of [
        [10010, 'X', '"abcdefghij"[c1] "Xabc'],
        [10000, 'Y', 'Y" "abcdefghij"[c1] "Xabc'],
        [10007, 'Z', 'Y" "abcdefZghij"[c1] "Xabc'],
        [10012, 'X', 'Y" "abcdefZghij"[c1] "XXabc'],
      ] as [number, string, string][]) {
        update(editor, () => $select(at));
        typeText(editor, text);
        expect(tree(editor)).toContain(run);
      }
      // A selection replaced across the end of the mark
      update(editor, () => $select(10011, 10013));
      typeText(editor, 'jQ');
      expect(tree(editor)).toContain('Y" "abcdefZghi"[c1] "jQXabc');
      expect(editor.read(() => $getRoot().getTextContentSize())).toBe(20004);
    });

    test('no edit splits a surrogate pair', () => {
      const editor = createTestEditor();
      update(editor, () => $init('x\u{1F600}\u{1F642}y'));
      mark(editor, 1, 5, 'c1');
      // An emoji typed between the marked emoji joins the run
      update(editor, () => $select(3));
      typeText(editor, '\u{1F603}');
      expect(tree(editor)).toBe(
        'paragraph("x" "\u{1F600}\u{1F603}\u{1F642}"[c1] "y")',
      );
      // Emoji replaced without a command by one that shares their first code
      // unit: the kept text is found by code point
      const other = createTestEditor();
      update(other, () => $init('x\u{1F600}\u{1F642}y'));
      mark(other, 1, 3, 'c1');
      update(other, () => $select(1, 5).insertText('\u{1F603}'));
      expect(tree(other)).toBe('paragraph("x\u{1F603}y")');
    });

    test('a handler that wraps the selection instead of replacing it keeps its ids', () => {
      const editor = createTestEditor();
      update(editor, () => $init('x teh y'));
      mark(editor, 0, 7, 'c1');
      mark(editor, 2, 4, 'c2');
      expect(tree(editor)).toBe('paragraph("x "[c1] "te"[c1,c2] "h y"[c1])');
      editor.registerCommand(
        CONTROLLED_TEXT_INSERTION_COMMAND,
        payload => {
          const selection = $getSelection();
          if (
            payload !== '"' ||
            !$isRangeSelection(selection) ||
            selection.isCollapsed()
          ) {
            return false;
          }
          const [start, end] = selection.isBackward()
            ? [selection.focus, selection.anchor]
            : [selection.anchor, selection.focus];
          const startNode = start.getNode() as TextNode;
          const endNode = end.getNode() as TextNode;
          const [startOffset, endOffset] = [start.offset, end.offset];
          endNode.spliceText(endOffset, 0, '"');
          startNode.spliceText(startOffset, 0, '"');
          const after = endOffset + (startNode.is(endNode) ? 2 : 1);
          endNode.select(after, after);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      );
      update(editor, () => $select(2, 5));
      typeText(editor, '"');
      expect(tree(editor)).toBe(
        `paragraph(${JSON.stringify('x "')}[c1] "te"[c1,c2] ${JSON.stringify('h" y')}[c1])`,
      );
    });

    function createEntityEditor(withMarkNode: boolean) {
      const editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            RichTextExtension,
            HashtagExtension,
            MarkExtension,
            ...(withMarkNode ? [] : [MarkStateExtension]),
          ],
          name: '[root]',
          nodes: () => [MentionNode],
          // Like a mentions plugin: "@name" is replaced by a new token node
          register: entityEditor =>
            entityEditor.registerNodeTransform(TextNode, node => {
              const match = node.isSimpleText()
                ? /@[a-z]+/.exec(node.getTextContent())
                : null;
              if (match !== null) {
                const parts = node.splitText(
                  match.index,
                  match.index + match[0].length,
                );
                const target = parts[match.index === 0 ? 0 : 1];
                target.replace($createMentionNode(target.getTextContent()));
              }
            }),
        }),
      );
      // With a root element, as deleting a character can read the DOM
      const root = document.createElement('div');
      root.contentEditable = 'true';
      document.body.appendChild(root);
      editor.setRootElement(root);
      onTestFinished(() => {
        editor.setRootElement(null);
        root.remove();
      });
      return editor;
    }

    function markAll(editor: LexicalEditor, withMarkNode: boolean) {
      update(editor, () => {
        const selection = $select(0, $paragraph().getTextContentSize());
        if (withMarkNode) {
          $wrapSelectionInMarkNode(selection, false, 'c1');
        } else {
          $addMarkID('c1', selection);
        }
      });
    }

    test('a hashtag created from marked text keeps its ids, like MarkNode', () => {
      for (const withMarkNode of [false, true]) {
        const editor = createEntityEditor(withMarkNode);
        update(editor, () => $init('see foo bar'));
        markAll(editor, withMarkNode);
        update(editor, () => $select(4));
        typeText(editor, '#');
        expect(tree(editor)).toBe(
          withMarkNode
            ? 'paragraph(mark[c1]("see " "#foo" " bar"))'
            : 'paragraph("see "[c1] "#foo"[c1] " bar"[c1])',
        );
        expect(
          editor.read(() =>
            $paragraph()
              .getAllTextNodes()
              .map(node => node.getType()),
          ),
        ).toEqual(['text', 'hashtag', 'text']);
        // Deleting the "#" turns it back into text, which keeps them too
        update(editor, () => $select(4, 5));
        update(editor, () => {
          editor.dispatchCommand(DELETE_CHARACTER_COMMAND, true);
        });
        expect(tree(editor)).toBe(
          withMarkNode
            ? 'paragraph(mark[c1]("see foo bar"))'
            : 'paragraph("see foo bar"[c1])',
        );
      }
    });

    test('a token node created from marked text keeps its ids, like MarkNode', () => {
      for (const withMarkNode of [false, true]) {
        const editor = createEntityEditor(withMarkNode);
        update(editor, () => $init('hi bob x'));
        markAll(editor, withMarkNode);
        update(editor, () => $select(3));
        typeText(editor, '@');
        expect(tree(editor)).toBe(
          withMarkNode
            ? 'paragraph(mark[c1]("hi " "@bob" " x"))'
            : 'paragraph("hi "[c1] "@bob"[c1] " x"[c1])',
        );
        expect(
          editor.read(() =>
            $paragraph()
              .getAllTextNodes()
              .map(node => `${node.getType()}:${node.getMode()}`),
          ),
        ).toEqual(['text:normal', 'test-mention:token', 'text:normal']);
      }
    });

    test('an atomic node created from text with different ids gets all of them', () => {
      // "#" typed at the start of a marked paragraph is at the edge of the
      // mark, but the hashtag it makes is one node: it keeps the ids of "foo"
      const editor = createEntityEditor(false);
      update(editor, () => $init('foo'));
      markAll(editor, false);
      update(editor, () => $select(0));
      typeText(editor, '#');
      expect(tree(editor)).toBe('paragraph("#foo"[c1])');
      expect(
        editor.read(() => $paragraph().getFirstChildOrThrow().getType()),
      ).toBe('hashtag');
    });

    test('typing inside a segmented node in a marked run keeps its ids, like MarkNode', () => {
      for (const withMarkNode of [false, true]) {
        const editor = createTestEditor();
        update(editor, () => {
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(
                $createTextNode('hi '),
                $createTextNode('Alice Smith').setMode('segmented'),
                $createTextNode(' ok'),
              ),
            );
        });
        markAll(editor, withMarkNode);
        update(editor, () => $select(8));
        typeText(editor, 'X');
        expect(tree(editor)).toBe(
          withMarkNode
            ? 'paragraph(mark[c1]("hi AliceX Smith ok"))'
            : 'paragraph("hi AliceX Smith ok"[c1])',
        );
      }
    });

    function compose(editor: LexicalEditor, taggedEdit: () => void) {
      update(editor, () => $select(15));
      update(editor, () => {
        editor.dispatchCommand(
          COMPOSITION_START_COMMAND,
          new CompositionEvent('compositionstart', {data: ''}),
        );
      });
      update(editor, () => {
        const marked = $paragraph().getChildAtIndex(1) as TextNode;
        marked.setTextContent('grew 4%に');
        marked.select(8, 8);
      });
      update(editor, () => {
        $addUpdateTag(COLLABORATION_TAG);
        taggedEdit();
      });
      update(editor, () => {
        const marked = $paragraph().getChildAtIndex(1) as TextNode;
        const text = marked.getTextContent().replace('に', '日本');
        marked.setTextContent(text);
        marked.select(text.length, text.length);
      });
      update(editor, () => $setCompositionKey(null));
    }

    test('an update tagged COLLABORATION_TAG editing the paragraph of a composition', () => {
      // Comparing with the paragraph from before the composition would take
      // the "P" of the tagged update for composed text and change its ids, so
      // the composed text is left in the node it was composed in
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      compose(editor, () => {
        const marked = $paragraph().getChildAtIndex(1) as TextNode;
        marked.setTextContent('grew 4%Pに');
        marked.select(9, 9);
      });
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%P日本"[c1] " in Q3.")',
      );
      // An edit in another paragraph does not change how it is compared
      const other = createTestEditor();
      update(other, () => {
        $init();
        $getRoot().append($createParagraphNode().append($createTextNode('z')));
      });
      mark(other, 8, 15, 'c1');
      compose(other, () => {
        $assertNodeType(
          $paragraph(1).getFirstChildOrThrow(),
          $isTextNode,
        ).setTextContent('zz');
      });
      expect(tree(other)).toBe(
        'paragraph("Revenue " "grew 4%"[c1] "日本 in Q3.") / paragraph("zz")',
      );
    });
  });

  describe('composition over a selection', () => {
    function startComposition(editor: LexicalEditor) {
      update(editor, () => {
        editor.dispatchCommand(COMPOSITION_START_COMMAND, {
          data: '',
          timeStamp: Number.MAX_SAFE_INTEGER,
        } as CompositionEvent);
      });
      expect(editor.isComposing()).toBe(true);
    }

    /** The input method writes `composed` at the caret, over the placeholder. */
    function compose(editor: LexicalEditor, composed: string) {
      update(editor, () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          throw new Error('no selection');
        }
        const target = selection.anchor.getNode() as TextNode;
        const content = target.getTextContent();
        let at = selection.anchor.offset;
        if (content[at] !== '\u200b' && content[at - 1] === '\u200b') {
          at--;
        }
        target.spliceText(at, content[at] === '\u200b' ? 1 : 0, composed, true);
      });
    }

    function setupMarked(
      text: string,
      marks: [number, number, string][],
      [start, end]: [number, number],
    ): LexicalEditor {
      const editor = createTestEditor();
      update(editor, () => $init(text));
      for (const [markStart, markEnd, id] of marks) {
        mark(editor, markStart, markEnd, id);
      }
      update(editor, () => $select(start, end));
      return editor;
    }

    test.each([
      // label, text, marked, replaced, composed, result
      [
        'the end of a run, by longer text',
        'abcd',
        [0, 4],
        [2, 4],
        'cde',
        'paragraph("abcde"[c1])',
      ],
      [
        'the end of a run followed by plain text, by longer text',
        'abcd xy',
        [0, 4],
        [2, 4],
        'cde',
        'paragraph("abcde"[c1] " xy")',
      ],
      [
        'a word inside a run',
        'x teh y',
        [0, 7],
        [2, 5],
        'the',
        'paragraph("x the y"[c1])',
      ],
      [
        'text only partly in the run',
        'abcd xy',
        [0, 4],
        [2, 6],
        'zz',
        'paragraph("ab"[c1] "zzy")',
      ],
    ] as [
      string,
      string,
      [number, number],
      [number, number],
      string,
      string,
    ][])(
      'replacing %s gives the text the ids all of the replaced text had',
      (_label, text, [markStart, markEnd], replaced, composed, result) => {
        const editor = setupMarked(
          text,
          [[markStart, markEnd, 'c1']],
          replaced,
        );
        startComposition(editor);
        compose(editor, composed);
        update(editor, () => $setCompositionKey(null));
        expect(tree(editor)).toBe(result);
      },
    );

    describe('in a block with a named slot', () => {
      /** "abcd xy" with c1 on "abcd", in the block (`where`) the test names. */
      function setupSlotted(where: 'children' | 'slot'): LexicalEditor {
        const editor = createTestEditor();
        update(editor, () => {
          const title = $createParagraphNode().append(
            $createTextNode(where === 'slot' ? 'abcd xy' : 'Title'),
          );
          const block = $create(TitledParagraphNode).append(
            $createTextNode(where === 'slot' ? 'Body' : 'abcd xy'),
          );
          $setSlot(block, 'title', title);
          $getRoot().clear().append(block);
        });
        // The text node holding "abcd xy" (a host's getAllTextNodes lists
        // its slots' text first, so it is picked directly)
        const $target = () => {
          const block = $paragraph();
          const parent =
            where === 'slot'
              ? ($getSlot(block, 'title') as ElementNode)
              : block;
          return parent.getFirstChildOrThrow() as TextNode;
        };
        update(editor, () => {
          $addMarkID('c1', $target().select(0, 4));
        });
        update(editor, () => {
          $target().select(2, 4);
        });
        return editor;
      }

      test.each(['children', 'slot'] as const)(
        'replacing the end of a run in its %s gives the text the ids all of the replaced text had',
        where => {
          const editor = setupSlotted(where);
          startComposition(editor);
          compose(editor, 'cde');
          update(editor, () => $setCompositionKey(null));
          const marked = editor.read(() => {
            const block = $paragraph();
            const target =
              where === 'slot'
                ? ($getSlot(block, 'title') as ElementNode)
                : block;
            return target
              .getChildren()
              .filter(node => $getNodeMarkIDs(node).includes('c1'))
              .map(node => node.getTextContent())
              .join('');
          });
          expect(marked).toBe('abcde');
        },
      );
    });

    test('replacing the end of a run inside an inline element that adds text of its own gives the text the ids all of the replaced text had', () => {
      const editor = createTestEditor();
      update(editor, () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $create(BracketedInlineNode).append($createTextNode('abcd xy')),
            ),
          );
      });
      const $text = () => $getRoot().getAllTextNodes()[0];
      update(editor, () => {
        $addMarkID('c1', $text().select(0, 4));
      });
      update(editor, () => {
        $text().select(2, 4);
      });
      startComposition(editor);
      compose(editor, 'cde');
      update(editor, () => $setCompositionKey(null));
      const marked = editor.read(() =>
        $getRoot()
          .getAllTextNodes()
          .filter(node => $getNodeMarkIDs(node).includes('c1'))
          .map(node => node.getTextContent())
          .join(''),
      );
      expect(marked).toBe('abcde');
    });

    /** Composes `composed` over the placeholder at the caret, if there is one. */
    function composeOverPlaceholder(editor: LexicalEditor, composed: string) {
      update(editor, () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          throw new Error('no selection');
        }
        const target = selection.anchor.getNode() as TextNode;
        const content = target.getTextContent();
        const at = selection.anchor.offset;
        if (content[at - 1] === '\u200b' || content[at - 1] === '\u00a0') {
          target.spliceText(at - 1, 1, composed, true);
        } else {
          target.spliceText(
            at,
            content[at] === '\u200b' ? 1 : 0,
            composed,
            true,
          );
        }
      });
    }

    test.each([
      ['nothing (a start that removes the selection)', ''],
      ['a zero-width space', '\u200b'],
      ['a no-break space', '\u00a0'],
    ])(
      'a selection replaced by %s at the composition start gives the composed text the ids all of it had',
      (_label, placeholder) => {
        const editor = setupMarked('abcd', [[0, 4, 'c1']], [2, 4]);
        editor.registerCommand(
          CONTROLLED_TEXT_INSERTION_COMMAND,
          payload => {
            const selection = $getSelection();
            if (
              payload !== '\u200b' ||
              placeholder === '\u200b' ||
              !$isRangeSelection(selection)
            ) {
              return false;
            }
            if (placeholder === '') {
              selection.removeText();
            } else {
              selection.insertText(placeholder);
            }
            return true;
          },
          COMMAND_PRIORITY_HIGH,
        );
        startComposition(editor);
        composeOverPlaceholder(editor, 'cde');
        update(editor, () => $setCompositionKey(null));
        // A no-break space the composition kept is not the point here: the
        // composed text and the text before it have the run's id
        expect(tree(editor).replace(/\u00a0/g, '')).toBe(
          'paragraph("abcde"[c1])',
        );
      },
    );

    /** Collapses the selection to its focus when a composition starts. */
    function collapseOnCompositionStart(editor: LexicalEditor) {
      editor.registerCommand(
        COMPOSITION_START_COMMAND,
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const {key, offset, type} = selection.focus;
            selection.anchor.set(key, offset, type);
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      );
    }

    test('a selection of an inline decorator without text that a handler kept was not replaced', () => {
      const editor = createTestEditor();
      update(editor, () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('ab'),
              $create(EmptyInlineDecoratorNode),
              $createTextNode('cd'),
            ),
          );
      });
      const $selectDecorator = () => {
        const key = $paragraph().getKey();
        const selection = $createRangeSelection();
        selection.anchor.set(key, 1, 'element');
        selection.focus.set(key, 2, 'element');
        $setSelection(selection);
        return selection;
      };
      update(editor, () => {
        $addMarkID('c1', $selectDecorator());
      });
      update(editor, () => {
        $selectDecorator();
      });
      collapseOnCompositionStart(editor);
      startComposition(editor);
      compose(editor, 'X');
      update(editor, () => $setCompositionKey(null));
      const composedIds = editor.read(() => {
        const node = $getRoot()
          .getAllTextNodes()
          .find(text => text.getTextContent().includes('X'));
        return node ? $getNodeMarkIDs(node) : null;
      });
      expect(composedIds).toEqual([]);
    });

    test('a selection that is a no-break space, kept by a start that wrote nothing, was not replaced', () => {
      const editor = setupMarked(
        'a\u00a0b',
        [
          [0, 3, 'c1'],
          [1, 2, 'c2'],
        ],
        [1, 2],
      );
      collapseOnCompositionStart(editor);
      // The start writes nothing (as a browser that composes in place)
      editor.registerCommand(
        CONTROLLED_TEXT_INSERTION_COMMAND,
        payload => payload === '\u200b',
        COMMAND_PRIORITY_HIGH,
      );
      startComposition(editor);
      compose(editor, 'X');
      update(editor, () => $setCompositionKey(null));
      const composedIds = editor.read(() => {
        const node = $getRoot()
          .getAllTextNodes()
          .find(text => text.getTextContent().includes('X'));
        return node ? $getNodeMarkIDs(node) : null;
      });
      expect(composedIds).toEqual(['c1']);
    });

    test('a selection that a handler collapsed before the composition started was not replaced', () => {
      const editor = setupMarked('abcd', [[0, 4, 'c1']], [2, 4]);
      editor.registerCommand(
        COMPOSITION_START_COMMAND,
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const {key, offset, type} = selection.focus;
            selection.anchor.set(key, offset, type);
          }
          return false;
        },
        COMMAND_PRIORITY_HIGH,
      );
      startComposition(editor);
      compose(editor, 'X');
      update(editor, () => $setCompositionKey(null));
      expect(tree(editor)).toBe('paragraph("abcd"[c1] "X")');
    });

    test('a selection that a handler of the composition placeholder kept was not replaced', () => {
      const editor = setupMarked(
        'x teh y',
        [
          [0, 7, 'c1'],
          [2, 4, 'c2'],
        ],
        [2, 5],
      );
      // Quotes the selection instead of replacing it with the placeholder
      editor.registerCommand(
        CONTROLLED_TEXT_INSERTION_COMMAND,
        payload => {
          const selection = $getSelection();
          if (
            payload !== '\u200b' ||
            !$isRangeSelection(selection) ||
            selection.isCollapsed()
          ) {
            return false;
          }
          const [start, end] = selection.isBackward()
            ? [selection.focus, selection.anchor]
            : [selection.anchor, selection.focus];
          const startNode = start.getNode() as TextNode;
          const endNode = end.getNode() as TextNode;
          const startAt = start.offset;
          const endAt = end.offset;
          endNode.spliceText(endAt, 0, '"');
          startNode.spliceText(startAt, 0, '"');
          const offset = endAt + (startNode.is(endNode) ? 2 : 1);
          endNode.select(offset, offset);
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      );
      startComposition(editor);
      update(editor, () => $setCompositionKey(null));
      expect(tree(editor)).toBe(
        'paragraph("x \\""[c1] "te"[c1,c2] "h\\" y"[c1])',
      );
    });
  });

  describe('output', () => {
    test('after loading JSON, and $removeMarkID(id) through it', () => {
      const source = createTestEditor();
      update(source, () => $init());
      mark(source, 8, 15, 'c1');
      mark(source, 0, 3, 'c2');
      const json = JSON.stringify(source.getEditorState().toJSON());
      const editor = createTestEditor();
      editor.setEditorState(editor.parseEditorState(json));
      expect(registryText(editor)).toEqual({c1: ['grew 4%'], c2: ['Rev']});
      update(editor, () => $removeMarkID('c1'));
      expect(registryText(editor)).toEqual({c2: ['Rev']});
      expect(tree(editor)).toBe('paragraph("Rev"[c2] "enue grew 4% in Q3.")');
    });

    test('drops the leaves of a removed paragraph, and only those', () => {
      const editor = createTestEditor();
      update(editor, () => {
        $init();
        $getRoot().append(
          $createParagraphNode().append($createTextNode('Two')),
        );
      });
      mark(editor, 0, 3, 'c1');
      update(editor, () => {
        const selection = $createRangeSelection();
        const node = $paragraph(1).getFirstChildOrThrow();
        selection.anchor.set(node.getKey(), 0, 'text');
        selection.focus.set(node.getKey(), 3, 'text');
        $addMarkID('c1', selection);
        $addMarkID('c2', selection);
      });
      expect(registryText(editor)).toEqual({c1: ['Rev', 'Two'], c2: ['Two']});
      update(editor, () => $paragraph(1).remove());
      expect(registryText(editor)).toEqual({c1: ['Rev']});
    });

    test('disabled from the start: empty, and $removeMarkID(id) walks the document', () => {
      const editor = createTestEditor({disabled: true});
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      expect(markIDNodeKeys(editor).size).toBe(0);
      update(editor, () => $removeMarkID('c1'));
      expect(tree(editor)).toBe('paragraph("Revenue grew 4% in Q3.")');
    });

    test('disabled with exportIDsToHTML: HTML export still writes the ids', () => {
      const editor = createTestEditor({disabled: true, exportIDsToHTML: true});
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      const html = editor.read(() => $generateHtmlFromNodes(editor, null));
      expect(html).toContain(`${MARK_STATE_IDS_ATTRIBUTE}="c1"`);
    });
  });

  describe('strict ids', () => {
    test('invalid ids from JSON are dropped', () => {
      const source = createTestEditor({withRoot: true});
      update(source, () => $init());
      mark(source, 8, 15, 'c1');
      const json = JSON.stringify(source.getEditorState().toJSON()).replace(
        '["c1"]',
        '["a b","","ok","\\u00a0",7]',
      );
      const editor = createTestEditor({withRoot: true});
      editor.setEditorState(editor.parseEditorState(json));
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%"[ok] " in Q3.")',
      );
      expect(registryText(editor)).toEqual({ok: ['grew 4%']});
      const marked = editor.read(() =>
        editor.getElementByKey($paragraph().getChildAtIndex(1)!.getKey()),
      );
      expect(marked!.getAttribute(MARK_STATE_IDS_ATTRIBUTE)).toBe('ok');
      // Only invalid ids: the leaf carries none
      const none = createTestEditor();
      none.setEditorState(
        none.parseEditorState(
          JSON.stringify(source.getEditorState().toJSON()).replace(
            '["c1"]',
            '["a b"]',
          ),
        ),
      );
      expect(tree(none)).toBe('paragraph("Revenue grew 4% in Q3.")');
    });

    test('invalid ids applied as NodeState or written with $setState are dropped', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      update(editor, () => {
        const node = $paragraph().getFirstChildOrThrow();
        // How a state from elsewhere is applied
        $getWritableNodeState(node.getWritable()).updateFromUnknown(
          MARK_STATE_KEY,
          ['b c', 'x', ''],
        );
      });
      expect(tree(editor)).toBe('paragraph("Revenue grew 4% in Q3."[x])');
      expect(registryText(editor)).toEqual({x: ['Revenue grew 4% in Q3.']});
    });

    test('HTML import drops invalid tokens and keeps the valid ones', () => {
      const editor = createTestEditor();
      update(editor, () => {
        const dom = new DOMParser().parseFromString(
          `<p><span ${MARK_STATE_IDS_ATTRIBUTE}="  c1 \t  c2 ">x</span></p>`,
          'text/html',
        );
        $getRoot()
          .clear()
          .append(...$generateNodesFromDOMViaExtension(dom));
      });
      expect(tree(editor)).toBe('paragraph("x"[c1,c2])');
    });
  });

  describe('queries', () => {
    test('$addMarkID returns the marked nodes, and a collapsed selection marks nothing', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      update(editor, () => {
        expect($addMarkID('c1', $select(3))).toEqual([]);
        const nodes = $addMarkID('c1', $select(8, 15));
        expect(nodes.map(node => node.getTextContent())).toEqual(['grew 4%']);
        // A collapsed selection removes nothing either
        $removeMarkID('c1', $select(10));
      });
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%"[c1] " in Q3.")',
      );
    });

    test("'all' with nothing shared, and a backward selection", () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 0, 7, 'c1');
      mark(editor, 8, 15, 'c2');
      editor.read(() => {
        const [first] = $paragraph().getChildren() as TextNode[];
        const last = $paragraph().getLastChildOrThrow();
        const selection = $createRangeSelection();
        selection.anchor.set(last.getKey(), 0, 'text');
        selection.focus.set(first.getKey(), 0, 'text');
        expect(selection.isBackward()).toBe(true);
        expect($getMarkIDsAtSelection(selection, 'all')).toEqual([]);
        expect($getMarkIDsAtSelection(selection, 'any')).toEqual(['c1', 'c2']);
      });
    });

    test('two editors with different markableNodes', () => {
      const lineBreaksOnly = createTestEditor({markableNodes: [LineBreakNode]});
      const defaults = createTestEditor();
      update(lineBreaksOnly, () => $init());
      update(defaults, () => $init());
      mark(lineBreaksOnly, 8, 15, 'c1');
      mark(defaults, 8, 15, 'c1');
      expect(tree(lineBreaksOnly)).toBe('paragraph("Revenue grew 4% in Q3.")');
      expect(tree(defaults)).toBe(
        'paragraph("Revenue " "grew 4%"[c1] " in Q3.")',
      );
    });
  });

  describe('DOM', () => {
    test('marked leaves get the theme classes and the ids attribute', () => {
      const editor = createTestEditor({withRoot: true});
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      mark(editor, 12, 19, 'c2');
      const root = editor.getRootElement()!;
      const spans = Array.from(
        root.querySelectorAll(`[${MARK_STATE_IDS_ATTRIBUTE}]`),
      ).map(el => [
        el.textContent,
        el.getAttribute(MARK_STATE_IDS_ATTRIBUTE),
        el.className,
      ]);
      expect(spans).toEqual([
        ['grew', 'c1', 'mark'],
        [' 4%', 'c1 c2', 'mark mark-overlap'],
        [' in ', 'c2', 'mark'],
      ]);
      update(editor, () => $removeMarkID('c2'));
      const after = Array.from(root.querySelectorAll('span')).map(el => [
        el.textContent,
        el.getAttribute(MARK_STATE_IDS_ATTRIBUTE),
        el.className,
      ]);
      expect(after).toEqual([
        ['Revenue ', null, ''],
        ['grew 4%', 'c1', 'mark'],
        [' in Q3.', null, ''],
      ]);
      editor.setRootElement(null);
      root.remove();
    });

    test('toggling disabled removes and restores the decoration', () => {
      const editor = createTestEditor({withRoot: true});
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      const root = editor.getRootElement()!;
      const {disabled} = getExtensionDependencyFromEditor(
        editor,
        MarkStateExtension,
      ).output;
      disabled.value = true;
      editor.update(() => {}, {discrete: true});
      expect(root.querySelector(`[${MARK_STATE_IDS_ATTRIBUTE}]`)).toBe(null);
      expect(root.querySelector('.mark')).toBe(null);
      expect(markIDNodeKeys(editor).size).toBe(0);
      disabled.value = false;
      editor.update(() => {}, {discrete: true});
      expect(
        root
          .querySelector(`[${MARK_STATE_IDS_ATTRIBUTE}]`)
          ?.getAttribute(MARK_STATE_IDS_ATTRIBUTE),
      ).toBe('c1');
      expect(registryText(editor)).toEqual({c1: ['grew 4%']});
      editor.setRootElement(null);
      root.remove();
    });
  });

  describe('isMarkIDShown', () => {
    /** [text, ids attribute, class] of each span of the editor DOM */
    function renderedSpans(editor: LexicalEditor) {
      return Array.from(editor.getRootElement()!.querySelectorAll('span')).map(
        el => [
          el.textContent,
          el.getAttribute(MARK_STATE_IDS_ATTRIBUTE),
          el.className,
        ],
      );
    }

    function isMarkIDShownSignal(editor: LexicalEditor) {
      return getExtensionDependencyFromEditor(editor, MarkStateExtension).output
        .isMarkIDShown;
    }

    test('the default renders every id', () => {
      const editor = createTestEditor({withRoot: true});
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      mark(editor, 12, 19, 'c2');
      expect(isMarkIDShownSignal(editor).value('anything')).toBe(true);
      expect(renderedSpans(editor)).toEqual([
        ['Revenue ', null, ''],
        ['grew', 'c1', 'mark'],
        [' 4%', 'c1 c2', 'mark mark-overlap'],
        [' in ', 'c2', 'mark'],
        ['Q3.', null, ''],
      ]);
    });

    test('hidden ids are not rendered but stay in the document', () => {
      const editor = createTestEditor({
        exportIDsToHTML: true,
        isMarkIDShown: id => id !== 'c2',
        withRoot: true,
      });
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      mark(editor, 12, 19, 'c2');
      expect(renderedSpans(editor)).toEqual([
        ['Revenue ', null, ''],
        ['grew', 'c1', 'mark'],
        [' 4%', 'c1', 'mark'],
        [' in ', null, ''],
        ['Q3.', null, ''],
      ]);
      // Only rendering is filtered
      expect(registryText(editor)).toEqual({
        c1: [' 4%', 'grew'],
        c2: [' 4%', ' in '],
      });
      let atSelection: string[] = [];
      update(editor, () => {
        atSelection = $getMarkIDsAtSelection($select(12, 19), 'any');
      });
      expect(atSelection).toEqual(['c1', 'c2']);
      const html = editor.read(() => $generateHtmlFromNodes(editor));
      expect(html).toContain(`${MARK_STATE_IDS_ATTRIBUTE}="c1 c2"`);
      expect(html).toContain(`${MARK_STATE_IDS_ATTRIBUTE}="c2"`);
    });

    test('newly marked text follows the filter', () => {
      const editor = createTestEditor({
        isMarkIDShown: id => id !== 'c2',
        withRoot: true,
      });
      update(editor, () => $init());
      mark(editor, 8, 12, 'c2');
      expect(renderedSpans(editor)).toEqual([
        ['Revenue ', null, ''],
        ['grew', null, ''],
        [' 4% in Q3.', null, ''],
      ]);
      mark(editor, 8, 12, 'c1');
      expect(renderedSpans(editor)).toEqual([
        ['Revenue ', null, ''],
        ['grew', 'c1', 'mark'],
        [' 4% in Q3.', null, ''],
      ]);
    });

    test('assigning a new filter at runtime re-renders the affected leaves', () => {
      const editor = createTestEditor({withRoot: true});
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      mark(editor, 12, 19, 'c2');
      const isMarkIDShown = isMarkIDShownSignal(editor);
      const resolved = new Set<string>();
      let updates = 0;
      onTestFinished(editor.registerUpdateListener(() => updates++));
      const {decorated, editorState} = {
        decorated: renderedSpans(editor),
        editorState: editor.getEditorState(),
      };

      // Resolve c2
      resolved.add('c2');
      isMarkIDShown.value = id => !resolved.has(id);
      expect(renderedSpans(editor)).toEqual([
        ['Revenue ', null, ''],
        ['grew', 'c1', 'mark'],
        [' 4%', 'c1', 'mark'],
        [' in ', null, ''],
        ['Q3.', null, ''],
      ]);
      // A re-render only: the document and the output are unchanged
      expect(editor.getEditorState().toJSON()).toEqual(editorState.toJSON());
      expect(registryText(editor)).toEqual({
        c1: [' 4%', 'grew'],
        c2: [' 4%', ' in '],
      });

      // Resolve c1 too: nothing is decorated
      resolved.add('c1');
      isMarkIDShown.value = id => !resolved.has(id);
      expect(
        editor.getRootElement()!.querySelector(`[${MARK_STATE_IDS_ATTRIBUTE}]`),
      ).toBe(null);
      expect(editor.getRootElement()!.querySelector('.mark')).toBe(null);

      // Reopen both
      resolved.clear();
      isMarkIDShown.value = id => !resolved.has(id);
      expect(renderedSpans(editor)).toEqual(decorated);
      expect(updates).toBe(3);
    });

    test("assigning a new filter changes no node, also where an element's stored text format is not its first text's", async () => {
      const editor = buildEditorFromExtensions(
        defineExtension({
          dependencies: [
            RichTextExtension,
            configExtension(HistoryExtension, {delay: 0}),
            MarkStateExtension,
          ],
          name: '[root]',
        }),
      );
      // The first paragraph's textFormat (0) is not its bold text's format,
      // as a client that never rendered it (headless, an agent) writes it
      editor.update(
        () => {
          const bold = $createTextNode('bold');
          bold.toggleFormat('bold');
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append(bold),
              $createParagraphNode().append($createTextNode('t4z t5z')),
            );
        },
        {discrete: true},
      );
      const root = document.createElement('div');
      root.contentEditable = 'true';
      document.body.appendChild(root);
      editor.setRootElement(root);
      onTestFinished(() => {
        editor.setRootElement(null);
        root.remove();
      });
      const $textFormat = () => {
        const paragraph = $getRoot().getFirstChild();
        return $isElementNode(paragraph) ? paragraph.getTextFormat() : -1;
      };
      expect(editor.read($textFormat)).toBe(0);
      // A comment in the other paragraph, so that a filter re-renders
      update(editor, () => {
        $addMarkID('c1', $select(0, 3, $paragraph(1)));
      });
      // The last edit, which an undo takes back
      update(editor, () => {
        $paragraph(1).selectEnd().insertText(' t6z');
      });
      const editorState = editor.getEditorState();
      isMarkIDShownSignal(editor).value = id => id !== 'c1';
      await Promise.resolve();
      expect(editor.read($textFormat)).toBe(0);
      expect(editor.getEditorState().toJSON()).toEqual(editorState.toJSON());
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      expect(editor.read(() => $getRoot().getTextContent())).toBe(
        'bold\n\nt4z t5z',
      );
    });

    test('a new filter re-renders nothing in a document without marks', () => {
      const editor = createTestEditor({withRoot: true});
      update(editor, () => $init());
      let updates = 0;
      onTestFinished(editor.registerUpdateListener(() => updates++));
      isMarkIDShownSignal(editor).value = () => false;
      expect(updates).toBe(0);
      mark(editor, 8, 15, 'c1');
      expect(updates).toBe(1);
      expect(renderedSpans(editor)).toEqual([
        ['Revenue ', null, ''],
        ['grew 4%', null, ''],
        [' in Q3.', null, ''],
      ]);
    });

    test('a filter assigned inside an edit re-renders after it, without changing it', async () => {
      const editor = createTestEditor({withRoot: true});
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      update(editor, () => $select(15));
      update(editor, () => {
        isMarkIDShownSignal(editor).value = () => false;
        editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, 'X');
      });
      // Text typed at the end of the run is still not marked
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%"[c1] "X in Q3.")',
      );
      await Promise.resolve();
      expect(renderedSpans(editor)).toEqual([
        ['Revenue ', null, ''],
        ['grew 4%', null, ''],
        ['X in Q3.', null, ''],
      ]);
    });

    test('a filter assigned in an update listener with an edit re-renders after that edit, which keeps its caret update', async () => {
      const editor = createTestEditor({withRoot: true});
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      update(editor, () => $select(10));
      let armed = true;
      onTestFinished(
        editor.registerUpdateListener(() => {
          if (!armed) {
            return;
          }
          armed = false;
          // A listener (an app's thread store reacting to the document)
          // resolves the thread and queues an edit of its own
          isMarkIDShownSignal(editor).value = () => false;
          editor.update(() => {
            editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, 'X');
          });
        }),
      );
      // Moving the caret commits an update that runs the listener
      update(editor, () => $select(15));
      await new Promise(resolve => setTimeout(resolve, 0));
      // Text typed at the end of the run is still not marked
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%"[c1] "X in Q3.")',
      );
      expect(renderedSpans(editor)).toEqual([
        ['Revenue ', null, ''],
        ['grew 4%', null, ''],
        ['X in Q3.', null, ''],
      ]);
      // The edit moved the DOM caret past the inserted text
      const domSelection = window.getSelection()!;
      expect(domSelection.anchorNode?.textContent).toBe('X in Q3.');
      expect(domSelection.anchorOffset).toBe(1);
    });

    test('a filter assigned in an update listener after its edit re-renders after that edit, which keeps its caret update', async () => {
      const editor = createTestEditor({withRoot: true});
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      update(editor, () => $select(10));
      let armed = true;
      onTestFinished(
        editor.registerUpdateListener(() => {
          if (!armed) {
            return;
          }
          armed = false;
          // A listener (an app's thread store reacting to the document)
          // queues an edit, then resolves the thread
          editor.update(() => {
            editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, 'X');
          });
          isMarkIDShownSignal(editor).value = () => false;
        }),
      );
      // Moving the caret commits an update that runs the listener
      update(editor, () => $select(15));
      await new Promise(resolve => setTimeout(resolve, 0));
      // Text typed at the end of the run is still not marked
      expect(tree(editor)).toBe(
        'paragraph("Revenue " "grew 4%"[c1] "X in Q3.")',
      );
      expect(renderedSpans(editor)).toEqual([
        ['Revenue ', null, ''],
        ['grew 4%', null, ''],
        ['X in Q3.', null, ''],
      ]);
      // The edit moved the DOM caret past the inserted text
      const domSelection = window.getSelection()!;
      expect(domSelection.anchorNode?.textContent).toBe('X in Q3.');
      expect(domSelection.anchorOffset).toBe(1);
    });

    test('a new filter does not move the DOM selection out of another editable', () => {
      const editor = createTestEditor({withRoot: true});
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      update(editor, () => $select(10));
      // A comment reply box next to the editor holds the caret
      const replyBox = document.createElement('div');
      replyBox.contentEditable = 'true';
      replyBox.textContent = 'Done, resolving';
      document.body.appendChild(replyBox);
      onTestFinished(() => replyBox.remove());
      const domSelection = window.getSelection()!;
      domSelection.collapse(replyBox.firstChild, 4);
      isMarkIDShownSignal(editor).value = () => false;
      expect(editor.getRootElement()!.querySelector('.mark')).toBe(null);
      expect(domSelection.anchorNode).toBe(replyBox.firstChild);
      expect(domSelection.anchorOffset).toBe(4);
    });

    test('a filter changed while disabled applies when re-enabled', () => {
      const editor = createTestEditor({withRoot: true});
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      mark(editor, 12, 19, 'c2');
      const {disabled, isMarkIDShown} = getExtensionDependencyFromEditor(
        editor,
        MarkStateExtension,
      ).output;
      disabled.value = true;
      editor.update(() => {}, {discrete: true});
      isMarkIDShown.value = id => id !== 'c1';
      expect(
        editor.getRootElement()!.querySelector(`[${MARK_STATE_IDS_ATTRIBUTE}]`),
      ).toBe(null);
      disabled.value = false;
      editor.update(() => {}, {discrete: true});
      expect(renderedSpans(editor)).toEqual([
        ['Revenue ', null, ''],
        ['grew', null, ''],
        [' 4%', 'c2', 'mark'],
        [' in ', 'c2', 'mark'],
        ['Q3.', null, ''],
      ]);
    });

    test('a filter set before the root element is attached applies on mount', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      isMarkIDShownSignal(editor).value = () => false;
      const root = document.createElement('div');
      root.contentEditable = 'true';
      document.body.appendChild(root);
      editor.setRootElement(root);
      onTestFinished(() => {
        editor.setRootElement(null);
        root.remove();
      });
      expect(root.querySelector(`[${MARK_STATE_IDS_ATTRIBUTE}]`)).toBe(null);
      expect(root.querySelector('.mark')).toBe(null);
    });
  });

  describe('HTML', () => {
    test('ids are not exported by default', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      const html = editor.read(() => $generateHtmlFromNodes(editor, null));
      expect(html).toContain('grew 4%');
      expect(html).not.toContain(MARK_STATE_IDS_ATTRIBUTE);
      expect(html).not.toContain('c1');
    });

    test('export and import round trip the ids', () => {
      const editor = createTestEditor({exportIDsToHTML: true});
      update(editor, () => $init());
      update(editor, () => {
        $select(10, 13).formatText('bold');
      });
      mark(editor, 8, 15, 'c1');
      mark(editor, 12, 19, 'c2');
      const before = tree(editor);
      const html = editor.read(() => $generateHtmlFromNodes(editor, null));
      expect(html).toContain(`${MARK_STATE_IDS_ATTRIBUTE}="c1 c2"`);

      const target = createTestEditor();
      update(target, () => {
        const dom = new DOMParser().parseFromString(html, 'text/html');
        $getRoot()
          .clear()
          .append(...$generateNodesFromDOMViaExtension(dom));
      });
      expect(tree(target)).toBe(before);
      expect(registryText(target)).toEqual(registryText(editor));
    });
  });

  describe('ids', () => {
    test('ids must be non-empty and free of whitespace', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      for (const id of ['', 'a b', 'a\tb', 'a\nb', ' a']) {
        expect(() =>
          update(editor, () => {
            $addMarkID(id, $select(8, 15));
          }),
        ).toThrow(/invalid mark id/);
      }
      // Anything else is fine, and round trips through HTML
      const ids = ['a"b', 'a,b', '<x>', '__proto__', 'é-1'];
      const exporting = createTestEditor({exportIDsToHTML: true});
      update(exporting, () => $init());
      for (const id of ids) {
        mark(exporting, 8, 15, id);
      }
      const html = exporting.read(() =>
        $generateHtmlFromNodes(exporting, null),
      );
      const target = createTestEditor();
      update(target, () => {
        const dom = new DOMParser().parseFromString(html, 'text/html');
        $getRoot()
          .clear()
          .append(...$generateNodesFromDOMViaExtension(dom));
      });
      expect(target.read(() => $getNodeMarkIDsOfText('grew'))).toEqual(
        [...ids].sort(),
      );
    });

    test('migrating a MarkNode with an invalid id throws', () => {
      const editor = createTestEditor();
      update(editor, () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createMarkNode(['a b']).append($createTextNode('x')),
            ),
          );
      });
      expect(() =>
        update(editor, () => {
          $migrateMarkNodesToMarkState();
        }),
      ).toThrow(/invalid mark id/);
    });
  });

  describe('links', () => {
    // "Revenue " link("grew"[c1]) " 4% in"[c1] " Q3."
    function setupLinked() {
      const editor = createTestEditor();
      update(editor, () => $init());
      update(editor, () => {
        $select(8, 12);
        $toggleLink('https://example.com');
      });
      mark(editor, 8, 18, 'c1');
      expect(tree(editor)).toBe(
        'paragraph("Revenue " link("grew"[c1]) " 4% in"[c1] " Q3.")',
      );
      return editor;
    }

    test('typing at the start of a run right after a marked link', () => {
      const editor = setupLinked();
      update(editor, () => {
        const [, , run] = $paragraph().getChildren() as TextNode[];
        run.select(0, 0);
      });
      typeText(editor, 'X');
      expect(tree(editor)).toBe(
        'paragraph("Revenue " link("grew"[c1]) "X 4% in"[c1] " Q3.")',
      );
    });

    test('typing at the end of marked link text', () => {
      const editor = setupLinked();
      update(editor, () => {
        $paragraph().getAllTextNodes()[1].select(4, 4);
      });
      typeText(editor, 'X');
      expect(editor.read(() => $getNodeMarkIDsOfText('X'))).toEqual(['c1']);
      expect(
        editor.read(() =>
          $paragraph()
            .getAllTextNodes()
            .map(node => node.getTextContent())
            .join(''),
        ),
      ).toBe('Revenue grewX 4% in Q3.');
    });

    test('typing with a toggled format at the link boundary', () => {
      const editor = setupLinked();
      update(editor, () => {
        const [, , run] = $paragraph().getChildren() as TextNode[];
        run.select(0, 0);
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          selection.toggleFormat('bold');
        }
      });
      typeText(editor, 'X');
      expect(editor.read(() => $getNodeMarkIDsOfText('X'))).toEqual(['c1']);
    });

    test('typing after the end of a marked link that ends the mark', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      update(editor, () => {
        $select(8, 12);
        $toggleLink('https://example.com');
      });
      mark(editor, 8, 12, 'c1');
      update(editor, () => {
        const [, , run] = $paragraph().getChildren() as TextNode[];
        run.select(0, 0);
      });
      typeText(editor, 'X');
      expect(editor.read(() => $getNodeMarkIDsOfText('X'))).toEqual([]);
    });

    test('the caret after a marked link is in the mark', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      update(editor, () => {
        $select(8, 12);
        $toggleLink('https://example.com');
      });
      mark(editor, 8, 12, 'c1');
      update(editor, () => {
        // End of "Revenue ", right before the link
        $paragraph().getAllTextNodes()[0].select(8, 8);
        expect($getMarkIDsAtSelection()).toEqual(['c1']);
      });
    });
  });

  describe('migration and compatibility', () => {
    test('a MarkNode document migrates to the same tree', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      // Nested MarkNodes (no nested element resolver registered)
      update(editor, () => {
        $wrapSelectionInMarkNode($select(8, 15), false, 'c1');
      });
      update(editor, () => {
        $wrapSelectionInMarkNode($select(12, 19), false, 'c2');
      });
      expect(tree(editor)).toBe(
        'paragraph("Revenue " mark[c1]("grew" mark[c2](" 4%")) mark[c2](" in ") "Q3.")',
      );
      let count = 0;
      update(editor, () => {
        count = $migrateMarkNodesToMarkState();
      });
      expect(count).toBe(3);

      const direct = createTestEditor();
      update(direct, () => $init());
      mark(direct, 8, 15, 'c1');
      mark(direct, 12, 19, 'c2');
      expect(tree(editor)).toBe(tree(direct));
      expect(registryText(editor)).toEqual(registryText(direct));
    });

    test('a MarkNode with several ids migrates', () => {
      const editor = createTestEditor();
      update(editor, () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('a'),
              $createMarkNode(['x', 'y']).append($createTextNode('b')),
            ),
          );
      });
      update(editor, () => {
        $migrateMarkNodesToMarkState();
      });
      expect(tree(editor)).toBe('paragraph("a" "b"[x,y])');
    });

    test('an editor without the extension keeps the ids', () => {
      const editor = createTestEditor();
      update(editor, () => $init());
      mark(editor, 8, 15, 'c1');
      mark(editor, 12, 19, 'c2');
      const json = JSON.stringify(editor.getEditorState().toJSON());

      const plain = buildEditorFromExtensions(
        defineExtension({dependencies: [RichTextExtension], name: '[root]'}),
      );
      plain.setEditorState(plain.parseEditorState(json));
      update(plain, () => {
        $paragraph().selectStart();
        $getSelection()!.insertText('Q4 ');
      });
      const roundTrip = createTestEditor();
      roundTrip.setEditorState(
        roundTrip.parseEditorState(
          JSON.stringify(plain.getEditorState().toJSON()),
        ),
      );
      expect(tree(roundTrip)).toBe(
        'paragraph("Q4 Revenue " "grew"[c1] " 4%"[c1,c2] " in "[c2] "Q3.")',
      );
      // The output is rebuilt from a loaded editor state
      expect(registryText(roundTrip)).toEqual({
        c1: [' 4%', 'grew'],
        c2: [' 4%', ' in '],
      });
    });
  });

  test('ids in JSON are a set: unordered input is saved sorted and without duplicates', () => {
    const editor = createTestEditor();
    update(editor, () => $init());
    const json = editor.getEditorState().toJSON() as SerializedEditorState;
    const paragraph = json.root.children[0] as unknown as {
      children: Record<string, unknown>[];
    };
    paragraph.children[0].$ = {markIds: ['c2', 'c1', 'c2', 7]};
    const loaded = createTestEditor();
    loaded.setEditorState(loaded.parseEditorState(JSON.stringify(json)));
    expect(tree(loaded)).toBe('paragraph("Revenue grew 4% in Q3."[c1,c2])');
    expect(registryText(loaded)).toEqual({
      c1: ['Revenue grew 4% in Q3.'],
      c2: ['Revenue grew 4% in Q3.'],
    });
    const saved = JSON.stringify(loaded.getEditorState().toJSON());
    expect(
      (
        (JSON.parse(saved) as SerializedEditorState).root
          .children[0] as unknown as {children: {$?: object}[]}
      ).children[0].$,
    ).toEqual({markIds: ['c1', 'c2']});
    // Stable across another round trip
    const again = createTestEditor();
    again.setEditorState(again.parseEditorState(saved));
    expect(JSON.stringify(again.getEditorState().toJSON())).toBe(saved);
  });

  describe('slots', () => {
    /**
     * paragraph(P) / figure{caption paragraph} / paragraph("After it.")
     */
    function $initFigure() {
      $init();
      const figure = new FigureNode();
      $getRoot().append(
        figure,
        $createParagraphNode().append($createTextNode('After it.')),
      );
      $setSlot(
        figure,
        'caption',
        $createParagraphNode().append($createTextNode('A caption')),
      );
    }

    function $selectAcrossFigure() {
      const [first] = $locate($paragraph(0), 8);
      const [last] = $locate($paragraph(2), 5);
      const selection = $createRangeSelection();
      selection.anchor.set(first.getKey(), 8, 'text');
      selection.focus.set(last.getKey(), 5, 'text');
      return selection;
    }

    const MARKED =
      'paragraph("Revenue " "grew 4% in Q3."[c1]) / ' +
      'test-figure{paragraph("A caption"[c1])} / ' +
      'paragraph("After"[c1] " it.")';

    test('marking a range marks the content of the slots in it', () => {
      const editor = createTestEditor();
      update(editor, $initFigure);
      update(editor, () => {
        $addMarkID('c1', $selectAcrossFigure());
      });
      expect(tree(editor)).toBe(MARKED);
      expect(registryText(editor)).toEqual({
        c1: ['A caption', 'After', 'grew 4% in Q3.'],
      });
    });

    test('a NodeSelection of a slot host marks the content of its slots', () => {
      const editor = createTestEditor();
      update(editor, $initFigure);
      update(editor, () => {
        const selection = $createNodeSelection();
        selection.add($getRoot().getChildAtIndex(1)!.getKey());
        $addMarkID('c1', selection);
      });
      expect(tree(editor)).toBe(
        'paragraph("Revenue grew 4% in Q3.") / ' +
          'test-figure{paragraph("A caption"[c1])} / paragraph("After it.")',
      );
    });

    test('removing an id removes it from the slots too', () => {
      for (const withExtension of [true, false]) {
        const editor = createTestEditor();
        update(editor, $initFigure);
        update(editor, () => {
          $addMarkID('c1', $selectAcrossFigure());
        });
        const json = JSON.stringify(editor.getEditorState().toJSON());
        // Without the extension, $removeMarkID walks the document
        const target = withExtension
          ? editor
          : buildEditorFromExtensions(
              defineExtension({
                dependencies: [RichTextExtension],
                name: '[root]',
                nodes: () => [FigureNode],
              }),
            );
        target.setEditorState(target.parseEditorState(json));
        update(target, () => $removeMarkID('c1'));
        expect(tree(target)).toBe(
          'paragraph("Revenue grew 4% in Q3.") / ' +
            'test-figure{paragraph("A caption")} / paragraph("After it.")',
        );
      }
    });

    test('the output is rebuilt from the slots of a loaded state', () => {
      const editor = createTestEditor();
      update(editor, $initFigure);
      update(editor, () => {
        $addMarkID('c1', $selectAcrossFigure());
      });
      const loaded = createTestEditor();
      loaded.setEditorState(
        loaded.parseEditorState(
          JSON.stringify(editor.getEditorState().toJSON()),
        ),
      );
      expect(tree(loaded)).toBe(MARKED);
      expect(registryText(loaded)).toEqual({
        c1: ['A caption', 'After', 'grew 4% in Q3.'],
      });
    });

    test('a MarkNode inside a slot migrates', () => {
      const editor = createTestEditor();
      update(editor, () => {
        $initFigure();
        const caption = $getSlot(
          $getRoot().getChildAtIndex(1)!,
          'caption',
        ) as ElementNode;
        const text = $assertNodeType(
          caption.getFirstChildOrThrow(),
          $isTextNode,
        );
        const [, rest] = text.splitText(2);
        const markNode = $createMarkNode(['c2']);
        rest.replace(markNode);
        markNode.append(rest);
      });
      update(editor, () => {
        expect($migrateMarkNodesToMarkState()).toBe(1);
      });
      expect(tree(editor)).toBe(
        'paragraph("Revenue grew 4% in Q3.") / ' +
          'test-figure{paragraph("A " "caption"[c2])} / paragraph("After it.")',
      );
    });
  });

  describe('markable nodes', () => {
    function $initMixed() {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append(
            $createTextNode('ab'),
            new TestDecoratorTextNode(),
            $createLineBreakNode(),
            new ChipNode(),
            $createTextNode('cd'),
          ),
        );
    }

    function $selectAll() {
      const paragraph = $paragraph();
      const selection = $createRangeSelection();
      selection.anchor.set(
        paragraph.getFirstChildOrThrow().getKey(),
        0,
        'text',
      );
      selection.focus.set(paragraph.getLastChildOrThrow().getKey(), 2, 'text');
      return selection;
    }

    test('by default TextNode, LineBreakNode and inline decorators, including DecoratorTextNode', () => {
      const editor = createTestEditor({withRoot: true});
      update(editor, $initMixed);
      update(editor, () => {
        $addMarkID('c1', $selectAll());
      });
      expect(tree(editor)).toBe(
        'paragraph("ab"[c1] test-decorator-text[c1] br[c1] test-chip[c1] "cd"[c1])',
      );
      expect(registryText(editor)).toEqual({c1: ['\n', '#', '@', 'ab', 'cd']});
      const decoratorText = editor
        .getRootElement()!
        .querySelector(`[${MARK_STATE_IDS_ATTRIBUTE}]`);
      expect(decoratorText).not.toBe(null);
    });

    test('a class list', () => {
      const editor = createTestEditor({markableNodes: [TextNode]});
      update(editor, $initMixed);
      update(editor, () => {
        $addMarkID('c1', $selectAll());
      });
      expect(tree(editor)).toBe(
        'paragraph("ab"[c1] test-decorator-text br test-chip "cd"[c1])',
      );
      expect(registryText(editor)).toEqual({c1: ['ab', 'cd']});
    });

    test('a guard function', () => {
      const editor = createTestEditor({
        markableNodes: [
          (node: LexicalNode) =>
            $isTextNode(node) && !node.getTextContent().includes('c'),
          TestDecoratorTextNode,
        ],
      });
      update(editor, $initMixed);
      update(editor, () => {
        $addMarkID('c1', $selectAll());
      });
      expect(tree(editor)).toBe(
        'paragraph("ab"[c1] test-decorator-text[c1] br test-chip "cd")',
      );
    });

    test('extending the default with a block decorator', () => {
      const editor = createTestEditor({
        markableNodes: [...DEFAULT_MARKABLE_NODES, FigureNode],
      });
      update(editor, () => {
        $init();
        $getRoot().append(new FigureNode());
      });
      update(editor, () => {
        const selection = $createNodeSelection();
        selection.add($getRoot().getLastChildOrThrow().getKey());
        $addMarkID('c1', selection);
      });
      expect(tree(editor)).toBe(
        'paragraph("Revenue grew 4% in Q3.") / test-figure[c1]{}',
      );
      expect(registryText(editor)).toEqual({c1: ['']});
    });
  });
});

function $getNodeMarkIDsOfText(text: string): string[] {
  const node = $getRoot()
    .getAllTextNodes()
    .find(textNode => textNode.getTextContent().includes(text));
  if (!node) {
    throw new Error(`no text node with ${text}`);
  }
  return $getNodeMarkIDs(node);
}
