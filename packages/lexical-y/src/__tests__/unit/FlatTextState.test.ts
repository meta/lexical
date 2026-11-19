/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A custom text class whose $config declares a flat StateConfig (its JSON
// holds the key at the top level). Lexical's splitText gives the parts after
// the first plain text nodes that keep the class's state configuration, so
// their JSON still holds the key flat, where a plain text node read from JSON
// ignores it. The binding stores such a key as NodeState, which every reader
// keeps, gives a line feed's line break all of the state, and reads the
// author's parts back so that it shows them as readers do: every client and
// a fresh reader keep the value on every part, with the same JSON.

import {
  $create,
  $createParagraphNode,
  $getRoot,
  $getState,
  $isElementNode,
  $setState,
  createState,
  type ElementNode,
  type LexicalNode,
  nodeSchema,
  stringValue,
  TextNode,
  withField,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {
  expectConverged,
  freshReader,
  NODES,
  type Peer,
  setup,
} from '../utils/harness';

const memo = createState('flat_text_memo', {parse: stringValue()});
const schema = nodeSchema<FlatMemoText>()({
  badge: withField(stringValue(), {field: '__badge'}),
});
class FlatMemoText extends TextNode {
  __badge = '';
  $config() {
    return this.config('flat_memo_text', {
      extends: TextNode,
      json: schema,
      stateConfigs: [{flat: true, stateConfig: memo}],
    });
  }
}
const nodes = [...NODES, FlatMemoText];
const VALUE = 'kept-42';

/** Every leaf's type and memo, in document order. */
function leaves(peer: Peer): string[] {
  return peer.read(() => {
    const out: string[] = [];
    const visit = (n: LexicalNode) => {
      if ($isElementNode(n)) {
        n.getChildren().forEach(visit);
      } else {
        out.push(
          `${n.getType()}:${JSON.stringify(n.getTextContent())}:${$getState(n, memo) || '-'}`,
        );
      }
    };
    visit($getRoot());
    return out;
  });
}

function $flat(text: string, mode: 'normal' | 'token' | 'segmented') {
  const n = $create(FlatMemoText).setTextContent(text).setMode(mode);
  n.getWritable().__badge = 'b';
  $setState(n, memo, VALUE);
  return n;
}

describe('a custom text class with a flat StateConfig', () => {
  for (const mode of ['normal', 'token', 'segmented'] as const) {
    for (const content of ['L\nR', '\nR', 'L\n\nR']) {
      test(`${mode} ${JSON.stringify(content)}: its line feeds' parts keep the state everywhere`, async () => {
        const t = await setup(() => $getRoot().append($createParagraphNode()), {
          nodes,
        });
        t.a.update(() => {
          ($getRoot().getFirstChildOrThrow() as ElementNode).append(
            $flat(content, mode),
          );
        });
        await t.sync();
        const authored = leaves(t.a);
        // The line breaks and the plain parts lost the value here, on the
        // other client (the line breaks on the author too).
        expect(authored.every(l => l.endsWith(`:${VALUE}`))).toBe(true);
        expect(authored.filter(l => l.startsWith('linebreak')).length).toBe(
          content.split('\n').length - 1,
        );
        const fresh = await freshReader(t.a, nodes);
        expect(leaves(t.b)).toEqual(authored);
        expect(leaves(fresh)).toEqual(authored);
        await expectConverged(t.peers);
      });
    }
  }

  test('a part split off by formatting keeps the state everywhere', async () => {
    const t = await setup(
      () =>
        $getRoot().append(
          $createParagraphNode().append($flat('left right', 'normal')),
        ),
      {nodes},
    );
    t.a.update(() => {
      const text = (
        $getRoot().getFirstChildOrThrow() as ElementNode
      ).getFirstChildOrThrow() as TextNode;
      text.select(5, 10).formatText('bold');
    });
    await t.sync();
    const authored = leaves(t.a);
    expect(authored.length).toBe(2);
    expect(authored.every(l => l.endsWith(`:${VALUE}`))).toBe(true);
    const fresh = await freshReader(t.a, nodes);
    expect(leaves(t.b)).toEqual(authored);
    expect(leaves(fresh)).toEqual(authored);
    await expectConverged(t.peers);
  });
});
