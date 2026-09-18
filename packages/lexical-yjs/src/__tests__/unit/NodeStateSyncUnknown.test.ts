/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {XmlText} from 'yjs';

import {
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {createBinding, type Provider} from '@lexical/yjs';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getWritableNodeState,
  $setState,
  createState,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {afterEach, assert, describe, expect, test} from 'vitest';
import {Doc, Map as YMap} from 'yjs';

// A control for the unknown-key path: state written through `$setState` with a
// StateConfig is tracked as *known* state (registering the key on a node type
// is what makes it parse back from JSON, not what makes it known here), and
// known state already syncs correctly on the create path.
const knownFlagState = createState('knownFlag', {
  parse: v => (typeof v === 'string' ? v : ''),
});

describe('collab-v1 node state: unknown keys', () => {
  const editors: LexicalEditorWithDispose[] = [];
  afterEach(() => {
    for (const editor of editors) {
      editor.dispose();
    }
    editors.length = 0;
  });

  function buildBinding() {
    const editor = buildEditorFromExtensions(
      defineExtension({
        $initialEditorState: null,
        name: '[node-state-unknown]',
      }),
    );
    editors.push(editor);
    const doc = new Doc();
    const docMap = new Map<string, Doc>([['node-state-unknown', doc]]);
    const binding = createBinding(
      editor,
      null as unknown as Provider,
      'node-state-unknown',
      doc,
      docMap,
    );
    return {binding, doc, editor};
  }

  function serialize(
    editor: LexicalEditor,
    binding: ReturnType<typeof createBinding>,
  ) {
    editor.read(() => {
      binding.doc.transact(() => {
        binding.root.syncChildrenFromLexical(
          binding,
          $getRoot(),
          null,
          null,
          null,
        );
      });
    });
  }

  function paragraphStateMap(binding: ReturnType<typeof createBinding>) {
    const collab = binding.root._children[0];
    assert('_xmlText' in collab);
    const xmlText = collab._xmlText as XmlText;
    const state = xmlText.getAttribute('__state') as unknown;
    assert(state instanceof YMap);
    return state as YMap<unknown>;
  }

  test('unknown state on a newly created node is written to the shared doc', () => {
    const {binding, editor} = buildBinding();

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('hello'));
        $getRoot().clear().append(paragraph);
        // State written by a plugin that this build does not have registered.
        $getWritableNodeState(paragraph).updateFromUnknown('pluginKey', 42);
      },
      {discrete: true},
    );

    serialize(editor, binding);

    expect(paragraphStateMap(binding).get('pluginKey')).toBe(42);
  });

  test('known state on a newly created node is written to the shared doc', () => {
    const {binding, editor} = buildBinding();

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('hello'));
        $getRoot().clear().append(paragraph);
        $setState(paragraph, knownFlagState, 'on');
      },
      {discrete: true},
    );

    serialize(editor, binding);

    expect(paragraphStateMap(binding).get('knownFlag')).toBe('on');
  });

  test('several unknown keys all reach the shared doc', () => {
    const {binding, editor} = buildBinding();

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('hello'));
        $getRoot().clear().append(paragraph);
        const state = $getWritableNodeState(paragraph);
        state.updateFromUnknown('a', 1);
        state.updateFromUnknown('b', 'two');
      },
      {discrete: true},
    );

    serialize(editor, binding);

    const stateMap = paragraphStateMap(binding);
    expect(stateMap.get('a')).toBe(1);
    expect(stateMap.get('b')).toBe('two');
  });
});
