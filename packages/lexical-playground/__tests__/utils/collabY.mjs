/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Multi-client helpers for the collab Y (`@lexical/y`) specs
// (`e2e/CollabY*.spec.mjs`, run with E2E_EDITOR_MODE=rich-text-with-collab-y
// against `pnpm run collab:y`).
//
// The split view drives its two frames with one keyboard, so edits there can
// only take turns. These specs need edits that cross in flight, so every
// client is a playground page in its own BrowserContext, typing with its own
// keyboard, and the relay delays server-to-client messages while the clients
// edit at the same time. Edits are real key events and toolbar clicks; only
// caret placement sets the DOM selection directly (where a click would land).

import {expect, test} from '@playwright/test';

import {E2E_PORT} from './index.mjs';

const RELAY = process.env.E2E_COLLAB_Y_RELAY || 'http://localhost:1235';
// The relay delay (ms) while clients edit concurrently.
export const DELAY = Number(process.env.E2E_COLLAB_Y_DELAY ?? 200);

// The playground's Vercel analytics scripts, which only a Vercel deployment
// serves.
const VERCEL_SCRIPT = /\/_vercel\/(?:insights|speed-insights)\/script\.js$/;

/**
 * Whether a console message is one every playground page logs that is not
 * about the editor or its transport: the playground's notice about profiling
 * with the debug view (src/App.tsx), and the failed loads of the Vercel
 * analytics scripts. Chromium (and WebKit) report a failed load as "Failed to
 * load resource: ..." with the script's URL as the message's location;
 * Firefox as "Loading failed for the <script> with source “<url>”.". Every
 * other warning or error is a problem (see Client).
 *
 * @param {import('@playwright/test').ConsoleMessage} message
 */
function isPageNoise(message) {
  const text = message.text();
  if (text.startsWith('If you are profiling the playground app')) {
    return true;
  }
  if (text.startsWith('Failed to load resource')) {
    return VERCEL_SCRIPT.test(message.location().url);
  }
  const firefox = /Loading failed for the <script> with source “([^”]+)”/.exec(
    text,
  );
  return firefox !== null && VERCEL_SCRIPT.test(firefox[1]);
}

// What the browsers log when a WebSocket to the collab provider (its rooms
// are under /playground-y/) fails to connect, is closed while it connects, or
// is cut off: "WebSocket connection to '<url>' failed: ..." (Chromium,
// WebKit), "Firefox can’t establish a connection to the server at <url>." and
// "The connection to <url> was interrupted while the page was loading."
// (Firefox). Such a message is a problem, even if the provider then
// reconnects, except while the client is deliberately offline (see
// Client.setOnline).
const PROVIDER_SOCKET_FAILURE =
  /(?:WebSocket connection to '|can.t establish a connection to the server at |The connection to )wss?:\/\/[^/\s']+\/playground-y\//;

const COLLAB_EXTENSION = '@lexical/y/Collab';

export class Client {
  /**
   * @param {string} name
   * @param {import('@playwright/test').BrowserContext} context
   * @param {import('@playwright/test').Page} page
   * @param {Session} session
   */
  constructor(name, context, page, session) {
    this.name = name;
    this.context = context;
    this.page = page;
    this.session = session;
    /** @type {string[]} */
    this.problems = [];
    this.mod = 'Control';
    // Whether the client is deliberately offline (see setOnline).
    this.offline = false;
    page.on('console', message => {
      const type = message.type();
      if (type !== 'warning' && type !== 'error') {
        return;
      }
      const text = message.text();
      if (
        isPageNoise(message) ||
        session.allowed(text) ||
        (this.offline && PROVIDER_SOCKET_FAILURE.test(text))
      ) {
        return;
      }
      this.problems.push(`console.${type}: ${text}`);
    });
    page.on('pageerror', error => {
      // A benign notification (see Session.open), reported as an uncaught
      // error by WebKit.
      if (/^ResizeObserver loop/.test(error.message)) {
        return;
      }
      this.problems.push(`pageerror: ${error.stack || error.message}`);
    });
  }

  get editor() {
    return this.page.locator('[data-lexical-editor="true"]');
  }

  /** @param {Function} fn @param {unknown} [arg] */
  evaluate(fn, arg) {
    return this.page.evaluate(fn, arg);
  }

