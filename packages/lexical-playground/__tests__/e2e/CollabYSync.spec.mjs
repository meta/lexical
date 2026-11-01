/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Collab Y (`@lexical/y`): clients that open a new document at once,
// clients that edit while disconnected (the toolbar's connect button) and
// reconnect, undo that only reverts the client's own changes, the version
// gate, a client waiting for its first sync, and provider connections that
// fail.

import {expect} from '@playwright/test';
import {createServer} from 'node:net';

import {
  closeSessions,
  converge,
  finish,
  openClients,
  seed,
  tokens,
} from '../utils/collabY.mjs';
import {E2E_PORT, test} from '../utils/index.mjs';

test.skip(({isCollab}) => isCollab !== 'y', 'Requires collab Y (@lexical/y)');
test.afterEach(closeSessions);

/** Call the editor's `setEditable` directly, as any code on the page could. */
async function setEditable(client, editable) {
  await client.evaluate(value => {
    document
      .querySelector('[data-lexical-editor]')
      .__lexicalEditor.setEditable(value);
  }, editable);
}

test.describe('Collab Y: a new document', () => {
  test('clients that open a new document at once write one paragraph', async ({
    browser,
  }) => {
    // Each client writes its initial state (an empty paragraph) into the
    // empty document when it first syncs; identical seeds merge into one.
    const {clients} = await openClients(browser, {n: 3, together: true});
    const {blocks} = await finish(clients);
    expect(blocks).toEqual(['paragraph:']);
    const [a, b] = clients;
    await a.editor.focus();
    await a.type('ka1z');
    await converge(clients);
    await b.editor.focus();
    await b.press('End');
    await b.type(' kb1z');
    const after = await finish(clients, {present: ['ka1z', 'kb1z']});
    expect(after.blocks).toEqual(['paragraph:ka1z kb1z']);
  });

  test('the split view shows the first paragraph once', async ({page}) => {
    const params = new URLSearchParams({
      collabId: `y-split-${test.info().project.name}-${Date.now()}`,
      emptyEditor: 'true',
      isCollab: 'true',
      isRichText: 'true',
      showTreeView: 'false',
      useCollabY: 'true',
    });
    await page.goto(`http://localhost:${E2E_PORT}/split/?${params}`);
    for (const name of ['left', 'right']) {
      const editor = page
        .frameLocator(`iframe[name="${name}"]`)
        .locator('[data-lexical-editor="true"]');
      await expect(editor).toHaveAttribute('contenteditable', 'true', {
        timeout: 20000,
      });
    }
    // Both frames initialized the new document; give their writes time to
    // reach each other.
    await page.waitForTimeout(1000);
    for (const name of ['left', 'right']) {
      await expect(
        page
          .frameLocator(`iframe[name="${name}"]`)
          .locator('[data-lexical-editor="true"] > *'),
      ).toHaveCount(1);
    }
  });
});

