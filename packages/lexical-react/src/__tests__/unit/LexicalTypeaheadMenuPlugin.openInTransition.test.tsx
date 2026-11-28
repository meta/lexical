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
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {RichTextPlugin} from '@lexical/react/LexicalRichTextPlugin';
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  type MenuRenderFn,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import {
  $createParagraphNode,
  $getRoot,
  type LexicalEditor,
  ParagraphNode,
} from 'lexical';
import * as React from 'react';
import {act, startTransition} from 'react';
import ReactDOM from 'react-dom';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, assert, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {...actual, startTransition: vi.fn(actual.startTransition)};
});

class TestMenuOption extends MenuOption {
  title: string;
  constructor(title: string) {
    super(title);
    this.title = title;
  }
}

const TEST_OPTIONS = [new TestMenuOption('Alpha')];

describe('LexicalTypeaheadMenuPlugin openInTransition', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;

  beforeEach(() => {
    class ResizeObserverMock {
      constructor(_callback: unknown) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);

    container = document.createElement('div');
    document.body.appendChild(container);
    reactRoot = createRoot(container);
    vi.mocked(startTransition).mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      reactRoot.unmount();
    });
    document.body.removeChild(container);
    vi.unstubAllGlobals();
  });

  const menuRenderFn: MenuRenderFn<TestMenuOption> = (
    anchorElementRef,
    itemProps,
  ) => {
    return anchorElementRef.current && itemProps.options.length
      ? ReactDOM.createPortal(
          <div
            className="custom-typeahead-menu"
            data-testid="custom-typeahead"
          />,
          anchorElementRef.current,
        )
      : null;
  };

  function Harness({openInTransition}: {openInTransition?: boolean}) {
    const checkForTriggerMatch = useBasicTypeaheadTriggerMatch('/', {
      minLength: 0,
    });
    return (
      <LexicalTypeaheadMenuPlugin<TestMenuOption>
        onQueryChange={vi.fn()}
        onSelectOption={vi.fn()}
        triggerFn={checkForTriggerMatch}
        options={TEST_OPTIONS}
        menuRenderFn={menuRenderFn}
        openInTransition={openInTransition}
      />
    );
  }

  async function typeTrigger(openInTransition?: boolean): Promise<void> {
    const editorRef = React.createRef<LexicalEditor>();

    await act(async () => {
      reactRoot.render(
        <LexicalComposer
          initialConfig={{
            namespace: 'test-typeahead-open-in-transition',
            nodes: [ParagraphNode],
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
          <EditorRefPlugin editorRef={editorRef} />
          <Harness openInTransition={openInTransition} />
        </LexicalComposer>,
      );
    });

    const editor = editorRef.current;
    assert(editor !== null, 'expected the editor ref to be populated');

    vi.mocked(startTransition).mockClear();

    await act(async () => {
      editor.update(() => {
        $getRoot()
          .clear()
          .append($createParagraphNode())
          .select()
          .insertText('/');
      });
    });
  }

  it('routes the open through startTransition by default', async () => {
    await typeTrigger();

    expect(startTransition).toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="custom-typeahead"]'),
    ).not.toBeNull();
  });

  it('opens without startTransition when openInTransition is false', async () => {
    await typeTrigger(false);

    expect(startTransition).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="custom-typeahead"]'),
    ).not.toBeNull();
  });
});