  /** The binding's status: 'pending', 'active' or 'readonly'. */
  status() {
    return this.evaluate(name => {
      const editor = document.querySelector(
        '[data-lexical-editor]',
      )?.__lexicalEditor;
      const output =
        editor?.[
          Symbol.for('@lexical/extension/LexicalBuilder')
        ]?.extensionNameMap.get(name)?.state?.output;
      return output ? output.binding.status : 'none';
    }, COLLAB_EXTENSION);
  }

  connected() {
    return this.page
      .locator('.action-button.connect')
      .getAttribute('title')
      .then(title => /^Disconnect/.test(title || ''));
  }

  /**
   * Wait until the binding reaches `status` and the provider is connected.
   *
   * @param {string} [status]
   * @param {number} [timeout] ms, for each of the two
   */
  async waitReady(status = 'active', timeout = 20000) {
    await expect.poll(() => this.status(), {timeout}).toBe(status);
    await expect.poll(() => this.connected(), {timeout}).toBe(true);
  }

  /** Whether the binding runs its self-check (see Session.open). */
  selfCheck() {
    return this.evaluate(name => {
      const editor = document.querySelector(
        '[data-lexical-editor]',
      )?.__lexicalEditor;
      const output =
        editor?.[
          Symbol.for('@lexical/extension/LexicalBuilder')
        ]?.extensionNameMap.get(name)?.state?.output;
      return output?.binding.options.selfCheck === true;
    }, COLLAB_EXTENSION);
  }

  /** The editor state as JSON (the root node). */
  json() {
    return this.evaluate(
      () =>
        document
          .querySelector('[data-lexical-editor]')
          .__lexicalEditor.getEditorState()
          .toJSON().root,
    );
  }

  async blocks() {
    return blocksOf(await this.json());
  }

  /** @param {string} text */
  async type(text, delay = 15) {
    await this.page.keyboard.type(text, {delay});
  }

  /** @param {...string} keys */
  async press(...keys) {
    for (const key of keys) {
      await this.page.keyboard.press(key.replace('Mod', this.mod));
    }
  }

