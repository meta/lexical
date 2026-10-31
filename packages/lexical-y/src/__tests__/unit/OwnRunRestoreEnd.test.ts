/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {Item} from '@y/y';

import {$addMarkID, $getNodeMarkIDs} from '@lexical/mark';
import {ContentFormat} from '@y/y';
import {
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setSelection,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  type Peer,
  setup,
} from '../utils/harness';
import {prepareMarkState as prepare} from '../utils/sizeOps';

// A client types uncommented text inside a word it commented itself, so its
// write restores the comment after that text and relies on the comment's own
// end (the null its comment wrote after the word) to end it. A collaborator
// that has not seen that text deletes the word and then deletes the
// comment's opener and end there, which for it bracket deleted content only,
// so deleting them changes nothing it shows. That second step is simulated
// with raw Yjs deletes (dropCommentItems): it stands for any concurrent
// deletion of that end (a delete next to a run of deleted content used to
// collapse its format items, keeping a bounded number; it keeps them all
// now, D86), and isolates the condition this guards: the
// restore's run losing the end it relied on. Merged, the restore must still
// end where the comment ended, not run on over the rest of the document.
//
// Main writes a restore's own null after the run's end only for runs
// another client opened (rule 5 of Cursor#format), so the cases where the
// writer opened the run itself fail on main: they are expected failures,
// tracked in #9609. #9562 (parked) made them pass but regressed other cases;
// the cases it regressed are the plain tests here (S9-12b, the #9589 tie,
// and OwnCommentGapCollapse.test.ts).

/**
 * Each word of `peer`'s first line, with its comment ids (spaces collapse:
 * the tests assert the line's text too).
 */
function words(peer: Peer): string {
  return peer.read(() =>
    ($block([0]).getAllTextNodes() as TextNode[])
      .flatMap(n => {
        const ids = $getNodeMarkIDs(n as LexicalNode);
        return n
          .getTextContent()
          .split(' ')
          .filter(w => w !== '')
          .map(w => (ids.length > 0 ? `${w}[${ids.join(',')}]` : w));
      })
      .join(' '),
  );
}

/** Delete `peer`'s live format items of comment `id` with raw Yjs deletes. */
function dropCommentItems(peer: Peer, id: string) {
  const doc = peer.doc;
  doc.transact(tr => {
    const walk = (type: {_start: Item | null}) => {
      for (let it = type._start; it !== null; it = it.right) {
        if (
          !it.deleted &&
          it.content instanceof ContentFormat &&
          it.content.key.endsWith(id)
        ) {
          it.delete(tr);
        }
        const content = it.content as {type?: {_start?: Item | null}};
        if (content.type !== undefined && content.type._start !== undefined) {
          walk(content.type as {_start: Item | null});
        }
      }
    };
    walk(doc.get('lexical-y') as unknown as {_start: Item | null});
  });
}

/**
 * Delete `peer`'s first live bold opener of its first line and the next
 * live bold item after it (that run's end) with raw Yjs deletes, as
 * dropCommentItems does for a comment.
 */
function dropFirstBoldRun(peer: Peer) {
  const doc = peer.doc;
  doc.transact(tr => {
    const root = doc.get('lexical-y') as unknown as {_start: Item | null};
    let opener: Item | null = null;
    for (let it = root._start; it !== null; it = it.right) {
      if (
        it.deleted ||
        !(it.content instanceof ContentFormat) ||
        it.content.key !== 'f:bold'
      ) {
        continue;
      }
      if (opener === null) {
        if (it.content.value === true) {
          opener = it;
        }
      } else {
        opener.delete(tr);
        it.delete(tr);
        return;
      }
    }
  });
}

/** Whether each text node of `peer` holding text after "lo" is bold. */
function boldAfterLo(peer: Peer): string {
  return peer.read(() => {
    const out: string[] = [];
    let seen = false;
    for (const n of $getRoot().getAllTextNodes() as TextNode[]) {
      if (seen) {
        out.push(`${n.getTextContent()}${n.hasFormat('bold') ? '*' : ''}`);
      }
      if (n.getTextContent().endsWith('lo')) {
        seen = true;
      }
    }
    return out.join('|');
  });
}

/** Bold the first line from `from` to `to`. */
const $boldIn = (from: number, to: number) => () => {
  const selection = $selectIn([0], from, to);
  selection.format = (selection.anchor.getNode() as TextNode).getFormat();
  selection.formatText('bold');
  $setSelection(null);
};

