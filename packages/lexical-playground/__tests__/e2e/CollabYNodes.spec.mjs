/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Collab Y (`@lexical/y`): tables under concurrent edits, decorator nodes
// with nested editors (image captions), and IME composition while a peer
// edits the same line.

import {expect} from '@playwright/test';

import {
  closeSessions,
  converge,
  findType,
  finish,
  openClients,
  seed,
  textOf,
} from '../utils/collabY.mjs';
import {test} from '../utils/index.mjs';

test.skip(({isCollab}) => isCollab !== 'y', 'Requires collab Y (@lexical/y)');
test.afterEach(closeSessions);

/** Each table as rows of cell texts. */
const tableShape = json =>
  findType(json, 'table').map(table =>
    table.children.map(row => row.children.map(cell => textOf(cell))),
  );

test.describe('Collab Y: tables', () => {
  test('typing in cells, then a row and a column inserted at the same time', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser);
    const [a, b] = clients;
    await seed(clients, ['tt0z']);
    await a.caret('tt0z');
    await a.insertTable(2, 2);
    let json = await converge(clients);
    expect(tableShape(json)).toEqual([
      [
        ['', ''],
        ['', ''],
      ],
    ]);
    await a.cell(0, 0);
    await b.cell(1, 1);
    await session.delay();
    await Promise.all([a.type('ta1z'), b.type('tb1z')]);
    json = await converge(clients);
    expect(tableShape(json)).toEqual([
      [
        ['ta1z', ''],
        ['', 'tb1z'],
      ],
    ]);
    // A inserts a row below row 0 while B inserts a column after column 1.
    await a.caret('ta1z');
    await b.caret('tb1z');
    await session.delay();
    await Promise.all([
      a.tableAction('table-insert-row-below'),
      b.tableAction('table-insert-column-after'),
    ]);
    json = await converge(clients);
    // Both inserts are kept. The row A inserted has the two columns A saw:
    // a table a race left ragged is shown as stored until a local table
    // command pads it.
    expect(tableShape(json)[0].map(row => row.length)).toEqual([3, 2, 3]);
    // A client that loads the document now shows it as stored too.
    const loader = await session.open('G');
    expect(tableShape(await loader.json())[0].map(row => row.length)).toEqual([
      3, 2, 3,
    ]);
    expect(await converge(clients)).toEqual(json);
    // Both type in one cell, then A types in the new row.
    await a.caret('ta1z');
    await b.caret('ta1z', 'before');
    await session.delay();
    await Promise.all([a.type(' ka1z'), b.type('kb1z ')]);
    await converge(clients);
    await a.cell(1, 0);
    await b.caret('tb1z');
    await session.delay();
    await Promise.all([
      (async () => {
        await a.type('ka2z');
        await a.press('Enter');
        await a.type('ka3z');
      })(),
      b.type(' kb2z'),
    ]);
    const final = await finish([...clients, loader], {
      present: ['tt0z', 'ta1z', 'tb1z', 'ka1z', 'kb1z', 'ka2z', 'ka3z', 'kb2z'],
    });
    // Still as stored: typing in its cells pads nothing.
    expect(tableShape(final.json)).toEqual([
      [
        ['kb1z ta1z ka1z', '', ''],
        ['ka2z|ka3z', ''],
        ['', 'tb1z kb2z', ''],
      ],
    ]);
  });

  test('two clients insert a row at the same place while a third types in the table', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser, {n: 3});
    const [a, b, c] = clients;
    await seed(clients, ['tt0z']);
    await a.caret('tt0z');
    await a.insertTable(2, 2);
    await converge(clients);
    await a.cell(0, 0);
    await a.type('ta1z');
    await converge(clients);
    await a.caret('ta1z');
    await b.caret('ta1z');
    await c.cell(1, 1);
    await session.delay();
    await Promise.all([
      a.tableAction('table-insert-row-below'),
      b.tableAction('table-insert-row-below'),
      c.type('kc1z'),
    ]);
    const {json} = await finish(clients, {present: ['tt0z', 'ta1z', 'kc1z']});
    const [shape] = tableShape(json);
    expect(shape.map(row => row.length)).toEqual([2, 2, 2, 2]);
    expect(shape[3][1]).toBe('kc1z');
  });
});

