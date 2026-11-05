/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// @vitest-environment jsdom

import * as Y from '@y/y';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

import {$selectIn, freshReader, setup} from '../../utils/harness';

// An app's mutation listener that edits the document (appends '#' to the
// last line, at most four times), in an editor with a DOM root: Lexical runs
// the update it makes at once, while it still notifies the listeners of the
// commit that triggered it.
// `variant`: 'discrete' makes the listener's update discrete; 'burst' applies
// the last remote change as three transactions in one task (each read runs
// the listener); 'queued' adds an app update listener that queues an update
// in the same commit as the listener's.
// 'local': the listener edits after two local commits in one task, with no
// remote change; 'inside': a provider applies a remote change inside a local
// update made after an earlier commit in the task, whose commit runs the
// listener.
type Variant = 'plain' | 'discrete' | 'burst' | 'queued' | 'local' | 'inside';

async function run(gc: boolean, variant: Variant) {
  const discrete = variant === 'discrete';
  const t = await setup(
    () =>
      $getRoot().append(
        $createParagraphNode().append($createTextNode('zero')),
        $createParagraphNode().append($createTextNode('two')),
      ),
    {gc, ids: [1, 2, 3]},
  );
  const {a, b} = t;
  const host = document.createElement('div');
  host.contentEditable = 'true';
  document.body.append(host);
  a.editor.setRootElement(host);
  let made = 0;
  // 'burst': the listener edits only while the three transactions are read.
  let armed =
    variant !== 'burst' && variant !== 'local' && variant !== 'inside';
  const limit =
    variant === 'burst'
      ? 3
      : variant === 'local' || variant === 'inside'
        ? 2
        : 4;
  a.editor.registerMutationListener(
    TextNode,
    mutations => {
      if (armed && made < limit && mutations.size > 0) {
        made++;
        a.editor.update(
          () => {
            const last = $getRoot().getLastChild();
            const text = $isElementNode(last) ? last.getLastDescendant() : null;
            if ($isTextNode(text)) {
              text.setTextContent(text.getTextContent() + '#');
            }
          },
          discrete ? {discrete: true} : undefined,
        );
      }
    },
    {skipInitialization: true},
  );
  if (variant === 'queued') {
    let queued = 0;
    a.editor.registerUpdateListener(({dirtyLeaves}) => {
      if (queued < 2 && dirtyLeaves.size > 0) {
        queued++;
        a.editor.update(() => {
          const selection = $selectIn([0], 0);
          selection.insertText('@');
        });
      }
    });
  }
  b.update(() => {
    $selectIn([0], 0, 2).formatText('bold');
    $setSelection(null);
  });
  await t.sync();
  a.update(() => {
    $selectIn([0], 1, 1);
  });
  await Promise.resolve();
  await t.sync();
  if (variant === 'local') {
    armed = true;
    a.update(() => {
      $selectIn([0], 0, 1).formatText('underline');
      $setSelection(null);
    });
    a.update(() => {
      $selectIn([0], 2, 3).formatText('underline');
      $setSelection(null);
    });
  } else if (variant === 'inside') {
    t.offline();
    b.update(() => {
      $selectIn([0], 2, 3).formatText('italic');
      $setSelection(null);
    });
    const remote = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
    a.update(() => {
      $selectIn([0], 0, 1).formatText('underline');
      $setSelection(null);
    });
    armed = true;
    a.update(() => {
      $selectIn([0], 3, 4).formatText('underline');
      $setSelection(null);
      Y.applyUpdate(a.doc, remote, 'provider');
    });
  } else if (variant === 'burst') {
    armed = true;
    for (const [from, to] of [
      [2, 3],
      [0, 1],
      [1, 2],
    ]) {
      b.editor.update(
        () => {
          $selectIn([0], from, to).formatText('italic');
          $setSelection(null);
        },
        {discrete: true},
      );
    }
  } else {
    b.update(() => {
      $selectIn([0], 2, 3).formatText('italic');
      $setSelection(null);
    });
  }
  await t.sync();
  expect(made).toBe(limit);
  // Each listener edit is stored once, as the editor shows it.
  const text = a.read(() => $getRoot().getTextContent());
  expect(text.endsWith('\n\ntwo' + '#'.repeat(limit))).toBe(true);
  expect(a.describe()).toBe((await freshReader(a)).describe());
  expect(b.describe()).toBe(a.describe());
  host.remove();
}

describe.each([false, true])('an edit a mutation listener makes, gc %s', gc => {
  test('is stored as the editor shows it', () => run(gc, 'plain'));
  test('with remote transactions read in one task: is stored as the editor shows it', () =>
    run(gc, 'burst'));
  test('with an update an update listener queues: is stored as the editor shows it', () =>
    run(gc, 'queued'));
  test('after two local commits in one task: is stored as the editor shows it', () =>
    run(gc, 'local'));
  test('with a remote change applied inside the local update: is stored as the editor shows it', () =>
    run(gc, 'inside'));
  // An app's own discrete update commits inside Lexical's notification of
  // the commit that triggered the listener, without the binding forcing it:
  // https://github.com/meta/lexical/issues/9799
  test.fails('in a discrete update: is stored as the editor shows it', () =>
    run(gc, 'discrete'),
  );
});
