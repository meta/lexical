/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// The issues' own repros, with garbage collection on (Yjs's default, which
// products use) and off, and both client id orders:
// - #9623: an undo reads the format items of its change after a
//   collaborator deleted them; with gc on they were collected, and the
//   comment came back over the rest of the document. The binding now keeps
//   its own format items from collection while they are undoable.
// - #9599: a restore's scan took a client's earlier end and later opener
//   (with another client's text between them) for one restored run, so its
//   undo wrote no end and a format ran onto the next word.
// - #9671: a format write kept the null and the restore that the writer's
//   own earlier insert left inside its range; a collaborator's typing relied
//   on that restore, and undoing the insert deleted it. Like Yjs's
//   formatText, the write now removes them.
// - A range end that restates another client's opener (rule 3) now also
//   ends it where that opener's run ended, so undoing that client's change
//   leaves the text after the range alone (#9622's family).

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {$isLinkNode, $toggleLink} from '@lexical/link';
import {
  $addMarkID,
  $getNodeMarkIDs,
  $removeMarkID,
  MarkStateExtension,
} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {$patchStyleText} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  type AnyLexicalExtension,
  configExtension,
  defineExtension,
  getStyleObjectFromCSS,
  type LexicalEditor,
  type RangeSelection,
  type TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {createYDoc, type YBinding, YCollabExtension} from '../../..';
import {readYState, seedYState} from '../../../headless';
import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  setup,
} from '../../utils/harness';

interface Client {
  binding: YBinding;
  doc: Y.Doc;
  editor: LexicalEditor;
}

const IDS = [
  [1, 2],
  [2, 1],
] as const;
const GC = [true, false];

function clients(
  extensions: AnyLexicalExtension[],
  seeded: Uint8Array,
  ids: readonly [number, number],
  gc: boolean,
): {A: Client; B: Client; sync: () => void; dispose: () => void} {
  const [A, B] = ids.map((id, n) => {
    const doc = createYDoc(seeded, {gc});
    doc.clientID = id;
    const editor = buildEditorFromExtensions(
      defineExtension({
        dependencies: [
          ...extensions,
          configExtension(YCollabExtension, {
            captureTimeout: 2 ** 30,
            doc,
            schemaVersion: 1,
            synced: true,
          }),
        ],
        name: `own-format-items-${n}`,
        onError: e => {
          throw e;
        },
      }),
    );
    const {binding} = getExtensionDependencyFromEditor(
      editor,
      YCollabExtension,
    ).output;
    return {binding, doc, editor};
  });
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
  const dispose = () => {
    A.editor.dispose();
    B.editor.dispose();
  };
  return {A, B, dispose, sync};
}

function step(client: Client, f: () => void) {
  client.editor.update(f, {discrete: true});
  client.binding.undoManager?.stopCapturing();
}

function undo(client: Client) {
  client.editor.dispatchCommand(UNDO_COMMAND, undefined);
  client.binding.undoManager?.stopCapturing();
}