test.describe('Collab Y: offline', () => {
  test('both sides edit text and structure while one is offline, then reconnect', async ({
    browser,
  }) => {
    const {clients} = await openClients(browser, {n: 3});
    const [a, b, c] = clients;
    await seed(clients, ['o1z o2z', 'o3z o4z', 'o5z']);
    await b.setOnline(false);
    // Online: A types in line 1 and splits line 2; C makes line 3 a heading.
    await a.caret('o1z');
    await a.type(' ka1z');
    await a.caret('o3z');
    await a.press('Enter');
    await a.type('ka2z ');
    await c.caret('o5z');
    await c.blockType('h1');
    await c.type(' kc1z');
    // Offline: B types in lines 1 and 2, and joins line 3 into line 2.
    await b.caret('o2z');
    await b.type(' kb1z');
    await b.caret('o4z');
    await b.type(' kb2z');
    await b.block(2, 'start');
    await b.press('Backspace');
    await b.type('kb3z ');
    await converge([a, c]);
    expect((await b.blocks()).join('|')).not.toContain('ka1z');
    expect((await a.blocks()).join('|')).not.toContain('kb1z');
    await b.setOnline(true);
    const {blocks} = await finish(clients, {
      present: [
        ...['o1z', 'o2z', 'o3z', 'o4z', 'o5z'],
        ...['ka1z', 'ka2z', 'kc1z', 'kb1z', 'kb2z', 'kb3z'],
      ],
    });
    expect(blocks[0]).toBe('paragraph:o1z ka1z o2z kb1z');
    expect(blocks.length).toBe(3);
  });

  test('large divergence: 30 lines on each side, lists, headings and joins', async ({
    browser,
  }) => {
    test.setTimeout(240000);
    const {clients} = await openClients(browser);
    const [a, b] = clients;
    const base = tokens('bl', 8);
    await seed(clients, base);
    await b.setOnline(false);
    // A appends 30 lines, makes a list of lines 2-4, a heading of line 6,
    // and types in every line.
    const ta = tokens('ka', 30);
    await a.block(7, 'end');
    for (const t of ta) {
      await a.press('Enter');
      await a.type(t, 0);
    }
    await a.range('bl2z', 'bl4z');
    await a.blockType('bullet-list');
    await a.caret('bl6z');
    await a.blockType('h2');
    const tx = tokens('kx', 8);
    for (let i = 0; i < 8; i++) {
      await a.caret(base[i]);
      await a.type(` ${tx[i]}`, 0);
    }
    // B, offline, prepends 30 lines, types in every line, joins two pairs
    // of lines and splits line 3.
    const tb = tokens('kb', 30);
    await b.block(0, 'start');
    for (const t of tb) {
      await b.type(t, 0);
      await b.press('Enter');
    }
    const ty = tokens('ky', 8);
    for (let i = 0; i < 8; i++) {
      await b.caret(base[i], 'before');
      await b.type(`${ty[i]} `, 0);
    }
    for (const i of [5, 7]) {
      await b.caret(ty[i], 'before');
      await b.press('Backspace');
    }
    await b.caret('bl3z');
    await b.press('Enter');
    await b.type('kb31z', 0);
    await b.setOnline(true);
    await finish(clients, {
      present: [...base, ...ta, ...tb, ...tx, ...ty, 'kb31z'],
    });
  });
});

test.describe('Collab Y: undo isolation', () => {
  test('undo and redo own typing after a peer typed in the same line', async ({
    browser,
  }) => {
    const {clients} = await openClients(browser);
    const [a, b] = clients;
    await seed(clients, ['u1z u2z']);
    await a.caret('u2z');
    await a.type(' ka1z');
    await a.stopCapturing();
    await converge(clients);
    await b.caret('u1z', 'before');
    await b.type('kb1z ');
    await b.caret('ka1z');
    await b.type(' kb2z');
    await converge(clients);
    await a.undo();
    await converge(clients);
    expect(await a.blocks()).toEqual(['paragraph:kb1z u1z u2z kb2z']);
    await a.redo();
    await converge(clients);
    expect(await a.blocks()).toEqual(['paragraph:kb1z u1z u2z ka1z kb2z']);
    await a.undo();
    await finish(clients, {
      absent: ['ka1z'],
      present: ['u1z', 'u2z', 'kb1z', 'kb2z'],
    });
  });

  test('undo of Enter and a heading keeps a peer’s edits in those lines', async ({
    browser,
  }) => {
    const {clients} = await openClients(browser);
    const [a, b] = clients;
    await seed(clients, ['s1z s2z', 's3z']);
    await a.caret('s1z');
    await a.press('Enter');
    await a.stopCapturing();
    await a.caret('s3z');
    await a.blockType('h1');
    await a.stopCapturing();
    await converge(clients);
    await b.caret('s2z');
    await b.type(' kb1z');
    await b.caret('s3z');
    await b.type(' kb2z');
    await converge(clients);
    await a.undo();
    await converge(clients);
    expect(await a.blocks()).toEqual([
      'paragraph:s1z',
      'paragraph: s2z kb1z',
      'paragraph:s3z kb2z',
    ]);
    await a.undo();
    await converge(clients);
    expect(await a.blocks()).toEqual([
      'paragraph:s1z s2z kb1z',
      'paragraph:s3z kb2z',
    ]);
    await a.redo();
    await a.redo();
    const {blocks} = await finish(clients, {
      present: ['s1z', 's2z', 's3z', 'kb1z', 'kb2z'],
    });
    expect(blocks).toEqual([
      'paragraph:s1z',
      'paragraph: s2z kb1z',
      'heading/h1:s3z kb2z',
    ]);
  });

  test('undo while a peer types inside the text being undone', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser);
    const [a, b] = clients;
    await seed(clients, ['c1z', 'c2z']);
    await a.caret('c1z');
    await a.type(' ka1z ka2z');
    await a.stopCapturing();
    await converge(clients);
    await b.caret('ka1z');
    await session.delay();
    await Promise.all([a.undo(), b.type(' kb1z kb2z', 30)]);
    const {blocks} = await finish(clients, {
      absent: ['ka2z'],
      present: ['c1z', 'c2z', 'kb1z', 'kb2z'],
    });
    expect(blocks[0]).toContain('kb1z kb2z');
  });
});

