/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {DRAG_DROP_PASTE, RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  COMMAND_PRIORITY_CRITICAL,
  DROP_COMMAND,
} from 'lexical';
import {describe, expect, onTestFinished, test} from 'vitest';

function createDropEventWithFiles(files: File[]): DragEvent {
  const dataTransfer = new DataTransfer();
  Object.defineProperty(dataTransfer, 'files', {
    enumerable: true,
    value: files,
  });
  Object.defineProperty(dataTransfer, 'types', {
    enumerable: true,
    value: ['Files'],
  });
  const event = new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    clientX: 10,
    clientY: 10,
  });
  Object.defineProperty(event, 'dataTransfer', {
    enumerable: true,
    value: dataTransfer,
  });
  return event;
}

function dispatchDropAndCaptureFiles(
  editor: ReturnType<typeof buildEditorFromExtensions>,
  event: DragEvent,
): File[] | null {
  let dispatchedFiles: File[] | null = null;
  const dispose = editor.registerCommand(
    DRAG_DROP_PASTE,
    files => {
      dispatchedFiles = files;
      return true;
    },
    COMMAND_PRIORITY_CRITICAL,
  );
  try {
    editor.dispatchCommand(DROP_COMMAND, event);
  } finally {
    dispose();
  }
  return dispatchedFiles;
}

describe('RichTextExtension DROP_COMMAND file handling', () => {
  const fakeImage = new File(['fake-bytes'], 'photo.png', {type: 'image/png'});

  test('dropped files are forwarded even when the drop point resolves to no caret', () => {
    // caretFromPoint() returns null whenever the browser cannot resolve a
    // caret for the drop coordinates -- for example when the file is dropped
    // on the editor's padding, or when neither caretRangeFromPoint nor
    // caretPositionFromPoint is available. The drop handler still calls
    // preventDefault() and returns true in that case, so if it does not
    // dispatch DRAG_DROP_PASTE the dropped file is silently discarded and
    // nothing at all happens for the user.
    using editor = buildEditorFromExtensions({
      dependencies: [RichTextExtension],
      name: 'test-drop-no-caret',
    });

    const dispatchedFiles = dispatchDropAndCaptureFiles(
      editor,
      createDropEventWithFiles([fakeImage]),
    );

    expect(dispatchedFiles).not.toBeNull();
    expect(dispatchedFiles).toHaveLength(1);
    expect(dispatchedFiles?.[0]).toBe(fakeImage);
  });

  test('dropped files are forwarded when the drop point does resolve to a caret', () => {
    // Regression guard for the path that already worked.
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode('hello'));
        $getRoot().append(paragraph);
      },
      dependencies: [RichTextExtension],
      name: 'test-drop-with-caret',
    });
    const rootElement = document.createElement('div');
    rootElement.contentEditable = 'true';
    document.body.appendChild(rootElement);
    editor.setRootElement(rootElement);
    editor.update(() => {}, {discrete: true});

    const textDOMNode = rootElement.querySelector('span')!.firstChild!;
    Object.defineProperty(document, 'caretRangeFromPoint', {
      configurable: true,
      value: () => {
        const range = document.createRange();
        range.setStart(textDOMNode, 1);
        return range;
      },
      writable: true,
    });
    onTestFinished(() => {
      delete (document as {caretRangeFromPoint?: unknown}).caretRangeFromPoint;
    });

    const dispatchedFiles = dispatchDropAndCaptureFiles(
      editor,
      createDropEventWithFiles([fakeImage]),
    );

    expect(dispatchedFiles).not.toBeNull();
    expect(dispatchedFiles?.[0]).toBe(fakeImage);

    editor.setRootElement(null);
    rootElement.remove();
  });
});
