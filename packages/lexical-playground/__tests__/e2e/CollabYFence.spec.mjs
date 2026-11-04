/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Collab Y (`@lexical/y`) against the fenced relay (scripts/collab-y-server.mjs,
// docs/collaboration/y-server.md "Migrating stored documents"): a room the
// relay migrates when it loads, clients that hand off what they held when
// the room migrated under them, and the records the relay keeps, lists and
// replays.

import {expect} from '@playwright/test';

import {
  closeSessions,
  converge,
  finish,
  openClients,
} from '../utils/collabY.mjs';
import {test} from '../utils/index.mjs';

test.skip(({isCollab}) => isCollab !== 'y', 'Requires collab Y (@lexical/y)');
test.afterEach(closeSessions);

const RELAY = process.env.E2E_COLLAB_Y_RELAY || 'http://localhost:1235';

/**
 * @param {string} path
 * @param {string} room
 * @param {{method?: string, params?: Record<string, string>}} [options]
 */
async function relay(path, room, {method = 'GET', params = {}} = {}) {
  const res = await fetch(
    `${RELAY}${path}?${new URLSearchParams({room, ...params})}`,
    {method},
  );
  expect(res.ok, `${method} ${path}`).toBe(true);
  return res.json();
}

/** The relay's records for the room, by kind. */
async function records(room) {
  return relay('/records', room);
}

test.describe('Collab Y: the fenced relay', () => {
  test.beforeAll(async () => {
    const health = await (await fetch(`${RELAY}/health`)).json();
    expect(health.fence, 'the relay runs its fence').toBe(true);
  });

  test('a room migrates when it loads; edits made offline across the migration are handed off, listed and replayed', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser, {n: 2});
    const [a, b] = clients;
    const room = session.relayRoom;
    await a.editor.focus();
    await a.type('base fa1z');
    await converge(clients);
    const before = await relay('/state', room);
    // A new room is seeded at SEED_LAYOUT, 1.
    expect(before.layout).toBe(1);

    // B goes offline and keeps typing; A types online.
    await b.setOnline(false);
    await b.editor.focus();
    await b.press('End');
    await b.type(' fb1z');
    await a.press('End');
    await a.type(' fa2z');
    await expect.poll(async () => (await records(room)).length).toBe(0);

    // The migration moment: a release whose floor is 2. The relay closes
    // every connection, seals the room and loads it again, which migrates
    // it before anyone is served.
    await relay('/floor', room, {method: 'POST', params: {n: '2'}});
    const after = await relay('/reload', room, {method: 'POST'});
    expect(after.layout).toBe(2);
    expect(after.generation).not.toBe(before.generation);

    // A was connected: it reconnects with a document of the old generation,
    // is stale, hands it off (nothing in it is new), reloads and bootstraps
    // from the migrated room.
    await expect
      .poll(async () => (await records(room)).map(r => r.kind), {
        timeout: 20000,
      })
      .toEqual(['handoff']);
    await a.waitReady('active', 30000);

    // C runs a release that reads layout 2 and up: the relay admits it.
    const c = await session.open('C', {params: {collabYMinLayout: '2'}});

    // B reconnects: stale too. Its handoff holds what it typed offline,
    // which the relay replays onto the room.
    await b.page.locator('.action-button.connect').click();
    await expect
      .poll(async () => (await records(room)).length, {timeout: 20000})
      .toBe(2);
    b.offline = false;
    await b.waitReady('active', 30000);
    const listed = await records(room);
    expect(listed.map(r => [r.kind, r.source])).toEqual([
      ['handoff', before.generation],
      ['handoff', before.generation],
    ]);
    expect(listed[0].actionable).toBe(false);
    expect(listed[1].actionable).toBe(true);
    expect(listed[1].replay).toMatchObject({conflicts: 0, eligible: true});
    expect(listed[1].replay.applied).toBeGreaterThan(0);

    // The recovery list shows both records on every client.
    await expect(c.page.locator('.collab-y-recovery')).toHaveAttribute(
      'data-records',
      '2',
      {timeout: 10000},
    );

    // fa2z (A, online) and fb1z (B, offline) were typed at the same place:
    // the replay orders them as a live merge does, by client id.
    const {blocks} = await finish([a, b, c], {
      present: ['fa1z', 'fa2z', 'fb1z'],
    });
    expect([
      ['paragraph:base fa1z fa2z fb1z'],
      ['paragraph:base fa1z fb1z fa2z'],
    ]).toContainEqual(blocks);
    expect((await relay('/state', room)).layout).toBe(2);
  });

  test('a release whose floor is above the room is refused until the room migrates', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser, {n: 1});
    const [a] = clients;
    const room = session.relayRoom;
    await a.editor.focus();
    await a.type('base fa1z');
    await converge(clients);
    expect((await relay('/state', room)).layout).toBe(1);
    // A floor-2 release opening the room before it migrated: it holds no
    // material and does not read layout 1, so it is refused (no sync) and
    // says so.
    const c = await session.open('C', {
      params: {collabYMinLayout: '2'},
      status: null,
    });
    await expect(
      c.page.locator('.collab-y-notice[data-verdict="refuse-layout"]'),
    ).toBeVisible({timeout: 20000});
    expect(await c.status()).not.toBe('active');
    // Once the room migrates, the same release is admitted.
    await relay('/floor', room, {method: 'POST', params: {n: '2'}});
    expect((await relay('/reload', room, {method: 'POST'})).layout).toBe(2);
    await a.waitReady('active', 30000);
    c.offline = true;
    await c.page.reload();
    c.offline = false;
    await c.waitReady('active', 30000);
    await finish([a, c], {present: ['fa1z']});
  });
});
