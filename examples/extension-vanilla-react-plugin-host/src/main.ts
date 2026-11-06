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
  configExtension,
  HorizontalRuleExtension,
  TabIndentationExtension,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {
  $createListItemNode,
  $createListNode,
  CheckListExtension,
} from '@lexical/list';
import {
  mountReactExtensionComponent,
  mountReactPluginHost,
  ReactPluginHostExtension,
} from '@lexical/react/ReactPluginHostExtension';
import {TreeViewExtension} from '@lexical/react/TreeViewExtension';
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
      // Hosts React plug-ins and extension components in an app that
      // otherwise doesn't use React
      ReactPluginHostExtension,
      // Style the tree view with Tailwind classes
      configExtension(TreeViewExtension, {
        viewClassName:
          'block bg-gray-800 text-white text-xs p-2 whitespace-pre-wrap rounded',
      }),
    ],
    name: '@lexical/extension-vanilla-react-plugin-host-example',
    namespace: '@lexical/extension-vanilla-react-plugin-host-example',
  }),
);
editor.setRootElement(document.getElementById('lexical-editor'));

// The React root that ReactPluginHostExtension renders into. The plug-ins
// and components it hosts can render anywhere in the page with portals.
const reactHost = document.createElement('div');
document.body.appendChild(reactHost);
mountReactPluginHost(editor, reactHost);

mountReactExtensionComponent(editor, {
  domNode: document.getElementById('tree-view'),
  extension: TreeViewExtension,
  key: 'tree-view',
  props: {},
});
