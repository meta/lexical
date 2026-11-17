/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
} from '@lexical/html';
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
  dateTimes: number[];
  hasDateTimeNode: boolean;
  html: string;
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

  return editor.read(() => {
    const dateTimes = $nodesOfType(DateTimeNode).map(node =>
      node.getDateTime().getTime(),
    );
    return {
      dateTimes,
      hasDateTimeNode: dateTimes.length > 0,
      html: $generateHtmlFromNodes(editor, null),
      text: $getRoot().getTextContent(),
    };
  });
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

  // Older versions wrote Date.prototype.toString(), whose zone name depends
  // on the runtime's language. Keep reading those attributes.
  it.each([
    [
      'Mon Nov 16 2026 00:00:00 GMT+0900 (Korean Standard Time)',
      Date.UTC(2026, 10, 15, 15),
    ],
    [
      'Mon Nov 16 2026 00:00:00 GMT+0900 (한국 표준시)',
      Date.UTC(2026, 10, 15, 15),
    ],
    [
      'Fri May 29 2026 05:34:56 GMT-0700 (Pacific Daylight Time)',
      Date.UTC(2026, 4, 29, 12, 34, 56),
    ],
  ])('still imports an attribute older versions wrote: %s', (attr, epoch) => {
    const result = importHtml(
      `<p><span data-lexical-datetime="${attr}">x</span></p>`,
    );

    expect(result.dateTimes).toEqual([epoch]);
  });

  it('writes an ISO attribute for an imported Google Docs date', () => {
    const seconds = 1779999999;
    const result = importHtml(
      `<p><span data-rich-links='{"type":"date","dat_df":{"dfie_ts":{"tv":{"tv_s":${seconds}}}}}'>gd text</span></p>`,
    );

    expect(result.dateTimes).toEqual([seconds * 1000]);
    // The visible text depends on the host time zone, so only check the attribute
    expect(result.html).toContain(
      `data-lexical-datetime="${new Date(seconds * 1000).toISOString()}"`,
    );
  });
});