/**
 * The read-only notice for a newer layout: the binding's warning code and
 * typed reason (on the element), and the text the playground picks from it.
 */
async function expectNewerLayoutNotice(client) {
  const notice = client.page.locator('.collab-y-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute(
    'data-code',
    '@lexical/y/unsupported-layout',
  );
  await expect(notice).toHaveAttribute('data-reason', 'newer');
  await expect(notice).toContainText('written by a newer version');
}

test.describe('Collab Y: version gate', () => {
  test('a client that does not support the document’s layout is read only', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser);
    const [a, b] = clients;
    // The binding's warning, logged by the playground as `message (code)`:
    // tolerated by its code, and checked below by code and reason.
    session.expect(/\(@lexical\/y\/unsupported-layout\)$/);
    await seed(clients, ['g1z']);
    // A newer client adds a newer layout version to the document's layout
    // record (the root's `lexical-y:<n>: true` attributes, a record that only
    // grows). Every reader takes the highest; 99 is one this binding does not
    // support.
    await a.evaluate(() => {
      const editor = document.querySelector(
        '[data-lexical-editor]',
      ).__lexicalEditor;
      const {binding} =
        editor[
          Symbol.for('@lexical/extension/LexicalBuilder')
        ].extensionNameMap.get('@lexical/y/Collab').state.output;
      binding.doc.transact(() => binding.root.setAttr('lexical-y:99', true));
    });
    // Clients that are open become read only...
    for (const c of [a, b]) {
      await expect.poll(() => c.status()).toBe('readonly');
      await expect(c.editor).toHaveAttribute('contenteditable', 'false');
      await expectNewerLayoutNotice(c);
    }
    // ...and so does a client that loads the document afterwards.
    const late = await session.open('L', {status: 'readonly'});
    await expect(late.editor).toHaveAttribute('contenteditable', 'false');
    await expectNewerLayoutNotice(late);
    expect(await late.blocks()).toEqual(['paragraph:g1z']);
    // Typing changes nothing.
    await b.editor.click({force: true});
    await b.type('kb1z');
    await late.editor.click({force: true});
    await late.type('kl1z');
    await b.page.waitForTimeout(300);
    for (const c of [a, b, late]) {
      expect(await c.blocks()).toEqual(['paragraph:g1z']);
      expect(c.problems).toEqual([]);
    }
    // The toolbar's read-only toggle is off, and nothing else can make the
    // editor editable while the binding is read only.
    for (const c of [b, late]) {
      await expect(c.page.locator('.action-button.unlock')).toBeDisabled();
      await setEditable(c, true);
      await expect(c.editor).toHaveAttribute('contenteditable', 'false');
      await c.editor.click({force: true});
      await c.type('kt1z');
    }
    await b.page.waitForTimeout(300);
    for (const c of [a, b, late]) {
      expect(await c.blocks()).toEqual(['paragraph:g1z']);
    }
  });

  test('a client older than a version that wrote the document is read only', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser);
    const [a, b] = clients;
    session.expect(/\(@lexical\/y\/unsupported-schema\)$/);
    await seed(clients, ['v1z']);
    // A newer version of the app (`schemaVersion` 99) wrote to the document:
    // it records its version on the root (`lexical-y-schema:<n>: true`, a
    // record that only grows) with its first write.
    await a.evaluate(() => {
      const editor = document.querySelector(
        '[data-lexical-editor]',
      ).__lexicalEditor;
      const {binding} =
        editor[
          Symbol.for('@lexical/extension/LexicalBuilder')
        ].extensionNameMap.get('@lexical/y/Collab').state.output;
      binding.doc.transact(() =>
        binding.root.setAttr('lexical-y-schema:99', true),
      );
    });
    for (const c of [a, b]) {
      await expect.poll(() => c.status()).toBe('readonly');
      await expect(c.editor).toHaveAttribute('contenteditable', 'false');
      const notice = c.page.locator('.collab-y-notice');
      await expect(notice).toBeVisible();
      await expect(notice).toHaveAttribute(
        'data-code',
        '@lexical/y/unsupported-schema',
      );
      await expect(notice).toHaveAttribute('data-reason', 'newer');
      await expect(notice).toContainText('newer version of the playground');
      expect(await c.blocks()).toEqual(['paragraph:v1z']);
    }
    // Typing changes nothing.
    await b.editor.click({force: true});
    await b.type('kb1z');
    await b.page.waitForTimeout(300);
    for (const c of [a, b]) {
      expect(await c.blocks()).toEqual(['paragraph:v1z']);
      expect(c.problems).toEqual([]);
    }
  });
});

