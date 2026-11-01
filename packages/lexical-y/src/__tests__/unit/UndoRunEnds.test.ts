/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// An undo of text typed inside a run of another value, and the run ends that
// text was written with. F types plain " mid" into bold "one two": F's write
// ends the bold before " mid" and gives it back after it. E, having seen it,
// types plain " plain" right after "one": that text lands after F's null and
// writes no item of its own. F's concurrent undo deletes F's null and F's
// restore with " mid", and " plain" turns bold on every client (and a
// comment covers it the same way). A delete of " mid" by hand keeps them.
//
// The cases marked test.fails fail on main, each tracked by the issue named
// above it: #9681 (an undo of text typed inside a run deletes that text's
// run ends; D74) or #9682 (an undo of a run's value leaves it after a
// restore the undo has seen; D64, documented in y.md's Limits, Undo).
// #9561 (an undo keeps the run ends of the text it removes) fixes both and
// is parked as a draft: with it, a collaborator's undo of text typed inside
// a run, concurrent with the undo of that run's value, gives the value back
// to the rest of the run (#9593).

import {$addMarkID, $getNodeMarkIDs, $removeMarkID} from '@lexical/mark';
import {$patchStyleText} from '@lexical/selection';
import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setCompositionKey,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $block,
  $locateIn,
  $selectIn,
  expectConverged,
  flush,
  type Peer,
  type Setup,
  setup,
} from '../utils/harness';
import {prepareMarkState} from '../utils/sizeOps';

const ORDERS = [
  [1, 2, 3],
  [3, 2, 1],
  [2, 3, 1],
  [1, 3, 2],
  [2, 1, 3],
  [3, 1, 2],
];

/** Each line's text nodes: text, `*` when bold, `[ids]` when commented. */
function $show(): string {
  const node = (n: LexicalNode) => {
    if (!$isTextNode(n)) {
      return n.getType();
    }
    const ids = $getNodeMarkIDs(n);
    return (
      n.getTextContent() +
      (n.hasFormat('bold') ? '*' : '') +
      (ids.length > 0 ? `[${ids.join(',')}]` : '')
    );
  };
  return $getRoot()
    .getChildren()
    .map(line => (line as ElementNode).getAllTextNodes().map(node).join('|'))
    .join(' / ');
}

const $line = (i = 0) => $getRoot().getChildAtIndex(i) as ElementNode;
/** The first text node of the first line. */
const $first = () => $line().getFirstChildOrThrow() as TextNode;
const $find = (text: string) =>
  $getRoot()
    .getAllTextNodes()
    .find(n => n.getTextContent() === text)!;

/** "one two" with `value` on it, as one text node. */
async function start(ids: number[], value: 'bold' | 'comment') {
  const t = await setup(
    () => {
      const text = $createTextNode('one two');
      if (value === 'bold') {
        text.toggleFormat('bold');
      }
      $getRoot().append($createParagraphNode().append(text));
    },
    {ids},
  );
  if (value === 'comment') {
    t.a.update(() => void $addMarkID('c1', $first().select(0, 7)));
    await t.sync();
  }
  for (const peer of t.peers) {
    peer.binding.undoManager?.clear();
  }
  return t;
}

/**
 * F (the third peer) types plain " mid" after "one"; E (the second), having
 * seen it, types plain " plain" right after "one" while F undoes.
 */
async function race(t: Setup, undo: 'undo' | 'delete' | 'none') {
  const [, e, f] = t.peers;
  f.update(() => {
    const [one] = $first().splitText(3);
    one.insertAfter($createTextNode(' mid'));
  });
  await t.sync();
  t.offline();
  e.update(() => void $find('one').insertAfter($createTextNode(' plain')));
  if (undo === 'undo') {
    f.undo();
  } else if (undo === 'delete') {
    f.update(() => $find(' mid').remove());
  }
  await t.sync();
  await expectConverged(t.peers);
  return t.a.read($show);
}