describe('a comment its author undid stays off the rest of the document when a collaborator undoes removing it (#9623)', () => {
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
  const $show = () =>
    $getRoot()
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
  const $selectWord = (f: (s: RangeSelection) => void) => {
    const p = $getRoot().getChildAtIndex(2);
    const t = $isElementNode(p) ? p.getFirstChild() : null;
    if (!$isTextNode(t)) {
      throw new Error('no text');
    }
    const s = $createRangeSelection();
    s.anchor.set(t.getKey(), 0, 'text');
    s.focus.set(t.getKey(), 5, 'text');
    $setSelection(s);
    f(s);
    $setSelection(null);
  };
  const seeded = seedYState(CONFIG, () => {
    $getRoot()
      .clear()
      .append(
        ...PARAS.map(t => $createParagraphNode().append($createTextNode(t))),
      );
  });
  for (const gc of GC) {
    for (const ids of IDS) {
      for (const removal of ['whole document', 'that word only'] as const) {
        test(`removal: ${removal} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, () => {
          const {A, B, sync, dispose} = clients(
            CONFIG.extensions,
            seeded,
            ids,
            gc,
          );
          try {
            step(B, () => $selectWord(s => $addMarkID('c2', s)));
            sync();
            step(A, () =>
              removal === 'whole document'
                ? $removeMarkID('c2')
                : $selectWord(s => $removeMarkID('c2', s)),
            );
            sync();
            undo(B);
            sync();
            undo(A);
            sync();
            const a = A.editor.getEditorState().read($show);
            expect(B.editor.getEditorState().read($show)).toEqual(a);
            expect(
              readYState(Y.encodeStateAsUpdate(A.doc), CONFIG, $show),
            ).toEqual(a);
            // On "two t" or nowhere; never on text nobody commented.
            expect(a.slice(0, 2)).toEqual(PARAS.slice(0, 2));
            expect(a.slice(3)).toEqual(PARAS.slice(3));
            expect(['two two two', 'two t[c2]|wo two']).toContain(a[2]);
          } finally {
            dispose();
          }
        });
      }
      test(`control: without the author's undo, the comment comes back on its word only (gc ${gc ? 'on' : 'off'}, ids ${ids})`, () => {
        const {A, B, sync, dispose} = clients(
          CONFIG.extensions,
          seeded,
          ids,
          gc,
        );
        try {
          step(B, () => $selectWord(s => $addMarkID('c2', s)));
          sync();
          step(A, () => $removeMarkID('c2'));
          sync();
          undo(A);
          sync();
          expect(A.editor.getEditorState().read($show)).toEqual([
            ...PARAS.slice(0, 2),
            'two t[c2]|wo two',
            ...PARAS.slice(3),
          ]);
        } finally {
          dispose();
        }
      });
    }
  }
});

describe("undoing one's own formats leaves the next word alone after a collaborator typed plain text inside the first run (#9599)", () => {
  const CONFIG = {extensions: [RichTextExtension], schemaVersion: 1};
  // "w0 " "w1 " "w2 " | "w3 " (strikethrough) "w4 " "w5 "
  const seeded = seedYState(CONFIG, () => {
    const $word = (w: string, struck = false) => {
      const t = $createTextNode(w + ' ');
      return struck ? t.setFormat('strikethrough') : t;
    };
    $getRoot()
      .clear()
      .append(
        $createParagraphNode().append($word('w0'), $word('w1'), $word('w2')),
        $createParagraphNode().append(
          $word('w3', true),
          $word('w4'),
          $word('w5'),
        ),
      );
  });
  const $find = (word: string): [TextNode, number] => {
    for (const t of $getRoot().getAllTextNodes()) {
      const i = t.getTextContent().indexOf(word);
      if (i >= 0) {
        return [t, i];
      }
    }
    throw new Error(word);
  };
  const $select = (from: string, to: string, fromOffset = 0, toEnd = true) => {
    const [a, ao] = $find(from);
    const [b, bo] = $find(to);
    const s = $createRangeSelection();
    s.anchor.set(a.getKey(), ao + fromOffset, 'text');
    s.focus.set(b.getKey(), toEnd ? bo + to.length : bo + fromOffset, 'text');
    $setSelection(s);
    return s;
  };
  const formats = (editor: LexicalEditor) =>
    editor.getEditorState().read(() =>
      $getRoot()
        .getAllTextNodes()
        .map(t => `${t.getTextContent()}:${t.getFormat()}`),
    );
  for (const gc of GC) {
    for (const ids of IDS) {
      test(`B's undos leave w4 alone (gc ${gc ? 'on' : 'off'}, ids ${ids})`, () => {
        const {A, B, dispose} = clients(CONFIG.extensions, seeded, ids, gc);
        try {
          step(B, () => void $select('w2', 'w3').formatText('italic'));
          step(B, () => {
            const s = $select('w3', 'w3', 2, false);
            s.setFormat(0);
            s.insertText(' zz');
          });
          step(B, () => void $select('w5', 'w5').formatText('italic'));
          Y.applyUpdate(A.doc, Y.encodeStateAsUpdate(B.doc));
          const formatOfW4 = (editor: LexicalEditor) =>
            editor.getEditorState().read(() => $find('w4')[0].getFormat());
          const before = formatOfW4(A.editor);
          const svA = Y.encodeStateVector(A.doc);
          const svB = Y.encodeStateVector(B.doc);
          // Concurrently: A types a plain "X" inside w3, B undoes its three steps.
          step(A, () => {
            const s = $select('w3', 'w3', 1, false);
            s.setFormat(0);
            s.insertText('X');
          });
          for (let i = 0; i < 3; i++) {
            B.binding.undo();
            B.binding.undoManager?.stopCapturing();
          }
          Y.applyUpdate(A.doc, Y.encodeStateAsUpdate(B.doc, svB));
          Y.applyUpdate(B.doc, Y.encodeStateAsUpdate(A.doc, svA));
          expect([formatOfW4(A.editor), formatOfW4(B.editor)]).toEqual([
            before,
            before,
          ]);
          expect(formats(B.editor)).toEqual(formats(A.editor));
        } finally {
          dispose();
        }
      });
    }
  }
});

