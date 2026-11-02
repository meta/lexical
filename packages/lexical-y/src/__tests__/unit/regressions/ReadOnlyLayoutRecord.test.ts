/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

// A remote change that brings a layout record (the first member entry of a
// set records layout 2) makes a client that is not active (read only: here
// the document records a newer schema) read the whole document again, from
// inside the change's transaction. That read saw the document as it was
// before the change (see Unread): content the change made, here cells
// another client's undo of a column delete brought back, showed with empty
// list items, self-check on or off, while an active client read it right.
//
// Captured from a randomized session: `doc` is the client's state, `batch`
// the remote update it applied next, `json` what the editor showed before.

import {CodePrismExtension} from '@lexical/code-prism';
import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
  NodeStructureExtension,
} from '@lexical/extension';
import {LinkExtension} from '@lexical/link';
import {ListExtension} from '@lexical/list';
import {MarkStateExtension} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {TableExtension} from '@lexical/table';
import * as Y from '@y/y';
import {
  $createTextNode,
  $getEditor,
  $getState,
  $getWritableNodeState,
  arraySetValue,
  configExtension,
  createState,
  defineExtension,
  type SerializedEditorState,
  stringValue,
} from 'lexical';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {expect, test} from 'vitest';

import {YCollabExtension} from '../../..';
import {createYDoc, readYState} from '../../../headless';

// A second annotation key, as an app keeps suggestions: a set in NodeState.
const suggestState = createState('suggest', {
  parse: arraySetValue(stringValue()),
});
const SuggestExtension = defineExtension({
  name: '@lexical/y/test/suggest',
  register: editor => {
    editor.update(
      () => {
        const node = $createTextNode();
        $getWritableNodeState(node);
        $getState(node, suggestState);
      },
      {discrete: true},
    );
    return () => {};
  },
});
const extensions = () => [
  NodeStructureExtension,
  RichTextExtension,
  ListExtension,
  LinkExtension,
  configExtension(TableExtension, {hasHorizontalScroll: false}),
  CodePrismExtension,
  MarkStateExtension,
  SuggestExtension,
];

const sorted = (x: unknown): unknown =>
  Array.isArray(x)
    ? x.map(sorted)
    : x !== null && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map(k => [k, sorted((x as Record<string, unknown>)[k])]),
        )
      : x;
const canon = (json: SerializedEditorState) => JSON.stringify(sorted(json));
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const idle = () => new Promise(resolve => setTimeout(resolve, 0));

for (const schemaVersion of [1, 2]) {
  for (const selfCheck of [false, true]) {
    test(`${schemaVersion === 1 ? 'a read-only' : 'an active'} client shows a remote change that brings a layout record (selfCheck ${selfCheck})`, async () => {
      const capture = JSON.parse(
        fs.readFileSync(
          path.join(__dirname, 'ReadOnlyLayoutRecord.json'),
          'utf8',
        ),
      );
      const doc = createYDoc();
      const editor = buildEditorFromExtensions(
        defineExtension({
          $initialEditorState: null,
          dependencies: [
            ...extensions(),
            configExtension(YCollabExtension, {doc, schemaVersion, selfCheck}),
          ],
          name: '@lexical/y/test/read-only-layout-record',
          onError: e => {
            throw e;
          },
          onWarn: () => {},
        }),
      );
      const {binding} = getExtensionDependencyFromEditor(
        editor,
        YCollabExtension,
      ).output;
      Y.applyUpdate(doc, bytes(capture.doc));
      binding.initialize();
      await idle();
      expect(binding.status).toBe(schemaVersion === 1 ? 'readonly' : 'active');
      expect(canon(editor.getEditorState().toJSON())).toBe(canon(capture.json));
      for (const update of capture.batch) {
        Y.applyUpdate(doc, bytes(update), 'remote');
      }
      await idle();
      const fresh = readYState(
        Y.encodeStateAsUpdate(doc),
        {extensions: extensions(), schemaVersion: 2},
        () => $getEditor().getEditorState().toJSON(),
      );
      expect(canon(editor.getEditorState().toJSON())).toBe(canon(fresh));
      editor.dispose();
    });
  }
}
