/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import type {Construct, TokenizeContext} from 'micromark-util-types';

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $convertFromMarkdownString,
  MdastExtension,
  MdastGfmExtension,
} from '@lexical/mdast';
import {configExtension, defineExtension} from 'lexical';
import {expect, it, onTestFinished, vi} from 'vitest';

// Counts the reads of this package's own emphasis construct, which micromark
// would not use where it resolves another copy of micromark-core-commonmark.
const reads = vi.hoisted(() => ({count: 0}));
vi.mock('micromark-core-commonmark', async importOriginal => {
  const original =
    await importOriginal<typeof import('micromark-core-commonmark')>();
  const attention: Construct = {
    ...original.attention,
    tokenize(this: TokenizeContext, effects, ok, nok) {
      reads.count++;
      return original.attention.tokenize.call(this, effects, ok, nok);
    },
  };
  return {...original, attention};
});

it('reads emphasis with its own micromark-core-commonmark in a strict import', () => {
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastGfmExtension,
        configExtension(MdastExtension, {
          importPunctuation: 'strict-commonmark',
        }),
      ],
      name: '[root]',
    }),
  );
  onTestFinished(() => editor.dispose());
  reads.count = 0;
  editor.update(() => $convertFromMarkdownString('foo**_bar_**baz'), {
    discrete: true,
  });
  expect(reads.count).toBeGreaterThan(0);
});
