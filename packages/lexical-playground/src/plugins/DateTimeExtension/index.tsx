/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {applyFormatFromStyle} from '@lexical/extension';
import {
  CoreImportExtension,
  defineImportRule,
  DOMImportExtension,
  sel,
} from '@lexical/html';
import {$insertNodeIntoLeaf, $wrapNodeInElement} from '@lexical/utils';
import {
  $create,
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  $isRootOrShadowRoot,
  $isTextNode,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  defineExtension,
  type LexicalCommand,
} from 'lexical';

import {
  $createDateTimeNode,
  $createDateTimeNodeFromValue,
  DateTimeNode,
} from '../../nodes/DateTimeNode/DateTimeNode';

type CommandPayload = {
  /** Insert the local calendar date of `dateTime` as an all-day date */
  allDay?: boolean;
  dateTime: Date;
};

export const INSERT_DATETIME_COMMAND: LexicalCommand<CommandPayload> =
  createCommand('INSERT_DATETIME_COMMAND');

const DateTimeRule = defineImportRule({
  $import: (ctx, el, $next) => {
    // An unparseable attribute falls through and keeps the element's own
    // content, the same way GoogleDocsDateRule below does.
    const node = $createDateTimeNodeFromValue(
      el.getAttribute('data-lexical-datetime')!,
    );
    if (node === null) {
      return $next();
    }
    const [firstChild] = ctx.$importChildren(el);
    if ($isTextNode(firstChild)) {
      node.setFormat(firstChild.getFormat());
    }
    return [node];
  },
  match: sel.tag('span').attr('data-lexical-datetime', true),
  name: '@lexical/playground/datetime',
});

const GoogleDocsDateRule = defineImportRule({
  $import: (_ctx, el, $next) => {
    let parsed: {
      dat_df?: {
        dfie_dt?: string;
        dfie_tpt?: number;
        dfie_ts?: {tv?: {tv_s?: number}};
      } | null;
    };
    try {
      parsed = JSON.parse(el.getAttribute('data-rich-links') ?? '{}');
    } catch {
      return $next();
    }
    const {dat_df} = parsed;
    if (dat_df == null) {
      return $next();
    }
    const seconds = dat_df.dfie_ts?.tv?.tv_s;
    const date = new Date(
      (seconds ?? 0) * 1000 || Date.parse(dat_df.dfie_dt ?? ''),
    );
    if (isNaN(date.getTime())) {
      return $next();
    }
    // Google Docs writes what some chips show as UTC: noon of the day for a
    // date without a time (dfie_tpt 0), and the wall clock time for a time
    // without a time zone (dfie_tpt 1). The time is kept without an offset,
    // so it is read as local time where it is pasted.
    const year = date.getUTCFullYear();
    const shown =
      seconds && year >= 0 && year <= 9999 ? date.toISOString() : '';
    const value =
      dat_df.dfie_tpt === 0
        ? shown.slice(0, 10)
        : dat_df.dfie_tpt === 1
          ? shown.slice(0, 19)
          : '';
    const node =
      (value !== '' ? $createDateTimeNodeFromValue(value) : null) ??
      $createDateTimeNode(date);
    return [applyFormatFromStyle(node, el.style)];
  },
  match: sel.tag('span').attr('data-rich-links', /"type"\s*:\s*"date"/),
  name: '@lexical/playground/datetime-google-docs',
});

export const DateTimeExtension = defineExtension({
  // Depend on CoreImportExtension so this extension's rules are merged after
  // the core rules (later-merged rules win dispatch). Without this the core
  // inline-format `<span>` rule could out-prioritize the `<span
  // data-lexical-datetime>` rule below, depending on where the app lists this
  // extension relative to the import baseline.
  dependencies: [
    CoreImportExtension,
    configExtension(DOMImportExtension, {
      rules: [DateTimeRule, GoogleDocsDateRule],
    }),
  ],
  name: '@lexical/playground/DateTime',
  nodes: [DateTimeNode],
  register: editor =>
    editor.registerCommand(
      INSERT_DATETIME_COMMAND,
      payload => {
        const {allDay, dateTime} = payload;
        const dateTimeNode = allDay
          ? $create(DateTimeNode).setAllDayDate(dateTime)
          : $createDateTimeNode(dateTime);

        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          dateTimeNode.setFormat(selection.format);
        }
        $insertNodeIntoLeaf(dateTimeNode);
        if ($isRootOrShadowRoot(dateTimeNode.getParent())) {
          $wrapNodeInElement(dateTimeNode, $createParagraphNode).selectEnd();
        }

        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});
