/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {
  type Binding,
  createBinding,
  type Provider,
  type ProviderAwareness,
  syncCursorPositions,
  type UserState,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $setSelection,
  defineExtension,
} from 'lexical';
import {afterEach, assert, describe, expect, test} from 'vitest';
import {Doc} from 'yjs';

import {syncLexicalSelectionToYjs} from '../../SyncCursors';

// Runs in a real browser rather than jsdom: `updateCursor` bails out as soon as
// `cursorsContainer.offsetParent` is null, which is always the case under
// jsdom, and the caret it builds is positioned from real `DOMRect`s. Those are
// exactly the parts that carry a peer's name and colour, so a jsdom test can
// only observe the fields on the `Cursor` record and would pass against a fix
// that left the rendered caret stale.

const REMOTE_CLIENT_ID = 4242;

describe('syncCursorPositions awareness refresh', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    let cleanup: undefined | (() => void);
    while ((cleanup = cleanups.pop())) {
      cleanup();
    }
  });

  /**
   * A mounted editor holding `ab cd`, bound to a Yjs doc that already has the
   * content synced, plus a cursors container attached to the page.
   */
  function mountEditorWithBinding(): {
    binding: Binding;
    cursorsContainer: HTMLElement;
    editor: LexicalEditorWithDispose;
  } {
    const rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    const cursorsContainer = document.createElement('div');
    cursorsContainer.style.position = 'relative';
    document.body.append(rootElement, cursorsContainer);

    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[cursor-awareness-browser]',
      }),
    );
    cleanups.push(() => {
      editor.dispose();
      rootElement.remove();
      cursorsContainer.remove();
    });
    editor.setRootElement(rootElement);
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('ab cd'));
        $getRoot().clear().append(paragraph);
      },
      {discrete: true},
    );

    const doc = new Doc();
    const binding = createBinding(
      editor,
      null as unknown as Provider,
      'cursor-awareness-browser',
      doc,
      new Map<string, Doc>([['cursor-awareness-browser', doc]]),
    );
    binding.cursorsContainer = cursorsContainer;
    editor.read(() => {
      doc.transact(() => {
        binding.root.syncChildrenFromLexical(
          binding,
          $getRoot(),
          null,
          null,
          null,
        );
      });
    });

    return {binding, cursorsContainer, editor};
  }

  /**
   * Encode a non-collapsed selection over the paragraph the way a peer would
   * publish it, so `syncCursorPositions` has real relative positions to decode.
   * A collapsed caret produces no selection rects, and the legacy overlay path
   * only attaches the caret to a rect.
   */
  function remoteUserState(
    binding: Binding,
    editor: LexicalEditorWithDispose,
  ): UserState {
    let localState: UserState = {
      anchorPos: null,
      awarenessData: {},
      color: '#000000',
      focusPos: null,
      focusing: true,
      name: 'peer',
    };
    const provider = {
      awareness: {
        getLocalState: () => localState,
        setLocalState: (state: UserState | null) => {
          assert(state !== null);
          localState = state;
        },
      } as unknown as ProviderAwareness,
    } as unknown as Provider;

    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChild();
        assert($isElementNode(paragraph));
        const text = paragraph.getFirstChildOrThrow();
        const selection = $createRangeSelection();
        selection.anchor.set(text.getKey(), 0, 'text');
        selection.focus.set(text.getKey(), 5, 'text');
        $setSelection(selection);
      },
      {discrete: true},
    );
    editor.read(() => {
      syncLexicalSelectionToYjs(binding, provider, null, $getSelection());
    });
    assert(localState.anchorPos !== null && localState.focusPos !== null);
    return localState;
  }

  function sync(
    binding: Binding,
    state: UserState,
    selectionHighlight = false,
  ): void {
    syncCursorPositions(binding, null as unknown as Provider, {
      getAwarenessStates: () =>
        new Map<number, UserState>([[REMOTE_CLIENT_ID, state]]),
      selectionHighlight,
    });
  }

  test('a renamed peer has its rendered caret label updated', () => {
    const {binding, cursorsContainer, editor} = mountEditorWithBinding();
    const state = remoteUserState(binding, editor);

    sync(binding, {...state, color: '#ff0000', name: 'Bob'});
    const cursor = binding.cursors.get(REMOTE_CLIENT_ID);
    assert(cursor !== undefined && cursor.selection !== null);
    expect(cursorsContainer.textContent).toBe('Bob');
    // `cursors` holds one mutable record per peer, so hold on to the DOM the
    // first sync built before the second one replaces it.
    const staleCaret = cursor.selection.caret;

    sync(binding, {...state, color: '#ff0000', name: 'Robert'});
    assert(cursor.selection !== null);
    // The label lives in the caret DOM built by `createCursorSelection`, so the
    // selection has to be rebuilt for the new name to render. An exact match
    // also rules out a leftover 'Bob' caret alongside the new one.
    expect(cursorsContainer.textContent).toBe('Robert');
    expect(staleCaret.isConnected).toBe(false);
  });

  test('a recoloured peer has its rendered caret recoloured', () => {
    const {binding, editor} = mountEditorWithBinding();
    const state = remoteUserState(binding, editor);

    sync(binding, {...state, color: 'rgb(255, 0, 0)', name: 'Bob'});
    const cursor = binding.cursors.get(REMOTE_CLIENT_ID);
    assert(cursor !== undefined && cursor.selection !== null);
    expect(cursor.selection.caret.style.backgroundColor).toBe('rgb(255, 0, 0)');
    const staleCaret = cursor.selection.caret;
    const staleSelections = cursor.selection.selections;

    sync(binding, {...state, color: 'rgb(0, 0, 255)', name: 'Bob'});
    assert(cursor.selection !== null);
    expect(cursor.selection.caret.style.backgroundColor).toBe('rgb(0, 0, 255)');
    // The old overlay is torn down rather than left painting the old colour
    // underneath the new one.
    expect(staleCaret.isConnected).toBe(false);
    expect(staleSelections.some(el => el.isConnected)).toBe(false);
  });

  test('a recoloured peer has its ::highlight() rule recoloured', () => {
    const {binding, editor} = mountEditorWithBinding();
    const state = remoteUserState(binding, editor);
    const highlightRules = () => {
      const sheet = binding.cursorHighlightSheet;
      return sheet === null
        ? []
        : Array.from(sheet.cssRules, rule => (rule as CSSStyleRule).cssText);
    };

    sync(binding, {...state, color: 'rgb(255, 0, 0)', name: 'Bob'}, true);
    expect(highlightRules()).toHaveLength(1);
    expect(highlightRules()[0]).toContain('rgb(255, 0, 0)');

    sync(binding, {...state, color: 'rgb(0, 0, 255)', name: 'Bob'}, true);
    // Replaced, not appended: a leftover rule for the same highlight name would
    // keep painting the old colour.
    expect(highlightRules()).toHaveLength(1);
    expect(highlightRules()[0]).toContain('rgb(0, 0, 255)');
  });

  test('an unchanged peer keeps the same rendered caret', () => {
    const {binding, editor} = mountEditorWithBinding();
    const state = remoteUserState(binding, editor);

    sync(binding, {...state, color: '#ff0000', name: 'Bob'});
    const first = binding.cursors.get(REMOTE_CLIENT_ID);
    assert(first !== undefined && first.selection !== null);
    const caret = first.selection.caret;

    sync(binding, {...state, color: '#ff0000', name: 'Bob'});
    expect(binding.cursors.get(REMOTE_CLIENT_ID)).toBe(first);
    expect(first.selection.caret).toBe(caret);
    expect(caret.isConnected).toBe(true);
  });
});
