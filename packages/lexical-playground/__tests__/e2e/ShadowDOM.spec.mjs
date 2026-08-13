/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  deleteNextWord,
  moveToEditorBeginning,
  selectAll,
  selectPrevWord,
  toggleBold,
} from '../keyboardShortcuts/index.mjs';
import {
  assertHTML,
  copyToClipboard,
  expect,
  focusEditor,
  html,
  initialize,
  insertSampleImage,
  pasteFromClipboard,
  test,
} from '../utils/index.mjs';

const IGNORE = {ignoreClasses: true, ignoreDir: true, ignoreInlineStyles: true};

test.describe('Shadow DOM', () => {
  test.beforeEach(({isCollab, isPlainText, page}) => {
    // Rich-text-only; collab renders in split iframes which is an orthogonal
    // concern to shadow root encapsulation.
    test.skip(isPlainText || isCollab);
    return initialize({isShadowDOM: true, page});
  });

  test('renders the editor inside an open shadow root', async ({page}) => {
    await expect(page.locator('[data-test-id="shadow-dom-host"]')).toHaveCount(
      1,
    );
    // document.querySelector does not pierce shadow roots, so a null result
    // proves the contentEditable lives inside the shadow tree. Playwright's
    // selector engine still sees it (it pierces open shadow roots).
    const contentEditableInLightDom = await page.evaluate(
      () => document.querySelector('div[contenteditable="true"]') !== null,
    );
    expect(contentEditableInLightDom).toBe(false);
    await expect(
      page.locator('div[contenteditable="true"]').first(),
    ).toBeVisible();
  });

  test('types and reconciles text inside the shadow root', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('Hello world');
    await assertHTML(
      page,
      html`
        <p><span data-lexical-text="true">Hello world</span></p>
      `,
      undefined,
      IGNORE,
    );
  });

  test('selects a word with Selection.modify and formats it', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('Hello world');
    // Word-granularity selection goes through RangeSelection.modify, which
    // reads the result via Selection.getComposedRanges inside a shadow root.
    await selectPrevWord(page);
    await toggleBold(page);
    await assertHTML(
      page,
      html`
        <p>
          <span data-lexical-text="true">Hello</span>
          <strong data-lexical-text="true">world</strong>
        </p>
      `,
      undefined,
      IGNORE,
    );
  });

  test('select all and delete clears the editor', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('Hello world');
    await selectAll(page);
    await page.keyboard.press('Backspace');
    await assertHTML(
      page,
      html`
        <p><br data-lexical-managed-linebreak="true" /></p>
      `,
      undefined,
      IGNORE,
    );
  });

  test('deletes by word inside the shadow root', async ({page}) => {
    await focusEditor(page);
    await page.keyboard.type('Hello world');
    await moveToEditorBeginning(page);
    // Forward word deletion extends the selection with native Selection.modify
    // and removes it; this is the operation that historically failed in shadow
    // DOM without composed-range reads.
    await deleteNextWord(page);
    const text = await page
      .locator('div[contenteditable="true"]')
      .first()
      .textContent();
    expect(text).not.toContain('Hello');
    expect(text).toContain('world');
  });

  test('clicking a table cell creates a range selection inside the cell', async ({
    page,
    browserName,
  }) => {
    // Webkit's headless pointer dispatch is flaky on the table cell hit-test;
    // the underlying handler is exercised by the chromium/firefox runs.
    test.skip(browserName === 'webkit');
    await focusEditor(page);
    // Manual sequence — `insertTable` from utils opens the Insert dropdown
    // via click() but the dropdown's outside-click handler also runs against
    // the same synthetic click event in the shadow-mounted toolbar; explicit
    // steps with waitFor between them keep the dropdown open long enough to
    // pick the Table item.
    await page
      .locator('.toolbar-item[aria-label="Insert specialized editor node"]')
      .click();
    const tableItem = page.locator('.dropdown .item .table');
    await tableItem.waitFor();
    await tableItem.click();
    await page.locator('input[data-test-id="table-modal-rows"]').fill('2');
    await page.locator('input[data-test-id="table-modal-columns"]').fill('2');
    await page
      .locator('div[data-test-id="table-model-confirm-insert"] > .Button__root')
      .click();
    await page.locator('table').waitFor();
    // Clicking a cell goes through the window-attached pointerdown listener
    // in lexical-table; without getComposedEventTarget the event.target is
    // retargeted to the shadow host and the rootElement.contains() gate
    // rejects the click. Type into a non-first cell to assert the click
    // actually placed the caret inside that cell.
    // InsertTableDialog defaults to includeHeaders=true, so 3 of the 4 cells
    // are <th>; pick the only <td> as the non-first cell.
    const targetCell = page.locator('table td').last();
    await targetCell.click();
    await page.keyboard.type('typed');
    const cellText = await targetCell.textContent();
    expect(cellText).toContain('typed');
  });

  test('component picker opens, navigates and inserts a heading', async ({
    page,
  }) => {
    await focusEditor(page);
    // The slash menu (LexicalTypeaheadMenuPlugin) repositions on scroll; the
    // popup is anchored to the editor's selection and its open/close cycle
    // exercises the typeahead path that reads the composed selection.
    await page.keyboard.type('/heading');
    // LexicalMenu's defaultMenuRenderFn portals the typeahead popup as
    // `<div class="typeahead-popover mentions-menu">`; there is no
    // dedicated data-test-id, so target the rendered class.
    await expect(
      page.locator('.typeahead-popover.mentions-menu'),
    ).toBeVisible();
    // Insert the first option (Heading 1).
    await page.keyboard.press('Enter');
    await page.keyboard.type('Heading text');
    await assertHTML(
      page,
      html`
        <h1><span data-lexical-text="true">Heading text</span></h1>
      `,
      undefined,
      IGNORE,
    );
  });

  test('inserts a sample image through the shadow toolbar', async ({page}) => {
    await focusEditor(page);
    // The Insert dropdown opens inside the shadow toolbar and the modal's
    // "Sample" button inserts an ImageNode whose <img> renders inside the
    // shadow root. Playwright's selector engine pierces open shadow roots,
    // so the image element is reachable from the page locator.
    await insertSampleImage(page);
    await expect(page.locator('.editor-image img').first()).toBeVisible();
  });

  test('pastes a file image into the shadow editor', async ({page}) => {
    await focusEditor(page);
    // Simulate a file-bearing paste targeted at the shadow-internal
    // contentEditable. `@lexical/clipboard`'s paste handler runs against
    // a real `ClipboardEvent`, reads `clipboardData.files`, and inserts
    // an ImageNode through `INSERT_IMAGE_COMMAND`. The interesting bit
    // here is that the paste event is dispatched at a node inside an
    // open shadow root and still reaches Lexical's listener.
    await page.evaluate(() => {
      const ce = window.__findShadowEditor(document);
      // 1x1 transparent PNG.
      const bytes = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        ),
        c => c.charCodeAt(0),
      );
      const file = new File([bytes], 'tiny.png', {type: 'image/png'});
      const dt = new DataTransfer();
      dt.items.add(file);
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        clipboardData: dt,
        composed: true,
      });
      if ((event.clipboardData.files?.length ?? 0) === 0) {
        // Firefox keeps the DataTransfer reference attached to a synthetic
        // ClipboardEvent, but `getData()` returns an empty string and `files`
        // is empty — its security policy refuses to expose script-set payloads
        // back to listeners.
        Object.defineProperty(event, 'clipboardData', {get: () => dt});
      }
      ce.dispatchEvent(event);
    });
    await expect(page.locator('.editor-image img').first()).toBeVisible();
  });

  test('clicking an image inside the shadow root selects the ImageNode', async ({
    page,
  }) => {
    await focusEditor(page);
    await insertSampleImage(page);
    const img = page.locator('.editor-image img').first();
    await img.click();
    // Lexical's image plugin upgrades the selection to a NodeSelection
    // (registered as a click listener on the rootElement, which lives
    // inside the shadow root). The plugin reflects the selected state by
    // toggling a `focused` class on the underlying <img>.
    await expect(img).toHaveClass(/focused/);
  });

  test('blur and re-focus on the shadow-internal editor exercise the focus path', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('before');
    // Drive the rootElement's blur path. Lexical registers focus / blur
    // listeners directly on the rootElement, which lives inside the
    // shadow root, so the listeners fire even though the document-level
    // `activeElement` is reported as the shadow host.
    await page.evaluate(() => {
      window.lexicalEditor.getRootElement().blur();
    });
    await focusEditor(page);
    // WebKit doesn't restore the caret to the end of the editor when
    // focus comes back through the shadow host the way Chromium and
    // Firefox do — type a marker, then assert on the full text rather
    // than relying on order. The focus listeners still fire either way,
    // which is the actual thing this test exercises.
    await page.keyboard.type(' after');
    const text = await page
      .locator('div[contenteditable="true"]')
      .first()
      .textContent();
    expect(text).toContain('before');
    expect(text).toContain(' after');
  });

  test('survives a Korean IME composition cycle inside the shadow root', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('start ');
    // Walk a Korean composition cycle (jamo → syllable) at the
    // shadow-internal contentEditable. Lexical registers its composition
    // listeners on the rootElement (inside the shadow root), so this
    // exercises them across the boundary. The platform IME normally
    // commits the composed text through DOM mutations the headless
    // browser can't simulate, but the editor must stay alive and accept
    // input after the cycle ends.
    await page.evaluate(() => {
      const ce = window.__findShadowEditor(document);
      const fire = (type, data) =>
        ce.dispatchEvent(
          new CompositionEvent(type, {bubbles: true, composed: true, data}),
        );
      fire('compositionstart', '');
      fire('compositionupdate', 'ㄱ');
      fire('compositionupdate', '가');
      fire('compositionupdate', '한');
      fire('compositionend', '한');
    });
    await page.keyboard.type(' end');
    const text = await page
      .locator('div[contenteditable="true"]')
      .first()
      .textContent();
    expect(text).toContain('start');
    expect(text).toContain('end');
  });

  test('survives a Chinese pinyin IME composition cycle inside the shadow root', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('start ');
    // Same shape as the Korean cycle above, but with the pinyin → hanzi
    // progression a Chinese IME typically drives. The platform IME
    // commits the final hanzi through DOM mutations the headless
    // browser can't simulate; the editor must stay alive and keep
    // accepting input.
    await page.evaluate(() => {
      const ce = window.__findShadowEditor(document);
      const fire = (type, data) =>
        ce.dispatchEvent(
          new CompositionEvent(type, {bubbles: true, composed: true, data}),
        );
      fire('compositionstart', '');
      fire('compositionupdate', 'ni');
      fire('compositionupdate', 'ni h');
      fire('compositionupdate', 'ni hao');
      fire('compositionend', '你好');
    });
    await page.keyboard.type(' end');
    const text = await page
      .locator('div[contenteditable="true"]')
      .first()
      .textContent();
    expect(text).toContain('start');
    expect(text).toContain('end');
  });

  test('copy and paste round-trips text inside the shadow root', async ({
    page,
  }) => {
    await focusEditor(page);
    // Wait until the editor's data-lexical-editor mount finishes so the
    // typed characters land on the shadow-internal contentEditable rather
    // than racing against the initial mount on CI.
    await page
      .locator('div[contenteditable="true"][data-lexical-editor="true"]')
      .waitFor();
    await page.keyboard.type('hi');
    // Wait until the typed text is reflected in the editor state and the
    // selection collapsed at the end of "hi". CI's faster timing races
    // selectAll/copy against the typing reconcile; local headless absorbs
    // it.
    await page
      .locator('div[contenteditable="true"][data-lexical-editor="true"]')
      .getByText('hi')
      .waitFor();
    await selectAll(page);
    // The copy guard in @lexical/clipboard reads selection through
    // getDOMSelectionPoints; without it the shadow host makes
    // isSelectionWithinEditor return false and the copy is dropped.
    const clipboard = await copyToClipboard(page);
    // Collapse the caret to the end of "hi" via window.getSelection so
    // paste inserts at the cursor rather than replacing the selectAll
    // range. moveToEditorEnd's Ctrl/Cmd+End keystroke never reaches the
    // shadow-internal editor on CI (document.activeElement reverts to
    // the shadow host), and WebKit ignores `addRange` with a start
    // container inside an open shadow tree — setBaseAndExtent works
    // across all engines (same approach as selectInnerText in the
    // browser-unit suite).
    await page.evaluate(() => {
      const editor = window.__findShadowEditor(document);
      const lastText = editor?.querySelector('[data-lexical-text="true"]');
      const textNode = lastText?.firstChild;
      if (textNode && textNode.nodeType === 3) {
        const end = textNode.textContent.length;
        const sel = window.getSelection();
        sel.setBaseAndExtent(textNode, end, textNode, end);
      }
    });
    await pasteFromClipboard(page, clipboard);
    await assertHTML(
      page,
      html`
        <p><span data-lexical-text="true">hihi</span></p>
      `,
      undefined,
      IGNORE,
    );
  });

  test('markdown shortcuts and a list run inside the shadow root', async ({
    page,
  }) => {
    await focusEditor(page);
    // `# heading` converts to <h1>, then a list shortcut starts a
    // bulleted list — both flows live in `@lexical/markdown` /
    // `@lexical/list` and depend on the shadow-aware text-mutation reads.
    await page.keyboard.type('# Heading');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- item one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('item two');
    await assertHTML(
      page,
      html`
        <h1><span data-lexical-text="true">Heading</span></h1>
        <ul>
          <li value="1"><span data-lexical-text="true">item one</span></li>
          <li value="2"><span data-lexical-text="true">item two</span></li>
        </ul>
      `,
      undefined,
      IGNORE,
    );
  });

  test('undo / redo round-trip from the lexical-history plugin works inside the shadow root', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('first');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second');
    // Lexical-history's undo/redo run through the editor's command queue,
    // not through DOM-level undo, and the playground's keyboard shortcut
    // dispatches them through the rootElement that lives inside the shadow
    // root.
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+z');
    const text = await page
      .locator('div[contenteditable="true"]')
      .first()
      .textContent();
    expect(text).not.toContain('second');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    const redoneText = await page
      .locator('div[contenteditable="true"]')
      .first()
      .textContent();
    expect(redoneText).toContain('first');
  });

  test('the playground tree-view mirrors the shadow-mounted editor state', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('tree view content');
    // The tree-view-output sits in the light DOM but reads the
    // EditorState that lives behind the shadow boundary; it should
    // surface the same text we just typed.
    const treeOutput = await page
      .locator('.tree-view-output pre')
      .first()
      .textContent();
    expect(treeOutput).toContain('tree view content');
  });

  test('file drop into the shadow editor inserts an ImageNode', async ({
    page,
  }) => {
    await focusEditor(page);
    // Synthesize an OS-style file drag and drop: a `DataTransfer`
    // carrying an `image/png` file, then `dragenter` / `dragover` /
    // `drop` dispatched at the shadow-internal contentEditable.
    await page.evaluate(() => {
      const ce = window.__findShadowEditor(document);
      const rect = ce.getBoundingClientRect();
      const clientX = Math.round(rect.left + rect.width / 2);
      const clientY = Math.round(rect.top + rect.height / 2);
      const bytes = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        ),
        c => c.charCodeAt(0),
      );
      const file = new File([bytes], 'dropped.png', {type: 'image/png'});
      const dt = new DataTransfer();
      dt.items.add(file);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        ce.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
            composed: true,
            dataTransfer: dt,
          }),
        );
      }
    });
    await expect(page.locator('.editor-image img').first()).toBeVisible();
  });

  test('typing 1000 characters inside the shadow root completes without hanging', async ({
    page,
  }) => {
    // A coarse perf smoke test: a large keyboard input run shouldn't
    // hang or trip the test timeout. This protects against accidental
    // reconciler regressions specific to the shadow code path (each
    // keystroke runs the full update + composed-selection read).
    await focusEditor(page);
    const t0 = Date.now();
    await page.keyboard.type('a'.repeat(1000), {delay: 0});
    const elapsed = Date.now() - t0;
    // Loose enough for CI macOS webkit (which has hit ~68s on
    // shared runners) but tight enough to still flag a real regression
    // — locally this run is around 1–2s.
    expect(elapsed).toBeLessThan(100_000);
    const text = await page
      .locator('div[contenteditable="true"]')
      .first()
      .textContent();
    expect((text ?? '').length).toBeGreaterThanOrEqual(1000);
  });

  test('populates shadowRoot.adoptedStyleSheets with document stylesheets', async ({
    page,
  }) => {
    await expect(page.locator('[data-test-id="shadow-dom-host"]')).toHaveCount(
      1,
    );
    const probe = await page.evaluate(() => {
      const host = document.querySelector('[data-test-id="shadow-dom-host"]');
      if (host === null || host.shadowRoot === null) {
        return null;
      }
      const sheets = Array.from(host.shadowRoot.adoptedStyleSheets);
      const lightSheetCount = Array.from(document.styleSheets).filter(s => {
        try {
          return s.cssRules.length > 0;
        } catch {
          return false;
        }
      }).length;
      const hasContentEditableRule = sheets.some(sheet =>
        Array.from(sheet.cssRules).some(rule =>
          rule.cssText.includes('.ContentEditable__root'),
        ),
      );
      const noImportRules = sheets.every(sheet =>
        Array.from(sheet.cssRules).every(
          rule => !/^@import/i.test(rule.cssText),
        ),
      );
      return {
        adoptedCount: sheets.length,
        hasContentEditableRule,
        lightSheetCount,
        noImportRules,
      };
    });
    expect(probe).not.toBeNull();
    // Adopted count should match the readable light-DOM sheet count: every
    // readable sheet (skipping the cross-origin ones we don't have today)
    // gets adopted, none are dropped on the floor.
    expect(probe.adoptedCount).toBe(probe.lightSheetCount);
    // The editor's own stylesheet must reach the shadow tree — a regression
    // that adopts the wrong sheets (or none) would silently pass the
    // count-only check.
    expect(probe.hasContentEditableRule).toBe(true);
    // @import rules are stripped before replaceSync so Chrome's "not allowed
    // here" warning never fires.
    expect(probe.noImportRules).toBe(true);
  });

  test('characterData update on a <style> refreshes adoptedStyleSheets', async ({
    page,
  }) => {
    await expect(page.locator('[data-test-id="shadow-dom-host"]')).toHaveCount(
      1,
    );

    const initial = await page.evaluate(async () => {
      const marker = document.createElement('style');
      marker.id = 'f10-test-style';
      marker.textContent = '.f10-probe { color: rgb(1, 2, 3); }';
      document.head.appendChild(marker);
      await new Promise(resolve => requestAnimationFrame(resolve));
      const host = document.querySelector('[data-test-id="shadow-dom-host"]');
      const sheets =
        host && host.shadowRoot
          ? Array.from(host.shadowRoot.adoptedStyleSheets)
          : [];
      return sheets.some(sheet =>
        Array.from(sheet.cssRules).some(r =>
          r.cssText.includes('color: rgb(1, 2, 3)'),
        ),
      );
    });
    expect(initial).toBe(true);

    const updated = await page.evaluate(async () => {
      const marker = document.getElementById('f10-test-style');
      if (marker === null) {
        return false;
      }
      // Mimic Vite HMR's in-place CSS text replace: mutate the existing
      // Text child's data so a characterData mutation fires (assigning
      // textContent would replace the child node and only fire childList).
      if (marker.firstChild instanceof Text) {
        marker.firstChild.data = '.f10-probe { color: rgb(9, 9, 9); }';
      } else {
        marker.textContent = '.f10-probe { color: rgb(9, 9, 9); }';
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
      const host = document.querySelector('[data-test-id="shadow-dom-host"]');
      const sheets =
        host && host.shadowRoot
          ? Array.from(host.shadowRoot.adoptedStyleSheets)
          : [];
      return sheets.some(sheet =>
        Array.from(sheet.cssRules).some(r =>
          r.cssText.includes('color: rgb(9, 9, 9)'),
        ),
      );
    });
    expect(updated).toBe(true);

    await page.evaluate(() => {
      document.getElementById('f10-test-style')?.remove();
    });
  });
});

test.describe('Shadow DOM (collab)', () => {
  test.beforeEach(({isCollab, isPlainText, page}) => {
    // The split view's two clients both render through ShadowDomWrapper
    // when the playground's shadow toggle is on. Rich-text-only mirrors
    // the non-collab block above; this describe only runs when the suite
    // is invoked in a collab mode.
    test.skip(isPlainText || !isCollab);
    return initialize({isCollab, isShadowDOM: true, page});
  });

  test('text typed on one client converges on the other inside shadow roots', async ({
    page,
  }) => {
    await focusEditor(page);
    await page.keyboard.type('shadow collab');
    // yjs sync is asynchronous; assert on the right frame's
    // contentEditable text. Both clients render inside their own open
    // shadow root, and Lexical's collab plugin uses the same composed
    // selection reads that drive the non-collab path.
    const rightEditable = page
      .frameLocator('[name="right"]')
      .locator('div[contenteditable="true"][data-lexical-editor="true"]')
      .first();
    await expect(rightEditable).toContainText('shadow collab');
  });
});
