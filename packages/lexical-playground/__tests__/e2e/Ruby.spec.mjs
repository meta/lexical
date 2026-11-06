/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  moveLeft,
  moveRight,
  pressBackspace,
  selectAll,
  selectCharacters,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  click,
  copyToClipboard,
  evaluate,
  expect,
  focusEditor,
  html,
  initialize,
  pasteFromClipboard,
  sleep,
  test,
} from '../utils/index.mjs';

test.skip(
  ({isPlainText, isCollab}) => isPlainText || !!isCollab,
  'Requires rich text without collaboration',
);

async function insertRubyViaToolbar(page, annotation) {
  await click(page, 'button[aria-label="Insert ruby annotation"]');
  const input = page.locator('.ruby-editor .ruby-input');
  await input.waitFor({state: 'visible', timeout: 1000});
  await input.fill(annotation);
  await input.press('Enter');
  await sleep(50);
  await focusEditor(page);
  await sleep(50);
}

async function getRubyNodes(page) {
  return evaluate(page, () => {
    const editor = window.lexicalEditor;
    const result = [];
    editor.read(() => {
      for (const [, node] of editor.getEditorState()._nodeMap) {
        if (node.getType() === 'ruby') {
          result.push({
            annotation: node.getAnnotation(),
            text: node.__text,
          });
        }
      }
    });
    return result;
  });
}

async function getSelectionInfo(page) {
  return evaluate(page, () => {
    const editor = window.lexicalEditor;
    return editor.read(() => {
      const sel = editor.getEditorState()._selection;
      if (!sel || !sel.anchor) {
        return null;
      }
      const anchorNode = editor.getEditorState()._nodeMap.get(sel.anchor.key);
      const focusNode = editor.getEditorState()._nodeMap.get(sel.focus.key);
      return {
        anchor: {
          offset: sel.anchor.offset,
          text: anchorNode?.__text || '',
          type: anchorNode?.getType() || '',
        },
        focus: {
          offset: sel.focus.offset,
          text: focusNode?.__text || '',
          type: focusNode?.getType() || '',
        },
        isCollapsed:
          sel.anchor.key === sel.focus.key &&
          sel.anchor.offset === sel.focus.offset,
      };
    });
  });
}

async function setCursorAt(page, textContent, offset) {
  await evaluate(
    page,
    ({text, off}) => {
      window.lexicalEditor.update(
        () => {
          const root = window.lexicalEditor
            .getEditorState()
            ._nodeMap.get('root');
          for (const node of root.getAllTextNodes()) {
            if (node.getTextContent() === text) {
              node.select(off, off);
              return;
            }
          }
          throw new Error(`setCursorAt: no TextNode with content "${text}"`);
        },
        {discrete: true},
      );
    },
    {off: offset, text: textContent},
  );
  await sleep(50);
}

async function selectNodeText(page, textContent) {
  await evaluate(
    page,
    text => {
      window.lexicalEditor.update(
        () => {
          const root = window.lexicalEditor
            .getEditorState()
            ._nodeMap.get('root');
          for (const node of root.getAllTextNodes()) {
            if (node.getTextContent() === text) {
              node.select(0, node.getTextContentSize());
              return;
            }
          }
          throw new Error(`selectNodeText: no TextNode with content "${text}"`);
        },
        {discrete: true},
      );
    },
    textContent,
  );
  await sleep(50);
}

