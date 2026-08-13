/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  buildEditorFromExtensions,
  getExtensionDependencyFromEditor,
} from '@lexical/extension';
import {DRAG_DROP_PASTE, RichTextExtension} from '@lexical/rich-text';
import {
  $getRoot,
  COMMAND_PRIORITY_CRITICAL,
  configExtension,
  PASTE_COMMAND,
} from 'lexical';
import {describe, expect, test} from 'vitest';

function createDataTransferWithFiles(
  textEntries: Record<string, string>,
  files: File[],
): DataTransfer {
  const dataTransfer = new DataTransfer();
  for (const [type, value] of Object.entries(textEntries)) {
    dataTransfer.setData(type, value);
  }
  Object.defineProperty(dataTransfer, 'files', {
    enumerable: true,
    value: files,
  });
  return dataTransfer;
}

function dispatchPasteAndCaptureFiles(
  editor: ReturnType<typeof buildEditorFromExtensions>,
  dataTransfer: DataTransfer,
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
    editor.dispatchCommand(
      PASTE_COMMAND,
      new ClipboardEvent('paste', {clipboardData: dataTransfer}),
    );
  } finally {
    dispose();
  }
  return dispatchedFiles;
}

describe('RichTextExtension shouldHandlePasteAsFiles', () => {
  const fakeImage = new File(['fake-bytes'], 'photo.png', {
    type: 'image/png',
  });

  test('default: a file pasted alongside text/html (browser copy-image) does NOT dispatch DRAG_DROP_PASTE', () => {
    // This is the exact repro from #8681: browsers put both `Files` and
    // `text/html` on the clipboard when copying an image via the context
    // menu, and historically that text/html presence blocks the file path.
    // This test locks in that this is still the *default*, so existing
    // consumers (e.g. the playground) don't silently change behavior.
    using editor = buildEditorFromExtensions({
      dependencies: [RichTextExtension],
      name: 'test-default',
    });

    const dataTransfer = createDataTransferWithFiles(
      {'text/html': '<img src="blob:fake">'},
      [fakeImage],
    );

    const dispatchedFiles = dispatchPasteAndCaptureFiles(editor, dataTransfer);

    expect(dispatchedFiles).toBeNull();
  });

  test('override: treating only text/plain as content lets the file win over an incidental text/html entry', () => {
    using editor = buildEditorFromExtensions({
      dependencies: [
        configExtension(RichTextExtension, {
          shouldHandlePasteAsFiles: (files: File[]) => files.length > 0,
        }),
      ],
      name: 'test-override',
    });

    const dataTransfer = createDataTransferWithFiles(
      {'text/html': '<img src="blob:fake">'},
      [fakeImage],
    );

    const dispatchedFiles = dispatchPasteAndCaptureFiles(editor, dataTransfer);

    expect(dispatchedFiles).not.toBeNull();
    expect(dispatchedFiles).toHaveLength(1);
    expect(dispatchedFiles?.[0]).toBe(fakeImage);
  });

  test('override does not hijack a plain text/html paste with no file', () => {
    // Guards against a sloppy override implementation that dispatches
    // DRAG_DROP_PASTE just because the content-check returned false,
    // ignoring that there's no file at all.
    using editor = buildEditorFromExtensions({
      $initialEditorState: () => {
        $getRoot();
      },
      dependencies: [
        configExtension(RichTextExtension, {
          shouldHandlePasteAsFiles: (files: File[]) => files.length > 0,
        }),
      ],
      name: 'test-no-file',
    });

    const dataTransfer = createDataTransferWithFiles(
      {'text/html': '<b>hello</b>'},
      [],
    );

    const dispatchedFiles = dispatchPasteAndCaptureFiles(editor, dataTransfer);

    expect(dispatchedFiles).toBeNull();
  });

  test('a file with no text content at all still dispatches DRAG_DROP_PASTE under the default config', () => {
    // This is the case that already worked before this change — a pure
    // regression guard that our new parameter didn't break it.
    using editor = buildEditorFromExtensions({
      dependencies: [RichTextExtension],
      name: 'test-file-only',
    });

    const dataTransfer = createDataTransferWithFiles({}, [fakeImage]);

    const dispatchedFiles = dispatchPasteAndCaptureFiles(editor, dataTransfer);

    expect(dispatchedFiles).not.toBeNull();
    expect(dispatchedFiles?.[0]).toBe(fakeImage);
  });

  test('shouldHandlePasteAsFiles can be modified as a signal after the editor is built', () => {
    using editor = buildEditorFromExtensions({
      dependencies: [RichTextExtension],
      name: 'test-signal',
    });

    const dep = getExtensionDependencyFromEditor(editor, RichTextExtension);
    // Flip to "files always win" at runtime, mirroring the existing
    // escapeFormatTriggers signal-mutation test for this same extension.
    dep.output.shouldHandlePasteAsFiles.value = (files: File[]) =>
      files.length > 0;

    const dataTransfer = createDataTransferWithFiles(
      {'text/html': '<img src="blob:fake">'},
      [fakeImage],
    );

    const dispatchedFiles = dispatchPasteAndCaptureFiles(editor, dataTransfer);

    expect(dispatchedFiles).not.toBeNull();
  });
});
