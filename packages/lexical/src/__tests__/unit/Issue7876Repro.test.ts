/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  TextNode,
} from 'lexical';
import {describe, expect, test} from 'vitest';

// Reproduction for https://github.com/facebook/lexical/issues/7876
//
// `editor.setEditorState(parsedState)` historically avoided dirtying nodes,
// so user-registered transforms did not run against text parsed from JSON.
// Carrying `_parsed` on EditorState and dirty-marking every node when that
// flag is set lets the transform fire after setEditorState, with the flag
// consumed in place so a history rollback to that state does not re-trigger.

const PARSED_TEXT = 'hello {{name}}';
const TRANSFORMED_TEXT = 'VARIABLE';

function buildEditor(onTransform?: (node: TextNode) => void) {
  const editor = buildEditorFromExtensions({
    dependencies: [RichTextExtension],
    name: 'issue-7876-repro',
    onError: e => {
      throw e;
    },
  });
  if (onTransform) {
    editor.registerNodeTransform(TextNode, onTransform);
  }
  return editor;
}

function makeParsedJSON(text: string): string {
  using src = buildEditor();
  src.update(
    () => {
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createTextNode(text)));
    },
    {discrete: true},
  );
  return JSON.stringify(src.getEditorState());
}

describe('Issue #7876: setEditorState triggers transforms on parsed state', () => {
  test('text-node transform fires for a JSON state passed to setEditorState', () => {
    using editor = buildEditor(node => {
      const text = node.getTextContent();
      if (text.includes('{{') && text !== TRANSFORMED_TEXT) {
        node.setTextContent(TRANSFORMED_TEXT);
      }
    });

    const parsed = editor.parseEditorState(makeParsedJSON(PARSED_TEXT));
    expect(parsed._parsed).toBe(true);

    editor.setEditorState(parsed);

    expect(editor.read(() => $getRoot().getTextContent())).toBe(
      TRANSFORMED_TEXT,
    );
  });

  test('text-node transform fires for a cloned parsed state (the documented no-focus form)', () => {
    using editor = buildEditor(node => {
      const text = node.getTextContent();
      if (text.includes('{{') && text !== TRANSFORMED_TEXT) {
        node.setTextContent(TRANSFORMED_TEXT);
      }
    });

    const parsed = editor.parseEditorState(makeParsedJSON(PARSED_TEXT));
    expect(parsed._parsed).toBe(true);

    // `editorState.clone(null)` is the form documented in
    // docs/concepts/editor-state.md for applying a state without focusing
    // the editor.
    const cloned = parsed.clone(null);
    expect(cloned._parsed).toBe(true);

    editor.setEditorState(cloned);

    expect(editor.read(() => $getRoot().getTextContent())).toBe(
      TRANSFORMED_TEXT,
    );
  });

  test('setEditorState consumes the `_parsed` flag so re-applying the resulting state does not re-trigger transforms', () => {
    let transformCalls = 0;
    using editor = buildEditor(node => {
      transformCalls++;
      const text = node.getTextContent();
      if (text.includes('{{') && text !== TRANSFORMED_TEXT) {
        node.setTextContent(TRANSFORMED_TEXT);
      }
    });

    editor.setEditorState(editor.parseEditorState(makeParsedJSON(PARSED_TEXT)));
    expect(transformCalls).toBeGreaterThanOrEqual(1);

    const currentState = editor.getEditorState();
    expect(currentState._parsed).toBeFalsy();

    const callsBeforeReapply = transformCalls;
    editor.setEditorState(currentState);
    expect(transformCalls - callsBeforeReapply).toBe(0);
  });

  test('a non-idempotent transform stabilises in two passes on a parsed state', () => {
    const SENTINEL = '#done:';
    let transformCalls = 0;
    using editor = buildEditor(node => {
      transformCalls++;
      const text = node.getTextContent();
      if (!text.startsWith(SENTINEL)) {
        node.setTextContent(SENTINEL + text);
      }
    });

    editor.setEditorState(editor.parseEditorState(makeParsedJSON(PARSED_TEXT)));

    expect(editor.read(() => $getRoot().getTextContent())).toBe(
      SENTINEL + PARSED_TEXT,
    );
    expect(transformCalls).toBeLessThanOrEqual(2);
  });

  test('setEditorState completes within bound on a 1000-paragraph parsed state', () => {
    let transformCalls = 0;
    using editor = buildEditor(() => {
      transformCalls++;
    });

    using src = buildEditor();
    const NUM_PARAS = 1000;
    src.update(
      () => {
        const root = $getRoot().clear();
        for (let i = 0; i < NUM_PARAS; i++) {
          root.append(
            $createParagraphNode().append($createTextNode(`line ${i}`)),
          );
        }
      },
      {discrete: true},
    );
    const json = JSON.stringify(src.getEditorState());

    const parsed = editor.parseEditorState(json);

    const start = performance.now();
    editor.setEditorState(parsed);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(transformCalls).toBeGreaterThanOrEqual(NUM_PARAS);
  });
});
