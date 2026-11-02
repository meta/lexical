/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $getRoot,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $p,
  $selectIn,
  expectConverged,
  flush,
  freshReader,
  type Peer,
  setup,
} from '../utils/harness';

// An update that throws, whether onError rethrows the error (the app catches
// it) or only reports it, changes nothing on any client, and every later
// edit is written: each editor shows what a fresh reader of the document
// shows. The binding writes every change the editor commits, also when it
// was not notified of the commit that made it or when an update left a
// pending state behind.

type OnError = 'rethrows' | 'reports';
const ON_ERROR: OnError[] = ['rethrows', 'reports'];
const SEEDS = Number(process.env.LEXICAL_Y_SEEDS || 25);

const LINE = 't1z t2z t3z t4z t5z t6z t7z t8z t9z';
const $doc = () => $getRoot().append($p(LINE), $p('tail line'));

/** Selects `text` in the first paragraph (the first occurrence). */
function $selectWords(text: string) {
  const at = $block([0]).getTextContent().indexOf(text);
  if (at < 0) {
    throw new Error(`not found: ${text}`);
  }
  return $selectIn([0], at, at + text.length);
}

/**
 * Runs an update that throws after `change` (or in `change`, or in what it
 * makes Lexical run, with `throws: false`).
 */
function failUpdate(
  peer: Peer,
  onError: OnError,
  change: () => void = () => {},
  discrete = true,
  throws = true,
) {
  const editor = peer.editor;
  const handler = editor._onError;
  if (onError === 'reports') {
    editor._onError = error => void peer.errors.push(error);
  }
  try {
    editor.update(
      () => {
        change();
        if (throws) {
          throw new Error('app bug');
        }
      },
      discrete ? {discrete} : undefined,
    );
    expect(onError).toBe('reports');
  } catch (error) {
    // The app catches what onError rethrows.
    expect(onError).toBe('rethrows');
    expect((error as Error).message).toBe('app bug');
  } finally {
    editor._onError = handler;
  }
  expect(peer.errors.map(error => (error as Error).message)).toEqual([
    'app bug',
  ]);
  peer.errors.length = 0;
}

describe.each(ON_ERROR)('an update that throws, onError %s', onError => {
  test('then a collaborator undoes a format on text another deleted, then the next edit (S7-30)', async () => {
    const t = await setup($doc, {ids: [1, 2, 3]});
    t.offline();
    t.b.update(() => void $selectWords('t3z').formatText('bold'));
    t.c.update(() => void $selectWords('t3z t4z t5z').removeText());
    await t.sync();
    failUpdate(t.a, onError);
    await t.sync();
    // A reads a change that shows nothing new there.
    t.b.undo();
    await t.sync();
    t.a.update(() => void $selectWords('t7z t8z').removeText());
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("t1z t2z  t6z  t9z") / paragraph("tail line")',
    );
  });

  test('that changed text: nobody gets the change, and the next edit is written', async () => {
    const t = await setup($doc);
    failUpdate(t.a, onError, () => {
      ($block([0]).getFirstChildOrThrow() as TextNode).setTextContent(
        'CHANGED',
      );
    });
    t.b.update(() => void $selectIn([1], 9).insertText('!'));
    t.a.update(() => void $selectIn([1], 0).insertText('>'));
    await t.sync();
    await expectConverged(
      t.peers,
      `paragraph("${LINE}") / paragraph(">tail line!")`,
    );
  });

  test('in updates batched as browsers commit them, then concurrent deletes (S7-34)', async () => {
    const t = await setup($doc, {ids: [1, 2, 3]});
    t.a.editor.update(() => void $selectWords('t1z').removeText());
    await flush();
    failUpdate(
      t.a,
      onError,
      () => void $selectWords('t2z').formatText('italic'),
      false,
    );
    await flush();
    t.offline();
    t.a.editor.update(() => void $selectWords('t6z t7z').removeText());
    t.c.editor.update(() => void $selectWords('t6z t7z t8z').removeText());
    await flush();
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph(" t2z t3z t4z t5z  t9z") / paragraph("tail line")',
    );
  });

  test('in a transform of a reader, on text a collaborator typed', async () => {
    const t = await setup($doc);
    t.b.editor.registerNodeTransform(TextNode, node => {
      if (node.getTextContent().includes('BOOM')) {
        throw new Error('app bug');
      }
    });
    t.a.update(() => void $selectIn([0], 3).insertText(' BOOM'));
    await t.sync();
    // B's edit of that text runs the transform, which throws.
    failUpdate(
      t.b,
      onError,
      () => void $selectIn([0], 3).insertText('!'),
      true,
      false,
    );
    t.a.update(() => void $selectIn([1], 9).insertText(' fromA'));
    t.b.update(() => void $selectIn([1], 0).insertText('fromB '));
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("t1z BOOM t2z t3z t4z t5z t6z t7z t8z t9z") / paragraph("fromB tail line fromA")',
    );
  });
});

/**
 * An edit at `word` in the first paragraph, discrete or batched (committed in
 * a microtask, as browsers commit); none where `word` is gone by then.
 */
