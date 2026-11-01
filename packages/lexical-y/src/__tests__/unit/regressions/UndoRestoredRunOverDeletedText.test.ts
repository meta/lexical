/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A types "yy " at the start of a paragraph and comments it (or bolds it) in
// one undo step; after a sync, B removes that comment (or bold) while A
// undoes its step; after a sync, B undoes its removal. The text the value
// was on is gone, so the value must come back on nothing: never on the
// paragraph's other words or the paragraphs after it. B's undo brings back
// A's opener, and the end that closed it was A's own, deleted by A's undo;
// the run the copy opens has to end there although nothing between the copy
// and that end is shown. The cells marked `it.fails` spread the value over
// the rest of the document (#9689): the restoring client cannot tell
// the author's own end from the end of a later, separate write by the same
// author (a fix that trusted `changeEnd` there was parked in #9687; see
// UndoRestoredRunSharedEnd.test.ts for the case it got wrong).

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
];

function $show(): string[] {
  return $getRoot()
    .getChildren()
    .map(b =>
      $isElementNode(b)
        ? b
            .getChildren()
            .map(c => {
              if (!$isTextNode(c)) {
                return '?';
              }
              const ids = $getNodeMarkIDs(MarkStateExtension, c);
              return `${c.getTextContent()}${c.hasFormat('bold') ? '{b}' : ''}${ids.length ? `[${ids.join(',')}]` : ''}`;
            })
            .join('|')
        : '?',
    );
}

type Client = {doc: Y.Doc; editor: LexicalEditor; step: () => void};

function clients(gc: boolean, ids: [number, number]) {
  const seeded = seedYState(CONFIG, () => {
    $getRoot()
      .clear()
      .append(
        ...PARAS.map(t => $createParagraphNode().append($createTextNode(t))),
      );
  });
  const [A, B] = ['A', 'B'].map((name, n) => {
    const doc = createYDoc(seeded, {gc});
    doc.clientID = ids[n];
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          RichTextExtension,
          MarkStateExtension,
          configExtension(YCollabExtension, {
            // Undo steps end where the test says (see step).
            captureTimeout: 2 ** 30,
            doc,
            schemaVersion: 1,
            synced: true,
          }),
        ],
        name: `restored-run/${name}`,
        onError: e => {
          throw e;
        },
      }),
    );
    const {binding} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    return {
      doc,
      editor,
      step: () => binding.undoManager?.stopCapturing(),
    };
  }) as unknown as [Client, Client];
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
  para = 2,
) {
  editor.update(
    () => {
      const block = $getRoot().getChildAtIndex(para) as ReturnType<
        typeof $createParagraphNode
      >;
      // a negative offset counts from the end of the paragraph's last text
      const t = a < 0 ? block.getLastChild() : block.getFirstChild();
      if (!$isTextNode(t)) {
        throw new Error('no text');
      }
      const n = t.getTextContentSize();
      const s = $createRangeSelection();
      s.anchor.set(t.getKey(), a < 0 ? n + a + 1 : a, 'text');
      s.focus.set(t.getKey(), b < 0 ? n + b + 1 : b, 'text');
      $setSelection(s);
      f(s);
      $setSelection(null);
    },
    {discrete: true},
  );
}

const type = (s: RangeSelection, text: string) => {
  s.format = 0;
  s.insertText(text);
};

type Shape = {
  name: string;
  /** Before A's step, synced (B's own values elsewhere). */
  pre?: (A: Client, B: Client) => void;
  /** The document at the end (default: as seeded). */
  expected?: string[];
  /** A's step (one undo step unless `twoSteps`). */
  write: (A: Client) => void;
  /** B's removal. */
  remove: (B: Client) => void;
  twoSteps?: boolean;
  /** Which of the two orders still spreads the value (#9689). */
  failsOn?: 'concurrent' | 'sequential';
};

