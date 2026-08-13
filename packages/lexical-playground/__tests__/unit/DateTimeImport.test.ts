/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {$generateNodesFromDOMViaExtension} from '@lexical/html';
import {$getRoot, $insertNodes, $nodesOfType, defineExtension} from 'lexical';
import {describe, expect, it} from 'vitest';

import {DateTimeNode} from '../../src/nodes/DateTimeNode/DateTimeNode';
import {PlaygroundImportExtension} from '../../src/nodes/PlaygroundImportExtension';
import {DateTimeExtension} from '../../src/plugins/DateTimeExtension';

const DateTimeImportTestExtension = defineExtension({
  $initialEditorState: null,
  dependencies: [PlaygroundImportExtension, DateTimeExtension],
  name: '[test-datetime-import]',
});

interface ImportResult {
  hasDateTimeNode: boolean;
  text: string;
}

function importHtml(html: string): ImportResult {
  using editor = buildEditorFromExtensions(DateTimeImportTestExtension);
  editor.update(
    () => {
      $getRoot().clear().select();
      const dom = new DOMParser().parseFromString(html, 'text/html');
      $insertNodes($generateNodesFromDOMViaExtension(dom));
    },
    {discrete: true},
  );

  expect(() => editor.getEditorState().toJSON()).not.toThrow();

  return editor.read(() => ({
    hasDateTimeNode: $nodesOfType(DateTimeNode).length > 0,
    text: $getRoot().getTextContent(),
  }));
}

describe('DateTime HTML import', () => {
  it('keeps the element content when the date cannot be parsed', () => {
    const result = importHtml(
      '<p><span data-lexical-datetime="not a date">some text</span></p>',
    );

    expect(result.hasDateTimeNode).toBe(false);
    expect(result.text).toBe('some text');
  });

  it('still imports a parseable date', () => {
    // Use a date in the local time zone and locale
    const may29 = new Date(2026, 4, 29);
    const result = importHtml(
      `<p><span data-lexical-datetime="${may29.toISOString()}">May 29</span></p>`,
    );

    expect(result.hasDateTimeNode).toBe(true);
    expect(result.text).toBe(may29.toDateString());
  });

  it('matches how the Google Docs rule already handles an unparseable date', () => {
    const result = importHtml(
      '<p><span data-rich-links=\'{"type":"date","dat_df":{"dfie_dt":"nope"}}\'>gd text</span></p>',
    );

    expect(result.hasDateTimeNode).toBe(false);
    expect(result.text).toBe('gd text');
  });
});
