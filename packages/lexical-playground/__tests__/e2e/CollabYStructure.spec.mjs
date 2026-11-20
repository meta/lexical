/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// Collab Y (`@lexical/y`): line structure (Enter, Backspace, Delete, block
// types, list indentation) changed by one client while others type. See
// ../utils/collabY.mjs for how the clients are driven.

import {expect} from '@playwright/test';

import {
  closeSessions,
  converge,
  findType,
  finish,
  openClients,
  seed,
  textOf,
  tokens,
} from '../utils/collabY.mjs';
import {test} from '../utils/index.mjs';

test.skip(({isCollab}) => isCollab !== 'y', 'Requires collab Y (@lexical/y)');
test.afterEach(closeSessions);

test.describe('Collab Y: structure while typing', () => {
  test('three clients type in the same line', async ({browser}) => {
    const {clients, session} = await openClients(browser, {n: 3});
    const [a, b, c] = clients;
    await seed(clients, ['s0z m0z e0z']);
    const [ta, tb, tc] = [tokens('ka', 4), tokens('kb', 4), tokens('kc', 4)];
    await a.caret('e0z');
    await b.caret('m0z');
    await c.caret('e0z');
    await session.delay();
    await Promise.all([
      a.type(' ' + ta.join(' ')),
      b.type(' ' + tb.join(' ')),
      c.type(' ' + tc.join(' ')),
    ]);
    const {blocks} = await finish(clients, {
      present: ['s0z', 'm0z', 'e0z', ...ta, ...tb, ...tc],
    });
    expect(blocks.length).toBe(1);
    // Each client's run stays in one piece, in order.
    for (const run of [ta, tb, tc]) {
      expect(blocks[0]).toContain(run.join(' '));
    }
  });

  test('Enter in the middle of a line while a peer types at its end', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser);
    const [a, b] = clients;
    await seed(clients, ['h1z h2z h3z h4z']);
    const tb = tokens('kb', 4);
    await a.caret('h2z');
    await b.caret('h4z');
    await session.delay();
    await Promise.all([
      (async () => {
        await a.press('Enter');
        await a.type('ka1z');
      })(),
      b.type(' ' + tb.join(' ')),
    ]);
    const {blocks} = await finish(clients, {
      present: ['h1z', 'h2z', 'h3z', 'h4z', 'ka1z', ...tb],
    });
    expect(blocks).toEqual([
      'paragraph:h1z h2z',
      `paragraph:ka1z h3z h4z ${tb.join(' ')}`,
    ]);
  });

  test('Backspace joins a line while peers type at its start and end', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser, {n: 3});
    const [a, b, c] = clients;
    await seed(clients, ['j1z j2z', 'j3z j4z', 'j5z']);
    const [tb, tc] = [tokens('kb', 3), tokens('kc', 3)];
    await a.block(1, 'start');
    await b.caret('j4z');
    await c.caret('j3z', 'before');
    await session.delay();
    await Promise.all([
      a.press('Backspace'),
      b.type(' ' + tb.join(' ')),
      c.type(tc.join(' ') + ' '),
    ]);
    const {blocks} = await finish(clients, {
      present: ['j1z', 'j2z', 'j3z', 'j4z', 'j5z', ...tb, ...tc],
    });
    expect(blocks).toEqual([
      `paragraph:j1z j2z${tc.join(' ')} j3z j4z ${tb.join(' ')}`,
      'paragraph:j5z',
    ]);
  });

  test('Delete at a line end while a peer types at the start of the next line', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser);
    const [a, b] = clients;
    await seed(clients, ['d1z d2z', 'd3z d4z']);
    const tb = tokens('kb', 3);
    await a.caret('d2z');
    await b.caret('d3z', 'before');
    await session.delay();
    await Promise.all([a.press('Delete'), b.type(tb.join(' ') + ' ')]);
    const {blocks} = await finish(clients, {
      present: ['d1z', 'd2z', 'd3z', 'd4z', ...tb],
    });
    expect(blocks).toEqual([`paragraph:d1z d2z${tb.join(' ')} d3z d4z`]);
  });

  test('two clients press Enter at the same position and type', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser);
    const [a, b] = clients;
    await seed(clients, ['e1z e2z']);
    await a.caret('e1z');
    await b.caret('e1z');
    await session.delay();
    await Promise.all([
      (async () => {
        await a.press('Enter');
        await a.type('ka1z');
      })(),
      (async () => {
        await b.press('Enter');
        await b.type('kb1z');
      })(),
    ]);
    const {blocks} = await finish(clients, {
      present: ['e1z', 'e2z', 'ka1z', 'kb1z'],
    });
    expect(blocks.length).toBe(3);
    expect(blocks[0]).toBe('paragraph:e1z');
  });

  test('heading and quote toggles while peers type in the line', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser, {n: 3});
    const [a, b, c] = clients;
    await seed(clients, ['q1z', 'q2z q3z', 'q4z']);
    await a.caret('q2z');
    await b.caret('q3z');
    await c.caret('q4z', 'before');
    await session.delay();
    await Promise.all([
      a.blockType('h1'),
      b.type(' kb1z kb2z'),
      (async () => {
        await c.blockType('h2');
        await c.type('kc1z ');
      })(),
    ]);
    await converge(clients);
    await a.caret('q2z');
    await session.delay();
    await Promise.all([a.blockType('quote'), b.type(' kb3z')]);
    const {blocks} = await finish(clients, {
      present: ['q1z', 'q2z', 'q3z', 'q4z', ...tokens('kb', 3), 'kc1z'],
    });
    expect(blocks).toEqual([
      'paragraph:q1z',
      'quote:q2z q3z kb1z kb2z kb3z',
      'heading/h2:kc1z q4z',
    ]);
  });

  test('list: create, indent, Enter and outdent while a peer types', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser);
    const [a, b] = clients;
    await seed(clients, ['li1z', 'li2z', 'li3z', 'li4z']);
    // A makes a bullet list of three lines while B types in line 2.
    await a.range('li1z', 'li3z');
    await b.caret('li2z');
    await session.delay();
    await Promise.all([a.blockType('bullet-list'), b.type(' kb1z kb2z')]);
    await converge(clients);
    // A indents item 2 while B types in item 3.
    await a.caret('li2z', 'before');
    await b.caret('li3z');
    await session.delay();
    await Promise.all([a.press('Tab'), b.type(' kb3z')]);
    await converge(clients);
    // A presses Enter at the end of item 3 and types, B types in item 2.
    await a.caret('kb3z');
    await b.caret('kb2z');
    await session.delay();
    await Promise.all([
      (async () => {
        await a.press('Enter');
        await a.type('ka1z');
      })(),
      b.type(' kb4z'),
    ]);
    await converge(clients);
    // A outdents item 2 while B types in item 1.
    await a.caret('li2z', 'before');
    await b.caret('li1z');
    await session.delay();
    await Promise.all([a.press('Shift+Tab'), b.type(' kb5z')]);
    const {blocks, json} = await finish(clients, {
      present: ['li1z', 'li2z', 'li3z', 'li4z', 'ka1z', ...tokens('kb', 5)],
    });
    expect(blocks).toEqual([
      'list/bullet:li1z kb5z|li2z kb1z kb2z kb4z|li3z kb3z|ka1z',
      'paragraph:li4z',
    ]);
    expect(json.children[0].children.map(item => item.value)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  test('link while peers type inside and after the linked text', async ({
    browser,
  }) => {
    const {clients, session} = await openClients(browser, {n: 3});
    const [a, b, c] = clients;
    await seed(clients, ['w1z w2z w3z w4z']);
    await a.range('w2z', 'w3z');
    await b.caret('w2z');
    await c.caret('w4z');
    await session.delay();
    await Promise.all([a.insertLink(), b.type(' kb1z'), c.type(' kc1z')]);
    let json = await converge(clients);
    const links = findType(json, 'link');
    expect(links.map(link => link.url)).toEqual(['https://']);
    // Text typed inside the range while it was linked is part of the link.
    expect(textOf(links[0])).toBe('w2z kb1z w3z');
    // A sets the URL; B then types at the end of the link.
    await a.caret('kb1z');
    await a.setLinkURL('https://a.example/');
    json = await converge(clients);
    expect(findType(json, 'link').map(link => link.url)).toEqual([
      'https://a.example/',
    ]);
    // A removes the link while B types inside it.
    await a.caret('kb1z');
    await b.caret('w2z');
    await session.delay();
    await Promise.all([a.insertLink(), b.type(' kb2z')]);
    const final = await finish(clients, {
      present: ['w1z', 'w2z', 'w3z', 'w4z', 'kb1z', 'kb2z', 'kc1z'],
    });
    expect(findType(final.json, 'link')).toEqual([]);
    expect(final.blocks).toEqual(['paragraph:w1z w2z kb2z kb1z w3z w4z kc1z']);
  });
});
