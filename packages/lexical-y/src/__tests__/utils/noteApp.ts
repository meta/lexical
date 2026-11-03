/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Test-only: a note editor's node set built from public packages (rich
// text, lists, check lists, code, links, tables without merged cells or
// background colors, tab indentation), plus MarkState comments, as a
// downstream note app configures it; and the configs the stored-corpora
// tests read with (the catalog's, or this one).

import {CodeExtension} from '@lexical/code-core';
import {TabIndentationExtension} from '@lexical/extension';
import {ClickableLinkExtension, LinkExtension} from '@lexical/link';
import {CheckListExtension, ListExtension} from '@lexical/list';
import {MarkStateExtension} from '@lexical/mark';
import {RichTextExtension} from '@lexical/rich-text';
import {TableExtension} from '@lexical/table';
import {configExtension, defineExtension} from 'lexical';

import {type HeadlessYConfig} from '../../headless';
import {catalogHeadlessConfig} from '../catalog/bind';

export const noteAppExtension = defineExtension({
  dependencies: [
    RichTextExtension,
    ListExtension,
    CheckListExtension,
    CodeExtension,
    LinkExtension,
    configExtension(ClickableLinkExtension, {newTab: true}),
    configExtension(TableExtension, {
      hasCellBackgroundColor: false,
      hasCellMerge: false,
    }),
    configExtension(TabIndentationExtension, {maxIndent: 6}),
  ],
  name: 'test/note-app',
  namespace: 'jot',
});

/** A stored corpus entry's configuration. */
export type CorpusConfig =
  | {readonly app: 'notes'}
  | Parameters<typeof catalogHeadlessConfig>[0];

/** The headless config a corpus entry is read with. */
export function corpusConfig(
  cfg: CorpusConfig,
  extra: Partial<HeadlessYConfig> = {},
): HeadlessYConfig {
  if (cfg !== undefined && 'app' in cfg) {
    return {
      extensions: [noteAppExtension, MarkStateExtension],
      schemaVersion: 1,
      ...extra,
    };
  }
  return catalogHeadlessConfig(cfg, extra);
}