const SHAPES: Shape[] = [
  {
    failsOn: 'concurrent',
    name: 'comment on typed text',
    remove: B => B.editor.update(() => $removeMarkID('c1'), {discrete: true}),
    write: A => {
      onRange(A.editor, 0, 0, s => type(s, 'yy '));
      onRange(A.editor, 0, 3, s => $addMarkID('c1', s));
    },
  },
  {
    failsOn: 'sequential',
    name: 'two comments on typed text, then more typing before them',
    remove: B => B.editor.update(() => $removeMarkID('c1'), {discrete: true}),
    write: A => {
      onRange(A.editor, 0, 0, s => type(s, 'yy '));
      onRange(A.editor, 0, 3, s => $addMarkID('c1', s));
      onRange(A.editor, 0, 3, s => $addMarkID('c2', s));
      onRange(A.editor, 0, 0, s => type(s, ' new '));
    },
  },
  {
    failsOn: 'concurrent',
    name: 'comment on typed text, typed and commented in two steps',
    remove: B => B.editor.update(() => $removeMarkID('c1'), {discrete: true}),
    twoSteps: true,
    write: A => {
      onRange(A.editor, 0, 0, s => type(s, 'yy '));
      A.step();
      onRange(A.editor, 0, 3, s => $addMarkID('c1', s));
    },
  },
  {
    failsOn: 'concurrent',
    name: 'bold on typed text',
    remove: B =>
      B.editor.update(
        () => {
          const t = (
            $getRoot().getChildAtIndex(2) as ReturnType<
              typeof $createParagraphNode
            >
          ).getFirstChild();
          if (!$isTextNode(t)) {
            throw new Error('no text');
          }
          const s = $createRangeSelection();
          s.anchor.set(t.getKey(), 0, 'text');
          s.focus.set(t.getKey(), t.getTextContentSize(), 'text');
          $setSelection(s);
          s.format = t.getFormat();
          s.formatText('bold');
          $setSelection(null);
        },
        {discrete: true},
      ),
    write: A => {
      onRange(A.editor, 0, 0, s => type(s, 'yy '));
      onRange(A.editor, 0, 3, s => s.formatText('bold'));
    },
  },
  {
    name: 'comment on text typed at the end of the document',
    remove: B => B.editor.update(() => $removeMarkID('c1'), {discrete: true}),
    write: A => {
      onRange(A.editor, -1, -1, s => type(s, ' yy'), 3);
      onRange(A.editor, -4, -1, s => $addMarkID('c1', s), 3);
    },
  },
  {
    failsOn: 'concurrent',
    name: 'comment on text typed at the end of a paragraph',
    remove: B => B.editor.update(() => $removeMarkID('c1'), {discrete: true}),
    write: A => {
      onRange(A.editor, -1, -1, s => type(s, ' yy'), 2);
      onRange(A.editor, -4, -1, s => $addMarkID('c1', s), 2);
    },
  },
  {
    expected: [PARAS[0], PARAS[1], PARAS[2], 'three[c1]| three three'],
    failsOn: 'concurrent',
    name: 'comment on typed text, the same comment id of the other client live after it',
    pre: (_A, B) => onRange(B.editor, 0, 5, s => $addMarkID('c1', s), 3),
    remove: B => B.editor.update(() => $removeMarkID('c1'), {discrete: true}),
    write: A => {
      onRange(A.editor, 0, 0, s => type(s, 'yy '));
      onRange(A.editor, 0, 3, s => $addMarkID('c1', s));
    },
  },
  {
    expected: [PARAS[0], PARAS[1], PARAS[2], 'three[c9]| three three'],
    failsOn: 'concurrent',
    name: 'comment on typed text, another comment id live after it',
    pre: (_A, B) => onRange(B.editor, 0, 5, s => $addMarkID('c9', s), 3),
    remove: B => B.editor.update(() => $removeMarkID('c1'), {discrete: true}),
    write: A => {
      onRange(A.editor, 0, 0, s => type(s, 'yy '));
      onRange(A.editor, 0, 3, s => $addMarkID('c1', s));
    },
  },
];

describe('undoing a removal brings back a value whose text and end the author undid', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ] as [number, number][]) {
      for (const shape of SHAPES) {
        for (const concurrent of [true, false]) {
          const spreads =
            shape.failsOn === (concurrent ? 'concurrent' : 'sequential');
          (spreads ? it.fails : it)(
            `${shape.name}; A undoes ${concurrent ? 'while B removes' : 'after B removed'} (gc ${gc ? 'on' : 'off'}, ids ${ids})${spreads ? ' (#9689)' : ''}`,
            () => {
              const {A, B, sync} = clients(gc, ids);
              if (shape.pre) {
                shape.pre(A, B);
                B.step();
                sync();
              }
              shape.write(A);
              A.step();
              sync();
              shape.remove(B);
              B.step();
              if (!concurrent) {
                sync();
              }
              A.editor.dispatchCommand(UNDO_COMMAND, undefined);
              if (shape.twoSteps) {
                A.editor.dispatchCommand(UNDO_COMMAND, undefined);
              }
              sync();
              B.editor.dispatchCommand(UNDO_COMMAND, undefined);
              sync();
              const a = A.editor.getEditorState().read($show);
              const b = B.editor.getEditorState().read($show);
              const fresh = readYState(
                Y.encodeStateAsUpdate(A.doc),
                CONFIG,
                $show,
              );
              expect(b).toEqual(a);
              expect(fresh).toEqual(a);
              expect(a).toEqual(shape.expected ?? PARAS);
            },
          );
        }
      }
    }
  }
});

describe('both clients comment the same text; A types at its start; B undoes its comment and removes it; A undoes; B undoes (#9689)', () => {
  for (const gc of [false, true]) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ] as [number, number][]) {
      // Fully sequential (synced after every step). The comment B removed
      // comes back over the paragraphs after it (#9689).
      it.fails(
        `no comment is left (gc ${gc ? 'on' : 'off'}, ids ${ids})`,
        () => {
          const {A, B, sync} = clients(gc, ids);
          // "two" in "zero two two": the second text node after each comment
          const second =
            (f: (s: RangeSelection) => void, a: number, b: number) =>
            (editor: LexicalEditor) =>
              editor.update(
                () => {
                  const block = $getRoot().getChildAtIndex(2) as ReturnType<
                    typeof $createParagraphNode
                  >;
                  const t = block.getChildAtIndex(1);
                  if (!$isTextNode(t)) {
                    throw new Error('no text');
                  }
                  const s = $createRangeSelection();
                  s.anchor.set(t.getKey(), a, 'text');
                  s.focus.set(t.getKey(), b, 'text');
                  $setSelection(s);
                  f(s);
                  $setSelection(null);
                },
                {discrete: true},
              );
          onRange(A.editor, 4, 7, s => $addMarkID('c1', s));
          A.step();
          sync();
          second(s => $addMarkID('c2', s), 0, 3)(B.editor);
          B.step();
          sync();
          second(s => type(s, 'yy'), 0, 0)(A.editor);
          A.step();
          sync();
          B.editor.dispatchCommand(UNDO_COMMAND, undefined);
          sync();
          B.editor.update(() => $removeMarkID('c2'), {discrete: true});
          B.step();
          sync();
          A.editor.dispatchCommand(UNDO_COMMAND, undefined);
          A.editor.dispatchCommand(UNDO_COMMAND, undefined);
          sync();
          B.editor.dispatchCommand(UNDO_COMMAND, undefined);
          sync();
          const a = A.editor.getEditorState().read($show);
          expect(B.editor.getEditorState().read($show)).toEqual(a);
          expect(a).toEqual(PARAS);
        },
      );
    }
  }
});