/** In `peer`'s first line, insert uncommented `text` at offset `off`. */
function $insertPlainAt(off: number, text: string) {
  for (const node of $block([0]).getAllTextNodes() as TextNode[]) {
    if (off > 0 && off < node.getTextContentSize()) {
      const [, tail] = node.splitText(off);
      tail.insertBefore($createTextNode(text));
      return;
    }
    off -= node.getTextContentSize();
  }
  throw new Error(`no text node holds offset ${off} inside it`);
}

describe('@lexical/y a restore of a comment its own client opened', () => {
  for (const ids of [
    [1, 2],
    [2, 1],
  ]) {
    test.fails(
      `ends where the comment ended when a collaborator's delete drops the comment's end (ids ${ids})`,
      async () => {
        const t = await setup(
          () => $getRoot().append($p('aa Kilo bb cc'), $p('tail line')),
          {ids, prepare},
        );
        t.a.update(() => void $addMarkID('c1', $selectIn([0], 3, 7)));
        await t.sync();
        expect(words(t.a)).toBe('aa Kilo[c1] bb cc');
        t.offline();
        // A types uncommented "X" inside its own commented word
        t.a.update(() => {
          const node = ($block([0]).getAllTextNodes() as TextNode[]).find(n =>
            n.getTextContent().startsWith('Kilo'),
          )!;
          const [, tail] = node.splitText(2);
          tail.insertBefore($createTextNode('X'));
        });
        expect(words(t.a)).toBe('aa Ki[c1] X lo[c1] bb cc');
        // B deletes the word, then drops the comment's items around it
        t.b.update(() => void $selectIn([0], 3, 8).removeText());
        dropCommentItems(t.b, 'c1');
        expect(words(t.b)).toBe('aa bb cc');
        await t.sync();
        await expectConverged(t.peers);
        // A's "X" is uncommented, and so is everything after it
        expect(t.a.read(() => $block([0]).getTextContent())).toBe('aa Xbb cc');
        expect(words(t.a)).toBe('aa Xbb cc');
        expect(
          t.a.read(() =>
            ($block([1]).getAllTextNodes() as TextNode[]).some(
              n => $getNodeMarkIDs(n).length > 0,
            ),
          ),
        ).toBe(false);
      },
    );
    // Fails on main (#9609): the comment's run ends with the end its restore
    // after the uncommented text wrote, and rule 5 writes no null for a run
    // its own client opened.
    test.fails(
      `ends where the comment ended when the comment was written with a hole in it (ids ${ids})`,
      async () => {
        const t = await setup(
          () => $getRoot().append($p('aa Kilo bb cc'), $p('tail line')),
          {ids, prepare},
        );
        // One write: the comment, with uncommented "X" inside it, so the
        // comment's end ends the run its restore after "X" opens
        t.a.update(() => {
          $addMarkID('c1', $selectIn([0], 3, 7));
          const node = ($block([0]).getAllTextNodes() as TextNode[]).find(n =>
            n.getTextContent().startsWith('Kilo'),
          )!;
          const [, tail] = node.splitText(2);
          tail.insertBefore($createTextNode('X'));
        });
        await t.sync();
        expect(words(t.a)).toBe('aa Ki[c1] X lo[c1] bb cc');
        t.offline();
        // A types uncommented "Y" inside "lo"
        t.a.update(() => {
          const node = ($block([0]).getAllTextNodes() as TextNode[]).find(
            n => n.getTextContent() === 'lo',
          )!;
          const [, tail] = node.splitText(1);
          tail.insertBefore($createTextNode('Y'));
        });
        expect(words(t.a)).toBe('aa Ki[c1] X l[c1] Y o[c1] bb cc');
        t.b.update(() => void $selectIn([0], 3, 9).removeText());
        dropCommentItems(t.b, 'c1');
        expect(words(t.b)).toBe('aa bb cc');
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.read(() => $block([0]).getTextContent())).toBe('aa Ybb cc');
        expect(words(t.a)).toBe('aa Ybb cc');
      },
    );
    // S9-12: one write of A types uncommented text at two places inside A's
    // own comment, so both of its restores end at the comment's end. Rule 5
    // gives that end one null of A's own (not one per restore: the undo
    // removes them together, and a second one would push the comment's end
    // out of the last items a collaborator's collapse keeps). A undoes the
    // write while B, which has not seen the undo, deletes the rest of the
    // comment and then the text after it.
    test(`S9-12: ends where the comment ended when its author undoes a write with two inserts inside it while a collaborator deletes past its end (ids ${ids})`, async () => {
      const t = await setup(
        () => $getRoot().append($p('aa Kilometer bb cc dd'), $p('tail line')),
        {ids, prepare},
      );
      t.a.update(() => void $addMarkID('c1', $selectIn([0], 3, 12)));
      await t.sync();
      t.a.update(() => {
        $insertPlainAt(9, 'Y');
        $insertPlainAt(6, 'X');
      });
      await t.sync();
      expect(words(t.a)).toBe('aa Kil[c1] X ome[c1] Y ter[c1] bb cc dd');
      t.offline();
      t.a.undo();
      expect(words(t.a)).toBe('aa Kilometer[c1] bb cc dd');
      // B deletes "ter", then " bb"
      t.b.update(() => void $selectIn([0], 11, 14).removeText());
      t.b.update(() => void $selectIn([0], 11, 14).removeText());
      expect(words(t.b)).toBe('aa Kil[c1] X ome[c1] Y cc dd');
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read(() => $block([0]).getTextContent())).toBe(
        'aa Kilome cc dd',
      );
      expect(words(t.a)).toBe('aa Kilome[c1] cc dd');
      expect(
        t.a.read(() =>
          ($block([1]).getAllTextNodes() as TextNode[]).some(
            n => $getNodeMarkIDs(n).length > 0,
          ),
        ),
      ).toBe(false);
    });
    // S9-12b: as S9-12, but A types "X" and "Y" in two writes. Main passes:
    // it writes no null of A's own for A's own run. With #9562 each write put
    // a null of A's own right after the comment's end, B's collapse kept
    // those two nulls (a key's last items) and dropped the end, and the
    // comment ran on once A undid both writes.
    test(`S9-12b: ends where the comment ended when its author undoes two writes inside it while a collaborator deletes past its end (ids ${ids})`, async () => {
      const t = await setup(
        () => $getRoot().append($p('aa Kilometer bb cc dd'), $p('tail line')),
        {ids, prepare},
      );
      t.a.update(() => void $addMarkID('c1', $selectIn([0], 3, 12)));
      await t.sync();
      t.a.update(() => $insertPlainAt(6, 'X'));
      t.a.update(() => $insertPlainAt(10, 'Y'));
      await t.sync();
      expect(words(t.a)).toBe('aa Kil[c1] X ome[c1] Y ter[c1] bb cc dd');
      t.offline();
      t.a.undo();
      t.a.undo();
      expect(words(t.a)).toBe('aa Kilometer[c1] bb cc dd');
      t.b.update(() => void $selectIn([0], 11, 14).removeText());
      t.b.update(() => void $selectIn([0], 11, 14).removeText());
      expect(words(t.b)).toBe('aa Kil[c1] X ome[c1] Y cc dd');
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read(() => $block([0]).getTextContent())).toBe(
        'aa Kilome cc dd',
      );
      expect(words(t.a)).toBe('aa Kilome[c1] cc dd');
    });
    test(`a restore in another client's run keeps its end after that client wrote the value again (ids ${ids})`, async () => {
      // B bolds "Kilo", types plain text, bolds "cc", then undoes all three,
      // while A types plain "X" inside "Kilo": A's restore keeps its end of
      // its own after B's end of "Kilo" (main passes; an earlier version of
      // #9562 took B's later bold opener for a hole and dropped it).
      const t = await setup(
        () => $getRoot().append($p('aa Kilo bb cc dd'), $p('tail line')),
        {ids, prepare},
      );
      t.b.update($boldIn(3, 7));
      await t.sync();
      t.b.update(() => $insertPlainAt(10, ' zz'));
      await t.sync();
      t.b.update($boldIn(14, 16));
      await t.sync();
      t.offline();
      t.b.undo();
      t.b.undo();
      t.b.undo();
      t.a.update(() => $insertPlainAt(5, 'X'));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toBe(
        'paragraph("aa KiX" "lo"{1} " bb cc dd") / paragraph("tail line")',
      );
    });
    test(`a restore in another client's run keeps its end when that run's items are dropped after its client wrote the value again (ids ${ids})`, async () => {
      // As above without the undos: B's bold opener and end of "Kilo" are
      // dropped while A types plain "X" inside it.
      const t = await setup(
        () => $getRoot().append($p('aa Kilo bb cc dd'), $p('tail line')),
        {ids, prepare},
      );
      t.b.update($boldIn(3, 7));
      await t.sync();
      t.b.update(() => $insertPlainAt(10, ' zz'));
      await t.sync();
      t.b.update($boldIn(14, 16));
      await t.sync();
      t.offline();
      t.a.update(() => $insertPlainAt(5, 'X'));
      dropFirstBoldRun(t.b);
      await t.sync();
      await expectConverged(t.peers);
      expect(boldAfterLo(t.a)).toBe(' bb zz |cc*| dd|tail line');
    });
    test.fails(
      `a restore of a run its own client opened keeps its end after that client wrote the value again (ids ${ids})`,
      async () => {
        // A bolds "Kilo", types plain text, bolds "cc", then types plain "X"
        // inside "Kilo" while B drops the bold opener and end of "Kilo".
        const t = await setup(
          () => $getRoot().append($p('aa Kilo bb cc dd'), $p('tail line')),
          {ids, prepare},
        );
        t.a.update($boldIn(3, 7));
        await t.sync();
        t.a.update(() => $insertPlainAt(10, ' zz'));
        await t.sync();
        t.a.update($boldIn(14, 16));
        await t.sync();
        t.offline();
        t.a.update(() => $insertPlainAt(5, 'X'));
        dropFirstBoldRun(t.b);
        await t.sync();
        await expectConverged(t.peers);
        expect(boldAfterLo(t.a)).toBe(' bb zz |cc*| dd|tail line');
      },
    );
    // Fails on main (#9609): with 64 comment ids the undo of Z removes the
    // comments from the untouched "et" (rule 5 writes no null for a restore
    // in a run its own client opened; the one comment id case passes).
    test.fails(
      `a later write's hole is not a run end with 64 comments on the run (ids ${ids})`,
      async () => {
        // Each write puts a null and a restore per comment id.
        const t = await setup(
          () => $getRoot().append($p('aa Kilometer bb cc'), $p('tail line')),
          {ids, prepare},
        );
        const marks = Array.from({length: 64}, (_, i) => `m${i}`);
        t.a.update(() => {
          const selection = $selectIn([0], 3, 12);
          for (const id of marks) {
            $addMarkID(id, selection);
          }
        });
        await t.sync();
        t.b.update(() => $insertPlainAt(10, 'Y'));
        await t.sync();
        t.a.update(() => $insertPlainAt(6, 'X'));
        await t.sync();
        t.a.update(() => $insertPlainAt(9, 'Z'));
        await t.sync();
        t.b.update(() => $insertPlainAt(8, 'Q'));
        await t.sync();
        t.a.undo();
        await t.sync();
        await expectConverged(t.peers);
        expect(
          t.a.read(() =>
            ($block([0]).getAllTextNodes() as TextNode[])
              .map(n => `${n.getTextContent()}:${$getNodeMarkIDs(n).length}`)
              .join('|'),
          ),
        ).toBe('aa :0|Kil:64|X:0|o:64|Q:0|met:64|Y:0|er:64| bb cc:0');
      },
    );
    for (const value of ['comment', 'bold'] as const) {
      test(`a later write's hole is not a run end (${value}, ids ${ids})`, async () => {
        // A's second write inside its own run ("Z") opens a hole with a
        // null of A's; B's restore in front of that hole must not take that
        // null for the run's end (it is followed by A's text and A's
        // restore of the run's value), or A's undo of "Z" leaves B's null
        // ending the run early.
        const t = await setup(
          () => $getRoot().append($p('aa Kilometer bb cc'), $p('tail line')),
          {ids, prepare},
        );
        const shown = (peer: Peer) =>
          value === 'comment'
            ? words(peer)
            : peer.read(() =>
                ($block([0]).getAllTextNodes() as TextNode[])
                  .map(
                    n => n.getTextContent() + (n.hasFormat('bold') ? '*' : ''),
                  )
                  .join('|'),
              );
        t.a.update(() => {
          const selection = $selectIn([0], 3, 12);
          if (value === 'comment') {
            $addMarkID('c1', selection);
          } else {
            selection.formatText('bold');
          }
        });
        await t.sync();
        t.b.update(() => $insertPlainAt(10, 'Y'));
        await t.sync();
        t.a.update(() => $insertPlainAt(6, 'X'));
        await t.sync();
        t.a.update(() => $insertPlainAt(9, 'Z'));
        await t.sync();
        t.b.update(() => $insertPlainAt(8, 'Q'));
        await t.sync();
        t.a.undo();
        await t.sync();
        await expectConverged(t.peers);
        expect(shown(t.a)).toBe(
          value === 'comment'
            ? 'aa Kil[c1] X o[c1] Q met[c1] Y er[c1] bb cc'
            : 'aa |Kil*|X|o*|Q|met*|Y|er*| bb cc',
        );
      });
    }
    // A unbolds part of its own bold run while B bolds text starting at the
    // run's end: main keeps " bb" bold in both id orders. With #9562, A's
    // own-run null and B's opener shared their origins, and with A's id
    // higher Yjs put the null between B's opener and its text (#9589; on
    // main that tie happens where another client bolded the run).
    test(`keeps a collaborator's bold that starts where the author's bold ends (ids ${ids})`, async () => {
      const $bold = (from: number, to: number) => () => {
        const selection = $selectIn([0], from, to);
        selection.format = (selection.anchor.getNode() as TextNode).getFormat();
        selection.formatText('bold');
        $setSelection(null);
      };
      const t = await setup(
        () => $getRoot().append($p('aa Kilo bb cc'), $p('tail line')),
        {ids, prepare},
      );
      t.a.update($bold(3, 7));
      await t.sync();
      t.offline();
      t.a.update($bold(4, 6));
      t.b.update($bold(7, 10));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.describe()).toContain('"o bb"{1}');
    });
    // The author types plain text inside its own bold run while B bolds from
    // inside that run past its end: main keeps B's bold on " bb cc" (with
    // #9562 the same tie lost it for A's higher id, #9589).
    test(`keeps a collaborator's bold that runs past the end of the author's bold while the author types inside it (ids ${ids})`, async () => {
      const $boldAll = (from: number, to: number) => () => {
        for (const n of $selectIn([0], from, to).extract()) {
          if ($isTextNode(n) && !n.hasFormat('bold')) {
            n.toggleFormat('bold');
          }
        }
        $setSelection(null);
      };
      const t = await setup(
        () => $getRoot().append($p('aa Kilo bb cc dd'), $p('tail line')),
        {ids, prepare},
      );
      t.a.update($boldAll(3, 7));
      await t.sync();
      t.offline();
      t.a.update(() => $insertPlainAt(5, 'X'));
      t.b.update($boldAll(5, 13));
      await t.sync();
      await expectConverged(t.peers);
      const shownBold = t.a.read(() =>
        ($block([0]).getAllTextNodes() as TextNode[])
          .map(n =>
            n.hasFormat('bold')
              ? `[${n.getTextContent()}]`
              : n.getTextContent(),
          )
          .join(''),
      );
      expect(shownBold).toBe('aa [Ki]X[lo bb cc] dd');
    });
  }
});