  /**
   * Put the caret before or after a token that occurs once in the document,
   * where a click would put it.
   *
   * @param {string} token
   * @param {'before' | 'after'} [where]
   */
  async caret(token, where = 'after') {
    await this.evaluate(
      ([t, w]) => {
        const root = document.querySelector('[data-lexical-editor]');
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const hits = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const i = node.data.indexOf(t);
          if (i >= 0) {
            hits.push([node, i]);
          }
        }
        if (hits.length !== 1) {
          throw new Error(`token ${t}: ${hits.length} hits`);
        }
        const [node, index] = hits[0];
        const offset = w === 'before' ? index : index + t.length;
        root.focus();
        window.getSelection().setBaseAndExtent(node, offset, node, offset);
      },
      [token, where],
    );
    await this.settleSelection();
  }

  /**
   * Select from the start of `from` to the end of `to`.
   *
   * @param {string} from
   * @param {string} [to]
   */
  async range(from, to = from) {
    await this.evaluate(
      ([f, t]) => {
        const root = document.querySelector('[data-lexical-editor]');
        const find = token => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const i = node.data.indexOf(token);
            if (i >= 0) {
              return [node, i];
            }
          }
          throw new Error(`token ${token} not found`);
        };
        const [a, ai] = find(f);
        const [b, bi] = find(t);
        root.focus();
        window.getSelection().setBaseAndExtent(a, ai, b, bi + t.length);
      },
      [from, to],
    );
    await this.settleSelection();
  }

  /**
   * Put the caret at the start or end of the top-level block `index` (a
   * negative index counts from the end).
   *
   * @param {number} index
   * @param {'start' | 'end'} [where]
   */
  async block(index, where = 'end') {
    await this.evaluate(
      ([i, w]) => {
        const root = document.querySelector('[data-lexical-editor]');
        const blocks = [...root.children];
        const block = blocks[i < 0 ? blocks.length + i : i];
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        const texts = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          texts.push(node);
        }
        root.focus();
        const selection = window.getSelection();
        if (texts.length === 0) {
          selection.setBaseAndExtent(block, 0, block, 0);
        } else if (w === 'start') {
          selection.setBaseAndExtent(texts[0], 0, texts[0], 0);
        } else {
          const last = texts[texts.length - 1];
          selection.setBaseAndExtent(
            last,
            last.data.length,
            last,
            last.data.length,
          );
        }
      },
      [index, where],
    );
    await this.settleSelection();
  }

  /** Let Lexical read the DOM selection (selectionchange is async). */
  async settleSelection() {
    await this.page.waitForTimeout(60);
  }

  /** @param {string} icon the block type's dropdown icon (h1, quote, ...) */
  async blockType(icon) {
    await this.page.locator('.toolbar-item.block-controls').click();
    await this.page.locator(`.dropdown .icon.${icon}`).click();
  }

  /** Link the selection with the toolbar (to `https://`). */
  async insertLink() {
    await this.page.getByLabel('Insert link').first().click();
  }

  /**
   * Set the URL of the link at the caret with the floating link editor.
   *
   * @param {string} url
   */
  async setLinkURL(url) {
    const input = this.page.locator('.link-input');
    if (!(await input.isVisible())) {
      await this.page.locator('.link-edit').click();
    }
    await input.fill(url);
    await input.press('Enter');
  }

  /** Insert a table with the toolbar's Insert menu. */
  async insertTable(rows = 2, columns = 2) {
    await this.page
      .locator('.toolbar-item[aria-label="Insert specialized editor node"]')
      .click();
    await this.page.locator('.dropdown .item .table').click();
    await this.page
      .locator('input[data-test-id="table-modal-rows"]')
      .fill(String(rows));
    await this.page
      .locator('input[data-test-id="table-modal-columns"]')
      .fill(String(columns));
    await this.page
      .locator('div[data-test-id="table-model-confirm-insert"] > .Button__root')
      .click();
  }

  /** Click into a cell of the first table. */
  async cell(row, column) {
    await this.page
      .locator('table')
      .first()
      .locator('tr')
      .nth(row)
      .locator('th, td')
      .nth(column)
      .click();
    await this.settleSelection();
  }

  /**
   * Run an item of the table cell action menu (the caret must be in a cell),
   * e.g. 'table-insert-row-below'.
   *
   * @param {string} testId
   */
  async tableAction(testId) {
    await this.page
      .locator(
        '.table-cell-action-button-container--active > .table-cell-action-button',
      )
      .click();
    await this.page.locator(`.item[data-test-id="${testId}"]`).click();
  }

  async undo() {
    await this.press('Mod+z');
  }

  async redo() {
    await this.press('Mod+Shift+z');
  }

  /** Disconnect or reconnect with the toolbar's connect button. */
  async setOnline(online) {
    if (!online) {
      // From here until it is connected again, a provider socket that fails
      // or is closed while it connects is what going offline does, not a
      // problem.
      this.offline = true;
    }
    if ((await this.connected()) !== online) {
      await this.page.locator('.action-button.connect').click();
    }
    await expect.poll(() => this.connected(), {timeout: 20000}).toBe(online);
    if (online) {
      this.offline = false;
    }
  }

  /**
   * IME composition through CDP (Chromium): each step is the whole
   * composition string, then `commit` is inserted.
   *
   * @param {string[]} steps
   * @param {string} commit
   */
  async ime(steps, commit, stepDelay = 60) {
    const cdp = await this.context.newCDPSession(this.page);
    for (const text of steps) {
      await cdp.send('Input.imeSetComposition', {
        selectionEnd: text.length,
        selectionStart: text.length,
        text,
      });
      await this.page.waitForTimeout(stepDelay);
    }
    await cdp.send('Input.insertText', {text: commit});
    await cdp.detach();
  }

  /** Stop merging the next edit into this client's current undo step. */
  stopCapturing() {
    return this.evaluate(name => {
      const editor = document.querySelector(
        '[data-lexical-editor]',
      ).__lexicalEditor;
      editor[Symbol.for('@lexical/extension/LexicalBuilder')].extensionNameMap
        .get(name)
        .state.output.binding.undoManager?.stopCapturing();
    }, COLLAB_EXTENSION);
  }
}

class Session {
  /**
   * @param {import('@playwright/test').Browser} browser
   * @param {string} room the playground's collabId
   */
  constructor(browser, room) {
    this.browser = browser;
    this.room = room;
    /** @type {Client[]} */
    this.clients = [];
    /** @type {RegExp[]} */
    this.expected = [];
  }

  /** The relay's room name for the main document. */
  get relayRoom() {
    return `playground-y/${this.room}/main`;
  }

  /** @param {string} text */
  allowed(text) {
    return this.expected.some(re => re.test(text));
  }