describe('an undo keeps the run ends of the text it removes', () => {
  // #9681: an undo of text typed inside a run deletes its run ends.
  test.fails.each(ORDERS)(
    'bold: text typed after its null stays plain (ids %i %i %i)',
    async (...ids) => {
      const t = await start(ids, 'bold');
      expect(await race(t, 'undo')).toBe('one*| plain| two*');
    },
  );

  // #9681: an undo of text typed inside a run deletes its run ends.
  test.fails.each(ORDERS)(
    'comment: text typed after its null stays uncommented (ids %i %i %i)',
    async (...ids) => {
      const t = await start(ids, 'comment');
      expect(await race(t, 'undo')).toBe('one[c1]| plain| two[c1]');
    },
  );

  test.each([[[1, 2, 3]], [[3, 2, 1]]])(
    'controls: no undo, or a delete by hand (ids %j)',
    async ids => {
      expect(await race(await start(ids, 'bold'), 'none')).toBe(
        'one*| plain mid| two*',
      );
      expect(await race(await start(ids, 'bold'), 'delete')).toBe(
        'one*| plain| two*',
      );
    },
  );

  // #9681: an undo of text typed inside a run deletes its run ends.
  test.fails.each(ORDERS)(
    'a paragraph inserted into a bold run split by Enter (ids %i %i %i)',
    async (...ids) => {
      const t = await setup(
        () => {
          const text = $createTextNode('one two');
          text.toggleFormat('bold');
          $getRoot().append($createParagraphNode().append(text));
        },
        {ids},
      );
      t.a.update(() => void $first().select(3, 3).insertParagraph());
      await t.sync();
      for (const peer of t.peers) {
        peer.binding.undoManager?.clear();
      }
      const [, e, f] = t.peers;
      f.update(
        () =>
          void $line().insertAfter(
            $createParagraphNode().append($createTextNode(' mid')),
          ),
      );
      await t.sync();
      t.offline();
      e.update(
        () =>
          void $line().insertAfter(
            $createParagraphNode().append($createTextNode(' plain')),
          ),
      );
      f.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('one* /  plain /  two*');
    },
  );

  // #9681: an undo of text typed inside a run deletes its run ends.
  test.fails.each(ORDERS)(
    'bold text typed into plain text: text typed before it inside its run stays bold (ids %i %i %i)',
    async (...ids) => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two')),
          ),
        {ids},
      );
      const [, e, f] = t.peers;
      f.update(() => {
        const [one] = $first().splitText(3);
        const mid = $createTextNode(' MID');
        mid.toggleFormat('bold');
        one.insertAfter(mid);
      });
      await t.sync();
      t.offline();
      e.update(() => {
        const bold = $createTextNode(' B');
        bold.toggleFormat('bold');
        $find(' MID').insertBefore(bold);
      });
      f.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('one| B*| two');
    },
  );

  // #9681: an undo of text typed inside a run deletes its run ends.
  test.fails('a redo puts the text back with its own value', async () => {
    const t = await start([1, 2, 3], 'bold');
    expect(await race(t, 'undo')).toBe('one*| plain| two*');
    const [, , f] = t.peers;
    f.binding.redo();
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.read($show)).toBe('one*| plain mid| two*');
  });

  test('typing and undoing at one place does not grow the run ends', async () => {
    const t = await start([1, 2, 3], 'bold');
    const [, , f] = t.peers;
    const live = (peer: Peer) => {
      const root = peer.doc.get('lexical-y') as unknown as {
        _start: Y.Item | null;
      };
      let n = 0;
      for (let it = root._start; it !== null; it = it.right as Y.Item | null) {
        if (!it.deleted && it.content instanceof Y.ContentFormat) {
          n++;
        }
      }
      return n;
    };
    const counts: number[] = [];
    for (let i = 0; i < 10; i++) {
      f.update(() => {
        const first = $first();
        const one =
          first.getTextContent() === 'one' ? first : first.splitText(3)[0];
        one.insertAfter($createTextNode(' mid'));
      });
      await t.sync();
      f.undo();
      await t.sync();
      counts.push(live(t.a));
    }
    await expectConverged(t.peers);
    expect(t.a.read($show)).toBe('one two*');
    expect(new Set(counts.slice(1)).size).toBe(1);
  });
});

// The pair of run ends a delete (and, with #9561, an undo) leaves of text
// typed inside a bold run gives the content after it the value the run had:
// an undo of that bold must not leave the content after the pair bold.
describe('an undo of the run such run ends restate', () => {
  for (const how of ['undo', 'delete'] as const) {
    // #9682 for the delete: the delete keeps F's run ends, and A's undo of
    // the bold leaves it after F's restore.
    (how === 'delete' ? test.fails : test).each(ORDERS)(
      `F types " mid" into A's bold and ${how}s it; A undoes the bold, redoes it, undoes it (ids %i %i %i)`,
      async (...ids) => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('one two')),
            ),
          {ids},
        );
        const [a, , f] = t.peers;
        a.update(() => void $first().select(0, 7).formatText('bold'));
        await t.sync();
        f.update(() => {
          const [one] = $first().splitText(3);
          one.insertAfter($createTextNode(' mid'));
        });
        await t.sync();
        if (how === 'undo') {
          f.undo();
        } else {
          f.update(() => $find(' mid').remove());
        }
        await t.sync();
        const steps: [() => void, string][] = [
          [() => a.undo(), 'one two'],
          [() => a.binding.redo(), 'one two*'],
          [() => a.undo(), 'one two'],
        ];
        for (const [step, expected] of steps) {
          step();
          await t.sync();
          await expectConverged(t.peers);
          expect(t.a.read($show).replace(/\|/g, '')).toBe(expected);
        }
      },
    );
  }
});

