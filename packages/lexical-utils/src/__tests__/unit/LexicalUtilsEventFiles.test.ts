/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {eventFiles} from '@lexical/utils';
import {describe, expect, it} from 'vitest';

// The jsdom DataTransferMock does not implement .items or .files, so we
// construct minimal DataTransfer-shaped objects directly. The eventFiles
// function only reads .types and .files from dataTransfer, and for the
// ClipboardEvent path it reads .clipboardData.
//
// For ClipboardEvent: eventFiles reads event.clipboardData.types and
// event.clipboardData.files.
// For DragEvent: eventFiles reads event.dataTransfer.types and .files.

function makeClipboardEvent(
  types: readonly string[],
  files: File[],
): ClipboardEvent {
  const fileList = Object.assign(files.slice(), {
    item: (i: number) => files[i] ?? null,
  }) as unknown as FileList;

  const clipboardData = {
    files: fileList,
    types,
  } as unknown as DataTransfer;

  return new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData,
  });
}

function makeDragEvent(types: readonly string[], files: File[]): DragEvent {
  const fileList = Object.assign(files.slice(), {
    item: (i: number) => files[i] ?? null,
  }) as unknown as FileList;

  const dataTransfer = {
    files: fileList,
    types,
  } as unknown as DataTransfer;

  return new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    dataTransfer,
  });
}

const pngFile = new File(['img'], 'image.png', {type: 'image/png'});

describe('eventFiles', () => {
  it('returns [false, [], false] when event has no DataTransfer', () => {
    const event = new KeyboardEvent('keydown') as unknown as ClipboardEvent;
    expect(eventFiles(event)).toStrictEqual([false, [], false]);
  });

  it('returns hasContent=true for text/html only clipboard (no files)', () => {
    const event = makeClipboardEvent(['text/html'], []);
    const [hasFiles, files, hasContent] = eventFiles(event);
    expect(hasFiles).toBe(false);
    expect(files).toHaveLength(0);
    expect(hasContent).toBe(true);
  });

  it('returns hasContent=true for text/plain only clipboard (no files)', () => {
    const event = makeClipboardEvent(['text/plain'], []);
    const [hasFiles, files, hasContent] = eventFiles(event);
    expect(hasFiles).toBe(false);
    expect(files).toHaveLength(0);
    expect(hasContent).toBe(true);
  });

  it('returns hasFiles=true and hasContent=false when only Files present', () => {
    const event = makeClipboardEvent(['Files'], [pngFile]);
    const [hasFiles, files, hasContent] = eventFiles(event);
    expect(hasFiles).toBe(true);
    expect(files).toHaveLength(1);
    expect(hasContent).toBe(false);
  });

  describe('browser-copied image: Files + text/html, no text/plain', () => {
    // When the user right-clicks an image in a browser and chooses Copy Image,
    // the clipboard holds Files (the actual image) and text/html (a remote img
    // fallback), but no text/plain. eventFiles reports hasFiles=true and
    // hasContent=true. The PASTE_COMMAND handler in @lexical/rich-text then
    // uses the absence of text/plain as the additional signal to prefer the
    // file over the HTML fallback and dispatch DRAG_DROP_PASTE.
    it('returns hasFiles=true and hasContent=true (text/html present)', () => {
      const event = makeClipboardEvent(['Files', 'text/html'], [pngFile]);
      const [hasFiles, files, hasContent] = eventFiles(event);
      expect(hasFiles).toBe(true);
      expect(files).toHaveLength(1);
      expect(hasContent).toBe(true);
    });

    it('DragEvent with files and text/html behaves the same way', () => {
      const event = makeDragEvent(['Files', 'text/html'], [pngFile]);
      const [hasFiles, files, hasContent] = eventFiles(event);
      expect(hasFiles).toBe(true);
      expect(files).toHaveLength(1);
      expect(hasContent).toBe(true);
    });
  });

  describe('Word-copied text: Files + text/html + text/plain', () => {
    // Word places a rasterized PNG in the Files slot alongside text/plain,
    // text/html, and text/rtf when copying rich text. eventFiles reports
    // hasContent=true. The PASTE_COMMAND handler checks text/plain separately
    // to avoid treating this as a file-first paste.
    it('returns hasFiles=true and hasContent=true (all types present)', () => {
      const event = makeClipboardEvent(
        ['text/plain', 'text/html', 'Files'],
        [pngFile],
      );
      const [hasFiles, files, hasContent] = eventFiles(event);
      expect(hasFiles).toBe(true);
      expect(files).toHaveLength(1);
      expect(hasContent).toBe(true);
    });
  });
});
