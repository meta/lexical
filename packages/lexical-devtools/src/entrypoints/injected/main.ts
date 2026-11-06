/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalCommandLog} from '@lexical/devtools-core';
import type {LexicalEditor} from 'lexical';

import {registerRPCService} from '@webext-pegasus/rpc';

import {InjectedPegasusService} from './InjectedPegasusService';
import {InjectedTabState} from './InjectedTabState';
import scanAndListenForEditors from './scanAndListenForEditors';

const commandLog = new WeakMap<LexicalEditor, LexicalCommandLog>();

export default function main() {
  // State for this page, held by this page: nothing about any other tab is
  // mirrored into the page's world.
  const tabState = new InjectedTabState();

  registerRPCService(
    'InjectedPegasusService',
    new InjectedPegasusService(tabState, commandLog),
  );

  scanAndListenForEditors(tabState, commandLog);
}
