/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A stored format bit under a text class that keeps none. A code highlight's
// setFormat is its own, so a reader shows no format there, yet a bit can be
// stored over part of one: a format written while the token was plain text,
// before it went back to a highlight, or a write from outside the editor.
// Text typed into the token stores the formats the node shows (none), so the
// stored bits differ across the one node its author shows, and a fresh read
// cut the node in two there: the author's editor no longer matched its own
// document. The bits are not shown, so they no longer set such nodes apart;
// they stay stored.

import {$createCodeHighlightNode, $createCodeNode} from '@lexical/code';
import {
  $createParagraphNode,
  $getRoot,
  TEXT_TYPE_TO_FORMAT,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  expectConverged,
  freshReader,
  type Peer,
  setup,
} from '../../utils/harness';

type RawRoot = {
  format(at: number, length: number, attrs: object): void;
  toDelta(): {children: {insert: unknown; format?: Record<string, unknown>}[]};
};
const raw = (p: Peer) => p.doc.get('lexical-y') as unknown as RawRoot;

const delta = (p: Peer) =>
  JSON.parse(JSON.stringify(raw(p).toDelta())) as ReturnType<
    RawRoot['toDelta']
  >;

/** The root's offset of `text`, counting each embed as one unit. */
function offsetOf(p: Peer, text: string): number {
  let flat = '';
  for (const piece of delta(p).children) {
    flat += typeof piece.insert === 'string' ? piece.insert : '\u0001';
  }
  const at = flat.indexOf(text);
  expect(at).toBeGreaterThanOrEqual(0);
  return at;
}

/** The stored text that carries format `key`. */
const storedWith = (p: Peer, key: string) =>
  delta(p)
    .children.filter(
      piece => typeof piece.insert === 'string' && piece.format?.[key] === true,
    )
    .map(piece => piece.insert)
    .join('');

const textNodes = (p: Peer) =>
  p.read(() =>
    $getRoot()
      .getAllTextNodes()
      .map(n => n.getTextContent()),
  );

/** Formats `text` with `key` from outside the editor (a raw write). */
async function formatRaw(
  t: Awaited<ReturnType<typeof setup>>,
  text: string,
  key: string,
) {
  const at = offsetOf(t.a, text);
  t.a.doc.transact(
    () => raw(t.a).format(at, text.length, {[key]: true}),
    'outside',
  );
  await t.sync();
  expect(storedWith(t.b, key)).toBe(text);
}

async function expectAuthorEqualsFresh(
  t: Awaited<ReturnType<typeof setup>>,
  author: Peer,
) {
  const fresh = await freshReader(author);
  expect(fresh.describe()).toBe(author.describe());
  await expectConverged(t.peers);
  expect(author.warnings.filter(w => /self-check/.test(w))).toEqual([]);
}

describe.each([false, true])('gc %s', gc => {
  // The soak's shape: a code line whose token " ab;" has a stored italic
  // over "ab"; a collaborator types at the start of "ab".
  test('text typed at the start of a stale italic inside a code highlight token reads as the author shows it', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createCodeNode('javascript').append(
            $createCodeHighlightNode('let', 'keyword'),
            $createCodeHighlightNode(' ab;'),
          ),
        ),
      {gc},
    );
    await formatRaw(t, 'ab', 'f:italic');
    t.b.update(() => {
      const node = $getRoot()
        .getAllTextNodes()
        .find(n => n.getTextContent().includes('ab')) as TextNode;
      const i = node.getTextContent().indexOf('ab');
      node.select(i, i).insertText('X');
    });
    await t.sync();
    await expectAuthorEqualsFresh(t, t.b);
    expect(textNodes(t.b)).toEqual(['let', ' Xab;']);
    expect(storedWith(t.b, 'f:italic')).toBe('ab');
  });

  // Every format bit at once (and one no class knows, which stays a
  // boundary): the highlight keeps none of the known ones.
  test('every known format bit over part of a highlight reads as one node', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append(
            $createCodeHighlightNode('alpha beta', 'comment'),
          ),
        ),
      {gc},
    );
    const at = offsetOf(t.a, 'beta');
    const all = Object.fromEntries(
      Object.keys(TEXT_TYPE_TO_FORMAT).map(name => [`f:${name}`, true]),
    );
    t.a.doc.transact(() => raw(t.a).format(at, 4, all), 'outside');
    await t.sync();
    expect(textNodes(t.b)).toEqual(['alpha beta']);
    expect((await freshReader(t.b)).describe()).toBe(t.b.describe());
    t.a.doc.transact(
      () => raw(t.a).format(at, 2, {'f:future': true}),
      'outside',
    );
    await t.sync();
    expect(textNodes(t.b)).toEqual(['alpha ', 'be', 'ta']);
    for (const name of Object.keys(TEXT_TYPE_TO_FORMAT)) {
      expect(storedWith(t.b, `f:${name}`)).toBe('beta');
    }
  });

  // A highlight with a stored bold over its second word: one node, typed
  // into at its end or at the start of the bold part.
  for (const where of ['end', 'start of the bold part']) {
    test(`text typed at the ${where} of a highlight over an ignored stored bold reads as the author shows it`, async () => {
      const t = await setup(
        () =>
          $getRoot().append(
            $createParagraphNode().append(
              $createCodeHighlightNode('alpha beta', 'comment'),
            ),
          ),
        {gc},
      );
      await formatRaw(t, 'beta', 'f:bold');
      t.b.update(() => {
        const nodes = $getRoot().getAllTextNodes();
        if (where === 'end') {
          const last = nodes[nodes.length - 1];
          const text = last.getTextContent() + '!';
          last.setTextContent(text).select(text.length, text.length);
        } else {
          const node = nodes.find(n => n.getTextContent().includes('beta'))!;
          const i = node.getTextContent().indexOf('beta');
          node.select(i, i).insertText('X');
        }
      });
      await t.sync();
      await expectAuthorEqualsFresh(t, t.b);
      expect(textNodes(t.b)).toEqual([
        where === 'end' ? 'alpha beta!' : 'alpha Xbeta',
      ]);
      expect(storedWith(t.b, 'f:bold')).toBe('beta');
    });
  }
});
