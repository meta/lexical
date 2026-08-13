/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $create,
  $createParagraphNode,
  $getDocument,
  $getEditor,
  $getNodeByKey,
  $getRoot,
  $getState,
  $setState,
  createState,
  DecoratorNode,
  defineExtension,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type NodeStateVersion,
} from 'lexical';
import {$assertNodeType} from 'lexical/src/__tests__/utils';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const labelState = createState('label', {
  parse: v => (v ? String(v) : 'hello'),
});
class ReactDecoratorNode extends DecoratorNode<React.ReactNode> {
  $config() {
    return this.config('react-decorator-portal-rev', {extends: DecoratorNode});
  }

  createDOM(_config: EditorConfig, editor: LexicalEditor): HTMLElement {
    return $getDocument().createElement('div');
  }

  updateDOM(): boolean {
    return false;
  }

  setLabel(label: string): this {
    return $setState(this, labelState, label);
  }

  getLabel(version?: NodeStateVersion): string {
    return $getState(this, labelState, version);
  }

  decorate(): React.ReactNode {
    return <span data-testid="decorator-portal">{this.getLabel()}</span>;
  }
}

function $createReactDecoratorNode(label: string): ReactDecoratorNode {
  return $create(ReactDecoratorNode).setLabel(label);
}

function $isReactDecoratorNode(
  node: LexicalNode | null | undefined,
): node is ReactDecoratorNode {
  return node instanceof ReactDecoratorNode;
}

describe('useDecorators root remount', () => {
  let container: HTMLDivElement | null = null;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    reactRoot = createRoot(container);
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container!);
    container = null;
    vi.restoreAllMocks();
  });

  test('recreates decorator portals after root detach/attach without decorator map changes', async () => {
    let editor!: LexicalEditor;
    let decoratorKey!: NodeKey;

    function App() {
      return (
        <LexicalComposer
          initialConfig={{
            editorState: () => {
              editor = $getEditor();
              const decorator = $createReactDecoratorNode('hello');
              decoratorKey = decorator.getKey();
              $getRoot().append($createParagraphNode(), decorator);
            },
            namespace: '',
            nodes: [ReactDecoratorNode],
            onError: err => {
              throw err;
            },
            theme: {},
          }}>
          <RichTextPlugin
            contentEditable={<ContentEditable />}
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
        </LexicalComposer>
      );
    }

    await act(async () => {
      reactRoot.render(<App />);
    });

    expect(editor).toBeDefined();
    expect(decoratorKey).toBeDefined();
    expect(
      container!.querySelector('[data-testid="decorator-portal"]')?.textContent,
    ).toBe('hello');

    const previousRoot = editor!.getRootElement();
    expect(previousRoot).not.toBeNull();

    // Detach the root, then refresh decorators while getElementByKey is null so
    // portal creation is skipped (same race as remount-before-root-attach).
    await act(async () => {
      editor.setRootElement(null);
    });

    await act(async () => {
      editor!.update(() => {
        const node = $assertNodeType(
          $getNodeByKey(decoratorKey!),
          $isReactDecoratorNode,
        );
        // Force a decorator refresh without changing rendered content.
        node.setLabel('hello');
      });
    });

    expect(
      container!.querySelector('[data-testid="decorator-portal"]'),
    ).toBeNull();

    const nextRoot = document.createElement('div');
    nextRoot.contentEditable = 'true';
    container!.appendChild(nextRoot);

    await act(async () => {
      editor.setRootElement(nextRoot);
    });

    expect(editor.getRootElement()).toBe(nextRoot);
    expect(editor.getRootElement()).not.toBe(previousRoot);
    expect(
      container!.querySelector('[data-testid="decorator-portal"]')?.textContent,
    ).toBe('hello');
  });
});

describe('useReactDecorators root remount', () => {
  let container: HTMLDivElement | null = null;
  let reactRoot: Root;

  beforeEach(() => {
    container = document.createElement('div');
    reactRoot = createRoot(container);
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container!);
    container = null;
    vi.restoreAllMocks();
  });

  test('recreates decorator portals after root detach/attach without decorator map changes', async () => {
    let editor!: LexicalEditor;
    let decoratorKey!: NodeKey;

    const extension = defineExtension({
      $initialEditorState: () => {
        editor = $getEditor();
        const decorator = $createReactDecoratorNode('hello');
        decoratorKey = decorator.getKey();
        $getRoot().append($createParagraphNode(), decorator);
      },
      dependencies: [RichTextExtension],
      name: '[test-useReactDecorators-root-remount]',
      nodes: [ReactDecoratorNode],
    });

    function App() {
      return <LexicalExtensionComposer extension={extension} />;
    }

    await act(async () => {
      reactRoot.render(<App />);
    });

    expect(editor).toBeDefined();
    expect(decoratorKey).toBeDefined();
    expect(
      container!.querySelector('[data-testid="decorator-portal"]')?.textContent,
    ).toBe('hello');

    const previousRoot = editor.getRootElement();
    expect(previousRoot).not.toBeNull();

    await act(async () => {
      editor.setRootElement(null);
    });

    await act(async () => {
      editor.update(() => {
        const node = $assertNodeType(
          $getNodeByKey(decoratorKey),
          $isReactDecoratorNode,
        );
        node.setLabel('hello');
      });
    });

    expect(
      container!.querySelector('[data-testid="decorator-portal"]'),
    ).toBeNull();

    const nextRoot = document.createElement('div');
    nextRoot.contentEditable = 'true';
    container!.appendChild(nextRoot);

    await act(async () => {
      editor.setRootElement(nextRoot);
    });

    expect(editor.getRootElement()).toBe(nextRoot);
    expect(editor.getRootElement()).not.toBe(previousRoot);
    expect(
      container!.querySelector('[data-testid="decorator-portal"]')?.textContent,
    ).toBe('hello');
  });
});
