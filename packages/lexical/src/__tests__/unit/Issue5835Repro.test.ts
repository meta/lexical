/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {$createCodeNode, CodeExtension} from '@lexical/code';
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {
  $createListItemNode,
  $createListNode,
  ListExtension,
} from '@lexical/list';
import {
  $createHeadingNode,
  $createQuoteNode,
  RichTextExtension,
} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $selectAll as selectAllUnprefixed,
  $setSlot,
  ElementNode,
  type LexicalEditor,
  type LexicalEditorWithDispose,
  type RangeSelection,
} from 'lexical';
import {assert, describe, expect, onTestFinished, test} from 'vitest';

import {$createTestShadowRootNode, TestShadowRootNode} from '../utils';

const $selectAll = selectAllUnprefixed;

// Stands in for a third-party block node. Its `collapseAtStart` returns false
// -- the ElementNode default -- which used to mean "keep this block"; widening
// the range means the block is simply part of what was selected, so a
// select-all delete removes it like anything else.
class StubbornNode extends ElementNode {
  $config() {
    return this.config('issue5835_stubborn', {extends: ElementNode});
  }
  createDOM(): HTMLElement {
    return document.createElement('aside');
  }
  updateDOM(): false {
    return false;
  }
  collapseAtStart(): false {
    return false;
  }
}

// A slot host: its `title` slot holds content that lives outside the regular
// child list, so the host is not an empty wrapper even when its one child is.
class HostNode extends ElementNode {
  $config() {
    return this.config('issue5835_host', {
      extends: ElementNode,
      slots: ['title'],
    });
  }
  createDOM(): HTMLElement {
    return document.createElement('div');
  }
  updateDOM(): false {
    return false;
  }
}

const ext = defineExtension({
  dependencies: [RichTextExtension, ListExtension, CodeExtension],
  name: '[5835]',
  nodes: [StubbornNode, HostNode, TestShadowRootNode],
});

/**
 * An editor attached to a root element: `deleteLine` reaches the native
 * selection to find the line boundary, so it needs a window to resolve.
 */
function createEditor(): LexicalEditorWithDispose {
  const editor = buildEditorFromExtensions(ext);
  const container = document.createElement('div');
  document.body.appendChild(container);
  editor.setRootElement(container);
  onTestFinished(() => {
    editor.setRootElement(null);
    container.remove();
  });
  return editor;
}

type Gesture = 'deleteCharacter' | 'deleteWord' | 'deleteLine';

function $applyGesture(
  selection: RangeSelection,
  gesture: Gesture,
  isBackward: boolean,
): void {
  selection[gesture](isBackward);
}

/** Select the whole document, then run one delete gesture over it. */
function selectAllAndDelete(
  editor: LexicalEditor,
  gesture: Gesture,
  isBackward: boolean,
): void {
  editor.update(
    () => {
      const selection = $selectAll();
      $applyGesture(selection, gesture, isBackward);
    },
    {discrete: true},
  );
}

/** The root's children, as `type` strings — enough to see what survived. */
function readRootTypes(editor: LexicalEditor): string[] {
  return editor.read(() =>
    $getRoot()
      .getChildren()
      .map(node => node.getType()),
  );
}

// `deleteLine` is not in this list: on a selection that spans more than one
// block it collapses to the anchor and deletes a single character instead of
// the range, so it never empties a multi-block document. Its single-block
// behaviour -- the Cmd+Backspace case this fix is about -- is covered below.
const GESTURES: Gesture[] = ['deleteCharacter', 'deleteWord'];
const DIRECTIONS = [true, false];