function edit(
  peer: Peer,
  batched: boolean,
  word: string,
  $edit: (at: number) => void,
) {
  const $run = () => {
    const at = $block([0]).getTextContent().indexOf(word);
    if (at >= 0) {
      $edit(at);
    }
  };
  if (batched) {
    peer.editor.update($run);
  } else {
    peer.update($run);
  }
}

/** A seeded random number generator (mulberry32). */
function random(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return n => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), s | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * n);
  };
}

describe('the invariant, over random edits, batched or not, with updates that throw', () => {
  test('editors show the document and every later edit is written', async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = random(seed * 7919);
      const t = await setup($doc, {ids: [1, 2, 3]});
      const log: string[] = [];
      for (let step = 0; step < 12; step++) {
        const peer = t.peers[rnd(3)];
        const words = peer.read(() =>
          $block([0]).getTextContent().match(/t\d+z/g),
        );
        const word = words === null ? null : words[rnd(words.length)];
        const kind = rnd(7);
        log.push(`${peer.doc.clientID}:${kind}:${word}`);
        if (kind === 0 || kind === 1) {
          // Rethrown or reported, discrete or batched, before or after a
          // change.
          failUpdate(
            peer,
            ON_ERROR[rnd(2)],
            rnd(2) === 0 || word === null
              ? undefined
              : () => void $selectWords(word).insertText('X'),
            rnd(2) === 0,
          );
        } else if (kind === 2 && word !== null) {
          edit(peer, rnd(2) === 0, word, at => {
            $selectIn([0], at, at + word.length).removeText();
          });
        } else if (kind === 3 && word !== null) {
          edit(peer, rnd(2) === 0, word, at => {
            $selectIn([0], at, at + word.length).formatText('bold');
          });
        } else if (kind === 4 && word !== null) {
          edit(peer, rnd(2) === 0, word, at => {
            $selectIn([0], at + word.length).insertText(` t${10 + step}z`);
          });
        } else if (kind === 5) {
          peer.undo();
        } else {
          peer.online = false;
        }
        if (rnd(3) === 0) {
          await t.sync();
        } else if (rnd(2) === 0) {
          await flush();
        }
      }
      await t.sync();
      try {
        await expectConverged(t.peers);
        // The next edits are written.
        for (const peer of t.peers) {
          peer.update(() =>
            $selectIn([1], 0).insertText(`${peer.doc.clientID}>`),
          );
        }
        await t.sync();
        await expectConverged(t.peers);
        // Each peer's, once.
        const fresh = await freshReader(t.a);
        const tail = fresh.describe().match(/paragraph\("(.*)tail line"\)$/);
        expect(tail && tail[1].match(/\d>/g)?.sort()).toEqual([
          '1>',
          '2>',
          '3>',
        ]);
      } catch (error) {
        throw new Error(
          `seed ${seed}: ${log.join(' ')}\n${error}\n` +
            t.peers
              .map(p => `${p.describe()} ${p.errors} ${p.warnings}`)
              .join('\n'),
        );
      }
    }
  }, 60_000);
});

/** The pending state a core that kept a failed update's state left. */
function leavePendingState(editor: LexicalEditor) {
  const committed = editor.getEditorState();
  const Pending = committed.constructor as new (
    nodeMap: Map<NodeKey, LexicalNode>,
  ) => EditorState;
  editor._pendingEditorState = new Pending(new Map(committed._nodeMap));
}

describe('the binding writes every committed change', () => {
  test('a pending state with nothing to commit is committed before a remote read, which then does not tag the next edit', async () => {
    const t = await setup($doc, {ids: [1, 2, 3]});
    t.offline();
    t.b.update(() => void $selectWords('t3z').formatText('bold'));
    t.c.update(() => void $selectWords('t3z t4z t5z').removeText());
    await t.sync();
    leavePendingState(t.a.editor);
    t.b.undo();
    t.a.update(() => void $selectWords('t7z t8z').removeText());
    await t.sync();
    await expectConverged(
      t.peers,
      'paragraph("t1z t2z  t6z  t9z") / paragraph("tail line")',
    );
  });

  // Open, #9514 (not caused by an update that throws): Lexical stops
  // notifying a commit's update listeners when one of them throws, so a
  // binding registered after the listener that threw never writes that
  // commit.
  test.fails(
    "a commit whose update listeners stopped before the binding's is not written (#9514)",
    async () => {
      let armed = false;
      const t = await setup($doc, {
        prepare: (editor: LexicalEditor) => {
          editor.registerUpdateListener(() => {
            if (armed) {
              armed = false;
              throw new Error('listener bug');
            }
          });
        },
      });
      armed = true;
      expect(() =>
        t.a.update(() => void $selectWords('t2z').removeText()),
      ).toThrow('listener bug');
      t.a.update(() => void $selectIn([1], 9).insertText('!'));
      await t.sync();
      await expectConverged(
        t.peers,
        'paragraph("t1z  t3z t4z t5z t6z t7z t8z t9z") / paragraph("tail line!")',
      );
    },
  );
});
