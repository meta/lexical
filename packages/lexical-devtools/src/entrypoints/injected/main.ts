/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {ExtensionState} from '../../store';
import type {LexicalCommandLog} from '@lexical/devtools-core';
import type {LexicalEditor} from 'lexical';
import type {StoreApi} from 'zustand';

import {registerRPCService} from '@webext-pegasus/rpc';

import {InjectedPegasusService} from './InjectedPegasusService';
import scanAndListenForEditors from './scanAndListenForEditors';

const commandLog = new WeakMap<LexicalEditor, LexicalCommandLog>();

export default async function main(
  tabID: number,
  extensionStore: StoreApi<ExtensionState>,
) {
  registerRPCService(
    'InjectedPegasusService',
    new InjectedPegasusService(tabID, extensionStore, commandLog),
  );

  scanAndListenForEditors(tabID, extensionStore, commandLog);

  // Serialized state is masked while no panel is open for this tab, so re-scan
  // whenever that changes to swap the relayed states between masked and clear.
  let wasPanelOpen = extensionStore.getState().isPanelOpen[tabID] === true;
  extensionStore.subscribe(state => {
    const isPanelOpen = state.isPanelOpen[tabID] === true;
    if (isPanelOpen !== wasPanelOpen) {
      wasPanelOpen = isPanelOpen;
      scanAndListenForEditors(tabID, extensionStore, commandLog);
    }
  });
}