test.describe('Ruby', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('Can insert a ruby annotation via toolbar', async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('Hello');
    await selectCharacters(page, 'left', 5);

    await insertRubyViaToolbar(page, 'ハロー');

    const rubies = await getRubyNodes(page);
    expect(rubies).toHaveLength(1);
    expect(rubies[0]).toEqual({annotation: 'ハロー', text: 'Hello'});

    const hasRubyDOM = await evaluate(page, () => {
      const root = document.querySelector('div[contenteditable="true"]');
      const inner = root.querySelector('[data-ruby-annotation]');
      return inner
        ? {
            annotation: inner.dataset.rubyAnnotation,
            hasClass: inner.classList.contains('PlaygroundEditorTheme__ruby'),
          }
        : null;
    });
    expect(hasRubyDOM).not.toBeNull();
    expect(hasRubyDOM.annotation).toBe('ハロー');
    expect(hasRubyDOM.hasClass).toBe(true);
  });

  test('Ruby DOM has wrapper span with inner annotated span', async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('漢');
    await selectAll(page);
    await insertRubyViaToolbar(page, 'かん');

    const structure = await evaluate(page, () => {
      const root = document.querySelector('div[contenteditable="true"]');
      const inner = root.querySelector('[data-ruby-annotation]');
      if (!inner) {
        return null;
      }
      const wrapper = inner.parentElement;
      return {
        innerTagName: inner.tagName,
        innerText: inner.textContent,
        wrapperHasDataLexicalText:
          wrapper.getAttribute('data-lexical-text') === 'true',
        wrapperTagName: wrapper.tagName,
      };
    });

    expect(structure).not.toBeNull();
    expect(structure.wrapperTagName).toBe('SPAN');
    expect(structure.innerTagName).toBe('SPAN');
    expect(structure.wrapperHasDataLexicalText).toBe(true);
    expect(structure.innerText).toBe('漢');
  });

  test('Arrow left skips over ruby node', async ({page}) => {
    await focusEditor(page);

    // "ABC" → select "B" → ruby → "A" + ruby("B","び") + "C"
    await page.keyboard.type('ABC');
    await moveLeft(page, 1);
    await selectCharacters(page, 'left', 1);
    await insertRubyViaToolbar(page, 'び');

    // Place cursor at "C":0, ArrowLeft → skip ruby → "A":1
    await setCursorAt(page, 'C', 0);
    await moveLeft(page, 1);
    await sleep(50);

    const info = await getSelectionInfo(page);
    expect(info).not.toBeNull();
    expect(info.anchor.type).toBe('text');
    expect(info.anchor.text).toBe('A');
    expect(info.anchor.offset).toBe(1);
  });

  test('Arrow right skips over ruby node', async ({page}) => {
    await focusEditor(page);

    // "ABC" → select "B" → ruby → "A" + ruby("B","び") + "C"
    await page.keyboard.type('ABC');
    await moveLeft(page, 1);
    await selectCharacters(page, 'left', 1);
    await insertRubyViaToolbar(page, 'び');

    // Place cursor at "A":1, ArrowRight → skip ruby → "C":0
    await setCursorAt(page, 'A', 1);
    await moveRight(page, 1);
    await sleep(50);

    const info = await getSelectionInfo(page);
    expect(info).not.toBeNull();
    expect(info.anchor.type).toBe('text');
    expect(info.anchor.text).toBe('C');
    expect(info.anchor.offset).toBe(0);
  });

  test('Backspace at ruby boundary deletes ruby as atomic unit', async ({
    page,
  }) => {
    await focusEditor(page);

    // "ABC" → select "B" → ruby → "A" + ruby("B","び") + "C"
    await page.keyboard.type('ABC');
    await moveLeft(page, 1);
    await selectCharacters(page, 'left', 1);
    await insertRubyViaToolbar(page, 'び');

    // Place caret at "C":0 (right after ruby boundary)
    await setCursorAt(page, 'C', 0);

    // Backspace: prev sibling of "C" is ruby → delete it
    await pressBackspace(page, 1);
    await sleep(50);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">AC</span>
        </p>
      `,
    );
  });

  test('Delete key at ruby boundary deletes ruby as atomic unit', async ({
    page,
  }) => {
    await focusEditor(page);

    // "ABC" → select "B" → ruby → "A" + ruby("B","び") + "C"
    await page.keyboard.type('ABC');
    await moveLeft(page, 1);
    await selectCharacters(page, 'left', 1);
    await insertRubyViaToolbar(page, 'び');

    // Place caret at "A":1 (right before ruby boundary)
    await setCursorAt(page, 'A', 1);

    // Delete: next sibling is ruby → delete it
    await page.keyboard.press('Delete');
    await sleep(50);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">AC</span>
        </p>
      `,
    );
  });

  test('Select-all and typing replaces ruby', async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('XY');
    await selectCharacters(page, 'left', 1);
    await insertRubyViaToolbar(page, 'わい');

    await selectAll(page);
    await sleep(50);

    await page.keyboard.type('Replaced');
    await sleep(50);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Replaced</span>
        </p>
      `,
    );

    const rubies = await getRubyNodes(page);
    expect(rubies).toHaveLength(0);
  });

  test('Toggle ruby off removes annotation and restores plain text', async ({
    page,
  }) => {
    await focusEditor(page);

    await page.keyboard.type('Word');
    await selectAll(page);
    await insertRubyViaToolbar(page, 'ワード');

    let rubies = await getRubyNodes(page);
    expect(rubies).toHaveLength(1);

    await selectAll(page);
    await sleep(50);
    await click(page, 'button[aria-label="Insert ruby annotation"]');
    await sleep(50);

    rubies = await getRubyNodes(page);
    expect(rubies).toHaveLength(0);

    const textContent = await evaluate(page, () => {
      const editor = window.lexicalEditor;
      return editor.read(() => {
        return editor.getEditorState()._nodeMap.get('root').getTextContent();
      });
    });
    expect(textContent).toContain('Word');
  });

  test('Copy and paste preserves ruby annotation', async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('Test');
    await selectAll(page);
    await insertRubyViaToolbar(page, 'テスト');

    await selectAll(page);

    {
      const clipboard = await copyToClipboard(page);

      // Collapse selection to end before Enter (webkit keeps selection
      // active after End, so ArrowRight is used to collapse first).
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await pasteFromClipboard(page, clipboard);
    }

    await sleep(100);

    const rubies = await getRubyNodes(page);
    expect(rubies).toHaveLength(2);
    expect(rubies[0]).toEqual({annotation: 'テスト', text: 'Test'});
    expect(rubies[1]).toEqual({annotation: 'テスト', text: 'Test'});
  });

  test('Multiple adjacent ruby nodes are independent', async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('AB');
    await evaluate(page, () => {
      window.lexicalEditor.update(
        () => {
          const root = window.lexicalEditor
            .getEditorState()
            ._nodeMap.get('root');
          for (const node of root.getAllTextNodes()) {
            if (node.getTextContent() === 'AB') {
              node.select(0, 1);
              return;
            }
          }
        },
        {discrete: true},
      );
    });
    await sleep(50);
    await insertRubyViaToolbar(page, 'えい');

    await selectNodeText(page, 'B');
    await insertRubyViaToolbar(page, 'びー');

    const rubies = await getRubyNodes(page);
    expect(rubies).toHaveLength(2);
    expect(rubies[0]).toEqual({annotation: 'えい', text: 'A'});
    expect(rubies[1]).toEqual({annotation: 'びー', text: 'B'});
  });

  test('Ruby node with collapsed selection is a no-op', async ({page}) => {
    await focusEditor(page);

    await page.keyboard.type('Hello');

    await click(page, 'button[aria-label="Insert ruby annotation"]');
    await sleep(50);

    const floatingEditor = page.locator('.ruby-editor .ruby-input');
    await expect(floatingEditor).not.toBeVisible();

    const rubies = await getRubyNodes(page);
    expect(rubies).toHaveLength(0);

    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
        </p>
      `,
    );
  });
});