/** Deletes every format item of `peer`'s document whose key names one of `ids`. */
function dropMarkItems(peer: Peer, ids: readonly string[]): void {
  peer.doc.transact(tr => {
    const walk = (type: {_start: Item | null}) => {
      for (let it = type._start; it !== null; it = it.right) {
        if (
          !it.deleted &&
          it.content instanceof ContentFormat &&
          ids.some(id => (it.content as ContentFormat).key.endsWith(id))
        ) {
          it.delete(tr);
        }
        const content = it.content as {type?: {_start?: Item | null}};
        if (content.type !== undefined && content.type._start !== undefined) {
          walk(content.type as {_start: Item | null});
        }
      }
    };
    walk(peer.doc.get('lexical-y') as unknown as {_start: Item | null});
  });
}

describe("@lexical/y a restore inside its own client's comment run, with many comment ids", () => {
  for (const count of [1, 16, 64, 128]) {
    for (const ids of [
      [1, 2],
      [2, 1],
    ]) {
      // Fails on main for every count (#9609: no own null for a run its own
      // client opened). With #9562 it passed up to 64 ids; past 64 structs
      // rule 5 cannot find where the comment change ended (changeEnd's scan
      // is capped, #9603).
      test.fails(
        `ends after the run when a collaborator deletes the word and its comment items (${count} ids, ids ${ids})`,
        async () => {
          const marks = Array.from(
            {length: count},
            (_, i) => `m${i.toString().padStart(3, '0')}`,
          );
          const t = await setup(
            () => $getRoot().append($p('aa Kilometer bb cc'), $p('tail line')),
            {ids, prepare},
          );
          t.a.update(() => {
            const selection = $selectIn([0], 3, 12);
            for (const id of marks) {
              $addMarkID(id, selection);
            }
          });
          await t.sync();
          t.offline();
          t.a.update(() => $insertPlainAt(6, 'X'));
          t.b.update(() => void $selectIn([0], 3, 13).removeText());
          dropMarkItems(t.b, marks);
          await t.sync();
          await expectConverged(t.peers);
          expect(t.a.read(() => $getRoot().getTextContent())).toBe(
            'aa Xbb cc\n\ntail line',
          );
          expect(
            t.a.read(() =>
              $getRoot()
                .getAllTextNodes()
                .flatMap(node => $getNodeMarkIDs(node)),
            ),
          ).toEqual([]);
        },
      );
    }
  }
});
