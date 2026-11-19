/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment jsdom

// A composes in "abc" (an app's TextNode whose selectionTransform appends
// "!" to the last line once a paragraph's NodeState flag has survived a
// commit), inside an inline element. B bolds "abc" (held); C sets the flag.
// Whatever the binding does to foresee A's next update must not run an
// update of its own, tagged as remote: the hook would run in it, and its
// edit would never be written (A showing "tail!", the others "tail", also
// after the release). The binding foresees the next update read-only (see
// YBinding#foreseeNextUpdate): A's own next update runs the hook, and its
// edit is stored, as on main.

import {
  $create,
  $createParagraphNode,
  $createTextNode,
  $getDocument,
  $getEditor,
  $getRoot,
  $getState,
  $hasUpdateTag,
  $setCompositionKey,
  $setSelection,
  $setState,
  type BaseSelection,
  COLLABORATION_TAG,
  createState,
  ElementNode,
  type LexicalEditor,
  ParagraphNode,
  type RangeSelection,
  TextNode,
} from 'lexical';
import {expect, onTestFinished, test} from 'vitest';

import {freshReader, NODES, setup} from '../../utils/harness';

const enabled = createState('hook_enabled', {parse: v => v === true});
class SwitchParagraph extends ParagraphNode {
  $config() {
    return this.config('hook_switch_paragraph', {
      extends: ParagraphNode,
      stateConfigs: [{stateConfig: enabled}],
    });
  }
}
class Box extends ElementNode {
  $config() {
    return this.config('hook_box', {
      children: 'inline',
      extends: ElementNode,
    });
  }
  isInline(): true {
    return true;
  }
  createDOM() {
    return $getDocument().createElement('span');
  }
  updateDOM(): false {
    return false;
  }
}
// An idempotent app reaction, deferred until its enabling state has survived
// a committed update. selectionTransform is a public mutator hook.
const done = new WeakSet<LexicalEditor>();
const calls = new WeakMap<LexicalEditor, unknown[]>();
class HookText extends TextNode {
  $config() {
    return this.config('hook_text', {extends: TextNode});
  }
  selectionTransform(_prev: BaseSelection | null, _next: RangeSelection) {
    const editor = $getEditor();
    const current = $getState($getRoot().getFirstChild()!, enabled);
    const previous = editor.getEditorState().read(() => {
      const p = $getRoot().getFirstChild();
      return p === null ? false : $getState(p, enabled);
    });
    if (
      !current ||
      !previous ||
      editor._compositionKey === null ||
      done.has(editor)
    )
      return;
    done.add(editor);
    calls.set(editor, [
      ...(calls.get(editor) ?? []),
      {current, previous, remote: $hasUpdateTag(COLLABORATION_TAG)},
    ]);
    const last = (
      $getRoot().getLastChildOrThrow() as ElementNode
    ).getLastDescendant() as TextNode;
    last.setTextContent(last.getTextContent() + '!');
  }
}
for (const gc of [false, true])
  for (const ids of [
    [1, 2, 3],
    [3, 2, 1],
  ])
    test(`an app's selection transform that edits in the composer's next update has its edit stored (gc ${gc}, ids ${ids})`, async () => {
      const t = await setup(
        () => {
          $getRoot().append(
            $create(SwitchParagraph).append(
              $create(Box).append($create(HookText).setTextContent('abc')),
            ),
            $createParagraphNode().append($createTextNode('tail')),
          );
        },
        {gc, ids, nodes: [...NODES, SwitchParagraph, Box, HookText]},
      );
      const {a, b, c} = t;
      const host = document.createElement('div');
      host.contentEditable = 'true';
      document.body.append(host);
      a.editor.setRootElement(host);
      host.focus();
      onTestFinished(() => {
        a.editor.setRootElement(null);
        host.remove();
        t.peers.forEach(p => p.stop());
      });
      let key = '';
      a.update(() => {
        const n = $getRoot().getAllTextNodes()[0];
        key = n.getKey();
        n.select(1, 1);
        $setCompositionKey(key);
      });
      a.update(() => {});
      expect(a.editor._compositionKey).toBe(key);
      const dom = a.editor.getElementByKey(key)!.firstChild!;
      b.update(() => {
        $getRoot().getAllTextNodes()[0].select(0, 3).formatText('bold');
        $setSelection(null);
      });
      await t.sync();
      c.update(() => {
        $setState($getRoot().getFirstChild()!, enabled, true);
        $setSelection(null);
      });
      await t.sync();
      const before = {
        dom: dom.isConnected,
        key: a.editor._compositionKey,
      };
      // A's real next update invokes the same hook locally on main.
      a.update(() => {});
      await t.sync();
      a.update(() => $setCompositionKey(null));
      await t.sync();
      const fresh = await freshReader(a);
      expect(before.key).toBe(key);
      expect(before.dom).toBe(true);
      expect(a.describe()).toBe(fresh.describe());
      expect(a.read(() => $getRoot().getTextContent())).toContain('tail!');
      for (const p of t.peers) {
        expect(p.describe()).toBe(a.describe());
      }
    });
