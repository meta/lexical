/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A client that received a comment's mark element without the text inside
// it (out-of-order delivery: the rest of that change has not arrived) shows
// nothing for the empty element. Text its editor writes by replacing a text
// node's content beside it (setTextContent, as an IME composition or app
// code does) was stored at the wrong position: the writer counted the
// element where the reader shows none
// (https://github.com/meta/lexical/issues/9807). The writer now counts
// exactly what the reader counts: it does not count such an element, and
// deletes one only where a delete meets it before its last unit (a removed
// line takes it along).

import {$createMarkNode, $wrapSelectionInMarkNode} from '@lexical/mark';
import {$createHeadingNode} from '@lexical/rich-text';
import * as Y from '@y/y';
import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getRoot,
  $setCompositionKey,
  $setSelection,
  booleanValue,
  ElementNode,
  nodeSchema,
  type TextNode,
  withField,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  $selectIn,
  expectConverged,
  freshReader,
  NODES,
  setup,
  WidgetNode,
} from '../../utils/harness';

async function run(gc: boolean, edit: 'compose' | 'set' | 'insert') {
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('one')),
        $createParagraphNode().append(
          $createTextNode('业丛东丝').toggleFormat('bold'),
        ),
      ),
    {gc, ids: [1, 2, 3]},
  );
  const {a, b} = t;
  t.offline();
  const before = Y.encodeStateVector(b.doc);
  // B moves the line's first character into a comment.
  b.update(() => {
    const selection = $selectIn([1], 0, 1);
    $wrapSelectionInMarkNode(selection, selection.isBackward(), 'c1');
    $setSelection(null);
  });
  const change = Y.encodeStateAsUpdate(b.doc, before);
  // A receives the formats and the mark element, and the deletion, but not
  // the mark's attributes or the text inside it (B's clocks 3 to 8).
  const ids = Y.createContentIdsFromUpdate(change);
  const inFlight = Y.createIdSet();
  inFlight.add(b.doc.clientID, 3, 6);
  Y.applyUpdate(
    a.doc,
    Y.intersectUpdateWithContentIds(change, {
      deletes: ids.deletes,
      inserts: Y.diffIdSet(ids.inserts, inFlight),
    }),
    'relay',
  );
  const $line = () =>
    ($getRoot().getLastChildOrThrow() as ElementNode).getTextContent();
  expect(a.read($line)).toBe('丛东丝');
  a.update(() => {
    if (edit === 'insert') {
      $selectIn([1], 1).insertText('ZZ');
      $setSelection(null);
      return;
    }
    const text = (
      $getRoot().getLastChildOrThrow() as ElementNode
    ).getFirstChildOrThrow() as TextNode;
    text.setTextContent('丛ZZ东丝');
    if (edit === 'compose') {
      text.select(3, 3);
      $setCompositionKey(text.getKey());
    } else {
      $setSelection(null);
    }
  });
  const fresh = await freshReader(a);
  expect(fresh.read($line)).toBe('丛ZZ东丝');
  expect(a.warnings.filter(w => w.includes('self-check'))).toEqual([]);
  fresh.stop();
  a.update(() => $setCompositionKey(null));
  await t.sync();
  await expectConverged(t.peers);
}

describe.each([false, true])(
  'text written beside an empty inline element, gc %s',
  gc => {
    test('inserted: stored where shown', () => run(gc, 'insert'));
    test('set on the text node: stored where shown', () => run(gc, 'set'));
    test('set by a composition: stored where shown', () => run(gc, 'compose'));
  },
);