describe('undo run ends, more orders of events', () => {
  // #9681: an undo of text typed inside a run deletes its run ends.
  test.fails.each(ORDERS)(
    "F has seen E's text when it undoes; then A undoes the bold (ids %i %i %i)",
    async (...ids) => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two')),
          ),
        {ids},
      );
      const [a, e, f] = t.peers;
      a.update(() => void $first().select(0, 7).formatText('bold'));
      await t.sync();
      f.update(() => {
        const [one] = $first().splitText(3);
        one.insertAfter($createTextNode(' mid'));
      });
      await t.sync();
      e.update(() => void $find('one').insertAfter($createTextNode(' plain')));
      await t.sync();
      f.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('one*| plain| two*');
      a.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show).replace(/\|/g, '')).toBe('one plain two');
      a.binding.redo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('one*| plain| two*');
    },
  );

  test('typing and undoing text of another style each time at one place stays bounded', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('one two')),
        ),
      {ids: [1, 2]},
    );
    const counts: number[] = [];
    for (let i = 0; i < 30; i++) {
      t.a.update(() => {
        const first = $first();
        const one =
          first.getTextContent() === 'one' ? first : first.splitText(3)[0];
        one.insertAfter(
          $createTextNode(' mid').setStyle(`color: rgb(${i}, 0, 0)`),
        );
      });
      await t.sync();
      t.a.undo();
      await t.sync();
      const root = t.b.doc.get('lexical-y') as unknown as {
        _start: Y.Item | null;
      };
      let n = 0;
      for (let it = root._start; it !== null; it = it.right as Y.Item | null) {
        if (!it.deleted && it.content instanceof Y.ContentFormat) {
          n++;
        }
      }
      counts.push(n);
    }
    await expectConverged(t.peers);
    expect(t.a.read($show)).toBe('one two');
    expect(Math.max(...counts.slice(10))).toBeLessThanOrEqual(
      Math.max(...counts.slice(0, 10)),
    );
  });

  test('a stack listener that undoes again does not interleave the steps', async () => {
    const t = await setup(
      () =>
        $getRoot().append($createParagraphNode().append($createTextNode('x'))),
      {ids: [1, 2]},
    );
    const um = t.a.binding.undoManager!;
    for (const ch of ['a', 'b']) {
      t.a.update(
        () =>
          void $first()
            .select(1 + (ch === 'b' ? 1 : 0), 1 + (ch === 'b' ? 1 : 0))
            .insertText(ch),
      );
      um.stopCapturing();
    }
    let once = true;
    const listener = ({origin}: {origin: unknown}) => {
      if (once && origin === um) {
        once = false;
        t.a.binding.undo();
      }
    };
    um.on('stack-item-added', listener);
    t.a.undo();
    um.off('stack-item-added', listener);
    expect(t.a.read(() => $getRoot().getTextContent())).toBe('xa');
    expect([um.undoStack.length, um.redoStack.length]).toEqual([1, 1]);
    t.a.binding.redo();
    expect(t.a.read(() => $getRoot().getTextContent())).toBe('xab');
  });
  test('a stack listener that throws leaves both stacks as they were recorded', async () => {
    const t = await setup(
      () =>
        $getRoot().append($createParagraphNode().append($createTextNode('x'))),
      {ids: [1, 2]},
    );
    const um = t.a.binding.undoManager!;
    for (const at of [1, 2]) {
      t.a.update(
        () =>
          void $first()
            .select(at, at)
            .insertText(at === 1 ? 'a' : 'b'),
      );
      um.stopCapturing();
    }
    t.a.undo();
    const listener = () => {
      throw new Error('listener');
    };
    um.on('stack-item-popped', listener);
    try {
      t.a.undo();
    } catch (_e) {
      // The listener's error.
    }
    um.off('stack-item-popped', listener);
    expect(t.a.read(() => $getRoot().getTextContent())).toBe('x');
    expect([um.undoStack.length, um.redoStack.length]).toEqual([0, 2]);
  });
  // #9681: an undo of text typed inside a run deletes its run ends.
  test.fails.each([[[1, 2, 3, 4]], [[4, 3, 2, 1]]])(
    "text a third peer typed inside the collaborator's text stays plain too (ids %j)",
    async ids => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two')),
          ),
        {ids},
      );
      const [a, e, f, g] = t.peers;
      a.update(() => void $first().select(0, 7).formatText('bold'));
      await t.sync();
      f.update(() => {
        const [one] = $first().splitText(3);
        one.insertAfter($createTextNode(' mid'));
      });
      await t.sync();
      e.update(() => void $find('one').insertAfter($createTextNode(' plain')));
      await t.sync();
      g.update(() => {
        const text = $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent().includes('plain'))!;
        const at = text.getTextContent().indexOf('plain') + 2;
        text.select(at, at).insertText(' NEST');
      });
      await t.sync();
      f.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('one*| pl NESTain| two*');
      a.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show).replace(/\|/g, '')).toBe('one pl NESTain two');
    },
  );

  /** A bolds "one two"; F types " mid" inside and undoes it. */
  async function boldAfterUndoneWord() {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('one two')),
        ),
      {ids: [1, 2, 3]},
    );
    const [a, , f] = t.peers;
    a.update(() => void $first().select(0, 7).formatText('bold'));
    await t.sync();
    f.update(() => {
      const [one] = $first().splitText(3);
      one.insertAfter($createTextNode(' mid'));
    });
    await t.sync();
    f.undo();
    await t.sync();
    return t;
  }
  const $plain = () => $show().replace(/\|/g, '');

  test('the bold ends where its undo ends it also when a listener clears the history', async () => {
    const t = await boldAfterUndoneWord();
    const um = t.a.binding.undoManager!;
    const clear = () => um.clear(false, true);
    um.on('stack-item-popped', clear);
    t.a.undo();
    um.off('stack-item-popped', clear);
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.read($plain)).toBe('one two');
  });

  test('a listener of the follow-up write that throws leaves it undone with its step', async () => {
    const t = await boldAfterUndoneWord();
    const listener = (tr: Y.Transaction) => {
      if ((tr.origin as {runEnd?: boolean} | null)?.runEnd === true) {
        throw new Error('listener');
      }
    };
    t.a.doc.on('afterTransaction', listener);
    try {
      t.a.undo();
    } catch (_e) {
      // The listener's error.
    }
    t.a.doc.off('afterTransaction', listener);
    expect(t.a.read($plain)).toBe('one two');
    t.a.binding.redo();
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.read($plain)).toBe('one two*');
  });

  test('an undo asked for while a redo finishes its follow-up writes is refused', async () => {
    const t = await boldAfterUndoneWord();
    t.a.undo();
    let asked: boolean | null = null;
    const listener = () => {
      if (asked === null) {
        asked = t.a.binding.undo();
      }
    };
    t.a.doc.on('afterTransaction', listener);
    t.a.binding.redo();
    t.a.doc.off('afterTransaction', listener);
    expect(asked).toBe(false);
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.read($plain)).toBe('one two*');
    t.a.undo();
    await t.sync();
    expect(t.a.read($plain)).toBe('one two');
  });
  test('the bold ends where its undo ends it also when a stack listener throws', async () => {
    const t = await boldAfterUndoneWord();
    const um = t.a.binding.undoManager!;
    const listener = ({origin}: {origin: unknown}) => {
      if (origin === um) {
        throw new Error('listener');
      }
    };
    um.on('stack-item-added', listener);
    expect(() => t.a.undo()).toThrow('listener');
    um.off('stack-item-added', listener);
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.read($plain)).toBe('one two');
  });
  test.each(ORDERS)(
    "a format change's closer next to the undone text ends its own value (ids %i %i %i)",
    async (...ids) => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two three')),
          ),
        {ids},
      );
      const [a, b, c] = t.peers;
      c.update(() => void $first().select(0, 3).formatText('bold'));
      await t.sync();
      c.update(() => {
        const two = $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent().startsWith(' two'))!;
        const selection = two.select(1, 4);
        // The selection's own format is the one it had at "one" (bold).
        selection.format = 0;
        selection.formatText('bold');
      });
      await t.sync();
      b.update(() => {
        $find(' ').remove();
      });
      await t.sync();
      a.update(() => {
        const one = $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent().startsWith('one'))!;
        one.select(3, 3).insertText(' x');
      });
      await t.sync();
      expect(t.a.read($show)).toBe('one*| x|two*| three');
      a.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show).replace('one*|two*', 'onetwo*')).toBe(
        'onetwo*| three',
      );
    },
  );

  // #9681: an undo of text typed inside a run deletes its run ends.
  test.fails.each(ORDERS)(
    'the end a kept restore relies on stays ended when a collaborator deletes the run (ids %i %i %i)',
    async (...ids) => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two three')),
          ),
        {ids},
      );
      const [b, h, d] = t.peers;
      b.update(() => void $first().select(4, 7).formatText('bold'));
      await t.sync();
      h.update(() => void $find('two').select(1, 1).insertText(' x'));
      await t.sync();
      expect(t.a.read($show)).toBe('one |t*| x|wo*| three');
      h.undo();
      await t.sync();
      // H's restore after " x" stays (with #9561), and so does the
      // null H's write put right after B's closer, which that restore relies
      // on: a later delete leaves it (and, before D86, a collapse of B's run
      // ends by that delete did too).
      const root = h.doc.get('lexical-y') as unknown as {
        _start: Y.Item | null;
      };
      const hNulls: Y.Item[] = [];
      for (let it = root._start; it !== null; it = it.right as Y.Item | null) {
        if (
          !it.deleted &&
          it.id.client === h.doc.clientID &&
          it.content instanceof Y.ContentFormat &&
          it.content.value === null
        ) {
          hNulls.push(it);
        }
      }
      expect(hNulls.length).toBe(2);
      d.update(() => void $find('two').select(0, 3).removeText());
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('one  three');
    },
  );
  test.each([
    [1, 2],
    [2, 1],
  ])(
    "a comment's ends that a collaborator's deletes drop do not come back with an undo of text typed inside it (ids %i %i)",
    async (...ids) => {
      // A comments three words and, offline, types "X" inside the middle one
      // and undoes it; B deletes the four words one by one, which collapsed
      // the comment's opener and end away before D86 (a delete now keeps
      // them). The run ends A's undo keeps rely
      // on that end (the null A's write put after it, rule 5 of
      // Cursor#format, needs #9562): without it the comment covered the rest
      // of the document.
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('aa w0 w1 Kilo w3 bb cc'),
            ),
            $createParagraphNode().append($createTextNode('tail line')),
          ),
        {ids, prepare: prepareMarkState},
      );
      const [a, b] = t.peers;
      const text = (peer: Peer) =>
        peer.read(() => $block([0]).getTextContent());
      for (const [word, id] of [
        ['w0', 'c0'],
        ['Kilo', 'c1'],
        ['w3', 'c3'],
      ]) {
        const i = text(a).indexOf(word);
        a.update(() => void $addMarkID(id, $selectIn([0], i, i + word.length)));
        a.binding.undoManager!.stopCapturing();
      }
      await t.sync();
      t.offline();
      a.update(() => {
        const kilo = $find('Kilo');
        const [, tail] = kilo.splitText(2);
        tail.insertBefore($createTextNode('X'));
      });
      a.undo();
      for (const word of ['w0', 'w1', 'Kilo', 'w3']) {
        const i = text(b).indexOf(word + ' ');
        b.update(
          () => void $selectIn([0], i, i + word.length + 1).removeText(),
        );
        b.binding.undoManager!.stopCapturing();
      }
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('aa bb cc / tail line');
    },
  );

  test.each(
    ORDERS.flatMap(ids => [
      ['bold', ...ids],
      ['comment', ...ids],
    ]) as ['bold' | 'comment', number, number, number][],
  )(
    "an undo while a composition holds a collaborator's %s keeps an offline peer's text in it (ids %i %i %i)",
    async (value, ...ids) => {
      const $on = (selection: ReturnType<typeof $selectIn>, on: boolean) => {
        if (value === 'bold') {
          selection.format = on ? 0 : 1;
          selection.formatText('bold');
        } else if (on) {
          $addMarkID('c1', selection);
        } else {
          $removeMarkID('c1', selection);
        }
      };
      const $has = (node: TextNode) =>
        value === 'bold'
          ? node.hasFormat('bold')
          : $getNodeMarkIDs(node).includes('c1');
      // "one" and the odd digits marked: "one0123456 two three".
      const t = await setup(
        () => {
          const prefix = $createTextNode('one');
          const line = $createParagraphNode().append(prefix);
          for (let i = 0; i < 7; i++) {
            const digit = $createTextNode(String(i));
            if (value === 'bold' && i % 2 === 1) {
              digit.toggleFormat('bold');
            }
            line.append(digit);
          }
          line.append($createTextNode(' two three'));
          $getRoot().append(line);
          if (value === 'bold') {
            prefix.toggleFormat('bold');
          } else {
            $addMarkID('c1', $selectIn([0], 0, 3));
            for (let i = 1; i < 7; i += 2) {
              $addMarkID('c1', $selectIn([0], 3 + i, 4 + i));
            }
          }
        },
        {ids, prepare: prepareMarkState},
      );
      const [a, b, c] = t.peers;
      // C, offline, types "T" in marked "1": it takes the value there and
      // writes no format item.
      c.online = false;
      c.update(() => {
        const one = $getRoot()
          .getAllTextNodes()
          .find(n => n.getTextContent() === '1')!;
        one.spliceText(1, 0, 'T');
      });
      b.update(() => $on($selectIn([0], 0, 3), false));
      await flush();
      // A composes "Y" after the digits.
      a.update(() => {
        const [node, offset] = $locateIn($block([0]), 10);
        node.select(offset, offset);
        $setCompositionKey(node.getKey());
        node.spliceText(offset, 0, 'Y', true);
      });
      await flush();
      b.update(() => void $selectIn([0], 3, 10).removeText());
      await flush();
      // B's format of "one" comes to A while it composes: held back.
      b.update(() => $on($selectIn([0], 0, 3), true));
      await flush();
      expect(
        (a.binding as unknown as {state: {hidden: unknown}}).state.hidden,
      ).not.toBeNull();
      expect(a.binding.undo()).toBe(true);
      a.update(() => $setCompositionKey(null));
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read(() => $getRoot().getTextContent())).toBe(
        'oneT two three',
      );
      expect(
        t.a.read(() =>
          $getRoot()
            .getAllTextNodes()
            .filter($has)
            .map(n => n.getTextContent())
            .join(''),
        ),
      ).toContain('T');
    },
  );
  // #9682: an undo of a run's value leaves it after a restore it has seen.
  test.fails.each(
    ORDERS.flatMap(ids => [
      ['after " mid"', ...ids],
      ['before " two"', ...ids],
    ]) as [string, number, number, number][],
  )(
    "text another peer typed in the run's value %s keeps it when the run is undone (ids %i %i %i)",
    async (where, ...ids) => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two')),
          ),
        {ids},
      );
      const [a, f, e] = t.peers;
      const $italic = () => $getRoot().getAllTextNodes();
      a.update(() => {
        const selection = $first().select(0, 7);
        selection.format = 0;
        selection.formatText('italic');
      });
      await t.sync();
      f.update(() => {
        const selection = $first().select(3, 3);
        selection.format = 0;
        selection.insertText(' mid');
      });
      await t.sync();
      // E types italic " PEER" right after F's plain " mid" (after F's item
      // that gives the italic back), or right before " two".
      e.update(() => {
        const nodes = $italic();
        const mid = nodes.find(n => n.getTextContent() === ' mid')!;
        const two = nodes.find(n => n.getTextContent() === ' two')!;
        const selection =
          where === 'after " mid"' ? mid.select(4, 4) : two.select(0, 0);
        selection.format = 2;
        selection.insertText(' PEER');
      });
      await t.sync();
      f.update(() => void $find(' mid').remove());
      await t.sync();
      a.undo();
      await t.sync();
      await expectConverged(t.peers);
      const $shown = () =>
        $getRoot()
          .getAllTextNodes()
          .map(n => n.getTextContent() + (n.hasFormat('italic') ? '/' : ''))
          .join('|');
      expect(t.a.read($shown)).toBe('one| PEER/| two');
    },
  );
  test.each(ORDERS)(
    "an undo keeps the restore its write needs when a collaborator's undone text inside left run ends (ids %i %i %i)",
    async (...ids) => {
      // A types plain " mid" into bold "one two" (a null before it, a
      // restore after it). B types bold "X" inside " mid" (an opener and a
      // null of its own there) and undoes it: those stay, as run ends of
      // undone text do. A undoes " mid": its null and its restore are both
      // neutral then. Taking the value before A's restore from B's null (an
      // item written next to A's text after A's step) deleted the restore,
      // and " two" lost its bold.
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two')),
          ),
        {ids},
      );
      const [a, b] = t.peers;
      t.a.update(() => {
        const selection = $first().select(0, 7);
        selection.format = 0;
        selection.formatText('bold');
      });
      await t.sync();
      a.binding.undoManager!.clear();
      a.update(() => {
        const selection = $first().select(3, 3);
        selection.format = 0;
        selection.insertText(' mid');
      });
      await t.sync();
      b.update(() => {
        const selection = $find(' mid').select(2, 2);
        selection.format = 1;
        selection.insertText('X');
      });
      await t.sync();
      expect(t.a.read($show)).toBe('one*| m|X*|id| two*');
      b.undo();
      await t.sync();
      a.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('one two*');
    },
  );
  test.each(ORDERS)(
    "an undo of an underline next to a document's own run ends leaves its later underline alone (S9-9, ids %i %i %i)",
    async (...ids) => {
      const $underlined = (text: string) => {
        const node = $createTextNode(text);
        node.toggleFormat('underline');
        return node;
      };
      // One write underlines "t6z t7z t8z" and, in the next line, "u2".
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $underlined('t6z t7z t8z'),
              $createTextNode(' tail'),
            ),
            $createParagraphNode().append(
              $createTextNode('p '),
              $underlined('u2'),
              $createTextNode(' q'),
            ),
          ),
        {ids},
      );
      const [, b, c] = t.peers;
      const $toggle = (peer: Peer, on: boolean) =>
        peer.update(() => {
          const selection = $selectIn([0], 4, 11);
          selection.format = on ? 0 : 8;
          selection.formatText('underline');
        });
      // B takes the underline off "t7z t8z"; C, having seen that, puts it
      // back; C undoes.
      $toggle(b, false);
      await t.sync();
      $toggle(c, true);
      await t.sync();
      c.undo();
      await t.sync();
      await expectConverged(t.peers);
      const $u = () =>
        $getRoot()
          .getChildren()
          .map(line =>
            (line as ElementNode)
              .getAllTextNodes()
              .map(
                n => n.getTextContent() + (n.hasFormat('underline') ? '_' : ''),
              )
              .join('|'),
          )
          .join(' / ');
      expect(t.a.read($u)).toBe('t6z _|t7z t8z tail / p |u2_| q');
    },
  );
  test.each([
    [false, 1, 2, 3],
    [false, 3, 2, 1],
    [true, 1, 2, 3],
    [true, 3, 2, 1],
  ])(
    "a collaborator's format over text an undo removes still ends the value there (typo first: %s, ids %i %i %i)",
    async (typo, ...ids) => {
      // A bolds "one two"; F types plain " mid" inside; C bolds "mi" of it
      // (its null stays live after "mi"); F undoes " mid", then A undoes its
      // bold: nothing is bold.
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two')),
          ),
        {ids},
      );
      const [a, f, c] = t.peers;
      a.update(() => {
        const selection = $first().select(0, 7);
        selection.format = 0;
        selection.formatText('bold');
      });
      await t.sync();
      f.update(() => {
        const selection = $first().select(3, 3);
        selection.format = 0;
        selection.insertText(' mid');
      });
      await t.sync();
      if (typo) {
        // C types "Z" after "mi" and deletes it again first: the null C's
        // bold writes there sits next to C's own deleted text.
        c.update(() => void $find(' mid').spliceText(3, 0, 'Z'));
        await t.sync();
        c.update(() => void $find(' miZd').spliceText(3, 1, ''));
        await t.sync();
      }
      c.update(() => {
        const selection = $find(' mid').select(1, 3);
        selection.format = 0;
        selection.formatText('bold');
      });
      await t.sync();
      f.undo();
      await t.sync();
      a.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('one two');
    },
  );
});