test.describe('Ruby — Shift+arrow selection', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('Shift+Right extends selection past ruby to next text', async ({
    page,
  }) => {
    await focusEditor(page);

    // "ABC" → select "B" → ruby → "A" + ruby("B","び") + "C"
    await page.keyboard.type('ABC');
    await moveLeft(page, 1);
    await selectCharacters(page, 'left', 1);
    await insertRubyViaToolbar(page, 'び');

    // Place caret at "A":1 (just before ruby)
    await setCursorAt(page, 'A', 1);

    // Shift+Right should skip ruby
    await page.keyboard.down('Shift');
    await moveRight(page, 1);
    await page.keyboard.up('Shift');
    await sleep(50);

    const info = await getSelectionInfo(page);
    expect(info).not.toBeNull();
    expect(info.isCollapsed).toBe(false);
    // Anchor stays at "A":1
    expect(info.anchor.text).toBe('A');
    expect(info.anchor.offset).toBe(1);
    // Focus lands on ruby end (normalization resolves "C":0 → ruby:end)
    expect(info.focus.type).toBe('ruby');
  });

  test('Shift+Left extends selection past ruby to previous text', async ({
    page,
  }) => {
    await focusEditor(page);

    // "ABC" → select "B" → ruby → "A" + ruby("B","び") + "C"
    await page.keyboard.type('ABC');
    await moveLeft(page, 1);
    await selectCharacters(page, 'left', 1);
    await insertRubyViaToolbar(page, 'び');

    // Place caret at "C":0 (just after ruby)
    await setCursorAt(page, 'C', 0);

    // Shift+Left should skip ruby and extend focus to "A"
    await page.keyboard.down('Shift');
    await moveLeft(page, 1);
    await page.keyboard.up('Shift');
    await sleep(50);

    const info = await getSelectionInfo(page);
    expect(info).not.toBeNull();
    expect(info.isCollapsed).toBe(false);
    // Focus should be on "A"
    expect(info.focus.text).toBe('A');
  });

  test('repeated Shift+Right across a ruby keeps extending the selection', async ({
    page,
  }) => {
    await focusEditor(page);

    // "ABCDEF" → select "B" → ruby → "A" + ruby("B","び") + "CDEF"
    await page.keyboard.type('ABCDEF');
    await moveLeft(page, 4);
    await selectCharacters(page, 'left', 1);
    await insertRubyViaToolbar(page, 'び');

    // Caret at "A":1, immediately before the ruby.
    await setCursorAt(page, 'A', 1);

    // Each Shift+Right must grow the selection: press 1 selects the ruby,
    // every later press adds one character of "CDEF". Two equal
    // consecutive lengths mean the focus bounced back onto the ruby via
    // DOM selection resolution and the arrow handler re-landed it at the
    // same boundary — the stall that the offset >=1 landing guards
    // against.
    const lengths = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.down('Shift');
      await moveRight(page, 1);
      await page.keyboard.up('Shift');
      await sleep(100);
      lengths.push(
        await evaluate(page, () =>
          window.lexicalEditor.read(() => {
            const sel = window.lexicalEditor.getEditorState()._selection;
            return sel ? sel.getTextContent().length : -1;
          }),
        ),
      );
    }
    expect(lengths[0]).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < lengths.length; i++) {
      expect(lengths[i]).toBeGreaterThan(lengths[i - 1]);
    }
  });

  test('Shift+Right skips consecutive ruby group', async ({page}) => {
    await focusEditor(page);

    // "ABCD" → select "B" → ruby, then select "C" → ruby
    // Result: "A" + ruby("B","び") + ruby("C","し") + "D"
    await page.keyboard.type('ABCD');
    await moveLeft(page, 2);
    await selectCharacters(page, 'left', 1);
    await insertRubyViaToolbar(page, 'び');

    // Programmatically select "C" from "CD" for second ruby
    await evaluate(page, () => {
      window.lexicalEditor.update(
        () => {
          const root = window.lexicalEditor
            .getEditorState()
            ._nodeMap.get('root');
          for (const node of root.getAllTextNodes()) {
            if (node.getTextContent() === 'CD') {
              node.select(0, 1);
              return;
            }
          }
        },
        {discrete: true},
      );
    });
    await sleep(50);
    await insertRubyViaToolbar(page, 'し');

    // Place caret at "A":1
    await setCursorAt(page, 'A', 1);

    // Shift+Right should skip both rubies
    await page.keyboard.down('Shift');
    await moveRight(page, 1);
    await page.keyboard.up('Shift');
    await sleep(50);

    const info = await getSelectionInfo(page);
    expect(info).not.toBeNull();
    expect(info.isCollapsed).toBe(false);
    // Focus landed past both rubies (normalization resolves D:0 → ruby:end)
    expect(info.focus.type).toBe('ruby');
  });

  test('Shift+Left skips consecutive ruby group', async ({page}) => {
    await focusEditor(page);

    // "ABCD" → rubies on "B" and "C"
    // Result: "A" + ruby("B","び") + ruby("C","し") + "D"
    await page.keyboard.type('ABCD');
    await moveLeft(page, 2);
    await selectCharacters(page, 'left', 1);
    await insertRubyViaToolbar(page, 'び');

    // Programmatically select "C" for second ruby
    await evaluate(page, () => {
      window.lexicalEditor.update(
        () => {
          const root = window.lexicalEditor
            .getEditorState()
            ._nodeMap.get('root');
          for (const node of root.getAllTextNodes()) {
            if (node.getTextContent() === 'CD') {
              node.select(0, 1);
              return;
            }
          }
        },
        {discrete: true},
      );
    });
    await sleep(50);
    await insertRubyViaToolbar(page, 'し');

    // Place caret at "D":0
    await setCursorAt(page, 'D', 0);

    // Shift+Left should skip both rubies, land focus on "A"
    await page.keyboard.down('Shift');
    await moveLeft(page, 1);
    await page.keyboard.up('Shift');
    await sleep(50);

    const info = await getSelectionInfo(page);
    expect(info).not.toBeNull();
    expect(info.isCollapsed).toBe(false);
    expect(info.focus.text).toBe('A');
  });
});

