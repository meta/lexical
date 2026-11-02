/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment node

// A change that leaves n formatted wrappers holding no text (the text in a
// mark inside each of n links is deleted, keeping a line break) shows each
// wrapper's stored text fields: the formats stored at the marks are found in
// one pass along the document, not one per wrapper from its start (see
// $unstoredWrapperTextFields), whether a collaborator's delete is read or
// the client deletes in one update of its own. Counted as the items checked
// (isGone), which grow linearly with n.

import {$createLinkNode} from '@lexical/link';
import {$createMarkNode} from '@lexical/mark';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
} from 'lexical';
import {expect, test, vi} from 'vitest';

import {expectConverged, setup} from '../../utils/harness';

const counter = vi.hoisted(() => ({on: false, visits: 0}));

vi.mock('../../../internal/Seen', async importOriginal => {
  const original =
    await importOriginal<typeof import('../../../internal/Seen')>();
  return {
    ...original,
    isGone: (...args: Parameters<typeof original.isGone>) => {
      if (counter.on) {
        counter.visits++;
      }
      return original.isGone(...args);
    },
  };
});

const $build = (n: number) => () => {
  for (let i = 0; i < n; i++) {
    $getRoot().append(
      $createParagraphNode().append(
        $createTextNode('before '),
        $createLinkNode(`https://link${i}.test`).append(
          $createMarkNode([`c${i}`]).append(
            $createTextNode(`word${i}`),
            $createLineBreakNode(),
          ),
        ),
        $createTextNode(' after'),
      ),
    );
  }
};

const $boldAll = () => {
  const texts = $getRoot().getAllTextNodes();
  const last = texts[texts.length - 1];
  const selection = texts[0].select(0, 0);
  selection.focus.set(last.getKey(), last.getTextContentSize(), 'text');
  selection.formatText('bold');
  $setSelection(null);
};

const $deleteWords = () => {
  for (const text of $getRoot().getAllTextNodes()) {
    if (text.getTextContent().startsWith('word')) {
      text.remove();
    }
  }
  $setSelection(null);
};

test('wrappers a remote delete leaves without text are settled in linear time', async () => {
  const visits: number[] = [];
  for (const n of [32, 64, 128]) {
    const t = await setup(() => {
      for (let i = 0; i < n; i++) {
        $getRoot().append(
          $createParagraphNode().append(
            $createTextNode('before '),
            $createLinkNode(`https://link${i}.test`).append(
              $createMarkNode([`c${i}`]).append(
                $createTextNode(`word${i}`),
                $createLineBreakNode(),
              ),
            ),
            $createTextNode(' after'),
          ),
        );
      }
    });
    try {
      t.b.update(() => {
        const texts = $getRoot().getAllTextNodes();
        const last = texts[texts.length - 1];
        const selection = texts[0].select(0, 0);
        selection.focus.set(last.getKey(), last.getTextContentSize(), 'text');
        selection.formatText('bold');
        $setSelection(null);
      });
      await t.sync();
      t.offline();
      t.a.update(() => {
        for (const text of $getRoot().getAllTextNodes()) {
          if (text.getTextContent().startsWith('word')) {
            text.remove();
          }
        }
        $setSelection(null);
      });
      counter.visits = 0;
      counter.on = true;
      await t.sync();
      counter.on = false;
      visits.push(counter.visits);
      await expectConverged(t.peers);
    } finally {
      counter.on = false;
      for (const p of t.peers) {
        p.stop();
      }
    }
  }
  // Doubling n doubles the work (about 2x); one pass per wrapper from the
  // start of the document would quadruple it.
  expect(visits[1] / visits[0]).toBeLessThan(3);
  expect(visits[2] / visits[1]).toBeLessThan(3);
}, 60_000);

test('wrappers a local delete leaves without text are settled in linear time', async () => {
  const visits: number[] = [];
  for (const n of [32, 64, 128]) {
    const t = await setup($build(n));
    try {
      t.b.update($boldAll);
      await t.sync();
      counter.visits = 0;
      counter.on = true;
      t.b.update($deleteWords);
      counter.on = false;
      visits.push(counter.visits);
      expect(
        t.b.read(() =>
          $getRoot()
            .getAllTextNodes()
            .some(text => text.getTextContent().startsWith('word')),
        ),
      ).toBe(false);
      await t.sync();
      await expectConverged(t.peers);
    } finally {
      counter.on = false;
      for (const p of t.peers) {
        p.stop();
      }
    }
  }
  expect(visits[1] / visits[0]).toBeLessThan(3);
  expect(visits[2] / visits[1]).toBeLessThan(3);
}, 60_000);

// One line of n links, each "wN" and a line break, bolded by the client
// that then deletes every link's text in one update: each link shows the
// text fields stored at its first atom, found in one walk of the line.
// Counted as the items' `right` links followed during the update.
test('links a local delete leaves without text in one line are settled in linear time', async () => {
  const reads: number[] = [];
  for (const n of [32, 64, 128]) {
    const t = await setup(() => {
      const paragraph = $createParagraphNode();
      for (let i = 0; i < n; i++) {
        paragraph.append(
          $createTextNode(' '),
          $createLinkNode(`https://link${i}.test`).append(
            $createTextNode(`w${i}`),
            $createLineBreakNode(),
          ),
        );
      }
      $getRoot().append(paragraph);
    });
    try {
      t.b.update(() => {
        const texts = $getRoot().getAllTextNodes();
        const last = texts[texts.length - 1];
        const selection = texts[0].select(0, 0);
        selection.focus.set(last.getKey(), last.getTextContentSize(), 'text');
        selection.formatText('bold');
        $setSelection(null);
      });
      await t.sync();
      let count = 0;
      const restores: (() => void)[] = [];
      const share = [
        ...(t.b.doc as unknown as {share: Map<string, unknown>}).share.values(),
      ][0] as {_start: {right: unknown} | null};
      for (
        let it = share._start as {right: unknown} | null;
        it !== null;
        it = it.right as {right: unknown} | null
      ) {
        const item = it;
        const descriptor = Object.getOwnPropertyDescriptor(item, 'right')!;
        const value = item.right;
        Object.defineProperty(item, 'right', {
          configurable: true,
          get() {
            count++;
            return value;
          },
          set(v) {
            Object.defineProperty(item, 'right', {
              ...descriptor,
              value: v,
            });
          },
        });
        restores.push(() => {
          if (
            Object.getOwnPropertyDescriptor(item, 'right')!.get !== undefined
          ) {
            Object.defineProperty(item, 'right', {...descriptor, value});
          }
        });
      }
      try {
        t.b.update(() => {
          for (const text of $getRoot().getAllTextNodes()) {
            if (/^w\d+$/.test(text.getTextContent())) {
              text.remove();
            }
          }
          $setSelection(null);
        });
      } finally {
        for (const restore of restores) {
          restore();
        }
      }
      reads.push(count);
      await t.sync();
      await expectConverged(t.peers);
    } finally {
      for (const p of t.peers) {
        p.stop();
      }
    }
  }
  expect(reads[1] / reads[0]).toBeLessThan(3);
  expect(reads[2] / reads[1]).toBeLessThan(3);
}, 60_000);
