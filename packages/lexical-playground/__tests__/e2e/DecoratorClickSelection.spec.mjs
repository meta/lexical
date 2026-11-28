/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveToLineBeginning,
  moveToLineEnd,
} from '../keyboardShortcuts/index.mjs';
import {
  expect,
  initialize,
  insertSampleImage,
  IS_MAC,
  test,
} from '../utils/index.mjs';

const PAGE_BREAK = 'hr[data-lexical-page-break]';
const ADD_TO_SELECTION = IS_MAC ? 'Meta' : 'Control';

test.describe('Decorator click selection', () => {
  test.skip(
    ({isCollab, isPlainText}) => isCollab || isPlainText,
    'Requires a local rich text editor',
  );

  test.beforeEach(async ({page}) => {
    await initialize({page});
    await page.locator('[data-lexical-editor]').evaluate(root => {
      const editor = root.__lexicalEditor;
      const state = editor.getEditorState().toJSON();
      const paragraph = text => ({
        children: [{text, type: 'text', version: 1}],
        type: 'paragraph',
        version: 1,
      });
      state.root.children = [
        paragraph('Before'),
        {type: 'page-break', version: 1},
        paragraph('Middle'),
        {type: 'page-break', version: 1},
        paragraph('After'),
        {type: 'horizontalrule', version: 1},
        {
          children: [
            {text: 'Inline ', type: 'text', version: 1},
            {equation: 'x^2', inline: true, type: 'equation', version: 1},
            {text: ' suffix', type: 'text', version: 1},
          ],
          type: 'paragraph',
          version: 1,
        },
        {
          $slots: {title: paragraph('Title')},
          children: [paragraph('Body')],
          type: 'card',
          version: 1,
        },
      ];
      editor.setEditorState(editor.parseEditorState(state));
    });
  });

  async function setMiddleCaret(page) {
    const middle = page.getByText('Middle', {exact: true});
    await middle.click();
    await moveToLineBeginning(page);
    await page.keyboard.press('ArrowRight');
  }

  async function shiftClickTextAt(page, text, offset) {
    const span = page.getByText(text, {exact: true});
    const position = await span.evaluate((element, index) => {
      const rect = element.getBoundingClientRect();
      const range = element.ownerDocument.createRange();
      range.setStart(element.firstChild, index);
      range.collapse(true);
      return {
        x: range.getBoundingClientRect().x - rect.x,
        y: rect.height / 2,
      };
    }, offset);
    await span.click({modifiers: ['Shift'], position});
  }

  async function getRange(page, nodeType) {
    return page.locator('[data-lexical-editor]').evaluate((root, type) => {
      const state = root.__lexicalEditor.getEditorState();
      return state.read(() => {
        const selection = state._selection;
        if (!selection?.anchor) {
          return null;
        }
        return {
          anchor: selection.anchor.getNode().getTextContent(),
          anchorOffset: selection.anchor.offset,
          backward: selection.isBackward(),
          includesTarget: selection
            .getNodes()
            .some(node => node.getType() === type),
        };
      });
    }, nodeType);
  }

  test('Shift-click includes the page break and keeps the original anchor in either direction', async ({
    page,
  }) => {
    await setMiddleCaret(page);
    const breaks = page.locator(PAGE_BREAK);
    await breaks.last().click({modifiers: ['Shift']});
    await expect
      .poll(() => getRange(page, 'page-break'))
      .toEqual({
        anchor: 'Middle',
        anchorOffset: 1,
        backward: false,
        includesTarget: true,
      });

    // Start again from a caret: on macOS, WebKit does not treat a selection as
    // directional, so Shift-clicking across the anchor of an existing range
    // natively moves the anchor to the opposite end, for text as well.
    await setMiddleCaret(page);
    await expect
      .poll(() => getRange(page, 'page-break'))
      .toMatchObject({
        anchor: 'Middle',
        anchorOffset: 1,
        includesTarget: false,
      });
    await breaks.first().click({modifiers: ['Shift']});
    await expect
      .poll(() => getRange(page, 'page-break'))
      .toEqual({
        anchor: 'Middle',
        anchorOffset: 1,
        backward: true,
        includesTarget: true,
      });
  });

  test('Ctrl-click replaces a range, adds another page break and toggles it off', async ({
    page,
  }) => {
    await setMiddleCaret(page);
    const breaks = page.locator(PAGE_BREAK);
    const selected = page.locator(PAGE_BREAK + '.selected');
    await breaks.first().click({modifiers: [ADD_TO_SELECTION]});
    await expect(selected).toHaveCount(1);
    await breaks.last().click({modifiers: [ADD_TO_SELECTION]});
    await expect(selected).toHaveCount(2);
    await breaks.last().click({modifiers: [ADD_TO_SELECTION]});
    await expect(selected).toHaveCount(1);
    await expect(breaks.first()).toHaveClass('selected');
  });

  test('plain-click selects a page break already included in a range', async ({
    page,
  }) => {
    await setMiddleCaret(page);
    const pageBreak = page.locator(PAGE_BREAK).last();
    await pageBreak.click({modifiers: ['Shift']});
    await expect.poll(() => getRange(page, 'page-break')).not.toBeNull();
    await pageBreak.click();
    await expect(pageBreak).toHaveClass('selected');
    await expect.poll(() => getRange(page, 'page-break')).toBeNull();
  });

  test('Shift-click includes a horizontal rule and an inline equation', async ({
    page,
  }) => {
    await setMiddleCaret(page);
    const rule = page.locator('hr:not([data-lexical-page-break])');
    await rule.click({modifiers: ['Shift']});
    await expect
      .poll(() => getRange(page, 'horizontalrule'))
      .toMatchObject({anchor: 'Middle', includesTarget: true});
    await rule.click();
    await expect(rule).toHaveClass(/selected/i);
    await expect.poll(() => getRange(page, 'horizontalrule')).toBeNull();

    await setMiddleCaret(page);
    await page.locator('.editor-equation').click({modifiers: ['Shift']});
    await expect
      .poll(() => getRange(page, 'equation'))
      .toMatchObject({anchor: 'Middle', includesTarget: true});
  });

  test('Ctrl-click selects a page break and horizontal rule together', async ({
    page,
  }) => {
    const pageBreak = page.locator(PAGE_BREAK).first();
    const rule = page.locator('hr:not([data-lexical-page-break])');
    await pageBreak.click({modifiers: [ADD_TO_SELECTION]});
    await rule.click({modifiers: [ADD_TO_SELECTION]});
    await expect(pageBreak).toHaveClass('selected');
    await expect(rule).toHaveClass(/selected/i);
    await rule.click({modifiers: [ADD_TO_SELECTION]});
    await expect(rule).not.toHaveClass(/selected/i);
    await expect(pageBreak).toHaveClass('selected');
  });

  test('Shift-click includes a YouTube embed when its outer container is clicked', async ({
    page,
  }) => {
    await page.route('https://www.youtube-nocookie.com/**', route =>
      route.fulfill({body: '', contentType: 'text/html'}),
    );
    await page.locator('[data-lexical-editor]').evaluate(root => {
      const editor = root.__lexicalEditor;
      const state = editor.getEditorState().toJSON();
      state.root.children.push({type: 'youtube', version: 1, videoID: 'test'});
      editor.setEditorState(editor.parseEditorState(state));
    });
    await setMiddleCaret(page);
    const embed = page.locator('.PlaygroundEditorTheme__embedBlock');
    const width = await embed.evaluate(element => element.clientWidth);
    await embed.click({
      modifiers: ['Shift'],
      position: {x: width - 4, y: 4},
    });
    await expect
      .poll(() => getRange(page, 'youtube'))
      .toMatchObject({anchor: 'Middle', includesTarget: true});
    await embed.click({position: {x: width - 4, y: 4}});
    await expect(embed).toHaveClass(/embedBlockFocus/);
    await expect.poll(() => getRange(page, 'youtube')).toBeNull();
  });

  test('Ctrl-click inside the equation input keeps the equation selected', async ({
    page,
  }) => {
    const equation = page.locator('.editor-equation');
    await equation.dblclick();
    const input = equation.getByRole('textbox');
    await expect(input).toBeVisible();
    await input.click({modifiers: [ADD_TO_SELECTION]});
    await expect(input).toBeVisible();
    await expect(equation).toHaveClass(/\bfocused\b/);
  });

  for (const modifier of ['Shift', ADD_TO_SELECTION]) {
    test(`${modifier}-double-click opens the Excalidraw editor`, async ({
      page,
    }) => {
      await page.locator('[data-lexical-editor]').evaluate(root => {
        const editor = root.__lexicalEditor;
        const state = editor.getEditorState().toJSON();
        state.root.children.push({
          children: [
            {
              data: JSON.stringify({
                elements: [
                  {
                    angle: 0,
                    backgroundColor: 'red',
                    boundElements: [],
                    fillStyle: 'solid',
                    height: 48,
                    id: 'rectangle',
                    isDeleted: false,
                    opacity: 100,
                    roughness: 0,
                    seed: 1,
                    strokeColor: '#000',
                    strokeStyle: 'solid',
                    strokeWidth: 1,
                    type: 'rectangle',
                    version: 1,
                    versionNonce: 1,
                    width: 48,
                    x: 0,
                    y: 0,
                  },
                ],
              }),
              type: 'excalidraw',
              version: 1,
            },
          ],
          type: 'paragraph',
          version: 1,
        });
        editor.setEditorState(editor.parseEditorState(state));
      });
      await setMiddleCaret(page);
      await page
        .locator('.excalidraw-button')
        .dblclick({modifiers: [modifier]});
      await expect(page.locator('.ExcalidrawModal__overlay')).toBeVisible();
    });
  }

  for (const backward of [false, true]) {
    test(`Shift-click extends from a selected image to text ${backward ? 'backward' : 'forward'}`, async ({
      page,
    }) => {
      await page
        .getByText(backward ? 'After' : 'Before', {exact: true})
        .click();
      await moveToLineEnd(page);
      await insertSampleImage(page);
      await page.locator('.editor-image img').click();
      // Hit a character boundary in the middle of the word, so the test
      // distinguishes the clicked caret position from either end of the text.
      const middle = page.getByText('Middle', {exact: true});
      await shiftClickTextAt(page, 'Middle', 3);
      await expect
        .poll(() =>
          middle.evaluate(span => {
            const state = span
              .closest('[data-lexical-editor]')
              .__lexicalEditor.getEditorState();
            return state.read(() => {
              const selection = state._selection;
              return (
                selection?.focus && {
                  backward: selection.isBackward(),
                  breaks: selection
                    .getNodes()
                    .filter(node => node.getType() === 'page-break').length,
                  focus: selection.focus.getNode().getTextContent(),
                  image: selection
                    .getNodes()
                    .some(node => node.getType() === 'image'),
                  offset: selection.focus.offset,
                }
              );
            });
          }),
        )
        .toEqual({
          backward,
          breaks: 1,
          focus: 'Middle',
          image: true,
          offset: 3,
        });
    });

    test(`Shift-click selects the text and both decorators ${backward ? 'backward' : 'forward'}`, async ({
      page,
    }) => {
      const breaks = page.locator(PAGE_BREAK);
      await (backward ? breaks.last() : breaks.first()).click();
      await (backward ? breaks.first() : breaks.last()).click({
        modifiers: ['Shift'],
      });
      await expect
        .poll(() => getRange(page, 'page-break'))
        .toMatchObject({backward, includesTarget: true});
      await page.keyboard.press('Backspace');
      await expect(breaks).toHaveCount(0);
      await expect(page.getByText('Middle', {exact: true})).toHaveCount(0);
      await expect(page.getByText('Before', {exact: true})).toBeVisible();
      await expect(page.getByText('After', {exact: true})).toBeVisible();
    });
  }

  for (const key of ['Backspace', 'x']) {
    test(`editing a backward range from a page break with ${key} preserves the next paragraph`, async ({
      page,
    }) => {
      await page.locator(PAGE_BREAK).last().click();
      await shiftClickTextAt(page, 'Middle', 3);
      await page.keyboard.press(key);
      await expect(page.locator(PAGE_BREAK)).toHaveCount(1);
      const paragraphs = page.locator('[data-lexical-editor] > p');
      await expect(paragraphs.nth(1)).toHaveText(
        key === 'Backspace' ? 'Mid' : 'Midx',
      );
      await expect(paragraphs.nth(2)).toHaveText('After');
    });
  }

  test('Shift-click after Shift+ArrowLeft preserves the next paragraph', async ({
    page,
  }) => {
    await page.locator(PAGE_BREAK).last().click();
    await shiftClickTextAt(page, 'Middle', 3);
    await page.keyboard.press('Shift+ArrowLeft');
    await shiftClickTextAt(page, 'Before', 3);
    await page.keyboard.press('Backspace');
    await expect(page.locator(PAGE_BREAK)).toHaveCount(0);
    const paragraphs = page.locator('[data-lexical-editor] > p');
    await expect(paragraphs.nth(0)).toHaveText('Bef');
    await expect(paragraphs.nth(1)).toHaveText('After');
  });

  for (const lastSelected of ['upper', 'lower']) {
    test(`Shift-click into text anchors at the last selected page break (${lastSelected})`, async ({
      page,
    }) => {
      const breaks = page.locator(PAGE_BREAK);
      const upperLast = lastSelected === 'upper';
      await (upperLast ? breaks.last() : breaks.first()).click();
      await (upperLast ? breaks.first() : breaks.last()).click({
        modifiers: [ADD_TO_SELECTION],
      });
      await expect(page.locator(PAGE_BREAK + '.selected')).toHaveCount(2);
      await shiftClickTextAt(page, 'After', 2);
      await page.keyboard.press('Backspace');
      await expect(breaks).toHaveCount(upperLast ? 0 : 1);
      await expect(page.getByText('Before', {exact: true})).toBeVisible();
      await expect(page.getByText('Middle', {exact: true})).toHaveCount(
        upperLast ? 0 : 1,
      );
      await expect(page.getByText('ter', {exact: true})).toBeVisible();
    });
  }

  for (const empty of [false, true]) {
    test(`Shift-click in blank space in ${empty ? 'an empty' : 'a nonempty'} paragraph`, async ({
      page,
    }) => {
      const paragraphs = page.locator('[data-lexical-editor] > p');
      const index = empty ? 2 : 1;
      if (empty) {
        await paragraphs.nth(1).click();
        await moveToLineEnd(page);
        await page.keyboard.press('Enter');
        await expect(paragraphs.nth(index)).toHaveText('');
      }
      await page.locator(PAGE_BREAK).last().click();
      const target = paragraphs.nth(index);
      const position = await target.evaluate(p => ({
        x: p.clientWidth - 4,
        y: p.clientHeight / 2,
      }));
      await target.click({modifiers: ['Shift'], position});
      await expect
        .poll(() => getRange(page, 'page-break'))
        .toMatchObject({
          backward: true,
          includesTarget: true,
        });
      await page.keyboard.press('Backspace');
      await expect(page.locator(PAGE_BREAK)).toHaveCount(1);
      await expect(target).toHaveText(empty ? '' : 'Middle');
      await expect(paragraphs.nth(index + 1)).toHaveText('After');
    });
  }

  test('Shift-click across the selected page break keeps it in the range', async ({
    page,
  }) => {
    await page.locator(PAGE_BREAK).last().click();
    await shiftClickTextAt(page, 'Middle', 3);
    await shiftClickTextAt(page, 'After', 2);
    await expect
      .poll(() => getRange(page, 'page-break'))
      .toMatchObject({
        backward: false,
        includesTarget: true,
      });
    await page.keyboard.press('Backspace');
    await expect(page.locator(PAGE_BREAK)).toHaveCount(1);
    const paragraphs = page.locator('[data-lexical-editor] > p');
    await expect(paragraphs.nth(1)).toHaveText('Middle');
    await expect(paragraphs.nth(2)).toHaveText('ter');
  });

  test('Shift-click in whitespace beside an inline equation preserves preceding text', async ({
    page,
  }) => {
    const equation = page.locator('.editor-equation');
    const paragraph = page.locator('p').filter({has: equation});
    await equation.click();
    const position = await paragraph.evaluate(p => ({
      x: p.clientWidth - 4,
      y: p.clientHeight / 2,
    }));
    await paragraph.click({modifiers: ['Shift'], position});
    await page.keyboard.press('Backspace');
    await expect(equation).toHaveCount(0);
    await expect(page.getByText('Inline', {exact: true})).toBeVisible();
    await expect(page.getByText('Before', {exact: true})).toBeVisible();
    await expect(page.getByText('suffix', {exact: true})).toHaveCount(0);
  });

  for (const firstTarget of ['text', 'decorator']) {
    test(`Shift-click crosses the original page break from ${firstTarget === 'text' ? 'text to a horizontal rule' : 'another page break to text'}`, async ({
      page,
    }) => {
      const breaks = page.locator(PAGE_BREAK);
      const rule = page.locator('hr:not([data-lexical-page-break])');
      await breaks.last().click();
      if (firstTarget === 'text') {
        await shiftClickTextAt(page, 'Middle', 3);
        await rule.click({modifiers: ['Shift']});
      } else {
        await breaks.first().click({modifiers: ['Shift']});
        await shiftClickTextAt(page, 'After', 2);
      }
      await page.keyboard.press('Backspace');
      await expect(breaks).toHaveCount(1);
      await expect(page.getByText('Middle', {exact: true})).toBeVisible();
      await expect(rule).toHaveCount(firstTarget === 'text' ? 0 : 1);
      if (firstTarget === 'decorator') {
        await expect(page.getByText('ter', {exact: true})).toBeVisible();
      }
    });
  }

  test('a canceled Shift-mousedown preserves the selected node', async ({
    page,
  }) => {
    const origin = page.locator(PAGE_BREAK).last();
    await origin.click();
    await expect(origin).toHaveClass('selected');
    // A plugin may register its listener after the editor's listener.
    await page.locator('[data-lexical-editor]').evaluate(root => {
      root.addEventListener('mousedown', event => event.preventDefault(), {
        once: true,
      });
    });
    await page.getByText('After', {exact: true}).hover();
    await page.keyboard.down('Shift');
    await page.mouse.down();
    try {
      await expect(origin).toHaveClass('selected');
      await expect.poll(() => getRange(page, 'page-break')).toBeNull();
    } finally {
      await page.mouse.up();
      await page.keyboard.up('Shift');
    }
    await expect(origin).toHaveClass('selected');
    await page.keyboard.press('Backspace');
    await expect(page.locator(PAGE_BREAK)).toHaveCount(1);
    await expect(page.getByText('After', {exact: true})).toBeVisible();
  });

  test('Shift-click on host chrome extends a multiple-node selection', async ({
    page,
  }) => {
    const pageBreak = page.locator(PAGE_BREAK).first();
    const card = page.locator('.lexical-card-node');
    await pageBreak.click();
    await page
      .locator(PAGE_BREAK)
      .last()
      .click({modifiers: [ADD_TO_SELECTION]});
    await card.click({modifiers: ['Shift'], position: {x: 6, y: 6}});
    await expect(pageBreak).toHaveClass('selected');
    await expect(page.locator(PAGE_BREAK).last()).toHaveClass('selected');
    await expect(card).toHaveAttribute('data-selected', 'true');
  });

  test('host chrome extends a range and toggles alongside a decorator', async ({
    page,
  }) => {
    await setMiddleCaret(page);
    const card = page.locator('.lexical-card-node');
    const position = {x: 6, y: 6};
    await card.click({modifiers: ['Shift'], position});
    await expect
      .poll(() => getRange(page, 'card'))
      .toEqual({
        anchor: 'Middle',
        anchorOffset: 1,
        backward: false,
        includesTarget: true,
      });

    await card.click({modifiers: [ADD_TO_SELECTION], position});
    await expect(card).toHaveAttribute('data-selected', 'true');
    const pageBreak = page.locator(PAGE_BREAK).first();
    await pageBreak.click({modifiers: [ADD_TO_SELECTION]});
    await expect(pageBreak).toHaveClass('selected');
    await expect(card).toHaveAttribute('data-selected', 'true');
    await card.click({modifiers: [ADD_TO_SELECTION], position});
    await expect(card).not.toHaveAttribute('data-selected', 'true');
    await expect(pageBreak).toHaveClass('selected');
  });

  test('Shift-click on host chrome from inside the host selects the whole host', async ({
    page,
  }) => {
    const card = page.locator('.lexical-card-node');
    await card.getByText('Body', {exact: true}).click();
    await moveToLineBeginning(page);
    await page.keyboard.press('ArrowRight');
    await card.click({modifiers: ['Shift'], position: {x: 6, y: 6}});

    await expect(card).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('Backspace');
    await expect(card).toHaveCount(0);
    await expect(page.getByText('After', {exact: true})).toBeVisible();
  });
});