// The same element emptied by peers: B and C each delete half of a comment's
// text at once, so the element stays with no content, which no editor shows.
async function runConcurrent(
  gc: boolean,
  edit: 'set' | 'insert' | 'unbold' | 'move bold',
) {
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('one')),
        $createParagraphNode().append(
          $createMarkNode(['c1']).append($createTextNode('ab')),
          ...(edit === 'set' || edit === 'insert'
            ? [$createTextNode('丛东丝')]
            : edit === 'unbold'
              ? [$createTextNode('丛东丝').toggleFormat('bold')]
              : [
                  $createTextNode('丛东').toggleFormat('bold'),
                  $createTextNode('丝'),
                ]),
        ),
      ),
    {gc, ids: [1, 2, 3]},
  );
  const {a, b, c} = t;
  t.offline();
  b.update(() => {
    $selectIn([1], 0, 1).removeText();
    $setSelection(null);
  });
  c!.update(() => {
    $selectIn([1], 1, 2).removeText();
    $setSelection(null);
  });
  await t.sync();
  const $line = () =>
    ($getRoot().getLastChildOrThrow() as ElementNode).getTextContent();
  expect(a.read($line)).toBe('丛东丝');
  if (edit === 'unbold' || edit === 'move bold') {
    // The format moves (or goes): every client and a fresh reader show it
    // where this editor does.
    a.update(() => {
      if (edit === 'unbold') {
        (
          (
            $getRoot().getLastChildOrThrow() as ElementNode
          ).getLastChildOrThrow() as TextNode
        ).toggleFormat('bold');
      } else {
        $selectIn([1], 0, 2).formatText('bold');
        $selectIn([1], 2, 3).formatText('bold');
      }
      $setSelection(null);
    });
    // The change was made (and written).
    expect(a.describe()).toBe(
      edit === 'unbold'
        ? 'paragraph("one") / paragraph("丛东丝")'
        : 'paragraph("one") / paragraph("丛东丝"{1})',
    );
    await t.sync();
    const fresh = await freshReader(a);
    expect(fresh.describe()).toBe(a.describe());
    expect(b.describe()).toBe(a.describe());
    fresh.stop();
    await expectConverged(t.peers);
    return;
  }
  a.update(() => {
    if (edit === 'insert') {
      $selectIn([1], 1).insertText('ZZ');
    } else {
      (
        (
          $getRoot().getLastChildOrThrow() as ElementNode
        ).getLastChildOrThrow() as TextNode
      ).setTextContent('丛ZZ东丝');
    }
    $setSelection(null);
  });
  const fresh = await freshReader(a);
  expect(fresh.read($line)).toBe('丛ZZ东丝');
  expect(a.warnings.filter(w => w.includes('self-check'))).toEqual([]);
  fresh.stop();
  await t.sync();
  await expectConverged(t.peers);
}

describe.each([false, true])(
  'text written beside an inline element peers emptied, gc %s',
  gc => {
    test('inserted: stored where shown', () => runConcurrent(gc, 'insert'));
    test('set on the text node: stored where shown', () =>
      runConcurrent(gc, 'set'));
    test('a format removed beside it: stored where shown', () =>
      runConcurrent(gc, 'unbold'));
    test('a format moved to the next text node: stored where shown', () =>
      runConcurrent(gc, 'move bold'));
  },
);

// A follow-up (BlockIdExtension's naming commit, or an update tagged
// `block-id-repair`) that removes a line holding an element peers emptied:
// the delete is sized by what readers show, so the next line keeps its first
// character for every client.
async function runFollowUpRemoval(gc: boolean, how: 'tagged' | 'queued') {
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('one')),
        $createParagraphNode().append(
          $createMarkNode(['c1']).append($createTextNode('ab')),
          $createTextNode('two'),
        ),
        $createParagraphNode().append($createTextNode('three')),
      ),
    {gc, ids: [1, 2, 3]},
  );
  const {a, b, c} = t;
  t.offline();
  b.update(() => {
    $selectIn([1], 0, 1).removeText();
    $setSelection(null);
  });
  c!.update(() => {
    $selectIn([1], 1, 2).removeText();
    $setSelection(null);
  });
  await t.sync();
  const $removeMiddle = () => {
    $getRoot().getChildAtIndex(1)!.remove();
    $setSelection(null);
  };
  if (how === 'tagged') {
    a.update($removeMiddle, 'block-id-repair');
  } else {
    // Queued from an update listener into the naming commit.
    let queued = false;
    const stop = a.editor.registerUpdateListener(({tags}) => {
      if (!queued && tags.has('block-id-repair')) {
        queued = true;
        a.editor.update($removeMiddle, {tag: 'block-id-repair'});
      }
    });
    a.update(() => {
      ($getRoot().getFirstChildOrThrow() as ElementNode).setFormat('center');
      $setSelection(null);
    }, 'block-id-repair');
    stop();
  }
  await t.sync();
  const fresh = await freshReader(a);
  expect(fresh.describe()).toBe(a.describe());
  expect(b.describe()).toBe(a.describe());
  fresh.stop();
  expect(a.read(() => $getRoot().getTextContent())).toBe('one\n\nthree');
  await expectConverged(t.peers);
}