  /**
   * Tolerate an expected console message (e.g. the binding's read-only
   * warning in the version gate spec).
   *
   * @param {RegExp} re
   */
  expect(re) {
    this.expected.push(re);
  }

  /**
   * Open a client and wait until its binding reaches `status` (within
   * `timeout` ms). `beforeLoad` runs on the client's browser context before
   * its page loads.
   *
   * @param {string} name
   * @param {{
   *   status?: string,
   *   timeout?: number,
   *   beforeLoad?: (context: import('@playwright/test').BrowserContext) => Promise<void>,
   * }} [options]
   */
  async open(name, {status = 'active', timeout, beforeLoad} = {}) {
    const context = await this.browser.newContext();
    // Keep the pages off the network: third-party scripts (analytics) that
    // fail to load fire window errors, which are not what these specs check.
    await context.route(
      url => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1',
      route => route.fulfill({body: '', status: 200}),
    );
    // "ResizeObserver loop completed with undelivered notifications" is a
    // benign window error event (the browser defers the notifications to the
    // next frame). The playground's dev error overlay cannot render it in
    // Firefox and throws, so it is stopped before the overlay sees it.
    await context.addInitScript(() => {
      window.addEventListener(
        'error',
        event => {
          if (/^ResizeObserver loop/.test(event.message)) {
            event.stopImmediatePropagation();
          }
        },
        true,
      );
    });
    if (beforeLoad) {
      await beforeLoad(context);
    }
    const page = await context.newPage();
    const client = new Client(name, context, page, this);
    this.clients.push(client);
    const params = new URLSearchParams({
      collabId: this.room,
      emptyEditor: 'true',
      isCollab: 'true',
      isRichText: 'true',
      selectBlock: 'false',
      showTreeView: 'false',
      useCollabY: 'true',
    });
    await page.goto(`http://localhost:${E2E_PORT}/?${params}`);
    await client.waitReady(status, timeout);
    // Without the binding's self-check, a write it does not read back the
    // same would not be reported, and no spec could fail on it. The
    // playground turns it on in every build but a production one (see
    // src/collaborationY.tsx).
    expect(await client.selfCheck(), 'the binding runs its self-check').toBe(
      true,
    );
    client.mod = (await page.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform),
    ))
      ? 'Meta'
      : 'Control';
    return client;
  }

  /**
   * Delay every server-to-client message in this room (0 turns it off).
   *
   * @param {number} ms
   */
  async delay(ms = DELAY) {
    const res = await fetch(
      `${RELAY}/delay?${new URLSearchParams({ms: String(ms), room: this.relayRoom})}`,
    );
    expect(res.ok).toBe(true);
  }

  async close() {
    await this.delay(0).catch(() => {});
    await Promise.all(this.clients.map(c => c.context.close().catch(() => {})));
  }
}

/**
 * Open `n` clients on a fresh document. The first one initializes it; the
 * others join after it is ready. With `together`, they all open at once, so
 * each initializes the new document.
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {{n?: number, together?: boolean}} [options]
 */
export async function openClients(browser, {n = 2, together = false} = {}) {
  const info = test.info();
  const room = `y-${info.project.name}-${info.testId}-${Date.now()}`;
  const session = new Session(browser, room);
  sessions.add(session);
  const names = [...'ABC'.slice(0, n)];
  if (together) {
    const clients = await Promise.all(names.map(name => session.open(name)));
    return {clients, session};
  }
  const clients = [];
  for (const name of names) {
    clients.push(await session.open(name));
  }
  return {clients, session};
}

const sessions = new Set();

/** Close every client a test opened. Call from test.afterEach. */
export async function closeSessions() {
  await Promise.all([...sessions].map(s => s.close()));
  sessions.clear();
}

/**
 * Type lines into the first client (Enter between them), wait until every
 * client has them, and keep the seeding out of everyone's undo history.
 *
 * @param {Client[]} clients
 * @param {string[]} lines
 */
export async function seed(clients, lines) {
  const [a] = clients;
  await a.editor.focus();
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      await a.press('Enter');
    }
    await a.type(lines[i], 0);
  }
  await converge(clients);
  for (const c of clients) {
    await c.stopCapturing();
  }
}

/** JSON with sorted object keys (NodeState key order is not meaningful). */
function canon(x) {
  if (Array.isArray(x)) {
    return x.map(canon);
  }
  if (x !== null && typeof x === 'object') {
    const out = {};
    for (const key of Object.keys(x).sort()) {
      out[key] = canon(x[key]);
    }
    return out;
  }
  return x;
}