// Selecting the whole document and deleting it should leave the editor in the
// same state as an empty editor: a single empty paragraph. Before the fix only
// a backwards `deleteCharacter` did that, and only for a heading or quote --
// forward delete, lists, and the word/line gestures left the last block behind
// as an empty heading/quote/list that kept its type.
//
// The fix widens a whole-document range to the root's own element points before
// deleting, so the range contains the blocks rather than just their text and
// the delete removes them outright.
describe('select-all + delete collapses to an empty paragraph (#5835)', () => {
  describe.for(GESTURES)('%s', gesture => {
    describe.for(DIRECTIONS)('isBackward: %s', isBackward => {
      test('heading as the only block', () => {
        using editor = createEditor();
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append($createHeadingNode('h1').append($createTextNode('hi')));
          },
          {discrete: true},
        );

        selectAllAndDelete(editor, gesture, isBackward);

        expect(readRootTypes(editor)).toEqual(['paragraph']);
        editor.read(() => {
          expect($getRoot().getAllTextNodes()).toEqual([]);
        });
      });

      test('quote as the only block', () => {
        using editor = createEditor();
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append($createQuoteNode().append($createTextNode('hi')));
          },
          {discrete: true},
        );

        selectAllAndDelete(editor, gesture, isBackward);

        expect(readRootTypes(editor)).toEqual(['paragraph']);
      });

      test('list followed by a paragraph', () => {
        using editor = createEditor();
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createListNode('bullet').append(
                  $createListItemNode().append($createTextNode('one')),
                  $createListItemNode().append($createTextNode('two')),
                ),
                $createParagraphNode().append($createTextNode('after')),
              );
          },
          {discrete: true},
        );

        selectAllAndDelete(editor, gesture, isBackward);

        expect(readRootTypes(editor)).toEqual(['paragraph']);
        editor.read(() => {
          expect($getRoot().getAllTextNodes()).toEqual([]);
        });
      });

      test('nested list', () => {
        using editor = createEditor();
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createListNode('bullet').append(
                  $createListItemNode().append($createTextNode('one')),
                  $createListItemNode().append(
                    $createListNode('bullet').append(
                      $createListItemNode().append($createTextNode('two')),
                    ),
                  ),
                ),
              );
          },
          {discrete: true},
        );

        selectAllAndDelete(editor, gesture, isBackward);

        expect(readRootTypes(editor)).toEqual(['paragraph']);
        editor.read(() => {
          expect($getRoot().getAllTextNodes()).toEqual([]);
        });
      });

      // Depth is what used to matter: emptying a nest from the inside sheds one
      // level at a time, so a nest with nothing but nested items could be left
      // as `list > listitem` -- still a bullet for the next character typed.
      // Removing the range takes every level at once, whatever the depth.
      test('a nest with no plain sibling item', () => {
        using editor = createEditor();
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createListNode('bullet').append(
                  $createListItemNode().append(
                    $createListNode('bullet').append(
                      $createListItemNode().append($createTextNode('two')),
                    ),
                  ),
                ),
              );
          },
          {discrete: true},
        );

        selectAllAndDelete(editor, gesture, isBackward);

        expect(readRootTypes(editor)).toEqual(['paragraph']);
        editor.read(() => {
          expect($getRoot().getTextContent()).toBe('');
        });
      });

      test('a deeply nested list unwraps every level', () => {
        using editor = createEditor();
        editor.update(
          () => {
            let item = $createListItemNode().append($createTextNode('deep'));
            for (let level = 0; level < 4; level++) {
              item = $createListItemNode().append(
                $createListNode('bullet').append(item),
              );
            }
            $getRoot().clear().append($createListNode('bullet').append(item));
          },
          {discrete: true},
        );

        selectAllAndDelete(editor, gesture, isBackward);

        expect(readRootTypes(editor)).toEqual(['paragraph']);
        editor.read(() => {
          expect($getRoot().getTextContent()).toBe('');
        });
      });

      test('paragraph as the first block is left as a paragraph', () => {
        using editor = createEditor();
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createParagraphNode().append($createTextNode('hi')),
                $createHeadingNode('h1').append($createTextNode('there')),
              );
          },
          {discrete: true},
        );

        selectAllAndDelete(editor, gesture, isBackward);

        expect(readRootTypes(editor)).toEqual(['paragraph']);
      });
    });
  });

  // Cmd+Backspace over a lone block: `deleteLine` reaches `removeText` for a
  // selection inside a single block, which is the path that used to leave the
  // emptied heading/quote behind.
  describe.for(DIRECTIONS)('deleteLine (isBackward: %s)', isBackward => {
    test('heading as the only block', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createHeadingNode('h1').append($createTextNode('hi')));
        },
        {discrete: true},
      );

      selectAllAndDelete(editor, 'deleteLine', isBackward);

      expect(readRootTypes(editor)).toEqual(['paragraph']);
    });

    test('quote as the only block', () => {
      using editor = createEditor();
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createQuoteNode().append($createTextNode('hi')));
        },
        {discrete: true},
      );

      selectAllAndDelete(editor, 'deleteLine', isBackward);

      expect(readRootTypes(editor)).toEqual(['paragraph']);
    });
  });

  // Widening the range means every block is simply part of what was selected,
  // so no block type needs special handling and none is consulted about whether
  // it should dissolve.
  describe('removes whatever block types the document holds', () => {
    test.for([true, false])('a code block (isBackward: %s)', isBackward => {
      using editor = createEditor();
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createCodeNode().append($createTextNode('const x = 1;')));
        },
        {discrete: true},
      );

      selectAllAndDelete(editor, 'deleteCharacter', isBackward);

      expect(readRootTypes(editor)).toEqual(['paragraph']);
    });

    test.for([true, false])(
      'a third-party block node (isBackward: %s)',
      isBackward => {
        using editor = createEditor();
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(new StubbornNode().append($createTextNode('note')));
          },
          {discrete: true},
        );

        selectAllAndDelete(editor, 'deleteCharacter', isBackward);

        expect(readRootTypes(editor)).toEqual(['paragraph']);
      },
    );

    // A block wrapping other blocks. Emptying this one from the inside could
    // only ever shed the list and leave the quote holding a stray paragraph;
    // removing the range takes the whole thing.
    test.for([true, false])(
      'a quote wrapping a list (isBackward: %s)',
      isBackward => {
        using editor = createEditor();
        editor.update(
          () => {
            $getRoot()
              .clear()
              .append(
                $createQuoteNode().append(
                  $createListNode('bullet').append(
                    $createListItemNode().append($createTextNode('one')),
                  ),
                ),
              );
          },
          {discrete: true},
        );

        selectAllAndDelete(editor, 'deleteCharacter', isBackward);

        expect(readRootTypes(editor)).toEqual(['paragraph']);
        editor.read(() => {
          expect($getRoot().getTextContent()).toBe('');
        });
      },
    );

    test.for([true, false])(
      'a slot host, slots and all (isBackward: %s)',
      isBackward => {
        using editor = createEditor();
        editor.update(
          () => {
            const host = new HostNode();
            host.append(
              $createHeadingNode('h1').append($createTextNode('body')),
            );
            $getRoot().clear().append(host);
            $setSlot(
              host,
              'title',
              $createTestShadowRootNode().append(
                $createParagraphNode().append($createTextNode('title')),
              ),
            );
          },
          {discrete: true},
        );

        selectAllAndDelete(editor, 'deleteCharacter', isBackward);

        expect(readRootTypes(editor)).toEqual(['paragraph']);
        editor.read(() => {
          expect($getRoot().getTextContent()).toBe('');
        });
      },
    );
  });

  // A slot is shadow-root isolated, so the rich-text SELECT_ALL handler scopes
  // select-all to the slot value rather than the document. That range does not
  // cover the root, so it must not widen and take the host with it.
  test('a select-all scoped to a slot only clears the slot', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const host = new HostNode();
        host.append($createHeadingNode('h1').append($createTextNode('body')));
        $getRoot().clear().append(host);
        const slotParagraph = $createParagraphNode().append(
          $createTextNode('title'),
        );
        $setSlot(
          host,
          'title',
          $createTestShadowRootNode().append(slotParagraph),
        );
        const text = slotParagraph.getFirstChildOrThrow();
        assert($isTextNode(text), 'Expected a TextNode');
        text.select(1, 1);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const current = $getSelection();
        assert($isRangeSelection(current), 'Expected RangeSelection');
        // What the SELECT_ALL handler does when the caret is inside a slot.
        $selectAll(current).deleteCharacter(true);
      },
      {discrete: true},
    );

    // The host and its own children are untouched; only the slot was cleared.
    expect(readRootTypes(editor)).toEqual(['issue5835_host']);
    editor.read(() => {
      expect($getRoot().getTextContent()).toContain('body');
    });
  });

  test('a partial delete that only empties the first block is unaffected', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const heading = $createHeadingNode('h1').append($createTextNode('abc'));
        $getRoot()
          .clear()
          .append(
            heading,
            $createParagraphNode().append($createTextNode('def')),
          );
        // Select only the heading's own text, not the whole document. Forward
        // delete: a backwards delete of an emptied first block is separately
        // collapsed by the pre-existing $collapseAtStart path, which is not
        // what this test is guarding.
        const text = heading.getFirstChildOrThrow();
        assert($isTextNode(text), 'Expected a TextNode');
        text.select(0, 3);
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $getSelection();
        assert($isRangeSelection(selection), 'Expected RangeSelection');
        selection.deleteCharacter(false);
      },
      {discrete: true},
    );

    // The heading keeps its type; it is not converted to a paragraph.
    expect(readRootTypes(editor)).toEqual(['heading', 'paragraph']);
    editor.read(() => {
      expect($getRoot().getLastChildOrThrow().getTextContent()).toBe('def');
    });
  });

  test('replacing all text in a lone non-paragraph block keeps its type', () => {
    // Guards the Prettier "format" regression: selecting all of a lone block's
    // content and inserting (a replace, which routes through removeText) must
    // keep the block, not collapse it to a paragraph.
    using editor = createEditor();
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createHeadingNode('h1').append($createTextNode('hi')));
      },
      {discrete: true},
    );

    editor.update(
      () => {
        const selection = $selectAll();
        selection.insertText('there');
      },
      {discrete: true},
    );

    expect(readRootTypes(editor)).toEqual(['heading']);
    editor.read(() => {
      expect($getRoot().getTextContent()).toBe('there');
      expect($isParagraphNode($getRoot().getFirstChild())).toBe(false);
    });
  });
});