describe('undoing text typed into a run and then formatted leaves the untouched rest of the run as it was (#9671)', () => {
  const CONFIG = {extensions: [RichTextExtension], schemaVersion: 1};
  const $texts = (): TextNode[] => {
    const p = $getRoot().getFirstChildOrThrow();
    return $isElementNode(p) ? p.getChildren().filter($isTextNode) : [];
  };
  const $at = (i: number): [TextNode, number] => {
    const ts = $texts();
    let acc = 0;
    for (const t of ts) {
      const n = t.getTextContentSize();
      if (i <= acc + n) {
        return [t, i - acc];
      }
      acc += n;
    }
    const last = ts[ts.length - 1];
    return [last, last.getTextContentSize()];
  };
  const $select = (i: number, j: number) => {
    const s = $createRangeSelection();
    const [a, ao] = $at(i);
    const [b, bo] = $at(j);
    s.anchor.set(a.getKey(), ao, 'text');
    s.focus.set(b.getKey(), bo, 'text');
    $setSelection(s);
    return s;
  };
  const $typePlain = (i: number, text: string) => {
    const s = $select(i, i);
    s.format = 0;
    s.insertText(text);
    $setSelection(null);
  };
  const $strike = (i: number, j: number) => {
    $select(i, j).formatText('strikethrough');
    $setSelection(null);
  };
  const show = (editor: LexicalEditor) =>
    editor.read(() =>
      $texts()
        .map(
          t =>
            t.getTextContent() +
            (t.hasFormat('bold') ? ':b' : '') +
            (t.hasFormat('strikethrough') ? ':s' : ''),
        )
        .join('|'),
    );

  // "abcdef" (bold) "ghi" (strikethrough). B types a plain "Z" inside "ghi",
  // then strikes "gZ" (or "fgZ"). A types a plain "1" right after Z. B undoes
  // twice. The clients sync after every step.
  const seeded = seedYState(CONFIG, () => {
    $getRoot()
      .clear()
      .append(
        $createParagraphNode().append(
          $createTextNode('abcdef').toggleFormat('bold'),
          $createTextNode('ghi').toggleFormat('strikethrough'),
        ),
      );
  });
  for (const gc of GC) {
    for (const ids of IDS) {
      for (const [range, cell] of [
        ['gZ', 'repro'],
        ['fgZ', 'repro'],
        ['gZ', 'control: A does not type'],
        ['gZ', 'control: B undoes only the strikethrough'],
      ] as const) {
        test(`"hi" keeps strikethrough (B strikes ${range}, ${cell}, gc ${gc ? 'on' : 'off'}, ids ${ids})`, () => {
          const {A, B, sync, dispose} = clients(
            CONFIG.extensions,
            seeded,
            ids,
            gc,
          );
          try {
            step(B, () => $typePlain(7, 'Z'));
            sync();
            step(B, () => $strike(range === 'gZ' ? 6 : 5, 8));
            sync();
            const typed = cell !== 'control: A does not type';
            if (typed) {
              step(A, () => $typePlain(8, '1'));
            }
            sync();
            undo(B);
            sync();
            expect(show(A.editor)).toBe(
              typed ? 'abcdef:b|g:s|Z1|hi:s' : 'abcdef:b|g:s|Z|hi:s',
            );
            if (cell === 'control: B undoes only the strikethrough') {
              return;
            }
            undo(B);
            sync();
            const want = typed ? 'abcdef:b|g:s|1|hi:s' : 'abcdef:b|ghi:s';
            expect([show(A.editor), show(B.editor)]).toEqual([want, want]);
          } finally {
            dispose();
          }
        });
      }
    }
  }

  // The mirror: "abc" (strikethrough) "def". B types a plain "Z" inside
  // "abc", then strikes Z (or more). A types a plain "1" right before or
  // after Z. B undoes twice. A's "1" stays plain.
  const mirror = seedYState(CONFIG, () => {
    $getRoot()
      .clear()
      .append(
        $createParagraphNode().append(
          $createTextNode('abc').toggleFormat('strikethrough'),
          $createTextNode('def'),
        ),
      );
  });
  for (const gc of GC) {
    for (const ids of IDS) {
      for (const [where, struck] of [
        ['before Z', 'Z'],
        ['after Z', 'Z'],
        ['before Z', 'Zc'],
        ['after Z', 'Zcd'],
      ] as const) {
        test(`A's plain 1 stays plain (A types ${where}, B strikes ${struck}, gc ${gc ? 'on' : 'off'}, ids ${ids})`, () => {
          const {A, B, sync, dispose} = clients(
            CONFIG.extensions,
            mirror,
            ids,
            gc,
          );
          try {
            step(B, () => $typePlain(2, 'Z'));
            sync();
            step(B, () => $strike(2, 2 + struck.length));
            sync();
            step(A, () => $typePlain(where === 'before Z' ? 2 : 3, '1'));
            sync();
            undo(B);
            sync();
            undo(B);
            sync();
            const want = 'ab:s|1|c:s|def';
            expect([show(A.editor), show(B.editor)]).toEqual([want, want]);
          } finally {
            dispose();
          }
        });
      }
    }
  }
});

