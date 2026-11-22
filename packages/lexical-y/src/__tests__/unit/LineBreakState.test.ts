/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $setState,
  createState,
  type ElementNode,
  type LineBreakNode,
  type TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {expectConverged, setup} from '../utils/harness';

const flag = createState('test-flag', {parse: (v: unknown) => v === true});
const $init = () =>
  $getRoot().append(
    $createParagraphNode().append(
      $createTextNode('ab'),
      $createLineBreakNode(),
      $createTextNode('cd'),
    ),
  );
const $br = () =>
  ($getRoot().getFirstChild() as ElementNode).getChildAtIndex(
    1,
  ) as LineBreakNode;

describe('@lexical/y NodeState on an existing line break', () => {
  test('is written when only the line break changes', async () => {
    const t = await setup($init);
    t.a.update(() => $setState($br(), flag, true));
    await t.sync();
    expect(t.b.read(() => $getState($br(), flag))).toBe(true);
    await expectConverged(t.peers);
  });

  test('is written with the text next to it (a comment across a line break)', async () => {
    const t = await setup($init);
    t.a.update(() => {
      $setState($br(), flag, true);
      $setState(
        ($getRoot().getFirstChild() as ElementNode).getFirstChild() as TextNode,
        flag,
        true,
      );
    });
    await t.sync();
    expect(t.b.read(() => $getState($br(), flag))).toBe(true);
    await expectConverged(t.peers);
  });

  test('is removed when reset', async () => {
    const t = await setup($init);
    t.a.update(() => $setState($br(), flag, true));
    await t.sync();
    t.b.update(() => $setState($br(), flag, false));
    await t.sync();
    expect(t.a.read(() => $getState($br(), flag))).toBe(false);
    await expectConverged(t.peers);
  });
});
