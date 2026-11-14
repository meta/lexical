/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Collab Y offline mode (`@lexical/y/offline`, the playground's "Collab Y
// Offline" setting): edits made with no connection are stored on the device,
// survive a reload, and sync on reconnect; when the room is replaced (the
// panel's "Simulate replaced" plays the server), the page's copy is captured
// and the Offline edits panel offers it back, reapplied at once at stage
// `replay` and on request at stage `persist`.

import {expect} from '@playwright/test';

import {closeSessions, converge, openClients, seed} from '../utils/collabY.mjs';
import {test} from '../utils/index.mjs';

test.skip(({isCollab}) => isCollab !== 'y', 'Requires collab Y (@lexical/y)');
test.afterEach(closeSessions);

const OFFLINE = {collabYOffline: 'true'};

const status = client =>
  client.page.locator('[data-test-id="collab-y-offline-status"]');

/** Wait until what the client typed is stored on its device. */
async function stored(client, {unsynced}) {
  await expect(status(client)).toHaveAttribute('data-persisted', 'true');
  await expect(status(client)).toHaveAttribute(
    'data-unsynced',
    String(unsynced),
  );
}

test.describe('Collab Y: offline mode', () => {
  test('edits made with no connection survive a reload and sync on reconnect', async ({
    browser,
  }) => {
    const {clients} = await openClients(browser, {params: OFFLINE});
    const [a, b] = clients;
    await seed(clients, ['ka1z']);
    await stored(a, {unsynced: false});

    // The relay becomes unreachable for A (a reload must not reach it).
    let blocked = true;
    await a.page.routeWebSocket(/playground-y/, ws => {
      if (blocked) {
        ws.close();
      } else {
        ws.connectToServer();
      }
    });
    await a.setOnline(false);
    await a.editor.focus();
    await a.press('End');
    await a.type(' kb2z');
    await stored(a, {unsynced: true});

    a.offline = true;
    await a.page.reload();
    // Editable at once from the stored document, with no connection.
    await expect.poll(() => a.status(), {timeout: 20000}).toBe('active');
    await expect.poll(() => a.blocks()).toEqual(['paragraph:ka1z kb2z']);
    expect(await b.blocks()).toEqual(['paragraph:ka1z']);
    await a.editor.focus();
    await a.press('End');
    await a.type(' kc3z');

    // The connection comes back: the documents merge.
    blocked = false;
    await expect.poll(() => a.connected(), {timeout: 30000}).toBe(true);
    a.offline = false;
    await converge(clients);
    expect(await b.blocks()).toEqual(['paragraph:ka1z kb2z kc3z']);
    await stored(a, {unsynced: false});
  });

  test('a replaced room: the offline edit is captured and reapplied as one undo step', async ({
    browser,
  }) => {
    const {clients} = await openClients(browser, {n: 1, params: OFFLINE});
    const [a] = clients;
    await seed(clients, ['one', 'two']);
    await stored(a, {unsynced: false});
    await a.setOnline(false);
    await a.caret('one');
    await a.type(' mine');
    await stored(a, {unsynced: true});

    // The server moves the room to the next epoch; the page follows.
    await a.page.locator('[data-test-id="collab-y-offline-replace"]').click();
    await a.page.waitForURL(/collabYEpoch=2/);
    a.offline = false;
    await a.waitReady();
    // Reapplied onto the room's new document.
    await expect
      .poll(() => a.blocks(), {timeout: 20000})
      .toEqual(['paragraph:one mine', 'paragraph:two']);
    await expect(
      a.page.locator('[data-test-id="collab-y-offline-capture"]'),
    ).toContainText('1 reapplied');
    await a.editor.focus();
    await a.undo();
    await expect
      .poll(() => a.blocks())
      .toEqual(['paragraph:one', 'paragraph:two']);
  });

  test('stage persist: nothing is applied until Reapply', async ({browser}) => {
    const {clients} = await openClients(browser, {
      n: 1,
      params: {...OFFLINE, collabYOfflineStage: 'persist'},
    });
    const [a] = clients;
    await seed(clients, ['one', 'two']);
    await stored(a, {unsynced: false});
    await a.setOnline(false);
    await a.caret('one');
    await a.type(' mine');
    await stored(a, {unsynced: true});

    await a.page.locator('[data-test-id="collab-y-offline-replace"]').click();
    await a.page.waitForURL(/collabYEpoch=2/);
    a.offline = false;
    await a.waitReady();
    const block = a.page.locator('[data-test-id="collab-y-offline-block"]');
    await expect(block).toHaveCount(1);
    await expect(block).toHaveAttribute('data-change', 'changed');
    await expect(block).toContainText('one mine');
    expect(await a.blocks()).toEqual(['paragraph:one', 'paragraph:two']);

    await block.locator('[data-test-id="collab-y-offline-reapply"]').click();
    await expect
      .poll(() => a.blocks())
      .toEqual(['paragraph:one mine', 'paragraph:two']);
    await expect(block).toHaveCount(0);
  });
});