test.describe('Collab Y: images', () => {
  test('an image syncs; its caption (a nested editor) cannot be added', async ({
    browser,
  }) => {
    const {clients} = await openClients(browser);
    const [a, b] = clients;
    await seed(clients, ['im1z']);
    await a.caret('im1z');
    await a.page
      .locator('.toolbar-item[aria-label="Insert specialized editor node"]')
      .click();
    await a.page.locator('.dropdown .item .image').click();
    await a.page
      .locator('button[data-test-id="image-modal-option-sample"]')
      .click();
    await expect(b.page.locator('.editor-image img')).toBeVisible();
    // `@lexical/y` does not sync nested editors, so the playground does not
    // offer to add a caption in this mode.
    await a.page.locator('.editor-image img').click();
    await expect(a.page.locator('.image-resizer').first()).toBeVisible();
    await expect(a.page.locator('.image-caption-button')).toHaveCount(0);
    const {json} = await finish(clients, {present: ['im1z']});
    expect(findType(json, 'image').map(image => image.showCaption)).toEqual([
      false,
    ]);
  });
});

const NIHON = ['n', 'に', 'にh', 'にほ', 'にほn', 'にほん'];
const TOKYO = ['t', 'と', 'とう', 'とうk', 'とうきょ', 'とうきょう'];

test.describe('Collab Y: IME', () => {
  test.skip(
    ({browserName}) => browserName !== 'chromium',
    'IME composition is driven through CDP',
  );

  test('compose in a line while a peer types in the same line', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser);
    const [a, b] = clients;
    await seed(clients, ['i1z i2z i3z']);
    await a.caret('i2z');
    await a.type(' ');
    await b.caret('i3z');
    await session.delay();
    await Promise.all([
      a.ime(NIHON, '日本', 80),
      b.type(' kb1z kb2z kb3z', 30),
    ]);
    await a.type(' ka1z');
    const {blocks} = await finish(clients, {
      present: ['i1z', 'i2z', 'i3z', '日本', 'ka1z', 'kb1z', 'kb2z', 'kb3z'],
    });
    expect(blocks).toEqual(['paragraph:i1z i2z 日本 ka1z i3z kb1z kb2z kb3z']);
  });

  test('compose while a peer splits the line before the composition', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser);
    const [a, b] = clients;
    await seed(clients, ['s1z s2z s3z']);
    await a.caret('s3z');
    await a.type(' ');
    await b.caret('s1z');
    await session.delay();
    await Promise.all([
      a.ime(NIHON, '日本', 80),
      (async () => {
        await b.page.waitForTimeout(120);
        await b.press('Enter');
        await b.type('kb1z ');
      })(),
    ]);
    const {blocks} = await finish(clients, {
      present: ['s1z', 's2z', 's3z', '日本', 'kb1z'],
    });
    expect(blocks).toEqual(['paragraph:s1z', 'paragraph:kb1z  s2z s3z 日本']);
  });

  test('compose while a peer splits the line after the composition', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser);
    const [a, b] = clients;
    await seed(clients, ['s1z s2z s3z s4z']);
    await a.caret('s2z');
    await b.caret('s3z');
    await session.delay();
    await Promise.all([
      a.ime(NIHON, '日本', 80),
      (async () => {
        await b.page.waitForTimeout(120);
        await b.press('Enter');
      })(),
    ]);
    const {blocks} = await finish(clients, {
      present: ['s1z', 's2z', 's3z', 's4z', '日本'],
    });
    // The node being composed keeps its DOM text node: the browser goes on
    // composing in it, and commits only what it composed.
    expect(blocks).toEqual(['paragraph:s1z s2z日本 s3z', 'paragraph: s4z']);
  });

  test('compose in a line while a peer joins it into the previous line', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser);
    const [a, b] = clients;
    await seed(clients, ['j1z', 'j2z j3z']);
    await a.caret('j2z');
    await a.type(' ');
    await b.block(1, 'start');
    await session.delay();
    await Promise.all([
      a.ime(TOKYO, '東京', 80),
      (async () => {
        await b.page.waitForTimeout(120);
        await b.press('Backspace');
      })(),
    ]);
    const {blocks} = await finish(clients, {
      present: ['j1z', 'j2z', 'j3z', '東京'],
    });
    expect(blocks).toEqual(['paragraph:j1zj2z 東京 j3z']);
  });
});
