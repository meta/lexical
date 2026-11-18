/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  CLEAR_HISTORY_COMMAND,
  type EditorState,
  type LexicalEditor,
  type SerializedEditorState,
} from 'lexical';

import {version} from '../package.json';

export interface SerializedDocument {
  /** The serialized editorState produced by editorState.toJSON() */
  editorState: SerializedEditorState;
  /** The time this document was created in epoch milliseconds (Date.now()) */
  lastSaved: number;
  /** The source of the document, defaults to Lexical */
  source: string | 'Lexical';
  /** The version of Lexical that produced this document */
  version: string;
}

/**
 * Generates a SerializedDocument from the given EditorState
 * @param editorState - the EditorState to serialize
 * @param config - An object that optionally contains source, lastSaved and
 * editor. source defaults to Lexical and lastSaved defaults to the current time
 * in epoch milliseconds. editor, the editor that editorState belongs to, is
 * active while its nodes are exported, so their exportJSON can call
 * $getEditor().
 */
export function serializedDocumentFromEditorState(
  editorState: EditorState,
  config: Readonly<{
    source?: string;
    lastSaved?: number;
    editor?: LexicalEditor;
  }> = Object.freeze({}),
): SerializedDocument {
  return {
    // Without an editor, toJSON uses the editor of an enclosing read of
    // editorState.
    editorState: editorState.toJSON({editor: config.editor}),
    lastSaved: config.lastSaved || Date.now(),
    source: config.source || 'Lexical',
    version,
  };
}

/**
 * Parse an EditorState from the given editor and document
 *
 * @param editor - The lexical editor
 * @param maybeStringifiedDocument - The contents of a .lexical file (as a JSON string, or already parsed)
 */
export function editorStateFromSerializedDocument(
  editor: LexicalEditor,
  maybeStringifiedDocument: SerializedDocument | string,
): EditorState {
  const json =
    typeof maybeStringifiedDocument === 'string'
      ? JSON.parse(maybeStringifiedDocument)
      : maybeStringifiedDocument;
  return editor.parseEditorState(json.editorState);
}

/**
 * Takes a file and inputs its content into the editor state as an input field.
 * @param editor - The lexical editor.
 */
export function importFile(editor: LexicalEditor) {
  readTextFileFromSystem(text => {
    editor.setEditorState(editorStateFromSerializedDocument(editor, text));
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND);
  });
}

function readTextFileFromSystem(callback: (text: string) => void) {
  // eslint-disable-next-line no-restricted-syntax
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.lexical';
  input.addEventListener('change', (event: Event) => {
    const target = event.target as HTMLInputElement;

    if (target.files) {
      const file = target.files[0];
      const reader = new FileReader();
      reader.readAsText(file, 'UTF-8');

      reader.onload = readerEvent => {
        if (readerEvent.target) {
          const content = readerEvent.target.result;
          callback(content as string);
        }
      };
    }
  });
  input.click();
}

/**
 * Generates a .lexical file to be downloaded by the browser containing the current editor state.
 * @param editor - The lexical editor.
 * @param config - An object that optionally contains fileName and source. fileName defaults to
 * the current date (as a string) and source defaults to Lexical.
 */
export function exportFile(
  editor: LexicalEditor,
  config: Readonly<{
    fileName?: string;
    source?: string;
  }> = Object.freeze({}),
) {
  const now = new Date();
  const serializedDocument = serializedDocumentFromEditorState(
    editor.getEditorState(),
    {
      ...config,
      editor,
      lastSaved: now.getTime(),
    },
  );
  const fileName = config.fileName || now.toISOString();
  exportBlob(serializedDocument, `${fileName}.lexical`);
}

// Adapted from https://stackoverflow.com/a/19328891/2013580
function exportBlob(data: SerializedDocument, fileName: string) {
  // eslint-disable-next-line no-restricted-syntax
  const a = document.createElement('a');
  // eslint-disable-next-line no-restricted-syntax
  const body = document.body;

  if (body === null) {
    return;
  }

  body.appendChild(a);
  a.style.display = 'none';
  const json = JSON.stringify(data);
  const blob = new Blob([json], {
    type: 'octet/stream',
  });
  // eslint-disable-next-line no-restricted-syntax
  const url = window.URL.createObjectURL(blob);
  a.href = url;
  a.download = fileName;
  a.click();
  // eslint-disable-next-line no-restricted-syntax
  window.URL.revokeObjectURL(url);
  a.remove();
}
