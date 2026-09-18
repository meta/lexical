/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {JSX} from 'react';

import {AutoFocusExtension, HMRExtension} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {useLexicalEditable} from '@lexical/react/useLexicalEditable';
import {RichTextExtension} from '@lexical/rich-text';
import {configExtension, defineExtension} from 'lexical';

const extension = defineExtension({
  dependencies: [
    RichTextExtension,
    HistoryExtension,
    AutoFocusExtension,
    configExtension(HMRExtension, {hot: import.meta.hot ?? null}),
  ],
  name: '@lexical/examples/hmr',
  namespace: 'HMR Demo',
});

const placeholder = 'Type here — edits survive HMR reloads…';

function EditableToggle(): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const isEditable = useLexicalEditable();
  return (
    <button
      onClick={() => editor.setEditable(!isEditable)}
      style={{marginTop: 8}}>
      {isEditable ? 'Make read-only' : 'Make editable'}
    </button>
  );
}

export default function App(): JSX.Element {
  return (
    <div>
      <h1>Lexical HMR Example</h1>
      <p>
        Edit <code>src/App.tsx</code> and save. The editor content, editable
        flag, and undo/redo history are preserved across hot module reloads.
      </p>
      <LexicalExtensionComposer extension={extension} contentEditable={null}>
        <div style={{border: '1px solid #ccc', borderRadius: 4, padding: 8}}>
          <ContentEditable
            aria-placeholder={placeholder}
            placeholder={<div style={{color: '#999'}}>{placeholder}</div>}
          />
        </div>
        <EditableToggle />
      </LexicalExtensionComposer>
    </div>
  );
}