describe.each([false, true])(
  'a follow-up removing a line with an inline element peers emptied, gc %s',
  gc => {
    test('in an update tagged block-id-repair: the next line keeps its text', () =>
      runFollowUpRemoval(gc, 'tagged'));
    test('queued into the naming commit from an update listener: the next line keeps its text', () =>
      runFollowUpRemoval(gc, 'queued'));
  },
);

// Nested elements peers emptied (a comment inside a comment): the outer one
// holds only the inner one, which no editor shows, so neither shows. A client
// that loads the document writes text after them where it shows it.
describe.each([false, true])(
  'text written after nested inline elements peers emptied, gc %s',
  gc => {
    test('by a client that loaded the document: stored where shown', async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createMarkNode(['c1']).append(
                $createMarkNode(['c2']).append($createTextNode('ab')),
              ),
              $createTextNode('right'),
            ),
          ),
        {gc, ids: [1, 2, 3]},
      );
      const {a, b, c} = t;
      t.offline();
      b.update(() => {
        $selectIn([0], 0, 1).removeText();
        $setSelection(null);
      });
      c!.update(() => {
        $selectIn([0], 1, 2).removeText();
        $setSelection(null);
      });
      await t.sync();
      expect(a.read(() => $getRoot().getTextContent())).toBe('right');
      const loaded = await freshReader(a);
      try {
        expect(loaded.read(() => $getRoot().getTextContent())).toBe('right');
        loaded.update(() => {
          $selectIn([0], 5).insertText('X');
          $setSelection(null);
        });
        const stored = await freshReader(loaded);
        expect(stored.read(() => $getRoot().getTextContent())).toBe('rightX');
        stored.stop();
        expect(loaded.warnings.filter(w => w.includes('self-check'))).toEqual(
          [],
        );
      } finally {
        loaded.stop();
      }
    });
  },
);

// A line removed while it holds an element no editor shows: the element goes
// with the line, as before (its text, arriving late or brought back by an
// undo, does not reappear at the start of the next line).
async function runLineRemoval(gc: boolean, how: 'late text' | 'undo') {
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('one')),
        how === 'late text'
          ? $createParagraphNode().append($createTextNode('业丛东丝'))
          : $createParagraphNode().append(
              $createMarkNode(['c1']).append($createTextNode('ab')),
              $createTextNode('two'),
            ),
        $createParagraphNode().append($createTextNode('three')),
      ),
    {gc, ids: [1, 2, 3]},
  );
  const {a, b, c} = t;
  t.offline();
  if (how === 'late text') {
    const before = Y.encodeStateVector(b.doc);
    // B moves the line's first character into a comment; A receives the
    // element but not the text inside it.
    b.update(() => {
      const selection = $selectIn([1], 0, 1);
      $wrapSelectionInMarkNode(selection, selection.isBackward(), 'c1');
      $setSelection(null);
    });
    const change = Y.encodeStateAsUpdate(b.doc, before);
    const ids = Y.createContentIdsFromUpdate(change);
    const inFlight = Y.createIdSet();
    inFlight.add(b.doc.clientID, 3, 6);
    Y.applyUpdate(
      a.doc,
      Y.intersectUpdateWithContentIds(change, {
        deletes: ids.deletes,
        inserts: Y.diffIdSet(ids.inserts, inFlight),
      }),
      'relay',
    );
  } else {
    b.update(() => {
      $selectIn([1], 0, 1).removeText();
      $setSelection(null);
    });
    c!.update(() => {
      $selectIn([1], 1, 2).removeText();
      $setSelection(null);
    });
    await t.sync();
    t.offline();
  }
  // A removes the middle line.
  a.update(() => {
    $getRoot().getChildAtIndex(1)!.remove();
    $setSelection(null);
  });
  await t.sync();
  if (how === 'undo') {
    // B undoes its delete inside the comment.
    b.undo();
    await t.sync();
  }
  const fresh = await freshReader(a);
  expect(fresh.describe()).toBe(a.describe());
  fresh.stop();
  expect(a.read(() => $getRoot().getTextContent())).toBe('one\n\nthree');
  await expectConverged(t.peers);
}

