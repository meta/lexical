/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import type {ExtensionState} from '../../store';
import type {StoreApi} from 'zustand';

import {IS_FIREFOX, IS_SAFARI} from 'lexical';

import {
  CONTENT_SCRIPT_PING,
  type ContentScriptPingMessage,
} from '../../contentScriptPing';

export default class ActionIconWatchdog {
  private constructor(
    private readonly extensionStore: StoreApi<ExtensionState>,
  ) {}

  static async start(store: StoreApi<ExtensionState>) {
    return new ActionIconWatchdog(store).init();
  }

  async init() {
    const tabs = await browser.tabs.query({});
    await Promise.all(
      tabs.map(tab =>
        tab.id == null
          ? undefined
          : this.checkAndHandleRestrictedPageIfSo(tab.id),
      ),
    );

    // Re-check the page once a navigation finishes and update the DevTools icon.
    browser.tabs.onUpdated.addListener(this.handleTabsUpdatedEvent.bind(this));

    // Serialized editor state lives as long as this service worker, so drop a
    // tab's contents once they can no longer describe anything on screen.
    browser.tabs.onRemoved.addListener(tabId => {
      this.extensionStore.getState().clearTab(tabId);
    });
  }

  private async setIcon(
    lexicalBuildType: 'restricted' | 'enabled',
    tabId: number,
  ) {
    const action =
      IS_FIREFOX || IS_SAFARI ? browser.browserAction : browser.action;

    await action.setIcon({
      path: {
        '128': browser.runtime.getURL(
          lexicalBuildType === 'enabled'
            ? '/icon/128.png'
            : '/icon/128-restricted.png',
        ),
        '16': browser.runtime.getURL(
          lexicalBuildType === 'enabled'
            ? '/icon/16.png'
            : '/icon/16-restricted.png',
        ),
        '32': browser.runtime.getURL(
          lexicalBuildType === 'enabled'
            ? '/icon/32.png'
            : '/icon/32-restricted.png',
        ),
        '48': browser.runtime.getURL(
          lexicalBuildType === 'enabled'
            ? '/icon/48.png'
            : '/icon/48-restricted.png',
        ),
      },
      tabId: tabId,
    });

    if (lexicalBuildType === 'restricted') {
      this.extensionStore.getState().markTabAsRestricted(tabId);
    }
  }

  private handleTabsUpdatedEvent(
    tabId: number,
    changeInfo: {status?: string},
  ): void {
    // A navigation tears down every editor the previous document had, so the
    // state retained for it is stale the moment loading starts.
    if (changeInfo.status === 'loading') {
      this.extensionStore.getState().clearTab(tabId);
    }

    // The content script runs at document_end, before the tab reports
    // "complete", so by then it can answer if this page allows it at all.
    if (changeInfo.status === 'complete') {
      this.checkAndHandleRestrictedPageIfSo(tabId).catch(console.error);
    }
  }

  /**
   * Whether our content script is running in the tab. Browsers do not run it
   * on restricted pages (chrome:, about:, edge:, file: without opt-in, the
   * extension stores), so this tells those pages apart without reading
   * `Tab.url`, which would need the `tabs` permission.
   */
  private async isContentScriptReachable(tabId: number): Promise<boolean> {
    try {
      const message: ContentScriptPingMessage = {type: CONTENT_SCRIPT_PING};
      return (await browser.tabs.sendMessage(tabId, message)) === true;
    } catch {
      // "Receiving end does not exist": no content script in this tab.
      return false;
    }
  }

  private async checkAndHandleRestrictedPageIfSo(tabId: number) {
    if (!(await this.isContentScriptReachable(tabId))) {
      return this.setIcon('restricted', tabId);
    }

    return this.setIcon('enabled', tabId);
  }
}
