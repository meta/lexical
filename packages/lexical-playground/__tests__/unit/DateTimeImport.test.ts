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
  bold: boolean[];
  dateTimes: number[];
  hasDateTimeNode: boolean;
  html: string;
  text: string;
  values: string[];
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
    const nodes = $nodesOfType(DateTimeNode);
    return {
      bold: nodes.map(node => node.hasFormat('bold')),
      dateTimes: nodes.map(node => node.getDateTime().getTime()),
      hasDateTimeNode: nodes.length > 0,
      html: $generateHtmlFromNodes(editor, null),
      text: $getRoot().getTextContent(),
      values: nodes.map(node => node.getDateTimeValue()),
    };
  });
}

// A date chip copied from Google Docs (Chrome, Korean UI). Google stores a
// chip without a time (dfie_tpt 0) as noon UTC of its day.
const GOOGLE_DOCS_DATE = {
  dfie_dt: '2026년 11월 17일',
  dfie_l: 'ko',
  dfie_p: {fres_frt: 0, fres_usd: '', tres_tv: 'y년 MMM d일'},
  dfie_pt: 3,
  dfie_tpt: 0,
  dfie_ts: {tv: {tv_n: 0, tv_s: 1794916800}},
  dfie_tzi: '',
  fres_frt: 1,
  fres_usd: '',
};

function googleDocsHtml(datDf: object | null, style = ''): string {
  const richLinks = JSON.stringify({dat_df: datDf, type: 'date'});
  return `<p><span data-rich-links='${richLinks}' style="${style}">gd text</span></p>`;
}

function atSeconds(tvS: number) {
  return {...GOOGLE_DOCS_DATE, dfie_ts: {tv: {tv_n: 0, tv_s: tvS}}};
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

  it.each([
    ['a date chip', GOOGLE_DOCS_DATE, '2026-11-17'],
    [
      'a date chip whose time was removed',
      {...GOOGLE_DOCS_DATE, dfie_tzi: 'ROK'},
      '2026-11-17',
    ],
    [
      'a chip at 12:00 in Seoul',
      {
        ...atSeconds(1794884400),
        dfie_dt: '2026년 11월 17일 오후 12:00 GMT+9',
        dfie_tpt: 2,
        dfie_tzi: 'ROK',
      },
      '2026-11-17T03:00:00.000Z',
    ],
    [
      'a chip at 12:00 UTC',
      {
        ...GOOGLE_DOCS_DATE,
        dfie_dt: '2026년 11월 17일 오후 12:00 UTC',
        dfie_tpt: 2,
        dfie_tzi: 'UCT',
      },
      '2026-11-17T12:00:00.000Z',
    ],
    [
      'a chip with another time type',
      {...GOOGLE_DOCS_DATE, dfie_tpt: 1},
      '2026-11-17T12:00:00.000Z',
    ],
    [
      'a date chip whose timestamp is 0',
      {...atSeconds(0), dfie_dt: '2026-11-17'},
      '2026-11-17T00:00:00.000Z',
    ],
    ['a date chip in year 9999', atSeconds(253382817600), '9999-05-20'],
    ['a date chip in year 0', atSeconds(-62155080000), '0000-05-20'],
    [
      'a date chip in year 10000',
      atSeconds(253414440000),
      '+010000-05-20T12:00:00.000Z',
    ],
    [
      'a date chip in year -1',
      atSeconds(-62186702400),
      '-000001-05-20T12:00:00.000Z',
    ],
  ])('imports %s from Google Docs', (_name, datDf, value) => {
    const result = importHtml(googleDocsHtml(datDf));

    expect(result.values).toEqual([value]);
  });

  it.each([
    ['a timestamp out of range', atSeconds(9e12)],
    ['no date', null],
  ])('keeps the text of a Google Docs chip with %s', (_name, datDf) => {
    const result = importHtml(googleDocsHtml(datDf));

    expect(result.hasDateTimeNode).toBe(false);
    expect(result.text).toBe('gd text');
  });

  it.each([
    ['date chip', GOOGLE_DOCS_DATE, '2026-11-17'],
    [
      'chip with a time',
      {...atSeconds(1794884400), dfie_tpt: 2, dfie_tzi: 'ROK'},
      '2026-11-17T03:00:00.000Z',
    ],
  ])('keeps the format of a Google Docs %s', (_name, datDf, value) => {
    const result = importHtml(googleDocsHtml(datDf, 'font-weight: 700'));

    expect(result.values).toEqual([value]);
    expect(result.bold).toEqual([true]);
  });
});
