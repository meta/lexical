/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  AutoLinkExtension,
  AutoLinkNode,
  autoLinkUrlMatcher,
} from '@lexical/link';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getState,
  $isRangeSelection,
  $setState,
  configExtension,
  createState,
  HISTORY_PUSH_TAG,
  REDO_COMMAND,
  TextNode,
  UNDO_COMMAND,
} from 'lexical';
import {expect, test} from 'vitest';

const state = createState('autolink-dom-history', {
  parse: value => (typeof value === 'string' ? value : ''),
});

test.each([false, true])(
  'DOM, mutations and history survive autolinking (several text nodes: %s)',
  several => {
    let enabled = false;
    using editor = buildEditorFromExtensions({
      $initialEditorState: null,
      dependencies: [
        configExtension(AutoLinkExtension, {
          matchers: [text => (enabled ? autoLinkUrlMatcher(text) : null)],
        }),
        configExtension(HistoryExtension, {disabled: false}),
      ],
      name: '[autolink DOM history]',
    });
    const root = document.createElement('div');
    editor.setRootElement(root);
    let key = '';
    editor.update(
      () => {
        const first = $setState(
          $createTextNode(several ? 'https://a' : 'https://a.co')
            .setFormat(8)
            .setStyle('color: red;'),
          state,
          'comment',
        );
        key = first.getKey();
        const paragraph = $createParagraphNode().append(first);
        if (several) {
          paragraph.append($createTextNode('.co').setFormat(1));
        }
        $getRoot().append(paragraph);
        first.select(5, 5);
      },
      {discrete: true, tag: HISTORY_PUSH_TAG},
    );
    const originalDOM = editor.getElementByKey(key);
    expect(originalDOM).not.toBe(null);
    const textMutations: [string, string][] = [];
    const linkMutations: string[] = [];
    editor.registerMutationListener(
      TextNode,
      mutations => textMutations.push(...mutations),
      {skipInitialization: true},
    );
    editor.registerMutationListener(
      AutoLinkNode,
      mutations => linkMutations.push(...mutations.values()),
      {skipInitialization: true},
    );
    const updates: {tag: boolean; previous: string; next: string}[] = [];
    editor.registerUpdateListener(({tags, prevEditorState, editorState}) => {
      updates.push({
        next: editorState.read(
          () => $getNodeByKey(key)?.getParent()?.getType() ?? 'missing',
        ),
        previous: prevEditorState.read(
          () => $getNodeByKey(key)?.getParent()?.getType() ?? 'missing',
        ),
        tag: tags.has('autolink-dom-history'),
      });
    });
    enabled = true;
    editor.update(() => $getNodeByKey(key)?.markDirty(), {
      discrete: true,
      tag: [HISTORY_PUSH_TAG, 'autolink-dom-history'],
    });
    expect(editor.getElementByKey(key)).toBe(originalDOM);
    expect(originalDOM?.parentElement?.tagName).toBe('A');
    expect(root.textContent).toBe('https://a.co');
    expect(textMutations.filter(([changed]) => changed === key)).toEqual([
      [key, 'updated'],
    ]);
    expect(linkMutations).toEqual(['created']);
    expect(updates).toEqual([
      {next: 'autolink', previous: 'paragraph', tag: true},
    ]);
    const check = (parent: string) =>
      editor.read(() => {
        const node = $getNodeByKey(key);
        expect(node?.getParent()?.getType()).toBe(parent);
        expect(node?.isAttached()).toBe(true);
        expect(node && $getState(node, state)).toBe('comment');
        const selection = $getSelection();
        expect($isRangeSelection(selection)).toBe(true);
        if ($isRangeSelection(selection)) {
          expect(selection.anchor.key).toBe(key);
          expect(selection.anchor.offset).toBe(5);
          expect(selection.focus.key).toBe(key);
          expect(selection.focus.offset).toBe(5);
        }
        expect($getRoot().getTextContent()).toBe('https://a.co');
      });
    check('autolink');
    editor.dispatchCommand(UNDO_COMMAND, undefined);
    check('paragraph');
    expect(editor.getElementByKey(key)?.style.color).toBe('red');
    expect(root.querySelector('a')).toBe(null);
    editor.dispatchCommand(REDO_COMMAND, undefined);
    check('autolink');
    expect(editor.getElementByKey(key)?.style.color).toBe('red');
    expect(root.querySelector('a')?.textContent).toBe('https://a.co');
  },
);