describe("a range end that restates another client's opener ends it where that opener's run ended", () => {
  // "ABC DEF GHI JKL MNO": B gives "I " and then "K" a value (two undo
  // steps); while offline, B undoes the second and C gives " J", across the
  // gap between them, a value of its own. Nobody gave " MNO" a value.
  const LINE = 'ABC DEF GHI JKL MNO';
  const ORDERS = [
    [1, 2, 3],
    [3, 2, 1],
    [2, 3, 1],
    [1, 3, 2],
    [2, 1, 3],
    [3, 1, 2],
  ];
  const $give = (
    kind: 'link' | 'color',
    who: 'B' | 'C',
    s: number,
    e: number,
  ) => {
    const sel = $selectIn([0], s, e);
    if (kind === 'link') {
      $toggleLink(who === 'B' ? 'https://b.test' : 'https://c.test');
    } else {
      $patchStyleText(sel, {color: who === 'B' ? 'red' : 'blue'});
    }
    $setSelection(null);
  };
  // Each text node after offset 14 with any value on it.
  const $valuesAfterK = () => {
    const out: string[] = [];
    let at = 0;
    for (const t of $block([0]).getAllTextNodes()) {
      const end = at + t.getTextContentSize();
      if (end > 14) {
        const color = getStyleObjectFromCSS(t.getStyle()).color;
        const link = t.getParent();
        if (color || $isLinkNode(link)) {
          out.push(
            `${t.getTextContent()} ${color ?? ''}${$isLinkNode(link) ? link.getURL() : ''}`,
          );
        }
      }
      at = end;
    }
    return out;
  };
  for (const gc of GC) {
    for (const ids of ORDERS) {
      for (const kind of ['link', 'color'] as const) {
        test(`${kind} (gc ${gc ? 'on' : 'off'}, ids ${ids})`, async () => {
          const t = await setup(() => $getRoot().append($p(LINE)), {gc, ids});
          const [, b, c] = t.peers;
          b.update(() => $give(kind, 'B', 10, 12));
          b.binding.undoManager?.stopCapturing();
          b.update(() => $give(kind, 'B', 13, 14));
          await t.sync();
          t.offline();
          b.undo();
          c.update(() => $give(kind, 'C', 11, 13));
          await t.sync();
          await expectConverged(t.peers);
          expect(t.a.editor.getEditorState().read($valuesAfterK)).toEqual([]);
        });
      }
    }
  }
});