describe.each([false, true])(
  'a line removed with an inline element no editor shows, gc %s',
  gc => {
    test('its text arriving late does not reappear in the next line', () =>
      runLineRemoval(gc, 'late text'));
    test('its text brought back by an undo does not reappear in the next line', () =>
      runLineRemoval(gc, 'undo'));
  },
);

// The same with a line without a marker (text a concurrent join left before
// a block node) that ends with the emptied element: removing the line takes
// the element too, where no end item follows for the delete to meet, and an
// edit that keeps the line ends it with its marker after the element is gone
// (left there, the element would follow the marker as a line of its own).
async function runMarkerlessLineRemoval(
  gc: boolean,
  how: 'remove' | 'range' | 'edit',
) {
  const t = await setup(
    () =>
      $getRoot().append(
        $createHeadingNode('h1').append($createTextNode('Title')),
        $createParagraphNode().append(
          $createTextNode('one'),
          $createMarkNode(['c1']).append($createTextNode('ab')),
        ),
        $createParagraphNode().append($createTextNode('two')),
      ),
    {gc, ids: [1, 2, 3]},
  );
  const {a, b, c} = t;
  t.offline();
  // A joins the line with the next while B inserts a block node between.
  a.update(() => {
    ($getRoot().getChildAtIndex(1) as ElementNode)
      .selectEnd()
      .deleteCharacter(false);
    $setSelection(null);
  });
  b.update(() => {
    $getRoot().getChildAtIndex(1)!.insertAfter($create(WidgetNode));
    $setSelection(null);
  });
  await t.sync();
  t.offline();
  b.update(() => {
    $selectIn([1], 3, 4).removeText();
    $setSelection(null);
  });
  c!.update(() => {
    $selectIn([1], 4, 5).removeText();
    $setSelection(null);
  });
  await t.sync();
  expect(a.describe()).toBe(
    'heading[h1]("Title") / paragraph("one") / test_widget / paragraph("two")',
  );
  a.update(() => {
    if (how === 'edit') {
      // An edit inside the line that keeps it (its last characters stay).
      (
        (
          $getRoot().getChildAtIndex(1) as ElementNode
        ).getFirstChild() as TextNode
      ).setTextContent('oe');
    } else if (how === 'remove') {
      $getRoot().getChildAtIndex(1)!.remove();
    } else {
      // A range delete from the end of the title.
      const selection = $selectIn([0], 5);
      const line = $getRoot().getChildAtIndex(1) as ElementNode;
      selection.focus.set(line.getKey(), line.getChildrenSize(), 'element');
      selection.removeText();
    }
    $setSelection(null);
  });
  await t.sync();
  const fresh = await freshReader(a);
  expect(fresh.describe()).toBe(a.describe());
  fresh.stop();
  expect(a.describe()).toBe(
    how === 'edit'
      ? 'heading[h1]("Title") / paragraph("oe") / test_widget / paragraph("two")'
      : 'heading[h1]("Title") / test_widget / paragraph("two")',
  );
  await expectConverged(t.peers);
}

describe.each([false, true])(
  'a line without a marker removed with an inline element no editor shows, gc %s',
  gc => {
    test('removed: no empty paragraph is left for other clients', () =>
      runMarkerlessLineRemoval(gc, 'remove'));
    test('deleted by a range from the end of the title: no empty paragraph is left for other clients', () =>
      runMarkerlessLineRemoval(gc, 'range'));
    test('edited inside, keeping its end: no empty paragraph is left for other clients', () =>
      runMarkerlessLineRemoval(gc, 'edit'));
  },
);

