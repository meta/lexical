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
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
  CoreImportExtension,
} from '@lexical/html';
import {
  $addMarkID,
  $createMarkNode,
  $getMarkIDsAtSelection,
  $getMarkIDsByFlavor,
  $getNodeMarkIDs,
  $migrateMarkNodesToMarkState,
  $removeMarkID,
  type AnyMarkFlavorExtension,
  defineMarkExtension,
  MARK_STATE_IDS_ATTRIBUTE,
  MARK_STATE_KEY,
  MarkBaseExtension,
  MarkExtension,
  type MarkFlavorExtension,
  type MarkIDsChange,
  MarkStateExtension,
  registerMarkIDsListener,
} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $addUpdateTag,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type AnyLexicalExtensionArgument,
  type BaseSelection,
  CLEAR_HISTORY_COMMAND,
  COLLABORATION_TAG,
  configExtension,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  defineExtension,
  HISTORIC_TAG,
  isCurrentlyReadOnlyMode,
  type LexicalEditor,
  type LexicalNode,
  type SerializedElementNode,
  type TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, expectTypeOf, onTestFinished, test} from 'vitest';

const CommentMarks = defineMarkExtension({
  className: 'comment',
  name: '@test/CommentMarks',
  overlapClassName: 'comment-overlap',
  stateKey: 'commentIds',
});

const SuggestionMarks = defineMarkExtension({
  className: 'suggestion',
  name: '@test/SuggestionMarks',
  stateKey: 'suggestionIds',
});

const TEXT = 'Ship the migration on Friday';

function createEditor(
  dependencies: AnyLexicalExtensionArgument[] = [CommentMarks, SuggestionMarks],
  withRoot = false,
): LexicalEditor {
  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        CoreImportExtension,
        configExtension(HistoryExtension, {delay: 0}),
        ...dependencies,
      ],
      name: '[root]',
      onError: error => {
        throw error;
      },
      theme: {mark: 'mark', markOverlap: 'mark-overlap'},
    }),
  );
  if (withRoot) {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    editor.setRootElement(root);
    onTestFinished(() => {
      editor.setRootElement(null);
      root.remove();
    });
  }
  onTestFinished(() => editor.dispose());
  return editor;
}

function update(editor: LexicalEditor, fn: () => void) {
  editor.update(fn, {discrete: true});
}

function $init(text = TEXT) {
  $getRoot()
    .clear()
    .append($createParagraphNode().append($createTextNode(text)));
}

/**
 * A selection of [start, end) of the paragraph's text, made the editor's
 * selection inside an update
 */
function $select(start: number, end = start) {
  const texts = $getRoot().getAllTextNodes();
  const point = (offset: number, preferNext: boolean) => {
    let acc = 0;
    for (let i = 0; i < texts.length; i++) {
      const size = texts[i].getTextContentSize();
      if (
        offset < acc + size ||
        (offset === acc + size && (!preferNext || i === texts.length - 1))
      ) {
        return [texts[i], offset - acc] as const;
      }
      acc += size;
    }
    throw new Error(`offset ${offset} out of range`);
  };
  const [a, ao] = point(start, true);
  const [b, bo] = point(end, false);
  const selection = $createRangeSelection();
  selection.anchor.set(a.getKey(), ao, 'text');
  selection.focus.set(b.getKey(), bo, 'text');
  if (!isCurrentlyReadOnlyMode()) {
    $setSelection(selection);
  }
  return selection;
}

/** The text runs with their ids per flavor: `"Friday"[c:c1 s:s7]` */
function runs(
  editor: LexicalEditor,
  flavors: readonly AnyMarkFlavorExtension[] = [CommentMarks, SuggestionMarks],
): string {
  return editor.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(node => {
        const ids = flavors
          .map(flavor => {
            const flavorIDs = $getNodeMarkIDs(flavor, node);
            return flavorIDs.length > 0
              ? `${flavor.stateKey}:${flavorIDs.join(',')}`
              : '';
          })
          .filter(Boolean)
          .join(' ');
        return JSON.stringify(node.getTextContent()) + (ids ? `[${ids}]` : '');
      })
      .join(' '),
  );
}

