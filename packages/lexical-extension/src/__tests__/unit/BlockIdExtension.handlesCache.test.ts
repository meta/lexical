/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {
  $getBlockById,
  $getBlockHandle,
  $getBlockHandles,
  $resolveBlockHandle,
  BlockIdExtension,
  blockIdState,
  buildEditorFromExtensions,
  configExtension,
} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  $setState,
  HISTORY_MERGE_TAG,
} from 'lexical';
import {assert, describe, expect, test, vi} from 'vitest';

import {buildHandleTable} from '../../internal/blockHandles';

vi.mock('../../internal/blockHandles', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../internal/blockHandles')>();
  return {...actual, buildHandleTable: vi.fn(actual.buildHandleTable)};
});

describe('block handle cache', () => {
  test('builds the handles once per set of ids', () => {
    let n = 0;
    const ids = ['V1StGXR8_Z5jdHi6B-myT', '9xQeLm2Pq0aK7cTb_wYuA'];
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        RichTextExtension,
        configExtension(BlockIdExtension, {
          generateId: () => (n < ids.length ? ids[n++] : `zz${n++}`),
        }),
      ],
      name: '[block-handle-cache]',
    });
    const options = {discrete: true, tag: HISTORY_MERGE_TAG} as const;
    editor.update(() => {
      $getRoot().append($createParagraphNode());
    }, options);
    editor.update(() => {
      $getRoot().clear();
    }, options);
    editor.update(
      () => {
        for (const text of ['a', 'b']) {
          $getRoot().append(
            $createParagraphNode().append($createTextNode(text)),
          );
        }
      },
      {discrete: true},
    );
    const builds = vi.mocked(buildHandleTable);
    builds.mockClear();
    const readAll = () =>
      editor.read(() => {
        for (const node of $getRoot().getChildren()) {
          $getBlockHandle(node);
        }
        $getBlockHandles();
        $resolveBlockHandle('V1St');
        $resolveBlockHandle('9xQe');
        $resolveBlockHandle('zzzz');
      });

    readAll();
    readAll();
    expect(builds).toHaveBeenCalledTimes(1);

    // Typing changes no id: no rebuild.
    editor.update(
      () => {
        const text = $getRoot().getFirstDescendant();
        assert($isTextNode(text));
        text.setTextContent('typed');
      },
      {discrete: true},
    );
    readAll();
    expect(builds).toHaveBeenCalledTimes(1);

    // A new id: one rebuild.
    editor.update(
      () => {
        $getRoot().append($createParagraphNode());
      },
      {discrete: true},
    );
    readAll();
    readAll();
    expect(builds).toHaveBeenCalledTimes(2);

    // A changed id: one rebuild.
    editor.update(
      () => {
        $setState($getBlockById(ids[1])!, blockIdState, 'renamed');
      },
      {discrete: true},
    );
    readAll();
    expect(builds).toHaveBeenCalledTimes(3);
  });
});
