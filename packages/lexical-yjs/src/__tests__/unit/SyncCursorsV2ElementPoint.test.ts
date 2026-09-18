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
  $getAnchorAndFocusForUserState,
  createBindingV2__EXPERIMENTAL,
  type Provider,
  type ProviderAwareness,
  type UserState,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $setSelection,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {
  $createTestDecoratorNode,
  TestDecoratorNode,
} from 'lexical/src/__tests__/utils';
import {afterEach, assert, describe, expect, test} from 'vitest';
import {Doc} from 'yjs';

import {syncLexicalSelectionToYjs} from '../../SyncCursors';
import {$updateYFragment} from '../../SyncV2';

// In collab-v2 a run of adjacent TextNodes is serialized as a single XmlText
// child (see normalizeNodeContent in SyncV2), so a paragraph whose lexical
// children are [Text, Text, Decorator] has only two yjs children:
// [XmlText, XmlElement]. An element-type selection point therefore has to be
// converted from a lexical child offset into a yjs child index.
describe('collab-v2 element selection points', () => {
  const editors: LexicalEditorWithDispose[] = [];
  afterEach(() => {
    for (const editor of editors) {
      editor.dispose();
    }
    editors.length = 0;
  });

  function createAwareness(): {
    awareness: ProviderAwareness;
    getState: () => UserState | null;
  } {
    let localState: UserState | null = {
      anchorPos: null,
      awarenessData: {},
      color: '#000000',
      focusPos: null,
      focusing: true,
      name: 'test',
    };
    return {
      awareness: {
        getLocalState: () => localState,
        getStates: () => new Map(),
        off: () => {},
        on: () => {},
        setLocalState: (state: UserState | null) => {
          localState = state;
        },
        setLocalStateField: (field: string, value: unknown) => {
          if (localState !== null) {
            localState = {...localState, [field]: value};
          }
        },
      } as unknown as ProviderAwareness,
      getState: () => localState,
    };
  }

  function buildBinding() {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[v2-element-point]',
        nodes: [TestDecoratorNode],
      }),
    );
    editors.push(editor);
    const doc = new Doc();
    const docMap = new Map<string, Doc>([['v2-element-point', doc]]);
    const binding = createBindingV2__EXPERIMENTAL(
      editor,
      'v2-element-point',
      doc,
      docMap,
    );
    return {binding, doc, editor};
  }

  function serialize(
    editor: LexicalEditor,
    binding: ReturnType<typeof createBindingV2__EXPERIMENTAL>,
  ) {
    editor.read(() => {
      binding.doc.transact(() => {
        $updateYFragment(
          binding.doc,
          binding.root,
          $getRoot(),
          binding,
          new Set(['root']),
        );
      });
    });
  }

  /**
   * Put a collapsed element-type selection at `offset` inside the paragraph,
   * push it through the awareness encoder, and decode it back. The encoded
   * form is what remote peers receive, so a mismatch here is a remote cursor
   * rendered at the wrong place.
   */
  function roundTripElementOffset(offset: number): {
    key: null | string;
    offset: number;
    paragraphKey: string;
  } {
    const {binding, editor} = buildBinding();
    const {awareness, getState} = createAwareness();
    const provider = {awareness} as unknown as Provider;

    let paragraphKey = '';
    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append(
          $createTextNode('a'),
          $createTextNode('b').setFormat('bold'),
          $createTestDecoratorNode(),
        );
        $getRoot().clear().append(paragraph);
        paragraphKey = paragraph.getKey();
      },
      {discrete: true},
    );

    serialize(editor, binding);

    editor.update(
      () => {
        const selection = $createRangeSelection();
        selection.anchor.set(paragraphKey, offset, 'element');
        selection.focus.set(paragraphKey, offset, 'element');
        $setSelection(selection);
      },
      {discrete: true},
    );

    editor.read(() => {
      syncLexicalSelectionToYjs(binding, provider, null, $getSelection());
    });

    const state = getState();
    assert(state !== null);

    const decoded = editor.read(() =>
      $getAnchorAndFocusForUserState(binding, state),
    );
    return {
      key: decoded.anchorKey,
      offset: decoded.anchorOffset,
      paragraphKey,
    };
  }

  test('an element point before a decorator that follows a text run round trips', () => {
    // lexical children: [Text 'a', Text 'b', Decorator]; offset 2 is the
    // caret just before the decorator.
    const result = roundTripElementOffset(2);
    expect(result.key).toBe(result.paragraphKey);
    expect(result.offset).toBe(2);
  });

  test('an element point at the start round trips', () => {
    const result = roundTripElementOffset(0);
    expect(result.key).toBe(result.paragraphKey);
    expect(result.offset).toBe(0);
  });

  test('an element point at the end round trips', () => {
    const result = roundTripElementOffset(3);
    expect(result.key).toBe(result.paragraphKey);
    expect(result.offset).toBe(3);
  });

  test('an element point inside a text run decodes to the end of the run', () => {
    // Offset 1 is between the two TextNodes, which share a single XmlText
    // child. Yjs has no index for that position, so the point necessarily
    // widens to the end of the run (offset 2) rather than round tripping.
    // Pinned here so the loss is a documented property, not a surprise.
    const result = roundTripElementOffset(1);
    expect(result.key).toBe(result.paragraphKey);
    expect(result.offset).toBe(2);
  });
});