function $textNode(text: string): TextNode {
  const node = $getRoot()
    .getAllTextNodes()
    .find(n => n.getTextContent() === text);
  if (!node) {
    throw new Error(`no TextNode ${JSON.stringify(text)}`);
  }
  return node;
}

function nodeKeys(
  editor: LexicalEditor,
  flavor: AnyMarkFlavorExtension,
): Record<string, string[]> {
  const map = getExtensionDependencyFromEditor(editor, flavor).output
    .markIDNodeKeys.value;
  return editor.read(() =>
    Object.fromEntries(
      Array.from(map, ([id, keys]) => [
        id,
        keys
          .map(key =>
            $getRoot()
              .getAllTextNodes()
              .find(n => n.getKey() === key),
          )
          .map(node => (node ? node.getTextContent() : '?'))
          .sort(),
      ]),
    ),
  );
}

function classes(element: HTMLElement): string {
  return Array.from(element.classList).sort().join(' ');
}

function type(editor: LexicalEditor, text: string) {
  editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, text);
}

describe('mark flavors', () => {
  describe('two flavors on the same text', () => {
    test('each flavor sees only its own ids', () => {
      const editor = createEditor();
      update(editor, () => $init());
      // "migration on Friday" commented, "Friday" with a suggestion
      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(9, 28));
      });
      update(editor, () => {
        $addMarkID(SuggestionMarks, 's7', $select(22, 28));
      });
      expect(runs(editor)).toBe(
        '"Ship the " "migration on "[commentIds:c1] "Friday"[commentIds:c1 suggestionIds:s7]',
      );
      editor.read(() => {
        const friday = $textNode('Friday');
        expect($getNodeMarkIDs(CommentMarks, friday)).toEqual(['c1']);
        expect($getNodeMarkIDs(SuggestionMarks, friday)).toEqual(['s7']);
        expect($getMarkIDsAtSelection(CommentMarks, $select(10, 24))).toEqual([
          'c1',
        ]);
        expect(
          $getMarkIDsAtSelection(SuggestionMarks, $select(10, 24), 'any'),
        ).toEqual(['s7']);
        expect(
          $getMarkIDsAtSelection(SuggestionMarks, $select(10, 24), 'all'),
        ).toEqual([]);
        expect($getMarkIDsByFlavor(friday)).toEqual({
          commentIds: ['c1'],
          suggestionIds: ['s7'],
        });
      });
      expect(nodeKeys(editor, CommentMarks)).toEqual({
        c1: ['Friday', 'migration on '],
      });
      expect(nodeKeys(editor, SuggestionMarks)).toEqual({s7: ['Friday']});

      // Removing everywhere touches only its own flavor; equal neighbors merge
      update(editor, () => $removeMarkID(SuggestionMarks, 's7'));
      expect(runs(editor)).toBe(
        '"Ship the " "migration on Friday"[commentIds:c1]',
      );
      expect(nodeKeys(editor, SuggestionMarks)).toEqual({});
      // The same id in two flavors is two different marks
      update(editor, () => {
        $addMarkID(SuggestionMarks, 'c1', $select(0, 4));
      });
      update(editor, () => $removeMarkID(CommentMarks, 'c1'));
      expect(runs(editor)).toBe(
        '"Ship"[suggestionIds:c1] " the migration on Friday"',
      );
    });

    test('each flavor renders its own classes and attribute', () => {
      const editor = createEditor(
        [CommentMarks, SuggestionMarks, MarkStateExtension],
        true,
      );
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(9, 28));
        $addMarkID(CommentMarks, 'c2', $select(22, 28));
        $addMarkID(SuggestionMarks, 's7', $select(22, 28));
      });
      update(editor, () => {
        $addMarkID('m1', $select(0, 4));
      });
      const dom = (text: string) =>
        editor.read(() => editor.getElementByKey($textNode(text).getKey())!);
      const friday = dom('Friday');
      expect(classes(friday)).toBe('comment comment-overlap suggestion');
      expect(friday.getAttribute('data-lexical-comment-ids')).toBe('c1 c2');
      expect(friday.getAttribute('data-lexical-suggestion-ids')).toBe('s7');
      expect(friday.hasAttribute(MARK_STATE_IDS_ATTRIBUTE)).toBe(false);
      const migration = dom('migration on ');
      expect(classes(migration)).toBe('comment');
      expect(migration.hasAttribute('data-lexical-suggestion-ids')).toBe(false);
      // The default flavor keeps the theme classes
      const ship = dom('Ship');
      expect(classes(ship)).toBe('mark');
      expect(ship.getAttribute(MARK_STATE_IDS_ATTRIBUTE)).toBe('m1');

      update(editor, () => $removeMarkID(CommentMarks, 'c2'));
      expect(classes(dom('Friday'))).toBe('comment suggestion');
    });

    test('flavors that share a class do not remove it from each other', () => {
      const Comments = defineMarkExtension({
        className: 'annotation comment',
        name: '@test/SharedComments',
        stateKey: 'commentIds',
      });
      const Suggestions = defineMarkExtension({
        className: 'annotation mark',
        name: '@test/SharedSuggestions',
        stateKey: 'suggestionIds',
      });
      const editor = createEditor(
        [MarkStateExtension, Comments, Suggestions],
        true,
      );
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID(Comments, 'c1', $select(0, 4));
        $addMarkID('m1', $select(5, 8));
      });
      const dom = (text: string) =>
        editor.read(() => editor.getElementByKey($textNode(text).getKey())!);
      // Suggestions has no id on either leaf, and keeps its hands off
      // `annotation` (Comments) and `mark` (MarkStateExtension's theme class)
      expect(classes(dom('Ship'))).toBe('annotation comment');
      expect(classes(dom('the'))).toBe('mark');
      update(editor, () => $removeMarkID(Comments, 'c1'));
      expect(classes(dom('Ship '))).toBe('');
    });

    test.each([
      [
        'at the end of both marks',
        28,
        '"Ship the migration on " "Friday"[commentIds:c1 suggestionIds:s7] "!"',
      ],
      [
        'inside both marks',
        25,
        '"Ship the migration on " "Fri!day"[commentIds:c1 suggestionIds:s7]',
      ],
      [
        'at the start of both marks',
        22,
        '"Ship the migration on !" "Friday"[commentIds:c1 suggestionIds:s7]',
      ],
    ])(
      'typing %s gives the text the ids of both flavors by the same rule',
      (_, at, expected) => {
        const editor = createEditor();
        update(editor, () => $init());
        update(editor, () => {
          $addMarkID(CommentMarks, 'c1', $select(22, 28));
          $addMarkID(SuggestionMarks, 's7', $select(22, 28));
        });
        update(editor, () => {
          $select(at);
          type(editor, '!');
        });
        expect(runs(editor)).toBe(expected);
      },
    );

    test('text typed at the edge of one flavor joins the other where it is inside', () => {
      const editor = createEditor();
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(9, 28));
        $addMarkID(SuggestionMarks, 's7', $select(22, 28));
      });
      update(editor, () => {
        $select(22);
        type(editor, 'next ');
      });
      expect(runs(editor)).toBe(
        '"Ship the " "migration on next "[commentIds:c1] "Friday"[commentIds:c1 suggestionIds:s7]',
      );
    });

    test('text replacing a selection gets the ids all of it had, per flavor', () => {
      const editor = createEditor();
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(22, 28));
        $addMarkID(SuggestionMarks, 's7', $select(9, 28));
      });
      update(editor, () => {
        $select(22, 28);
        type(editor, 'Monday');
      });
      expect(runs(editor)).toBe(
        '"Ship the " "migration on "[suggestionIds:s7] "Monday"[commentIds:c1 suggestionIds:s7]',
      );
    });

    test('pasted text keeps the ids of every flavor', () => {
      const editor = createEditor();
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(22, 28));
        $addMarkID(SuggestionMarks, 's7', $select(25, 28));
      });
      update(editor, () => {
        const json = $generateJSONFromSelectedNodes(editor, $select(22, 28));
        $select(0);
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          throw new Error('no selection');
        }
        $insertGeneratedNodes(
          editor,
          $generateNodesFromSerializedNodes(json.nodes),
          selection,
        );
      });
      expect(runs(editor)).toBe(
        '"Fri"[commentIds:c1] "day"[commentIds:c1 suggestionIds:s7] "Ship the migration on " "Fri"[commentIds:c1] "day"[commentIds:c1 suggestionIds:s7]',
      );
    });
  });

  describe('registerMarkIDsListener', () => {
    function record(editor: LexicalEditor, flavor: AnyMarkFlavorExtension) {
      const calls: string[] = [];
      const unregister = registerMarkIDsListener(
        editor,
        flavor,
        (change: MarkIDsChange) => {
          const list = (set: ReadonlySet<string>) =>
            Array.from(set).sort().join(',');
          const tags = [HISTORIC_TAG, COLLABORATION_TAG].filter(tag =>
            change.tags.has(tag),
          );
          calls.push(
            `+[${list(change.added)}] -[${list(change.removed)}] =[${list(change.ids)}]` +
              (tags.length > 0 ? ` ${tags.join(',')}` : ''),
          );
        },
      );
      return {calls, unregister};
    }

    test('reports added, removed (orphaned) and restored ids across undo and paste', () => {
      const editor = createEditor();
      update(editor, () => $init());
      editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
      const comments = record(editor, CommentMarks);
      const suggestions = record(editor, SuggestionMarks);
      expect(comments.calls).toEqual([]);

      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(22, 28));
      });
      update(editor, () => {
        $addMarkID(CommentMarks, 'c2', $select(0, 4));
      });
      expect(comments.calls).toEqual(['+[c1] -[] =[c1]', '+[c2] -[] =[c1,c2]']);

      // Typing inside a mark changes no ids: nothing to report
      update(editor, () => {
        $select(25);
        type(editor, 'x');
      });
      expect(comments.calls).toHaveLength(2);

      // Copy the commented text, then delete all of it: c1 is orphaned
      let copied: ReturnType<typeof $generateJSONFromSelectedNodes> | null =
        null;
      update(editor, () => {
        copied = $generateJSONFromSelectedNodes(editor, $select(22, 29));
      });
      update(editor, () => {
        $select(21, 29).removeText();
      });
      expect(comments.calls.at(-1)).toBe('+[] -[c1] =[c2]');

      // Undo brings it back
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      // The undo commits at the next microtask; a read commits it now
      editor.read(() => {});
      expect(comments.calls.at(-1)).toBe(
        '+[c1] -[] =[c1,c2]' + ` ${HISTORIC_TAG}`,
      );
      expect(runs(editor)).toContain('"Frixday"[commentIds:c1]');

      // Deleted again, then pasted back
      update(editor, () => {
        $select(21, 29).removeText();
      });
      expect(comments.calls.at(-1)).toBe('+[] -[c1] =[c2]');
      update(editor, () => {
        const selection = $select(21);
        $insertGeneratedNodes(
          editor,
          $generateNodesFromSerializedNodes(copied!.nodes),
          selection,
        );
      });
      expect(comments.calls.at(-1)).toBe('+[c1] -[] =[c1,c2]');

      // The other flavor's listener saw nothing
      expect(suggestions.calls).toEqual([]);
    });

    test('a collaborator update is tagged', () => {
      const editor = createEditor();
      update(editor, () => $init());
      const {calls} = record(editor, CommentMarks);
      update(editor, () => {
        $addUpdateTag(COLLABORATION_TAG);
        $addMarkID(CommentMarks, 'c1', $select(0, 4));
      });
      expect(calls).toEqual([`+[c1] -[] =[c1] ${COLLABORATION_TAG}`]);
    });

    test('the first call lists the ids already in the document, and unregistering stops it', () => {
      const editor = createEditor();
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(0, 4));
        $addMarkID(CommentMarks, 'c2', $select(5, 8));
      });
      const {calls, unregister} = record(editor, CommentMarks);
      expect(calls).toEqual(['+[c1,c2] -[] =[c1,c2]']);
      unregister();
      update(editor, () => $removeMarkID(CommentMarks, 'c1'));
      expect(calls).toHaveLength(1);
    });

    test('disabling reports nothing, enabling reports the net change', () => {
      const editor = createEditor();
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(0, 4));
      });
      const {calls} = record(editor, CommentMarks);
      const {disabled} = getExtensionDependencyFromEditor(
        editor,
        CommentMarks,
      ).output;
      disabled.value = true;
      update(editor, () => {
        $removeMarkID(CommentMarks, 'c1');
        $addMarkID(CommentMarks, 'c3', $select(5, 8));
      });
      expect(calls).toEqual(['+[c1] -[] =[c1]']);
      disabled.value = false;
      expect(calls).toEqual(['+[c1] -[] =[c1]', '+[c3] -[c1] =[c3]']);
      // Disabled, and back with no net change: nothing
      disabled.value = true;
      disabled.value = false;
      expect(calls).toHaveLength(2);
    });

    test('a listener registered while disabled gets every id when enabled', () => {
      const editor = createEditor();
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(0, 4));
      });
      const early = record(editor, CommentMarks);
      const {disabled} = getExtensionDependencyFromEditor(
        editor,
        CommentMarks,
      ).output;
      disabled.value = true;
      const late = record(editor, CommentMarks);
      expect(late.calls).toEqual([]);
      disabled.value = false;
      expect(late.calls).toEqual(['+[c1] -[] =[c1]']);
      // The listener registered before has nothing new to hear
      expect(early.calls).toEqual(['+[c1] -[] =[c1]']);
    });

    test('a listener that throws on its first call is not registered', () => {
      const editor = createEditor();
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(0, 4));
      });
      let calls = 0;
      expect(() =>
        registerMarkIDsListener(editor, CommentMarks, () => {
          calls++;
          throw new Error('listener failed');
        }),
      ).toThrow('listener failed');
      update(editor, () => $removeMarkID(CommentMarks, 'c1'));
      expect(calls).toBe(1);
    });

    test('a flavor disabled by another flavor listener in the same commit reports nothing', () => {
      const editor = createEditor();
      update(editor, () => $init());
      const {disabled, markIDNodeKeys} = getExtensionDependencyFromEditor(
        editor,
        SuggestionMarks,
      ).output;
      registerMarkIDsListener(editor, CommentMarks, () => {
        disabled.value = true;
      });
      const suggestions = record(editor, SuggestionMarks);
      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(0, 4));
        $addMarkID(SuggestionMarks, 's1', $select(0, 4));
      });
      expect(disabled.value).toBe(true);
      expect(suggestions.calls).toEqual([]);
      expect(markIDNodeKeys.value.size).toBe(0);
      disabled.value = false;
      expect(suggestions.calls).toEqual(['+[s1] -[] =[s1]']);
    });

    test('an editor without the flavor throws, naming the fix', () => {
      const editor = createEditor([CommentMarks]);
      expect(() =>
        registerMarkIDsListener(editor, SuggestionMarks, () => {}),
      ).toThrow(
        'registerMarkIDsListener: the editor was not built with @test/SuggestionMarks. Add it to the dependencies of the extension the editor is built from.',
      );
    });
  });

  describe('isMarkIDShown per flavor', () => {
    test('a flavor filter hides only that flavor', () => {
      const resolved = new Set(['c1']);
      const editor = createEditor(
        [
          configExtension(CommentMarks, {
            isMarkIDShown: id => !resolved.has(id),
          }),
          SuggestionMarks,
        ],
        true,
      );
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(22, 28));
        $addMarkID(SuggestionMarks, 'c1', $select(22, 28));
      });
      const friday = () =>
        editor.read(
          () => editor.getElementByKey($textNode('Friday').getKey())!,
        );
      expect(classes(friday())).toBe('suggestion');
      expect(friday().hasAttribute('data-lexical-comment-ids')).toBe(false);
      expect(friday().getAttribute('data-lexical-suggestion-ids')).toBe('c1');
      // The ids stay in the document
      expect(runs(editor)).toContain(
        '"Friday"[commentIds:c1 suggestionIds:c1]',
      );

      // Reopen the thread
      resolved.delete('c1');
      getExtensionDependencyFromEditor(
        editor,
        CommentMarks,
      ).output.isMarkIDShown.value = id => !resolved.has(id);
      expect(classes(friday())).toBe('comment suggestion');
      expect(friday().getAttribute('data-lexical-comment-ids')).toBe('c1');
    });
  });

  describe('the default flavor', () => {
    test('MarkStateExtension is the flavor on markIds', () => {
      expect(MarkStateExtension.stateKey).toBe(MARK_STATE_KEY);
      expect(MarkStateExtension.attribute).toBe(MARK_STATE_IDS_ATTRIBUTE);
      expect(MarkStateExtension.name).toBe('@lexical/mark/MarkState');
      expect(CommentMarks.attribute).toBe('data-lexical-comment-ids');
    });

    test('the functions without a flavor act on MarkStateExtension, beside other flavors', () => {
      const editor = createEditor([MarkStateExtension, CommentMarks]);
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID('m1', $select(0, 4));
        $addMarkID(MarkStateExtension, 'm2', $select(0, 4));
        $addMarkID(CommentMarks, 'c1', $select(0, 4));
      });
      editor.read(() => {
        const ship = $textNode('Ship');
        expect($getNodeMarkIDs(ship)).toEqual(['m1', 'm2']);
        expect($getNodeMarkIDs(MarkStateExtension, ship)).toEqual(['m1', 'm2']);
        expect($getMarkIDsAtSelection($select(1))).toEqual(['m1', 'm2']);
        expect($getMarkIDsAtSelection(CommentMarks, $select(1))).toEqual([
          'c1',
        ]);
        expect(ship.exportJSON().$).toEqual({
          [MARK_STATE_KEY]: ['m1', 'm2'],
          commentIds: ['c1'],
        });
      });
      update(editor, () => $removeMarkID('m1'));
      expect(runs(editor, [MarkStateExtension, CommentMarks])).toBe(
        '"Ship"[markIds:m2 commentIds:c1] " the migration on Friday"',
      );
      const {flavors} = getExtensionDependencyFromEditor(
        editor,
        MarkBaseExtension,
      ).output;
      expect(Array.from(flavors.keys())).toEqual(['markIds', 'commentIds']);
      expect(flavors.get('commentIds')).toBe(CommentMarks);
    });

    test('$migrateMarkNodesToMarkState can target a flavor', () => {
      const editor = createEditor([MarkExtension, CommentMarks]);
      update(editor, () => {
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('Ship the '),
              $createMarkNode(['t1']).append($createTextNode('migration')),
            ),
          );
      });
      update(editor, () => {
        expect($migrateMarkNodesToMarkState(CommentMarks)).toBe(1);
      });
      expect(runs(editor, [MarkStateExtension, CommentMarks])).toBe(
        '"Ship the " "migration"[commentIds:t1]',
      );
    });
  });

  describe('serialization', () => {
    test('JSON round trips the ids of every flavor', () => {
      const editor = createEditor();
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(9, 28));
        $addMarkID(SuggestionMarks, 's7', $select(22, 28));
      });
      const json = editor.getEditorState().toJSON();
      const friday = (json.root.children[0] as SerializedElementNode)
        .children[2];
      expect(friday.$).toEqual({commentIds: ['c1'], suggestionIds: ['s7']});

      const target = createEditor();
      target.setEditorState(target.parseEditorState(JSON.stringify(json)));
      expect(runs(target)).toBe(runs(editor));
      expect(nodeKeys(target, CommentMarks)).toEqual(
        nodeKeys(editor, CommentMarks),
      );
      expect(target.getEditorState().toJSON()).toEqual(json);
    });

    test('ids of a flavor the editor lacks are kept as unknown state', () => {
      const editor = createEditor();
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID(SuggestionMarks, 's7', $select(22, 28));
      });
      const json = JSON.stringify(editor.getEditorState().toJSON());
      const target = createEditor([CommentMarks]);
      target.setEditorState(target.parseEditorState(json));
      expect(JSON.stringify(target.getEditorState().toJSON())).toBe(json);
    });

    test('HTML round trips each flavor through its own attribute', () => {
      const editor = createEditor([
        configExtension(CommentMarks, {exportIDsToHTML: true}),
        SuggestionMarks,
      ]);
      update(editor, () => $init());
      update(editor, () => {
        $addMarkID(CommentMarks, 'c1', $select(22, 28));
        $addMarkID(SuggestionMarks, 's7', $select(22, 28));
      });
      const html = editor.read(() => $generateHtmlFromNodes(editor, null));
      expect(html).toContain('data-lexical-comment-ids="c1"');
      // SuggestionMarks does not export its ids
      expect(html).not.toContain('s7');

      const target = createEditor();
      update(target, () => {
        const dom = new DOMParser().parseFromString(
          html.replace(
            'data-lexical-comment-ids="c1"',
            'data-lexical-comment-ids="c1" data-lexical-suggestion-ids="s9"',
          ),
          'text/html',
        );
        $getRoot()
          .clear()
          .append(...$generateNodesFromDOMViaExtension(dom));
      });
      expect(runs(target)).toBe(
        '"Ship the migration on " "Friday"[commentIds:c1 suggestionIds:s9]',
      );
    });
  });

  describe('errors', () => {
    test('two flavors with the same stateKey fail when the editor is built', () => {
      const Notes = defineMarkExtension({
        name: '@test/Notes',
        stateKey: 'commentIds',
      });
      expect(() => createEditor([CommentMarks, Notes])).toThrow(
        'MarkBaseExtension: @test/CommentMarks and @test/Notes both use stateKey "commentIds". Give each flavor its own stateKey.',
      );
    });

    test('two flavors with the same attribute fail when the editor is built', () => {
      const Notes = defineMarkExtension({
        attribute: 'data-lexical-comment-ids',
        name: '@test/Notes',
        stateKey: 'noteIds',
      });
      expect(() => createEditor([CommentMarks, Notes])).toThrow(
        'MarkBaseExtension: @test/CommentMarks and @test/Notes both render the attribute data-lexical-comment-ids. Give each flavor its own attribute.',
      );
    });

    test('attributes that differ only in case clash', () => {
      const Notes = defineMarkExtension({
        attribute: 'DATA-LEXICAL-COMMENT-IDS',
        name: '@test/Notes',
        stateKey: 'noteIds',
      });
      expect(Notes.attribute).toBe('data-lexical-comment-ids');
      expect(() => createEditor([CommentMarks, Notes])).toThrow(
        'both render the attribute data-lexical-comment-ids',
      );
    });

    test.each(['', 'a b', MARK_STATE_KEY, '__proto__'])(
      'stateKey %j is rejected with the fix in the message',
      stateKey => {
        expect(() =>
          defineMarkExtension({
            name: '@test/Bad',
            stateKey: stateKey as 'badIds',
          }),
        ).toThrow(
          `defineMarkExtension: invalid stateKey ${JSON.stringify(stateKey)} for @test/Bad. Use a non-empty name without whitespace, other than "markIds" (the key of MarkStateExtension) and "__proto__", such as "commentIds".`,
        );
      },
    );
  });

  describe('types', () => {
    test('the definition types the flavor', () => {
      expectTypeOf(CommentMarks.stateKey).toEqualTypeOf<'commentIds'>();
      expectTypeOf(CommentMarks.name).toEqualTypeOf<'@test/CommentMarks'>();
      expectTypeOf(CommentMarks).toEqualTypeOf<
        MarkFlavorExtension<'@test/CommentMarks', 'commentIds'>
      >();
      expectTypeOf(MarkStateExtension.stateKey).toEqualTypeOf<'markIds'>();
      expectTypeOf(CommentMarks).toMatchTypeOf<AnyMarkFlavorExtension>();
    });

    test('the original signatures stay the last overloads', () => {
      // Parameters and ReturnType read the last overload, so code that uses
      // them on these functions sees the same types as before flavors
      expectTypeOf<Parameters<typeof $addMarkID>>().toEqualTypeOf<
        [id: string, selection: BaseSelection]
      >();
      expectTypeOf<Parameters<typeof $removeMarkID>>().toEqualTypeOf<
        [id: string, selection?: null | BaseSelection]
      >();
      expectTypeOf<Parameters<typeof $getMarkIDsAtSelection>>().toEqualTypeOf<
        [selection?: null | BaseSelection, mode?: 'any' | 'all']
      >();
      expectTypeOf<Parameters<typeof $getNodeMarkIDs>>().toEqualTypeOf<
        [node: LexicalNode]
      >();
      expectTypeOf<
        Parameters<typeof $migrateMarkNodesToMarkState>
      >().toEqualTypeOf<[node?: LexicalNode]>();
    });

    test('the type rules reject what the runtime rejects', () => {
      // Only type checked: each call would throw
      const typeOnly = () => {
        defineMarkExtension({
          name: '@test/Default',
          // @ts-expect-error "markIds" is the key of MarkStateExtension, the default flavor. Choose another stateKey, such as "commentIds"
          stateKey: 'markIds',
        });
        defineMarkExtension({
          name: '@test/Empty',
          // @ts-expect-error stateKey must not be empty: use a name such as "commentIds"
          stateKey: '',
        });
        defineMarkExtension({
          name: '@test/Spaced',
          // @ts-expect-error stateKey must not contain whitespace: use a name such as "commentIds"
          stateKey: 'comment ids',
        });
        defineMarkExtension({
          name: '@test/Proto',
          // @ts-expect-error stateKey must not be "__proto__", which objects cannot hold as a key: use a name such as "commentIds"
          stateKey: '__proto__',
        });
        const dynamic: string = 'commentIds';
        defineMarkExtension({
          name: '@test/Dynamic',
          // @ts-expect-error stateKey must be a string literal, such as "commentIds"
          stateKey: dynamic,
        });
        update(createEditor(), () => {
          // @ts-expect-error the flavor comes first, before the id
          $addMarkID('c1', CommentMarks, $getSelection()!);
          // @ts-expect-error a selection is required
          $addMarkID(CommentMarks, 'c1');
          // @ts-expect-error only a mark flavor can be passed first
          $getNodeMarkIDs(RichTextExtension, $getRoot());
        });
        registerMarkIDsListener(
          createEditor(),
          // @ts-expect-error only a mark flavor has ids to report
          RichTextExtension,
          () => {},
        );
      };
      expect(typeof typeOnly).toBe('function');
    });
  });
});