/** The text of the nodes with a format or a comment, in order. */
const $annotated = () =>
  $getRoot()
    .getAllTextNodes()
    .filter(n => n.getFormat() !== 0 || $getNodeMarkIDs(n).length !== 0)
    .map(n => n.getTextContent())
    .join('');

const VALUES = ['bold', 'italic', 'underline', 'comment'] as const;

/** A gives "one two" `value` (a format, or comment c1). */
function $give(value: (typeof VALUES)[number]) {
  const selection = $first().select(0, 7);
  selection.format = 0;
  if (value === 'comment') {
    $addMarkID('c1', selection);
  } else {
    selection.formatText(value);
  }
}

describe('run ends an undo kept, after changes made since', () => {
  // A gives "one two" a value; F types plain " mid" after "one"; then,
  // concurrently, F undoes its typing (keeping its null and the restore
  // after " mid") while A undoes the value: the restore gave " two" the
  // value for everyone, unless A's undo sees F's (with #9561; the
  // concurrent case is a documented limit, below).
  describe.each(VALUES)('%s', value => {
    test.each(ORDERS)(
      'F undoes " mid" while A undoes the value: none of it keeps the value, and a redo gives it back (ids %i %i %i)',
      async (...ids) => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append($createTextNode('one two')),
            ),
          {ids, prepare: prepareMarkState},
        );
        const [a, , f] = t.peers;
        a.update(() => $give(value));
        await t.sync();
        f.update(() => {
          const [one] = $first().splitText(3);
          one.insertAfter($createTextNode(' mid'));
        });
        await t.sync();
        t.offline();
        f.undo();
        a.undo();
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.read(() => $getRoot().getTextContent())).toBe('one two');
        expect(t.a.read($annotated)).toBe('');
        a.binding.redo();
        await t.sync();
        await expectConverged(t.peers);
        expect(t.a.read($annotated)).toBe('one two');
      },
    );
  });

  // #9681: an undo of text typed inside a run deletes its run ends.
  test.fails.each(ORDERS)(
    'with text a collaborator typed after the null: it stays plain, and a redo gives " two" its bold back (ids %i %i %i)',
    async (...ids) => {
      // E's " plain" relies on F's null: F ends the restore's bold with an
      // item of its own instead, and deletes it again on A's redo.
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two')),
          ),
        {ids},
      );
      const [a, e, f] = t.peers;
      a.update(() => $give('bold'));
      await t.sync();
      f.update(() => {
        const [one] = $first().splitText(3);
        one.insertAfter($createTextNode(' mid'));
      });
      await t.sync();
      e.update(() => void $find('one').insertAfter($createTextNode(' plain')));
      await t.sync();
      t.offline();
      f.undo();
      a.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show).replace(/\|/g, '')).toBe('one plain two');
      a.binding.redo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('one*| plain| two*');
    },
  );

  // #9681: an undo of text typed inside a run deletes its run ends.
  test.fails.each(ORDERS)(
    'type, delete, undo, undo: text typed after the null stays plain (ids %i %i %i)',
    async (...ids) => {
      // The second undo deletes the copy the first one made of " mid" (the
      // undo manager follows `redone`): the run ends next to that copy are
      // the step's own.
      const t = await start(ids, 'bold');
      const [, e, f] = t.peers;
      f.update(() => {
        const [one] = $first().splitText(3);
        one.insertAfter($createTextNode(' mid'));
      });
      await t.sync();
      f.update(() => $find(' mid').remove());
      await t.sync();
      f.undo();
      await t.sync();
      expect(t.a.read($show)).toBe('one*| mid| two*');
      t.offline();
      e.update(() => void $find('one').insertAfter($createTextNode(' plain')));
      f.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('one*| plain| two*');
    },
  );

  test.each(ORDERS)(
    "the undo of a block moved into a collaborator's underline, while it undoes the underline (ids %i %i %i)",
    async (...ids) => {
      // D's move writes the block anew inside B's underline, with an opener
      // of the block's own underline that gives the value B's run gives.
      // D's undo kept that opener (it changed nothing then), and with B's
      // concurrent undo it underlined "two" for everyone.
      const t = await setup(
        () => {
          const xx = $createTextNode('xx');
          xx.toggleFormat('underline');
          $getRoot().append(
            $createParagraphNode().append(xx, $createTextNode(' yy')),
            $createParagraphNode().append($createTextNode('one')),
            $createParagraphNode().append($createTextNode('two')),
            $createParagraphNode().append($createTextNode('three')),
          );
        },
        {ids},
      );
      const [, b, d] = t.peers;
      b.update(() => {
        const one = $line(1).getFirstChildOrThrow() as TextNode;
        const two = $line(2).getFirstChildOrThrow() as TextNode;
        const selection = one.select(0, 0);
        selection.focus.set(two.getKey(), 3, 'text');
        selection.formatText('underline');
      });
      await t.sync();
      d.update(() => void $line(1).insertAfter($line(0)));
      await t.sync();
      t.offline();
      b.undo();
      d.undo();
      await t.sync();
      await expectConverged(t.peers);
      const $underlined = () =>
        $getRoot()
          .getChildren()
          .map(line =>
            (line as ElementNode)
              .getAllTextNodes()
              .map(
                n => n.getTextContent() + (n.hasFormat('underline') ? '_' : ''),
              )
              .join('|'),
          )
          .join(' / ');
      expect(t.a.read($underlined)).toBe('xx_| yy / one / two / three');
    },
  );

  // #9682: an undo of a run's value leaves it after a restore it has seen.
  test.fails.each(ORDERS)(
    'an undo ends its value past the restore of text it has seen, still there (ids %i %i %i)',
    async (...ids) => {
      // A bolds "one two"; F types plain " mid" inside, which A sees; A
      // undoes the bold: F's restore gave " two" the bold back.
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two')),
          ),
        {ids},
      );
      const [a, , f] = t.peers;
      a.update(() => $give('bold'));
      await t.sync();
      f.update(() => {
        const selection = $first().select(3, 3);
        selection.format = 0;
        selection.insertText(' mid');
      });
      await t.sync();
      a.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show).replace(/\|/g, '')).toBe('one mid two');
      a.binding.redo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('one*| mid| two*');
    },
  );

  test('control: text typed inside the range as the undo runs, which the undo has not seen, keeps the restore (documented)', async () => {
    // The concurrent case of the test above, a documented limit (y.md
    // Limits, Undo): A's undo cannot end a restore it has not seen.
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append($createTextNode('one two')),
        ),
      {ids: [1, 2, 3]},
    );
    const [a, , f] = t.peers;
    a.update(() => $give('bold'));
    await t.sync();
    t.offline();
    f.update(() => {
      const selection = $first().select(3, 3);
      selection.format = 0;
      selection.insertText(' mid');
    });
    a.undo();
    await t.sync();
    await expectConverged(t.peers);
    expect(t.a.read($show)).toBe('one mid| two*');
  });

  test.each(ORDERS)(
    'after the concurrent undos, a redo of the value and then of the typing gives " mid" back plain (ids %i %i %i)',
    async (...ids) => {
      // A bolds "one two"; F types plain " mid"; F undoes while A undoes the
      // bold; then A redoes the bold, and F redoes " mid": " mid" comes back
      // with the null and restore F's write gave it, plain inside the bold.
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two')),
          ),
        {ids},
      );
      const [a, , f] = t.peers;
      a.update(() => $give('bold'));
      await t.sync();
      f.update(() => {
        const [one] = $first().splitText(3);
        one.insertAfter($createTextNode(' mid'));
      });
      await t.sync();
      t.offline();
      f.undo();
      a.undo();
      await t.sync();
      a.binding.redo();
      await t.sync();
      f.binding.redo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('one*| mid| two*');
    },
  );

  test.each([
    [1, 2, 3],
    [3, 2, 1],
  ])(
    'F undoes " mid" while A concurrently undoes the bold: " two" ends plain (ids %i %i %i)',
    async (...ids) => {
      // F's undo keeps its null and the restore after " mid" (text typed
      // next to " mid" would rely on them); A's undo, which has not seen
      // F's, removes the bold's opener and end, so the restore gives " two"
      // bold for everyone. Settling it needs a write after both are seen,
      // which no client may make while it applies an update.
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two')),
          ),
        {ids},
      );
      const [a, , f] = t.peers;
      a.update(() => $give('bold'));
      await t.sync();
      t.offline();
      f.update(() => {
        const [one] = $first().splitText(3);
        one.insertAfter($createTextNode(' mid'));
      });
      f.undo();
      a.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(t.a.read($show)).toBe('one two');
    },
  );

  test.each([
    ['segmented', false, 1, 2, 3],
    ['segmented', false, 3, 2, 1],
    ['token', false, 1, 2, 3],
    ['token', false, 3, 2, 1],
    ['segmented', true, 1, 2, 3],
    ['token', true, 3, 2, 1],
  ] as const)(
    'an undo of text put inside a %s text node leaves the node whole (commented: %s, ids %i %i %i)',
    async (mode, commented, ...ids: number[]) => {
      // A node's own keys (its segment, its mode) are not run ends an undo
      // keeps: keeping the mode's end without the segment's split the node
      // in two.
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createTextNode('aa '),
              $createTextNode('one two').setMode(mode),
              $createTextNode(' bb'),
            ),
          ),
        {ids, prepare: prepareMarkState},
      );
      if (commented) {
        t.a.update(() => void $addMarkID('c1', $find('one two').select(0, 7)));
        await t.sync();
        for (const peer of t.peers) {
          peer.binding.undoManager?.clear();
        }
      }
      const shown = () =>
        t.a.describe() +
        t.a.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(n => $getNodeMarkIDs(n).join(','))
            .join('|'),
        );
      const before = shown();
      const [, , f] = t.peers;
      f.update(() => {
        const node = $find('one two');
        const [left] = node.splitText(5);
        left.insertAfter($createTextNode('X'));
      });
      await t.sync();
      f.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(shown()).toBe(before);
    },
  );

  // #9681: an undo of text typed inside a run deletes its run ends.
  test.fails.each(ORDERS)(
    'style: text typed after its null stays unstyled (ids %i %i %i)',
    async (...ids) => {
      // A text node's style is a run like a format: the undo keeps its run
      // ends (a node's mode is not, see the segmented and token case).
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('one two')),
          ),
        {ids},
      );
      t.a.update(() => $patchStyleText($first().select(0, 7), {color: 'red'}));
      await t.sync();
      for (const peer of t.peers) {
        peer.binding.undoManager?.clear();
      }
      const [, e, f] = t.peers;
      f.update(() => {
        const [one] = $first().splitText(3);
        one.insertAfter($createTextNode(' mid'));
      });
      await t.sync();
      t.offline();
      e.update(() => void $find('one').insertAfter($createTextNode(' plain')));
      f.undo();
      await t.sync();
      await expectConverged(t.peers);
      expect(
        t.a.read(() =>
          $getRoot()
            .getAllTextNodes()
            .map(n => n.getTextContent() + (n.getStyle() ? '{red}' : ''))
            .join('|'),
        ),
      ).toBe('one{red}| plain| two{red}');
    },
  );

  test('the undo of a long formatted paste walks its runs once', async () => {
    // Item links read by the undo, the paste's length doubling each time:
    // linear in it (a walk per deleted item was quadratic).
    const walks: number[] = [];
    for (const n of [200, 400, 800]) {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append($createTextNode('seed')),
          ),
        {ids: [7, 8]},
      );
      t.a.update(() => {
        const paragraph = $createParagraphNode();
        for (let i = 0; i < n; i++) {
          paragraph.append(
            $createTextNode('word ').setFormat(i % 2 === 0 ? 'bold' : 0),
          );
        }
        $getRoot().append(paragraph);
      });
      await t.sync();
      let count = 0;
      for (const structs of t.a.doc.store.clients.values()) {
        for (const item of structs) {
          if (!(item instanceof Y.Item)) {
            continue;
          }
          for (const name of ['left', 'right'] as const) {
            let link = item[name];
            Object.defineProperty(item, name, {
              configurable: true,
              enumerable: true,
              get() {
                count++;
                return link;
              },
              set(next) {
                link = next;
              },
            });
          }
        }
      }
      t.a.undo();
      expect(t.a.read(() => $getRoot().getTextContent())).toBe('seed');
      walks.push(count);
    }
    expect(walks[1] / walks[0]).toBeLessThan(2.5);
    expect(walks[2] / walks[1]).toBeLessThan(2.5);
  });
});
