/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import './styles.css';

import {
  $createHorizontalRuleNode,
  AutoFocusExtension,
  buildEditorFromExtensions,
  EditorStateExtension,
  effect,
  HorizontalRuleExtension,
  TabIndentationExtension,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $createListItemNode,
  $createListNode,
  CheckListExtension,
} from '@lexical/list';
import {RichTextExtension} from '@lexical/rich-text';
import {TailwindExtension} from '@lexical/tailwind';
import {$createTextNode, $getRoot, defineExtension} from 'lexical';

function $prepopulatedRichText() {
  $getRoot().append(
    $createListNode('check').append(
      $createListItemNode(true).append($createTextNode('First item is done!')),
      $createListItemNode(false).append($createTextNode('TODO')),
    ),
    // This is just to demo the vanilla js decorator stuff
    $createHorizontalRuleNode(),
    $createHorizontalRuleNode(),
  );
}

const editorRef = document.getElementById('lexical-editor');
const stateRef = document.getElementById('lexical-state') as HTMLPreElement;

const LazyExtension = defineExtension({
  name: '@lexical/extension-vanilla-tailwind-example/Lazy',
  register(editor, _config, state) {
    let dispose: undefined | (() => void);
    import('./lazyLoaded').then(mod => {
      if (!state.getSignal().aborted) {
        dispose = mod.registerLazyLoaded(editor);
      }
    });
    return () => {
      if (dispose) {
        dispose();
      }
    };
  },
});

// Keeps the "Editor state" panel below the editor in sync
const StateViewExtension = defineExtension({
  dependencies: [EditorStateExtension],
  name: '@lexical/extension-vanilla-tailwind-example/StateView',
  register(_editor, _config, state) {
    const editorState = state.getDependency(EditorStateExtension).output;
    // Using signals from @preact/signals-core allows us to do what is done
    // from the legacy React plugins without having to wrap a component
    // around a hook, plus it's all framework independent.
    return effect(() => {
      stateRef.textContent = JSON.stringify(
        editorState.value.toJSON(true),
        undefined,
        2,
      );
    });
  },
});

const editor = buildEditorFromExtensions(
  defineExtension({
    $initialEditorState: $prepopulatedRichText,
    dependencies: [
      // These don't have to be in any particular order, they will be
      // topologically sorted by their dependencies
      TailwindExtension,
      HistoryExtension,
      RichTextExtension,
      AutoFocusExtension,
      CheckListExtension,
      TabIndentationExtension,
      HorizontalRuleExtension,
      StateViewExtension,
      LazyExtension,
    ],
    name: '@lexical/extension-vanilla-tailwind-example',
    namespace: '@lexical/extension-vanilla-tailwind-example',
  }),
);
editor.setRootElement(editorRef);
