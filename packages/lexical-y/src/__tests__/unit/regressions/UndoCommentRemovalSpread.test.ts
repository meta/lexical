/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// Two clients, synced after every step: A comments "two two " (c1) and
// maybe "two" (c2) and types at the start of the line, in one undo step; B
// removes c1; A undoes; B undoes its removal. c1 must come back on its own
// text only, never on the paragraphs after it (#9623).

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {
  $addMarkID,
  $getNodeMarkIDs,
  $removeMarkID,
  MarkStateExtension,
} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  configExtension,
  defineExtension,
  type LexicalEditor,
  type RangeSelection,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {createYDoc, YCollabExtension} from '../../..';
import {readYState, seedYState} from '../../../headless';

const CONFIG = {
  extensions: [RichTextExtension, MarkStateExtension],
  schemaVersion: 1,
};
const PARAS = [
  'zero zero zero',
  'one one one',
  'two two two',
  'three three three',
  'four four four',
];

function $show(): string[] {
  return $getRoot()
    .getChildren()
    .map(b =>
      $isElementNode(b)
        ? b
            .getChildren()
            .map(c => {
              const ids = $isTextNode(c)
                ? $getNodeMarkIDs(MarkStateExtension, c)
                : [];
              return `${c.getTextContent()}${ids.length ? `[${ids.join(',')}]` : ''}`;
            })
            .join('|')
        : '?',
    );
}

function clients() {
  const seeded = seedYState(CONFIG, () => {
    $getRoot()
      .clear()
      .append(
        ...PARAS.map(t => $createParagraphNode().append($createTextNode(t))),
      );
  });
  const [A, B] = ['A', 'B'].map(name => {
    const doc = createYDoc();
    Y.applyUpdate(doc, seeded);
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          MarkStateExtension,
          configExtension(YCollabExtension, {
            // Undo steps end where the test says, whatever the runner's
            // speed (see step).
            captureTimeout: 2 ** 30,
            doc,
            schemaVersion: 1,
            synced: true,
          }),
        ],
        name: `repro/${name}`,
      }),
    );
    const {binding} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    return {
      doc,
      editor,
      // Ends the client's current undo step.
      step: () => binding.undoManager?.stopCapturing(),
    };
  }) as unknown as [
    {doc: Y.Doc; editor: LexicalEditor; step: () => void},
    {doc: Y.Doc; editor: LexicalEditor; step: () => void},
  ];
  const sync = () => {
    Y.applyUpdate(
      B.doc,
      Y.encodeStateAsUpdate(A.doc, Y.encodeStateVector(B.doc)),
    );
    Y.applyUpdate(
      A.doc,
      Y.encodeStateAsUpdate(B.doc, Y.encodeStateVector(A.doc)),
    );
  };
  return {A, B, sync};
}

function onRange(
  editor: LexicalEditor,
  a: number,
  b: number,
  f: (s: RangeSelection) => void,
) {
  editor.update(
    () => {
      const t = (
        $getRoot().getChildAtIndex(2) as ReturnType<typeof $createParagraphNode>
      ).getFirstChild();
      if (!$isTextNode(t)) throw new Error('no text');
      const s = $createRangeSelection();
      s.anchor.set(t.getKey(), a, 'text');
      s.focus.set(t.getKey(), b, 'text');
      $setSelection(s);
      f(s);
      $setSelection(null);
    },
    {discrete: true},
  );
}

describe('undoing the removal of a comment after its author undid adding it, with a second comment and typing', () => {
  for (const typed of [true, false]) {
    for (const second of [true, false]) {
      // Spread with garbage collection on (#9623) until the binding kept its
      // own format items from collection while they are undoable.
      it(`keeps the comment off the paragraphs after it (second comment: ${second}, typed at its start: ${typed})`, () => {
        const {A, B, sync} = clients();
        onRange(A.editor, 0, 8, s => $addMarkID('c1', s));
        if (second) onRange(A.editor, 0, 3, s => $addMarkID('c2', s));
        if (typed)
          onRange(A.editor, 0, 0, s => {
            s.format = 0;
            s.insertText(' new ');
          });
        // A's comments and typing are one undo step.
        A.step();
        sync();
        B.editor.update(() => $removeMarkID('c1'), {discrete: true});
        B.step();
        sync();
        A.editor.dispatchCommand(UNDO_COMMAND, undefined);
        sync();
        B.editor.dispatchCommand(UNDO_COMMAND, undefined);
        sync();
        const a = A.editor.getEditorState().read($show);
        const b = B.editor.getEditorState().read($show);
        const fresh = readYState(Y.encodeStateAsUpdate(A.doc), CONFIG, $show);
        expect(b).toEqual(a);
        expect(fresh).toEqual(a);
        expect(a.slice(0, 2)).toEqual(PARAS.slice(0, 2));
        expect(a.slice(3)).toEqual(PARAS.slice(3));
        // And c1 is on exactly its words or nowhere: the comment's author
        // undid it, and whether B's undo of its removal brings it back is
        // undecided (it must not cover less, nor more).
        const withC1 = A.editor.getEditorState().read(() => {
          const block = $getRoot().getChildAtIndex(2);
          return $isElementNode(block)
            ? block
                .getAllTextNodes()
                .filter(n =>
                  $getNodeMarkIDs(MarkStateExtension, n).includes('c1'),
                )
                .map(n => n.getTextContent())
                .join('')
            : '?';
        });
        expect(['', 'two two '], 'c1 on its words or nowhere').toContain(
          withC1,
        );
      });
    }
  }
});
