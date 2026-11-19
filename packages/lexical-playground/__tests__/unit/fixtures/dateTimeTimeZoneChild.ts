/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Run by DateTimeNodeTimeZone.test.ts in a child process whose TZ is set
// before Node starts, because a test worker cannot change its time zone.
// Prints what the node does in that time zone as one JSON object.

import {buildEditorFromExtensions} from '@lexical/extension';
import {withDOM} from '@lexical/headless/dom';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
} from '@lexical/html';
import {
  $create,
  $createParagraphNode,
  $getRoot,
  $insertNodes,
  $nodesOfType,
  $parseSerializedNode,
  defineExtension,
  type LexicalEditor,
} from 'lexical';

import {
  DateTimeNode,
  getTimeValue,
  normalizeDateTime,
} from '../../../src/nodes/DateTimeNode/DateTimeNode';
import {DateTimeExtension} from '../../../src/plugins/DateTimeExtension';
import {getLocalDateValue} from '../../utils/dateTime.mjs';

const DateTimeChildExtension = defineExtension({
  $initialEditorState: null,
  dependencies: [DateTimeExtension],
  name: '[test-datetime-time-zone-child]',
});

function withDateTimeNode<T>(
  dateTime: string,
  $read: (node: DateTimeNode, editor: LexicalEditor) => T,
): T {
  using editor = buildEditorFromExtensions(DateTimeChildExtension);
  editor.update(
    () => {
      const node = $parseSerializedNode({
        ...$create(DateTimeNode).exportJSON(),
        dateTime,
      });
      if (!(node instanceof DateTimeNode)) {
        throw new Error('expected a DateTimeNode');
      }
      $getRoot().clear().append($createParagraphNode().append(node));
    },
    {discrete: true},
  );
  return editor.read(() => {
    const [node] = $nodesOfType(DateTimeNode);
    return $read(node, editor);
  });
}

function importHtmlValue(html: string): string[] {
  using editor = buildEditorFromExtensions(DateTimeChildExtension);
  editor.update(
    () => {
      $getRoot().clear().select();
      const dom = new DOMParser().parseFromString(html, 'text/html');
      $insertNodes($generateNodesFromDOMViaExtension(dom));
    },
    {discrete: true},
  );
  return editor.read(() =>
    $nodesOfType(DateTimeNode).map(node => node.getDateTimeValue()),
  );
}

function setAllDayDateValue(date: Date): string {
  using editor = buildEditorFromExtensions(DateTimeChildExtension);
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append($createParagraphNode().append($create(DateTimeNode)));
      $nodesOfType(DateTimeNode)[0].setAllDayDate(date);
    },
    {discrete: true},
  );
  return editor.read(() => $nodesOfType(DateTimeNode)[0].getDateTimeValue());
}

const ALL_DAY_VALUES = [
  '2026-11-04',
  '0000-02-29',
  '0050-06-01',
  '2011-12-30',
  '2026-09-06',
];

const result = withDOM(() => {
  const morning = new Date(2026, 10, 4, 9, 5);
  return {
    // The Date the picker starts from: local midnight of the all-day date
    decoratedDateTime: withDateTimeNode('2026-11-04', node => {
      const {dateTime} = node.decorate().props;
      return [dateTime.getFullYear(), dateTime.getMonth(), dateTime.getDate()];
    }),

    // What the e2e tests expect for today, given local midnight
    e2eDateValue: [
      getLocalDateValue(new Date(2026, 10, 4)),
      getLocalDateValue(new Date(2027, 0, 1)),
    ],

    exportedText: ALL_DAY_VALUES.map(value =>
      withDateTimeNode(value, (_node, editor) => {
        const html = $generateHtmlFromNodes(editor, null);
        return (
          new DOMParser().parseFromString(html, 'text/html').body.textContent ??
          ''
        );
      }),
    ),

    getDateTime: withDateTimeNode('2026-11-04', node => {
      const dateTime = node.getDateTime();
      return [
        dateTime.getFullYear(),
        dateTime.getMonth(),
        dateTime.getDate(),
        dateTime.getHours(),
        dateTime.getMinutes(),
      ];
    }),
    // 1942-04-25 23:00 was skipped in Atlantic/Azores, the local time of
    // new Date(0) there
    getDateTime1942: withDateTimeNode('1942-04-25', node => {
      const dateTime = node.getDateTime();
      return [dateTime.getDate(), dateTime.getHours()];
    }),
    // A Google Docs date chip: noon UTC, which is the next day from UTC+12 east
    googleDocsImport: importHtmlValue(
      `<p><span data-rich-links='{"type":"date","dat_df":{"dfie_ts":{"tv":{"tv_s":1794916800}},"dfie_tpt":0}}'>x</span></p>`,
    ),
    // A Google Docs 12:00 chip without a time zone pastes as 12:00 here, and
    // one with a time zone keeps its instant
    googleDocsTime: [
      ...importHtmlValue(
        `<p><span data-rich-links='{"type":"date","dat_df":{"dfie_ts":{"tv":{"tv_s":1794916800}},"dfie_tpt":1}}'>x</span></p>`,
      ).map(value => [getTimeValue(value), new Date(value).getDate()]),
      importHtmlValue(
        `<p><span data-rich-links='{"type":"date","dat_df":{"dfie_ts":{"tv":{"tv_s":1794884400}},"dfie_tpt":2}}'>x</span></p>`,
      ),
    ],
    htmlImport: importHtmlValue(
      '<p><span data-lexical-datetime="2011-12-30">x</span></p>',
    ),
    offsetless: [
      normalizeDateTime('2026-11-04T10:30:00'),
      new Date('2026-11-04T10:30:00').toISOString(),
    ],
    setAllDayDate: [
      setAllDayDateValue(new Date(2026, 10, 4)),
      // Local New Year, which is still the old year in UTC east of UTC
      setAllDayDateValue(new Date(2027, 0, 1)),
    ],
    text: ALL_DAY_VALUES.map(value =>
      withDateTimeNode(value, node => node.getTextContent()),
    ),
    timeValue: [
      getTimeValue('2026-09-06'),
      getTimeValue(morning.toISOString()),
    ],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
});

process.stdout.write(JSON.stringify(result));