const allowsEmpty = nodeSchema<AllowsEmptyInline>()({
  emptyAllowed: withField(booleanValue(), {field: '__emptyAllowed'}),
});

/** An inline element whose instances may be empty (an instance field). */
class AllowsEmptyInline extends ElementNode {
  __emptyAllowed: boolean = true;
  $config() {
    return this.config('allows_empty_inline', {
      children: 'inline',
      extends: ElementNode,
      json: allowsEmpty,
    });
  }
  isInline(): true {
    return true;
  }
  canBeEmpty(): boolean {
    return this.__emptyAllowed;
  }
  createDOM(): HTMLElement {
    return $getDocument().createElement('span');
  }
  updateDOM(): false {
    return false;
  }
}

// An empty inline element the editor shows (its instance may be empty) is
// counted like any other.
describe.each([false, true])(
  'text set beside an empty inline element the editor shows, gc %s',
  gc => {
    for (const filled of [false, true]) {
      test(`${filled ? 'filled' : 'empty'}: stored where shown`, async () => {
        const t = await setup(
          () =>
            $getRoot().append(
              $createParagraphNode().append(
                $createTextNode('left'),
                $create(AllowsEmptyInline).append(
                  ...(filled ? [$createTextNode('middle')] : []),
                ),
                $createTextNode('right'),
              ),
            ),
          {gc, ids: [1, 2, 3], nodes: [...NODES, AllowsEmptyInline]},
        );
        t.a.update(() => {
          $getRoot()
            .getAllTextNodes()
            .find(n => n.getTextContent() === 'right')!
            .setTextContent('rightX');
        });
        await t.sync();
        const fresh = await freshReader(t.a);
        expect(fresh.describe()).toBe(t.a.describe());
        expect(t.a.warnings.filter(w => w.includes('self-check'))).toEqual([]);
        fresh.stop();
        await expectConverged(t.peers);
      });
    }
  },
);

// The emptied comment refilled by a change a provider applies inside A's
// local update (read after it, D108): the write sees the comment as A shows
// it, empty, so the refill stays and A's text lands where A shows it.
describe.each([false, true])(
  'text set beside an emptied comment a change applied in the update refills, gc %s',
  gc => {
    test('both kept, each where shown', async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createMarkNode(['c1']).append($createTextNode('ab')),
              $createTextNode('right'),
            ),
          ),
        {gc, ids: [1, 2, 3]},
      );
      const {a, b, c} = t;
      let mark: Y.Node | null = null;
      for (const list of b.doc.store.clients.values()) {
        for (const it of list) {
          if (
            it instanceof Y.Item &&
            it.content instanceof Y.ContentType &&
            it.content.type.name === 'i:mark'
          ) {
            mark = it.content.type as Y.Node;
          }
        }
      }
      t.offline();
      b.update(() => {
        $selectIn([0], 0, 1).removeText();
        $setSelection(null);
      });
      c!.update(() => {
        $selectIn([0], 1, 2).removeText();
        $setSelection(null);
      });
      await t.sync();
      expect(a.read(() => $getRoot().getTextContent())).toBe('right');
      t.offline();
      const seen = Y.encodeStateVector(b.doc);
      b.doc.transact(() => mark!.insert(0, 'REF'), 'peer');
      const refill = Y.encodeStateAsUpdate(b.doc, seen);
      a.update(() => {
        Y.applyUpdate(a.doc, refill, 'provider');
        $getRoot().getAllTextNodes()[0].setTextContent('rightX');
        $setSelection(null);
      });
      await t.sync();
      const fresh = await freshReader(a);
      expect(fresh.read(() => $getRoot().getTextContent())).toBe('REFrightX');
      expect(fresh.describe()).toBe(a.describe());
      fresh.stop();
      await expectConverged(t.peers);
    });
  },
);
