/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {SerializedRawEditorState} from '../../types';
import type {ITabStateService} from '../background/TabStateService';

import {getRPCService} from '@webext-pegasus/rpc';

/**
 * Everything the injected script knows, for the one page it runs in.
 *
 * This script runs in the page's main world, so it is the least trusted part
 * of the extension: it therefore holds the state of its own page only, and
 * never receives anything about another tab. What it collects is pushed to
 * the background, which attributes it to this tab by the id the browser
 * attests on the sender and routes it to the panel inspecting this tab.
 *
 * Editor content is only sent while that panel is open. The rest of the time
 * the page reports a count, so the popup can say how many editors are here
 * without the content leaving the page at all.
 */
export class InjectedTabState {
  private readonly backgroundService = getRPCService<ITabStateService>(
    'TabStateService',
    'background',
  );

  /**
   * Editors this script has already attached listeners to.
   *
   * Separate from the states below, which are dropped whenever the panel
   * closes: a listener registered once must not be registered again.
   */
  private readonly listenedEditors = new Set<string>();

  private states: {[editorKey: string]: SerializedRawEditorState} = {};
  private panelOpen = false;

  isListening(editorKey: string): boolean {
    return this.listenedEditors.has(editorKey);
  }

  markListening(editorKey: string): void {
    this.listenedEditors.add(editorKey);
  }

  isPanelOpen(): boolean {
    return this.panelOpen;
  }

  setPanelOpen(isPanelOpen: boolean): void {
    this.panelOpen = isPanelOpen;

    if (!isPanelOpen) {
      // Nothing is kept for a panel that is not there to read it.
      this.states = {};
    }

    this.push();
  }

  replaceStates(states: {[editorKey: string]: SerializedRawEditorState}): void {
    this.states = states;
    this.push();
  }

  setState(editorKey: string, state: SerializedRawEditorState): void {
    this.states = {...this.states, [editorKey]: state};
    this.push();
  }

  reportIsSelecting(isSelecting: boolean): void {
    this.backgroundService.reportIsSelecting(isSelecting).catch(console.error);
  }

  reportSelectedEditorKey(editorKey: string | null): void {
    this.backgroundService
      .reportSelectedEditorKey(editorKey)
      .catch(console.error);
  }

  private push(): void {
    this.backgroundService
      .reportEditorCount(Object.keys(this.states).length)
      .catch(console.error);

    if (this.panelOpen) {
      this.backgroundService.reportStates(this.states).catch(console.error);
    }
  }
}
