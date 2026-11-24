/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {EditorRefPlugin} from '@lexical/react/LexicalEditorRefPlugin';
import {
  $createHorizontalRuleNode,
  HorizontalRuleNode,
} from '@lexical/react/LexicalHorizontalRuleNode';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  IS_APPLE,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';
import {act, createRef, type RefObject} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, assert, beforeEach, describe, expect, it} from 'vitest';

describe('HorizontalRuleNode click selection', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;
  let editor: LexicalEditor;
  let textKey: NodeKey;
  let ruleKeys: NodeKey[];

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);
    const editorRef = createRef<LexicalEditor>() as RefObject<LexicalEditor>;

    await act(async () => {
      reactRoot.render(
        <LexicalComposer
          initialConfig={{
            namespace: 'horizontal-rule',
            nodes: [HorizontalRuleNode],
            onError: (error: Error) => {
              throw error;
            },
          }}>
          <EditorRefPlugin editorRef={editorRef} />
          <RichTextPlugin
            contentEditable={<ContentEditable />}
            ErrorBoundary={({children}) => <>{children}</>}
          />
        </LexicalComposer>,
      );
    });
    editor = editorRef.current;
    await act(async () => {
      editor.update(
        () => {
          const text = $createTextNode('hello');
          const rules = [
            $createHorizontalRuleNode(),
            $createHorizontalRuleNode(),
          ];
          $getRoot()
            .clear()
            .append($createParagraphNode().append(text), ...rules);
          textKey = text.getKey();
          ruleKeys = rules.map(rule => rule.getKey());
          text.select(2, 2);
        },
        {discrete: true},
      );
    });
  });

  afterEach(async () => {
    await act(async () => {
      reactRoot.unmount();
    });
    container.remove();
  });

  async function click(index: number, init: MouseEventInit = {}) {
    const element = editor.getElementByKey(ruleKeys[index]);
    assert(element !== null);
    await act(async () => {
      element.dispatchEvent(
        new MouseEvent('click', {bubbles: true, cancelable: true, ...init}),
      );
    });
  }

  function getSelectedKeys(): null | NodeKey[] {
    return editor.read(() => {
      const selection = $getSelection();
      return $isNodeSelection(selection)
        ? selection.getNodes().map(node => node.getKey())
        : null;
    });
  }

  it('extends the range with Shift-click', async () => {
    await click(0, {shiftKey: true});

    editor.read(() => {
      const selection = $getSelection();
      assert($isRangeSelection(selection));
      expect(selection.anchor.key).toBe(textKey);
      expect(selection.anchor.offset).toBe(2);
      expect(selection.getNodes().map(node => node.getKey())).toContain(
        ruleKeys[0],
      );
    });
  });

  it('selects a rule covered by a range with a plain click', async () => {
    await click(0, {shiftKey: true});
    expect(getSelectedKeys()).toBeNull();

    await click(0);
    expect(getSelectedKeys()).toEqual([ruleKeys[0]]);
  });

  it('deselects a selected rule with a plain click', async () => {
    await click(0);
    expect(getSelectedKeys()).toEqual([ruleKeys[0]]);

    await click(0);
    expect(getSelectedKeys() ?? []).toEqual([]);
  });

  it('toggles rules independently with the platform modifier', async () => {
    const modifier = IS_APPLE ? {metaKey: true} : {ctrlKey: true};
    await click(0, modifier);
    await click(1, modifier);
    expect(getSelectedKeys()).toEqual(ruleKeys);

    await click(0, modifier);
    expect(getSelectedKeys()).toEqual([ruleKeys[1]]);
  });
});
