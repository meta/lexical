/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {HistoryExtension, SharedHistoryExtension} from '@lexical/history';
import {configExtension} from 'lexical';
import {describe, expect, test} from 'vitest';

const PARENT_MAX_DEPTH = 7;
const PARENT_DELAY = 123;

function buildParent() {
  return buildEditorFromExtensions({
    dependencies: [
      configExtension(HistoryExtension, {
        delay: PARENT_DELAY,
        maxDepth: PARENT_MAX_DEPTH,
      }),
    ],
    name: 'shared-max-depth-parent',
  });
}

function buildChild() {
  return buildEditorFromExtensions({
    dependencies: [SharedHistoryExtension],
    name: 'shared-max-depth-child',
  });
}

describe('SharedHistoryExtension forwards the parent history signals', () => {
  test('the child adopts the parent maxDepth', () => {
    using parent = buildParent();
    using child = buildChild();

    const shared = getExtensionDependencyFromEditor(
      child,
      SharedHistoryExtension,
    );
    shared.output.parentEditor.value = parent;

    const parentHistory = getExtensionDependencyFromEditor(
      parent,
      HistoryExtension,
    );
    const childHistory = getExtensionDependencyFromEditor(
      child,
      HistoryExtension,
    );

    // Premise: the parent really carries the configured cap, and the child's
    // own default differs from it.
    expect(parentHistory.output.maxDepth.peek()).toBe(PARENT_MAX_DEPTH);

    // The child pushes onto the parent's shared undoStack, so it has to apply
    // the parent's cap rather than its own default.
    expect(childHistory.output.maxDepth.peek()).toBe(PARENT_MAX_DEPTH);
  });

  test('the already-forwarded signals still arrive', () => {
    using parent = buildParent();
    using child = buildChild();

    const shared = getExtensionDependencyFromEditor(
      child,
      SharedHistoryExtension,
    );
    shared.output.parentEditor.value = parent;

    const parentHistory = getExtensionDependencyFromEditor(
      parent,
      HistoryExtension,
    );
    const childHistory = getExtensionDependencyFromEditor(
      child,
      HistoryExtension,
    );
    const keys = [
      'delay',
      'historyState',
      'now',
      'maxDepth',
      'disabled',
    ] as const;
    expect(
      Object.fromEntries(keys.map(k => [k, childHistory.output[k].peek()])),
    ).toEqual(
      Object.fromEntries(keys.map(k => [k, parentHistory.output[k].peek()])),
    );
  });
});