/**
 * Wait until every client shows the same document, unchanged for 400ms, and
 * return it.
 *
 * @param {Client[]} clients
 */
export async function converge(clients, timeout = 20000) {
  const session = clients[0].session;
  await session.delay(0);
  for (const c of clients) {
    await c.waitReady();
  }
  const start = Date.now();
  let last = '';
  let stableSince = 0;
  let states = [];
  while (Date.now() - start < timeout) {
    states = await Promise.all(
      clients.map(async c => JSON.stringify(canon(await c.json()))),
    );
    if (states.every(s => s === states[0])) {
      if (states[0] === last) {
        if (Date.now() - stableSince >= 400) {
          return JSON.parse(states[0]);
        }
      } else {
        last = states[0];
        stableSince = Date.now();
      }
    } else {
      last = '';
    }
    await clients[0].page.waitForTimeout(100);
  }
  throw new Error(
    `clients did not converge after ${timeout}ms:\n` +
      clients
        .map(
          (c, i) =>
            `${c.name}: ${JSON.stringify(blocksOf(JSON.parse(states[i] || '{}')))}`,
        )
        .join('\n'),
  );
}

/** The text of a JSON node: blocks joined with '|', inline text concatenated. */
export function textOf(node) {
  if (typeof node.text === 'string') {
    return node.text;
  }
  if (node.type === 'linebreak') {
    return '\n';
  }
  const children = node.children || [];
  const isBlock = child =>
    Array.isArray(child.children) &&
    !['link', 'autolink', 'mark'].includes(child.type);
  return children
    .map(child => textOf(child))
    .join(children.some(isBlock) ? '|' : '');
}

/**
 * The top-level blocks as `type[/tag|/listType]:text`.
 *
 * @param {any} root
 */
export function blocksOf(root) {
  return (root.children || []).map(node => {
    const kind =
      node.type === 'heading'
        ? `heading/${node.tag}`
        : node.type === 'list'
          ? `list/${node.listType}`
          : node.type;
    return `${kind}:${textOf(node)}`;
  });
}

/**
 * Every node of a type in a JSON tree.
 *
 * @param {any} json
 * @param {string} type
 */
export function findType(json, type) {
  const out = [];
  const walk = node => {
    if (node.type === type) {
      out.push(node);
    }
    (node.children || []).forEach(walk);
  };
  walk(json);
  return out;
}

/** @param {string} prefix @param {number} n */
export const tokens = (prefix, n) =>
  Array.from({length: n}, (_, i) => `${prefix}${i + 1}z`);

function count(haystack, needle) {
  let n = 0;
  for (
    let i = haystack.indexOf(needle);
    i >= 0;
    i = haystack.indexOf(needle, i + 1)
  ) {
    n++;
  }
  return n;
}

/**
 * The checks every case ends with: all clients converge; a client that loads
 * the document afterwards shows the same; each token in `present` occurs
 * exactly once and each in `absent` never; and no client logged an error or
 * warning other than page noise (see isPageNoise). The binding's self-check
 * reports through the editor's warnings, and a provider connection that
 * failed is reported even if the provider then reconnected.
 *
 * @param {Client[]} clients
 * @param {{present?: string[], absent?: string[]}} [tokens]
 */
export async function finish(clients, {present = [], absent = []} = {}) {
  const json = await converge(clients);
  const session = clients[0].session;
  const fresh = await session.open('F');
  const freshJSON = canon(await fresh.json());
  expect(
    JSON.stringify(freshJSON),
    'a client loading the document afterwards shows the same',
  ).toBe(JSON.stringify(json));
  const text = textOf(json);
  const errors = [];
  for (const t of present) {
    if (count(text, t) !== 1) {
      errors.push(`${t} x${count(text, t)}`);
    }
  }
  for (const t of absent) {
    if (count(text, t) !== 0) {
      errors.push(`${t} x${count(text, t)}`);
    }
  }
  const blocks = blocksOf(json);
  expect(
    errors,
    `lost or duplicated text in ${JSON.stringify(blocks)}`,
  ).toEqual([]);
  const problems = [...clients, fresh].flatMap(c =>
    c.problems.map(p => `[${c.name}] ${p}`),
  );
  expect(problems, 'console errors or warnings').toEqual([]);
  return {blocks, json};
}