test.describe('Collab Y: before the first sync', () => {
  test('the editor is not editable until the binding has read the document', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser, {n: 1});
    const [a] = clients;
    await seed(clients, ['p1z']);
    // The relay holds back what it sends: the next client waits for its
    // first sync.
    await session.delay(3000);
    const late = await session.open('L', {status: 'pending'});
    await expect(late.editor).toHaveAttribute('contenteditable', 'false');
    await expect(late.page.locator('.action-button.unlock')).toBeDisabled();
    // Nothing makes it editable before then, so nothing typed is dropped
    // when the document arrives.
    await setEditable(late, true);
    await expect(late.editor).toHaveAttribute('contenteditable', 'false');
    await late.editor.click({force: true});
    await late.type('kp1z');
    await session.delay(0);
    await late.waitReady();
    await expect(late.editor).toHaveAttribute('contenteditable', 'true');
    await expect(late.page.locator('.action-button.lock')).toBeEnabled();
    expect(await late.blocks()).toEqual(['paragraph:p1z']);
    // Once active, it is the client's to lock and unlock.
    await late.page.locator('.action-button.lock').click();
    await expect(late.editor).toHaveAttribute('contenteditable', 'false');
    await late.page.locator('.action-button.unlock').click();
    await expect(late.editor).toHaveAttribute('contenteditable', 'true');
    await finish([a, late], {present: ['p1z']});
  });
});

/** A local port nothing listens on: one the system just assigned and freed. */
function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Send the first `count` collab provider WebSockets of a browser context's
 * pages (all of them if `count` is negative) to `port` on localhost, where
 * nothing listens: each fails as a refused connection, which the browser
 * logs, and the provider retries as after any failure. The provider is
 * matched by its rooms' path (/playground-y/), not its host and port.
 *
 * @param {import('@playwright/test').BrowserContext} context
 * @param {number} port
 * @param {number} count
 */
function refuseProviderSockets(context, port, count) {
  return context.addInitScript(
    ([refusedPort, refusedCount]) => {
      const NativeWebSocket = window.WebSocket;
      let refused = 0;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url, protocols) {
          const target = new URL(url, window.location.href);
          if (
            target.pathname.startsWith('/playground-y/') &&
            (refusedCount < 0 || refused < refusedCount)
          ) {
            refused++;
            target.host = `localhost:${refusedPort}`;
          }
          super(target.href, protocols);
        }
      };
    },
    [port, count],
  );
}

test.describe('Collab Y: transport', () => {
  test('a provider connection that fails is reported, even after the provider reconnects', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser, {n: 1});
    const port = await unusedPort();
    // B's first provider socket is refused; the provider reconnects, so B
    // opens, syncs and converges.
    const b = await session.open('B', {
      beforeLoad: context => refuseProviderSockets(context, port, 1),
    });
    const refused = `localhost:${port}/playground-y/`;
    expect(b.problems.length).toBeGreaterThan(0);
    expect(b.problems.filter(p => !p.includes(refused))).toEqual([]);
    await seed([...clients, b], ['t1z']);
    // Everything else the final checks look at is fine; the failed
    // connection fails them.
    await expect(finish([...clients, b], {present: ['t1z']})).rejects.toThrow(
      new RegExp(`\\[B\\] console\\.(error|warning): .*${refused}`),
    );
  });

  test('a client whose provider never connects does not open', async ({
    browser,
  }) => {
    const {session} = await openClients(browser, {n: 1});
    const port = await unusedPort();
    await expect(
      session.open('B', {
        beforeLoad: context => refuseProviderSockets(context, port, -1),
        timeout: 5000,
      }),
    ).rejects.toThrow();
    const b = session.clients[session.clients.length - 1];
    expect(await b.status()).toBe('pending');
    expect(await b.connected()).toBe(false);
    const refused = `localhost:${port}/playground-y/`;
    expect(b.problems.length).toBeGreaterThan(0);
    expect(b.problems.filter(p => !p.includes(refused))).toEqual([]);
  });
});