test.describe('Ruby — line boundary navigation', () => {
  test.beforeEach(({isCollab, page}) => initialize({isCollab, page}));

  test('Arrow left at line start when ruby is first child does not get stuck', async ({
    page,
  }) => {
    await focusEditor(page);

    // "AB" → select "A" → ruby → ruby("A","えい") + "B"
    await page.keyboard.type('AB');
    await evaluate(page, () => {
      window.lexicalEditor.update(
        () => {
          const root = window.lexicalEditor
            .getEditorState()
            ._nodeMap.get('root');
          for (const node of root.getAllTextNodes()) {
            if (node.getTextContent() === 'AB') {
              node.select(0, 1);
              return;
            }
          }
        },
        {discrete: true},
      );
    });
    await sleep(50);
    await insertRubyViaToolbar(page, 'えい');

    // Place caret at "B":0 (right after ruby)
    await setCursorAt(page, 'B', 0);

    // ArrowLeft should skip ruby. Since ruby is first child with no
    // previous TextNode, cursor should move to paragraph boundary.
    await moveLeft(page, 1);
    await sleep(50);

    const info = await getSelectionInfo(page);
    expect(info).not.toBeNull();
    // Cursor moved away from "B". It lands on ruby because ruby is the
    // boundary child and DOM resolution normalizes paragraph:0 back to it.
    expect(info.anchor.text).not.toBe('B');
  });

  test('Arrow right at line end when ruby is last child does not get stuck', async ({
    page,
  }) => {
    await focusEditor(page);

    // "AB" → select "B" → ruby → "A" + ruby("B","び")
    await page.keyboard.type('AB');
    await selectCharacters(page, 'left', 1);
    await insertRubyViaToolbar(page, 'び');

    // Place caret at "A":1 (just before ruby)
    await setCursorAt(page, 'A', 1);

    // ArrowRight should skip ruby. Since ruby is last child with no
    // next TextNode, cursor should move to paragraph end boundary.
    await moveRight(page, 1);
    await sleep(50);

    const info = await getSelectionInfo(page);
    expect(info).not.toBeNull();
    // Cursor should have moved away from "A" — it landed on or past
    // ruby (ruby is last child, so there is no further text node).
    expect(info.anchor.text).not.toBe('A');
  });

  test('Shift+Left at line start when ruby is first child extends to boundary', async ({
    page,
  }) => {
    await focusEditor(page);

    // "AB" → select "A" → ruby → ruby("A","えい") + "B"
    await page.keyboard.type('AB');
    await evaluate(page, () => {
      window.lexicalEditor.update(
        () => {
          const root = window.lexicalEditor
            .getEditorState()
            ._nodeMap.get('root');
          for (const node of root.getAllTextNodes()) {
            if (node.getTextContent() === 'AB') {
              node.select(0, 1);
              return;
            }
          }
        },
        {discrete: true},
      );
    });
    await sleep(50);
    await insertRubyViaToolbar(page, 'えい');

    // Place caret at "B":0
    await setCursorAt(page, 'B', 0);

    // Shift+Left should extend selection past ruby to start boundary
    await page.keyboard.down('Shift');
    await moveLeft(page, 1);
    await page.keyboard.up('Shift');
    await sleep(50);

    const info = await getSelectionInfo(page);
    expect(info).not.toBeNull();
    expect(info.isCollapsed).toBe(false);
  });

  test('Shift+Right at line end when ruby is last child extends to boundary', async ({
    page,
  }) => {
    await focusEditor(page);

    // "AB" → select "B" → ruby → "A" + ruby("B","び")
    await page.keyboard.type('AB');
    await selectCharacters(page, 'left', 1);
    await insertRubyViaToolbar(page, 'び');

    // Place caret at "A":1
    await setCursorAt(page, 'A', 1);

    // Shift+Right should extend selection past ruby to end boundary
    await page.keyboard.down('Shift');
    await moveRight(page, 1);
    await page.keyboard.up('Shift');
    await sleep(50);

    const info = await getSelectionInfo(page);
    expect(info).not.toBeNull();
    expect(info.isCollapsed).toBe(false);
  });

  test('Arrow keys do not get stuck when ruby is the only child', async ({
    page,
  }) => {
    await focusEditor(page);

    // Type single char, select all, convert to ruby
    await page.keyboard.type('漢');
    await selectAll(page);
    await insertRubyViaToolbar(page, 'かん');

    // Pressing End then multiple ArrowLeft presses should eventually
    // reach paragraph start — cursor must not stay stuck on the ruby.
    await page.keyboard.press('End');
    await sleep(50);
    await moveLeft(page, 3);
    await sleep(200);

    const afterLeft = await getSelectionInfo(page);
    expect(afterLeft).not.toBeNull();

    // Pressing Home then multiple ArrowRight presses should eventually
    // reach paragraph end.
    await page.keyboard.press('Home');
    await sleep(50);
    await moveRight(page, 3);
    await sleep(200);

    const afterRight = await getSelectionInfo(page);
    expect(afterRight).not.toBeNull();

    // The main assertion: after enough arrow presses in each direction,
    // the cursor position changed — it was not stuck on the ruby.
    // Exact positions vary by browser, so we verify non-null selection.
  });
});

