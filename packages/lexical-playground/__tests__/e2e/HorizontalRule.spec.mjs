/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveLeft,
  moveToLineBeginning,
  pressBackspace,
  selectAll,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  assertSelection,
  click,
  copyToClipboard,
  expect,
  focusEditor,
  getPageOrFrame,
  html,
  initialize,
  insertCollapsible,
  pasteFromClipboard,
  selectFromInsertDropdown,
  test,
  waitForSelector,
} from '../utils/index.mjs';

async function toggleBulletList(page) {
  await click(page, '.block-controls');
  await click(page, '.dropdown .icon.bullet-list');
}

test.skip(({isPlainText}) => isPlainText, 'Requires rich text');

test.describe('HorizontalRule', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));
  test('Can create a horizontal rule and move selection around it', async ({
    page,
    isCollab,
  }) => {
    await focusEditor(page);

    await selectFromInsertDropdown(page, '.horizontal-rule');

    await waitForSelector(page, 'hr');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <hr
          class="PlaygroundEditorTheme__hr"
          contenteditable="false"
          data-lexical-decorator="true" />
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2],
      focusOffset: 0,
      focusPath: [2],
    });

    await page.keyboard.press('ArrowUp');

    // NodeSelection DOM representation varies across browsers
    // (Chromium auto-restores it), so assert Lexical internal state.
    const nodeSelAfterUp = await getPageOrFrame(page).evaluate(() => {
      const sel = window.lexicalEditor.getEditorState()._selection;
      return sel !== null && '_nodes' in sel && sel._nodes.size === 1;
    });
    expect(nodeSelAfterUp).toBe(true);

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2],
      focusOffset: 0,
      focusPath: [2],
    });

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0],
      focusOffset: 0,
      focusPath: [0],
    });

    await page.keyboard.type('Some text');

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2],
      focusOffset: 0,
      focusPath: [2],
    });

    await page.keyboard.type('Some more text');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Some text</span>
        </p>
        <hr
          class="PlaygroundEditorTheme__hr"
          contenteditable="false"
          data-lexical-decorator="true" />
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Some more text</span>
        </p>
      `,
    );

    await moveToLineBeginning(page);

    await page.keyboard.press('ArrowLeft');

    await page.keyboard.press('ArrowLeft');

    await assertSelection(page, {
      anchorOffset: 1,
      anchorPath: [0],
      focusOffset: 1,
      focusPath: [0],
    });

    await pressBackspace(page, 10);

    // Collab doesn't process the cursor correctly
    if (!isCollab) {
      await assertHTML(
        page,
        '<div class="PlaygroundEditorTheme__blockCursor" contenteditable="false" data-lexical-cursor="true"></div><hr class="PlaygroundEditorTheme__hr" data-lexical-decorator="true" contenteditable="false"><p class="PlaygroundEditorTheme__paragraph" dir="auto"><span data-lexical-text="true">Some more text</span></p>',
      );
    }

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [],
      focusOffset: 0,
      focusPath: [],
    });
  });

  test.describe(() => {
    test.skip(({isCollab}) => isCollab);
    test('Shows block cursor before a horizontal rule preceded by a paragraph', async ({
      page,
    }) => {
      await focusEditor(page);

      await page.keyboard.type('Before');

      await selectFromInsertDropdown(page, '.horizontal-rule');
      await waitForSelector(page, 'hr');

      // Programmatically set a block cursor just before the HR
      // (root offset 1), so the HR is preceded by an editable paragraph.
      await getPageOrFrame(page).evaluate(() => {
        const editor = window.lexicalEditor;
        editor.update(
          () => {
            const root = editor.getEditorState()._nodeMap.get('root');
            root.select(1, 1);
          },
          {discrete: true},
        );
      });

      // The block cursor should render between the paragraph and the HR
      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span data-lexical-text="true">Before</span>
          </p>
          <div
            class="PlaygroundEditorTheme__blockCursor"
            contenteditable="false"
            data-lexical-cursor="true"></div>
          <hr
            class="PlaygroundEditorTheme__hr"
            contenteditable="false"
            data-lexical-decorator="true" />
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
    });
  });

  test('Will add a horizontal rule at the end of a current TextNode and move selection to the new ParagraphNode.', async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Test');

    await assertSelection(page, {
      anchorOffset: 4,
      anchorPath: [0, 0, 0],
      focusOffset: 4,
      focusPath: [0, 0, 0],
    });

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Test</span>
        </p>
      `,
    );

    await selectFromInsertDropdown(page, '.horizontal-rule');

    await waitForSelector(page, 'hr');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Test</span>
        </p>
        <hr
          class="PlaygroundEditorTheme__hr"
          contenteditable="false"
          data-lexical-decorator="true" />
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2],
      focusOffset: 0,
      focusPath: [2],
    });
  });

  test('Will add a horizontal rule and split a TextNode across 2 paragraphs if the caret is in the middle of the TextNode, moving selection to the start of the new ParagraphNode.', async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Test');

    await assertSelection(page, {
      anchorOffset: 4,
      anchorPath: [0, 0, 0],
      focusOffset: 4,
      focusPath: [0, 0, 0],
    });

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Test</span>
        </p>
      `,
    );

    await moveLeft(page, 2);

    await assertSelection(page, {
      anchorOffset: 2,
      anchorPath: [0, 0, 0],
      focusOffset: 2,
      focusPath: [0, 0, 0],
    });

    await selectFromInsertDropdown(page, '.horizontal-rule');

    await waitForSelector(page, 'hr');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Te</span>
        </p>
        <hr
          class="PlaygroundEditorTheme__hr"
          contenteditable="false"
          data-lexical-decorator="true" />
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">st</span>
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2, 0, 0],
      focusOffset: 0,
      focusPath: [2, 0, 0],
    });
  });

  test('Will add a horizontal rule and split a TextNode across 2 ListItemNode if the caret is in the middle of the TextNode, moving selection to the start of the new ParagraphNode', async ({
    page,
  }) => {
    await focusEditor(page);
    await toggleBulletList(page);

    await page.keyboard.type('Test');

    await assertSelection(page, {
      anchorOffset: 4,
      anchorPath: [0, 0, 0, 0],
      focusOffset: 4,
      focusPath: [0, 0, 0, 0],
    });

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Test</span>
          </li>
        </ul>
      `,
    );

    await moveLeft(page, 2);

    await assertSelection(page, {
      anchorOffset: 2,
      anchorPath: [0, 0, 0, 0],
      focusOffset: 2,
      focusPath: [0, 0, 0, 0],
    });

    await selectFromInsertDropdown(page, '.horizontal-rule');

    await waitForSelector(page, 'hr');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">Te</span>
          </li>
        </ul>
        <hr
          class="PlaygroundEditorTheme__hr"
          contenteditable="false"
          data-lexical-decorator="true" />
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <span data-lexical-text="true">st</span>
          </li>
        </ul>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2, 0, 0, 0],
      focusOffset: 0,
      focusPath: [2, 0, 0, 0],
    });
  });

  test('Will add a horizontal rule and split a TextNode across 2 ListItemNode if the caret is in an empty ListItemNode, moving selection to the start of the new ListItemNode (#6849)', async ({
    page,
  }) => {
    await focusEditor(page);
    await toggleBulletList(page);

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [0, 0],
      focusOffset: 0,
      focusPath: [0, 0],
    });

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <br data-lexical-managed-linebreak="true" />
          </li>
        </ul>
      `,
    );

    await selectFromInsertDropdown(page, '.horizontal-rule');

    await waitForSelector(page, 'hr');

    await assertHTML(
      page,
      html`
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <br data-lexical-managed-linebreak="true" />
          </li>
        </ul>
        <hr
          class="PlaygroundEditorTheme__hr"
          contenteditable="false"
          data-lexical-decorator="true" />
        <ul class="PlaygroundEditorTheme__ul" dir="auto">
          <li class="PlaygroundEditorTheme__listItem" value="1">
            <br data-lexical-managed-linebreak="true" />
          </li>
        </ul>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2, 0],
      focusOffset: 0,
      focusPath: [2, 0],
    });
  });

  test('Can copy and paste a horizontal rule', async ({page}) => {
    await focusEditor(page);

    await selectFromInsertDropdown(page, '.horizontal-rule');

    await waitForSelector(page, 'hr');

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <hr
          class="PlaygroundEditorTheme__hr"
          contenteditable="false"
          data-lexical-decorator="true" />
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2],
      focusOffset: 0,
      focusPath: [2],
    });

    // Select all the text
    await selectAll(page);

    {
      // Copy all the text
      const clipboard = await copyToClipboard(page);

      // Delete content
      await page.keyboard.press('Backspace');

      await pasteFromClipboard(page, clipboard);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
          <hr
            class="PlaygroundEditorTheme__hr"
            contenteditable="false"
            data-lexical-decorator="true" />
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );

      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [2],
        focusOffset: 0,
        focusPath: [2],
      });

      await page.keyboard.press('ArrowUp');
      // ArrowUp from empty paragraph now stops at the decorator
      // (NodeSelection); press again to exit past it.
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Backspace');

      await pasteFromClipboard(page, clipboard);
    }

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <hr
          class="PlaygroundEditorTheme__hr"
          contenteditable="false"
          data-lexical-decorator="true" />
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
        <hr
          class="PlaygroundEditorTheme__hr"
          contenteditable="false"
          data-lexical-decorator="true" />
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );

    await assertSelection(page, {
      anchorOffset: 0,
      anchorPath: [2],
      focusOffset: 0,
      focusPath: [2],
    });
  });

  test.describe(() => {
    test.skip(({isCollab}) => isCollab);
    test('Can delete empty paragraph after a horizontal rule without deleting the horizontal rule', async ({
      page,
      browserName,
    }) => {
      await focusEditor(page);

      await selectFromInsertDropdown(page, '.horizontal-rule');

      await waitForSelector(page, 'hr');

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
          <hr
            class="PlaygroundEditorTheme__hr"
            contenteditable="false"
            data-lexical-decorator="true" />
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
        `,
      );
      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [2],
        focusOffset: 0,
        focusPath: [2],
      });

      // Delete content
      await page.keyboard.press('Backspace');

      await focusEditor(page);

      await assertHTML(
        page,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <br data-lexical-managed-linebreak="true" />
          </p>
          <hr
            class="PlaygroundEditorTheme__hr PlaygroundEditorTheme__hrSelected"
            contenteditable="false"
            data-lexical-decorator="true" />
        `,
      );

      if (browserName === 'webkit' || browserName === 'firefox') {
        await assertSelection(page, {
          anchorOffset: 0,
          anchorPath: [],
          focusOffset: 0,
          focusPath: [],
        });
      } else {
        await assertSelection(page, {
          anchorOffset: 0,
          anchorPath: [0],
          focusOffset: 0,
          focusPath: [0],
        });
      }

      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Delete');

      await assertHTML(
        page,
        html`
          <hr
            class="PlaygroundEditorTheme__hr PlaygroundEditorTheme__hrSelected"
            contenteditable="false"
            data-lexical-decorator="true" />
        `,
      );

      await assertSelection(page, {
        anchorOffset: 0,
        anchorPath: [],
        focusOffset: 0,
        focusPath: [],
      });
    });

    test('ArrowDown from middle of multi-line paragraph does not jump to adjacent decorator', async ({
      page,
    }) => {
      await focusEditor(page);

      // Soft line breaks (Shift+Enter) guarantee multiple visual lines
      // regardless of viewport width.
      await page.keyboard.type('Line one');
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await page.keyboard.type('Line two');
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
      await page.keyboard.type('Line three');
      await page.keyboard.press('Enter');
      await selectFromInsertDropdown(page, '.horizontal-rule');
      await waitForSelector(page, 'hr');

      // Move cursor to the first line of the paragraph
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      const inParagraph = await getPageOrFrame(page).evaluate(() => {
        const sel = window.lexicalEditor.getEditorState()._selection;
        return sel !== null && 'anchor' in sel;
      });
      expect(inParagraph).toBe(true);

      // ArrowDown from line one should move to line two, NOT to the decorator.
      await page.keyboard.press('ArrowDown');

      // Should still be a RangeSelection (not NodeSelection on the HR)
      const stillRange = await getPageOrFrame(page).evaluate(() => {
        const sel = window.lexicalEditor.getEditorState()._selection;
        return sel !== null && 'anchor' in sel && !('_nodes' in sel);
      });
      expect(stillRange).toBe(true);
    });

    test('ArrowUp navigates through consecutive decorators', async ({page}) => {
      await focusEditor(page);

      await page.keyboard.type('Top');
      await page.keyboard.press('Enter');
      await selectFromInsertDropdown(page, '.horizontal-rule');
      await waitForSelector(page, 'hr');
      await selectFromInsertDropdown(page, '.horizontal-rule');
      await page.keyboard.type('Bottom');

      const isNodeSel = () =>
        getPageOrFrame(page).evaluate(() => {
          const sel = window.lexicalEditor.getEditorState()._selection;
          return sel !== null && '_nodes' in sel && sel._nodes.size === 1;
        });
      const isRangeSel = () =>
        getPageOrFrame(page).evaluate(() => {
          const sel = window.lexicalEditor.getEditorState()._selection;
          return sel !== null && 'anchor' in sel && !('_nodes' in sel);
        });

      // ArrowUp from "Bottom" → should select second HR
      await page.keyboard.press('ArrowUp');
      expect(await isNodeSel()).toBe(true);

      // ArrowUp → exit NodeSelection, then ArrowUp → first HR
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      expect(await isNodeSel()).toBe(true);

      // ArrowUp → should exit to "Top" paragraph
      await page.keyboard.press('ArrowUp');
      expect(await isRangeSel()).toBe(true);
    });

    test('ArrowDown from last line of paragraph stops at adjacent decorator', async ({
      page,
    }) => {
      await focusEditor(page);

      await page.keyboard.type('Some text');
      await page.keyboard.press('Enter');
      await selectFromInsertDropdown(page, '.horizontal-rule');
      await waitForSelector(page, 'hr');

      // Go back to "Some text" paragraph
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');

      // ArrowDown from this single-line paragraph should select the HR
      await page.keyboard.press('ArrowDown');

      const isNodeSel = await getPageOrFrame(page).evaluate(() => {
        const sel = window.lexicalEditor.getEditorState()._selection;
        return sel !== null && '_nodes' in sel && sel._nodes.size === 1;
      });
      expect(isNodeSel).toBe(true);
    });

    test('ArrowDown from last list item selects adjacent decorator', async ({
      page,
    }) => {
      await focusEditor(page);

      // Create a bullet list then insert HR after it
      await page.keyboard.type('Item one');
      await click(page, '.block-controls');
      await click(page, '.dropdown .icon.bullet-list');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Item two');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await selectFromInsertDropdown(page, '.horizontal-rule');
      await waitForSelector(page, 'hr');

      // Move cursor back to the last list item
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');

      const inList = await getPageOrFrame(page).evaluate(() => {
        const sel = window.lexicalEditor.getEditorState()._selection;
        return sel !== null && 'anchor' in sel;
      });
      expect(inList).toBe(true);

      // ArrowDown from last list item should select the HR
      await page.keyboard.press('ArrowDown');

      const isNodeSel = await getPageOrFrame(page).evaluate(() => {
        const sel = window.lexicalEditor.getEditorState()._selection;
        return sel !== null && '_nodes' in sel && sel._nodes.size === 1;
      });
      expect(isNodeSel).toBe(true);
    });

    test('Clicking between consecutive block decorators creates selection (#6775)', async ({
      page,
    }) => {
      await focusEditor(page);

      await selectFromInsertDropdown(page, '.horizontal-rule');
      await waitForSelector(page, 'hr');
      await selectFromInsertDropdown(page, '.horizontal-rule');
      await getPageOrFrame(page).waitForFunction(() => {
        const editor = document.querySelector('[contenteditable="true"]');
        return editor && editor.querySelectorAll('hr').length === 2;
      });

      // Remove all non-decorator children so the HRs are directly adjacent
      await getPageOrFrame(page).evaluate(() => {
        const editor = window.lexicalEditor;
        editor.update(
          () => {
            const root = editor.getEditorState()._nodeMap.get('root');
            for (const child of root.getChildren()) {
              if (!('decorate' in child)) {
                child.remove();
              }
            }
          },
          {discrete: true},
        );
      });

      // Click between the two HR elements
      const clickPos = await getPageOrFrame(page).evaluate(() => {
        const editor = document.querySelector('[contenteditable="true"]');
        const hrs = editor.querySelectorAll('hr');
        const rect1 = hrs[0].getBoundingClientRect();
        const rect2 = hrs[1].getBoundingClientRect();
        return {
          x: Math.round(rect1.left + rect1.width / 2),
          y: Math.round((rect1.bottom + rect2.top) / 2),
        };
      });
      await page.mouse.click(clickPos.x, clickPos.y);

      // Without the fix, Firefox leaves selection as null (rangeCount === 0).
      // The fix computes the correct child offset from click coordinates.
      await expect
        .poll(() =>
          getPageOrFrame(page).evaluate(() => {
            const sel = window.lexicalEditor.getEditorState()._selection;
            if (sel === null) {
              return null;
            }
            if ('anchor' in sel) {
              return {
                anchorKey: sel.anchor.key,
                anchorType: sel.anchor.type,
                type: 'range',
              };
            }
            return {type: 'node'};
          }),
        )
        .toEqual({anchorKey: 'root', anchorType: 'element', type: 'range'});
    });

    test('ArrowDown from block cursor between shadow root and decorator selects the decorator', async ({
      page,
    }) => {
      await focusEditor(page);

      await page.keyboard.type('Top');
      await page.keyboard.press('Enter');

      // Insert a collapsible (shadow root) — cursor lands in the title
      await insertCollapsible(page);
      await page.keyboard.type('Title');

      // Navigate out of the collapsible: right from title end → content,
      // then right again → trailing paragraph after the collapsible.
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');

      // Insert an HR (decorator) right after the collapsible
      await selectFromInsertDropdown(page, '.horizontal-rule');
      await waitForSelector(page, 'hr');

      // Remove the empty paragraph between collapsible and HR, then set
      // selection to a block cursor just before the HR so the two nodes
      // are directly adjacent (the tree shape that triggers the bug).
      await getPageOrFrame(page).evaluate(() => {
        const editor = window.lexicalEditor;
        editor.update(
          () => {
            const root = editor.getEditorState()._nodeMap.get('root');
            const children = root.getChildren();
            for (let i = 0; i < children.length; i++) {
              const child = children[i];
              if (
                child.getType() === 'paragraph' &&
                child.getTextContentSize() === 0 &&
                i > 0 &&
                children[i - 1].getType() === 'collapsible-container'
              ) {
                child.remove();
                break;
              }
            }
            // Set block cursor between collapsible and HR
            const updated = root.getChildren();
            for (let i = 0; i < updated.length; i++) {
              if (updated[i].getType() === 'horizontalrule') {
                root.select(i, i);
                break;
              }
            }
          },
          {discrete: true},
        );
      });

      // Verify we're at a block cursor on root
      const blockCursorState = await getPageOrFrame(page).evaluate(() => {
        const sel = window.lexicalEditor.getEditorState()._selection;
        return (
          sel !== null &&
          'anchor' in sel &&
          sel.anchor.type === 'element' &&
          sel.anchor.key === 'root'
        );
      });
      expect(blockCursorState).toBe(true);

      // ArrowDown from this block cursor should select the HR
      await page.keyboard.press('ArrowDown');

      const isNodeSel = await getPageOrFrame(page).evaluate(() => {
        const sel = window.lexicalEditor.getEditorState()._selection;
        return sel !== null && '_nodes' in sel && sel._nodes.size === 1;
      });
      expect(isNodeSel).toBe(true);
    });
  });
});
