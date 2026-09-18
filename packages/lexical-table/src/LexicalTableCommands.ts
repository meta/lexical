/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {createCommand, type LexicalCommand} from 'lexical';

export type InsertTableCommandPayloadHeaders =
  | Readonly<{
      rows: boolean;
      columns: boolean;
    }>
  | boolean;

export type InsertTableCommandPayload = Readonly<{
  columns: string;
  rows: string;
  includeHeaders?: InsertTableCommandPayloadHeaders;
}>;

export const INSERT_TABLE_COMMAND: LexicalCommand<InsertTableCommandPayload> =
  createCommand('INSERT_TABLE_COMMAND');
