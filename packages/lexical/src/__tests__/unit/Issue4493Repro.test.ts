/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {PlainTextExtension} from '@lexical/plain-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type ElementNode,
  HISTORY_MERGE_TAG,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// Reproduction for https://github.com/facebook/lexical/issues/4493
//
// registerNodeTransform re-verifies a newly registered transform against
// content that already existed before it was registered, by force-marking
// every existing node of that type dirty (markNodesWithTypesAsDirty). That
// pass is bookkeeping, not a user edit, so it is tagged HISTORY_MERGE_TAG --
// but only when it opens its own update. When it instead lands inside an
// update that is already open (e.g. AutoFocusPlugin's editor.focus() call,
// racing a code-highlighting plugin's registration in the same effect
// flush), the two used to merge into one update carrying only the other
// call's tag, silently dropping HISTORY_MERGE_TAG. Consumers that key off
// that tag -- OnChangePlugin's default `ignoreHistoryMergeTagChange`, and
// undo history -- would then treat pure re-verification as a real edit.
describe('Issue #4493: registerNodeTransform tagging when an update is already open', () => {
  test('the forced re-verification pass is tagged history-merge even when it lands inside another open update', async () => {
    using editor = buildEditorFromExtensions({
      dependencies: [PlainTextExtension],
      name: 'issue-4493-repro',
      onError: e => {
        throw e;
      },
    });
    editor.setRootElement(document.createElement('div'));
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('hello')));
      },
      {discrete: true},
    );

    const observed: {dirty: boolean; tags: string[]}[] = [];
    const unregister = editor.registerUpdateListener(
      ({dirtyElements, dirtyLeaves, tags}) => {
        observed.push({
          dirty: dirtyElements.size > 0 || dirtyLeaves.size > 0,
          tags: [...tags],
        });
      },
    );

    // AutoFocusPlugin's effect: opens a non-discrete update tagged 'focus'.
    editor.focus();
    // A second plugin's effect, in the same synchronous tick, re-verifying
    // the already-existing TextNode content it just started managing (the
    // way a code-highlighting plugin's registerCodeHighlighting call
    // re-verifies existing code blocks). Neither update has committed yet,
    // so this coalesces into the same pending update as the focus call.
    const removeTransform = editor.registerNodeTransform(TextNode, () => {});

    // Nothing has committed synchronously; both calls share one pending update.
    expect(observed).toHaveLength(0);

    await Promise.resolve();
    await Promise.resolve();

    expect(observed).toHaveLength(1);
    // The dirty flags make this update look like a real content change...
    expect(observed[0].dirty).toBe(true);
    // ...so it must carry HISTORY_MERGE_TAG alongside 'focus', identifying it
    // as bookkeeping rather than an edit.
    expect(observed[0].tags).toContain('focus');
    expect(observed[0].tags).toContain(HISTORY_MERGE_TAG);

    removeTransform();
    unregister();
  });

  test('a real, subsequent edit is not tagged history-merge', async () => {
    using editor = buildEditorFromExtensions({
      dependencies: [PlainTextExtension],
      name: 'issue-4493-repro-real-edit',
      onError: e => {
        throw e;
      },
    });
    editor.setRootElement(document.createElement('div'));
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('hello')));
      },
      {discrete: true},
    );
    const removeTransform = editor.registerNodeTransform(TextNode, () => {});
    await Promise.resolve();
    await Promise.resolve();

    const observed: string[][] = [];
    const unregister = editor.registerUpdateListener(({tags}) => {
      observed.push([...tags]);
    });

    editor.update(() => {
      const textNode = $getRoot()
        .getFirstChild<ElementNode>()!
        .getFirstChild<TextNode>()!;
      textNode.selectEnd();
      textNode.insertAfter($createTextNode(' world'));
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(observed).toHaveLength(1);
    expect(observed[0]).not.toContain(HISTORY_MERGE_TAG);

    removeTransform();
    unregister();
  });
});