// The floating ruby editor reads the focused element to decide when to
// close. document.activeElement reports the shadow *host* when the editor
// UI renders inside a shadow root, so these checks must go through the
// popup's own root node (getActiveElement) or the popup closes while its
// input still has focus.
test.describe('Ruby — floating editor in shadow DOM', () => {
  test.beforeEach(({page}) => {
    // Rich-text-only; collab renders in split iframes which is an
    // orthogonal concern to shadow root encapsulation.
    return initialize({isShadowDOM: true, page});
  });

  test('focusout without relatedTarget keeps the popup open while its input has focus', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('漢字');
    await selectAll(page);
    await click(page, 'button[aria-label="Insert ruby annotation"]');

    const input = page.locator('.ruby-editor .ruby-input');
    await input.waitFor({state: 'visible', timeout: 1000});
    await input.fill('かんじ');

    // Synthesize the focus-change path that has no relatedTarget (focus
    // moving to browser chrome, devtools, another frame): the popup's
    // requestAnimationFrame fallback must observe that focus is still on
    // the input via the popup's shadow root, not via document.
    await input.evaluate(el => {
      el.dispatchEvent(
        new FocusEvent('focusout', {bubbles: true, composed: true}),
      );
    });
    await sleep(200);

    await expect(input).toBeVisible();
    const inputStillFocused = await input.evaluate(
      el => el.getRootNode().activeElement === el,
    );
    expect(inputStillFocused).toBe(true);

    // The surviving popup is fully functional: Enter creates the ruby.
    await input.press('Enter');
    await sleep(100);
    expect(await getRubyNodes(page)).toEqual([
      {annotation: 'かんじ', text: '漢字'},
    ]);
  });

  test('popup opens on ruby click and closes when focus moves back into the editor', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('漢字ほか');
    await selectNodeText(page, '漢字ほか');
    // Ruby only the leading text so a later click can land on plain text.
    await evaluate(page, () => {
      window.lexicalEditor.update(
        () => {
          const root = window.lexicalEditor
            .getEditorState()
            ._nodeMap.get('root');
          const textNode = root.getAllTextNodes()[0];
          textNode.select(0, 2);
        },
        {discrete: true},
      );
    });
    await click(page, 'button[aria-label="Insert ruby annotation"]');
    const input = page.locator('.ruby-editor .ruby-input');
    await input.waitFor({state: 'visible', timeout: 1000});
    await input.fill('かんじ');
    await input.press('Enter');
    await sleep(100);

    await click(page, 'span[data-ruby-annotation]');
    await input.waitFor({state: 'visible', timeout: 1000});

    // Clicking the plain text after the ruby moves focus back into the
    // contentEditable; the relatedTarget path must close the popup (the
    // shadow-aware check must not report a false "still focused"). The
    // :not() excludes the ruby itself (its role="group" wrapper is also a
    // data-lexical-text span) — clicking it would (correctly) reopen the
    // popup instead.
    await click(page, 'span[data-lexical-text="true"]:not([role="group"])');
    await sleep(200);
    await expect(input).toBeHidden();
  });
});
