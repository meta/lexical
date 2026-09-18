/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {EditorRefPlugin} from '@lexical/react/LexicalEditorRefPlugin';
import {
  $createHorizontalRuleNode,
  HorizontalRuleNode,
} from '@lexical/react/LexicalHorizontalRuleNode';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {useLexicalNodeSelection} from '@lexical/react/useLexicalNodeSelection';
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $selectAll,
  type LexicalEditor,
  type NodeKey,
} from 'lexical';
import * as React from 'react';
import {act, createRef} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

describe('useLexicalNodeSelection', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;
  let editor: LexicalEditor;
  let editorRef: React.RefObject<LexicalEditor>;
  let setSelected: (selected: boolean) => void;
  let ruleKey: NodeKey;

  function Probe({nodeKey}: {nodeKey: NodeKey}) {
    [, setSelected] = useLexicalNodeSelection(nodeKey);
    return null;
  }

  function Seed({onSeeded}: {onSeeded: (key: NodeKey) => void}) {
    const [contextEditor] = useLexicalComposerContext();
    React.useEffect(() => {
      let key = '';
      contextEditor.update(
        () => {
          const rule = $createHorizontalRuleNode();
          $getRoot()
            .clear()
            .append(
              $createParagraphNode().append($createTextNode('hello')),
              rule,
            );
          key = rule.getKey();
        },
        {discrete: true},
      );
      onSeeded(key);
    }, [contextEditor, onSeeded]);
    return null;
  }

  function Harness() {
    const [key, setKey] = React.useState<NodeKey | null>(null);
    const onSeeded = React.useCallback((seeded: NodeKey) => {
      ruleKey = seeded;
      setKey(seeded);
    }, []);
    return (
      <LexicalComposer
        initialConfig={{
          namespace: 'node-selection',
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
        <Seed onSeeded={onSeeded} />
        {key !== null && <Probe nodeKey={key} />}
      </LexicalComposer>
    );
  }

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);
    editorRef = createRef<LexicalEditor>() as React.RefObject<LexicalEditor>;

    await act(async () => {
      reactRoot.render(<Harness />);
    });
    editor = editorRef.current;
  });

  afterEach(async () => {
    await act(async () => {
      reactRoot.unmount();
    });
    container.remove();
  });

  it('keeps a range selection that does not cover the node', () => {
    act(() => {
      // A caret in the paragraph, which does not reach the horizontal rule.
      editor.update(() => void $getRoot().getFirstChild()!.selectEnd(), {
        discrete: true,
      });
      expect(editor.read(() => $getNodeByKey(ruleKey)!.isSelected())).toBe(
        false,
      );
    });

    // Deselecting a node the selection does not reach has nothing to do, so it
    // must not discard the user's caret to say so.
    act(() => {
      setSelected(false);
    });

    act(() => {
      expect(editor.read(() => $isRangeSelection($getSelection()))).toBe(true);
    });
  });

  it('deselects a node the range selection does cover', () => {
    act(() => {
      editor.update(() => void $selectAll(), {discrete: true});
      // LexicalNode.isSelected() is true for a RangeSelection that covers the
      // node, so the `clearSelection(); setSelected(!isSelected)` toggle used by
      // HorizontalRuleNode, BlockWithAlignableContents and the playground
      // decorators arrives here with `false`. Ignoring it makes those a dead
      // click: isSelected stays true, so the node can never be selected.
      expect(editor.read(() => $getNodeByKey(ruleKey)!.isSelected())).toBe(
        true,
      );
    });

    act(() => {
      setSelected(false);
    });

    act(() => {
      expect(editor.read(() => $getNodeByKey(ruleKey)!.isSelected())).toBe(
        false,
      );
    });
  });

  it('still creates a node selection when asked to select', () => {
    act(() => {
      editor.update(() => void $selectAll(), {discrete: true});
    });

    act(() => {
      setSelected(true);
    });

    act(() => {
      expect(
        editor.read(() => {
          const selection = $getSelection();
          return $isNodeSelection(selection) && selection.has(ruleKey);
        }),
      ).toBe(true);
    });
  });

  it('still removes the node from an existing node selection', () => {
    act(() => {
      setSelected(true);
    });
    act(() => {
      expect(
        editor.read(() => {
          const selection = $getSelection();
          return $isNodeSelection(selection) && selection.has(ruleKey);
        }),
      ).toBe(true);
    });

    act(() => {
      setSelected(false);
    });
    act(() => {
      expect(editor.read(() => $getNodeByKey(ruleKey)!.isSelected())).toBe(
        false,
      );
    });
  });
});
