/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {createHeadlessEditor} from '@lexical/headless';
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';

const editor = createHeadlessEditor({
  nodes: [],
  onError: error => {
    throw error;
  },
});
editor.update(
  () => {
    $getRoot().append(
      $createParagraphNode().append($createTextNode('Hello Metro')),
    );
  },
  {discrete: true},
);
const json = editor.getEditorState().toJSON();
console.log(
  `METRO_OK ${process.env.NODE_ENV} ${json.root.children[0].children[0].text}`,
);
