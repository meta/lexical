/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// R21-B's scaling probe as a guard: one update fragments a line into n set
// runs with an insert and a delete between each two (spliced, set whole,
// spliced again). Resolving the line's identities must stay linear in its
// length: the time per character at n = 3200 within a small constant of n =
// 200 (a per-node floor took 5.8 s at n = 3200, 29.5 ms at 200).

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  type ElementNode,
  type TextNode,
} from 'lexical';
import {expect, test} from 'vitest';

import {TextReplay} from '../../../internal/TextEdits';
import {freshReader, setup} from '../../utils/harness';

const proto = TextReplay.prototype as unknown as {
  resolve: (key: string) => unknown;
};
const resolve = proto.resolve;
let spent = 0;
proto.resolve = function (this: unknown, key: string) {
  const t0 = performance.now();
  try {
    return resolve.call(this, key);
  } finally {
    spent += performance.now() - t0;
  }
};

async function run(n: number): Promise<number> {
  const text = 'abcd'.repeat(n);
  const t = await setup(() => {
    $getRoot().append(
      $createParagraphNode().append($createTextNode('Title')),
      $createParagraphNode().append($createTextNode(text)),
    );
  });
  spent = 0;
  t.a.update(() => {
    const x = (
      $getRoot().getChildAtIndex(1) as ElementNode
    ).getFirstChild() as TextNode;
    for (let k = n - 1; k >= 0; k--) {
      x.spliceText(k * 4, 0, 'X', false);
      x.spliceText(k * 4, 1, '', false);
    }
    x.setTextContent('Z ' + x.getTextContent());
    for (let k = n - 1; k >= 0; k--) {
      x.spliceText(2 + k * 4, 0, 'X', false);
      x.spliceText(2 + k * 4, 1, '', false);
    }
    $setSelection(null);
  });
  const ms = spent;
  const expected = 'Z ' + text;
  await t.sync();
  const f = await freshReader(t.a);
  const texts = [t.a, t.b, f].map(p =>
    p.read(() => $getRoot().getChildAtIndex(1)!.getTextContent()),
  );
  expect(texts).toEqual([expected, expected, expected]);
  [...t.peers, f].forEach(p => {
    p.stop();
    p.doc.destroy();
  });
  return ms / text.length;
}

test('R21-B scaling: a line fragmented into set runs resolves in linear time', async () => {
  const median = async (n: number, k: number) => {
    const xs: number[] = [];
    for (let i = 0; i < k; i++) {
      xs.push(await run(n));
    }
    xs.sort((a, b) => a - b);
    return xs[k >> 1];
  };
  await median(200, 3);
  const small = await median(200, 5);
  const large = await median(3200, 3);
  // eslint-disable-next-line no-console
  console.log(
    `R22_SCALING per char: n=200 ${(small * 1e3).toFixed(2)} us, n=3200 ${(
      large * 1e3
    ).toFixed(2)} us, ratio ${(large / small).toFixed(2)}`,
  );
  // Quadratic work is 16 times the time per character at 16 times the size.
  expect(large).toBeLessThan(small * 3 + 0.001);
}, 120000);
