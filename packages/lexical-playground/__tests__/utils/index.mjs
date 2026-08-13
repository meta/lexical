/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {expect, test as base} from '@playwright/test';
import * as glob from 'glob';
import {randomUUID} from 'node:crypto';
import prettier from 'prettier';
import * as lockfile from 'proper-lockfile';
import {URLSearchParams} from 'url';

import {selectAll} from '../keyboardShortcuts/index.mjs';

function findAsset(pattern) {
  const prefix = 'packages/lexical-playground/build';
  const resolvedPattern = `${prefix}/assets/${pattern}`;
  for (const fn of glob.sync(resolvedPattern, {windowsPathsNoEscape: true})) {
    return fn.replaceAll('\\', '/').slice(prefix.length);
  }
  throw new Error(`Missing asset at ${resolvedPattern}`);
}

export const E2E_PORT = process.env.E2E_PORT || 3000;
export const E2E_BROWSER = process.env.E2E_BROWSER;
export const IS_MAC = process.platform === 'darwin';
export const IS_WINDOWS = process.platform === 'win32';
export const IS_LINUX = !IS_MAC && !IS_WINDOWS;
export const IS_COLLAB_V1 =
  process.env.E2E_EDITOR_MODE === 'rich-text-with-collab';
export const IS_COLLAB_V2 =
  process.env.E2E_EDITOR_MODE === 'rich-text-with-collab-v2';
export const IS_COLLAB = IS_COLLAB_V1 || IS_COLLAB_V2;
const IS_RICH_TEXT = process.env.E2E_EDITOR_MODE !== 'plain-text';
const IS_PLAIN_TEXT = process.env.E2E_EDITOR_MODE === 'plain-text';
export const IS_TABLE_HORIZONTAL_SCROLL =
  process.env.E2E_TABLE_MODE !== 'legacy';
export const SAMPLE_SVG_URL = '/logo.svg';
export const SAMPLE_IMAGE_URL =
  E2E_PORT === 3000
    ? '/src/images/yellow-flower.jpg'
    : findAsset('yellow-flower*.jpg');
export const SAMPLE_LANDSCAPE_IMAGE_URL =
  E2E_PORT === 3000 ? '/src/images/landscape.jpg' : findAsset('landscape*.jpg');
export const LEXICAL_IMAGE_BASE64 =
  'data:image/png;base64,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';
export const YOUTUBE_SAMPLE_URL =
  'https://www.youtube-nocookie.com/embed/jNQXAC9IVRw';

export function wrapTableHtml(
  expected,
  {ignoreClasses = false, ignoreDir = false} = {},
) {
  return html`
    ${expected
      .replace(/<table(\s[^>]*)?>/g, (match, rawAttrs = '') => {
        const attrs = [...rawAttrs.matchAll(/(\w+)=["']([^"']*)["']/g)].map(
          m => [m[1], m[2]],
        );
        const dirAttr = attrs.find(([k]) => k === 'dir');
        const outerDivAttrs = [dirAttr]
          .filter(Boolean)
          .map(([k, v]) => `${k}="${v}"`);
        const innerDivAttrs = [
          !ignoreClasses && [
            'class',
            'PlaygroundEditorTheme__tableScrollableWrapper',
          ],
        ]
          .filter(Boolean)
          .map(([k, v]) => `${k}="${v}"`);
        const tableAttrs = attrs
          .filter(([k]) => k !== 'dir')
          .map(([k, v]) => `${k}="${v}"`);
        return `<div ${outerDivAttrs.join(' ')}><div ${innerDivAttrs.join(' ')}><table ${tableAttrs.join(' ')}>`;
      })
      .replace(/<\/table>/g, '</table></div></div>')}
  `;
}

export async function initialize({
  page,
  isCollab,
  selectBlock,
  isAutocomplete,
  isCharLimit,
  isCharLimitUtf8,
  isMaxLength,
  hasLinkAttributes,
  hasNestedTables,
  hasFitNestedTables,
  shouldDisableFocusOnClickChecklist,
  showNestedEditorTreeView,
  tableCellMerge,
  tableCellBackgroundColor,
  shouldUseLexicalContextMenu,
  tableHorizontalScroll,
  shouldAllowHighlightingWithBrackets,
  selectionAlwaysOnDisplay,
  isShadowDOM,
}) {
  const appSettings = {};
  appSettings.isRichText = IS_RICH_TEXT;
  appSettings.emptyEditor = true;
  appSettings.tableHorizontalScroll =
    tableHorizontalScroll ?? IS_TABLE_HORIZONTAL_SCROLL;
  if (isCollab) {
    appSettings.isCollab = !!isCollab;
    appSettings.useCollabV2 = isCollab === 2;
    appSettings.collabId = randomUUID();
  }
  if (showNestedEditorTreeView === undefined) {
    appSettings.showNestedEditorTreeView = true;
  }
  appSettings.isAutocomplete = !!isAutocomplete;
  appSettings.isCharLimit = !!isCharLimit;
  appSettings.isCharLimitUtf8 = !!isCharLimitUtf8;
  appSettings.isMaxLength = !!isMaxLength;
  appSettings.hasLinkAttributes = !!hasLinkAttributes;
  appSettings.hasNestedTables = !!hasNestedTables;
  appSettings.hasFitNestedTables = !!hasFitNestedTables;
  appSettings.shouldDisableFocusOnClickChecklist =
    !!shouldDisableFocusOnClickChecklist;
  if (tableCellMerge !== undefined) {
    appSettings.tableCellMerge = tableCellMerge;
  }
  if (tableCellBackgroundColor !== undefined) {
    appSettings.tableCellBackgroundColor = tableCellBackgroundColor;
  }
  appSettings.shouldUseLexicalContextMenu = !!shouldUseLexicalContextMenu;

  appSettings.shouldAllowHighlightingWithBrackets =
    !!shouldAllowHighlightingWithBrackets;

  appSettings.selectionAlwaysOnDisplay = !!selectionAlwaysOnDisplay;
  // The playground app defaults `selectBlock` to true (see appSettings.ts),
  // but the e2e harness pins it to false unless a spec opts in (e.g.
  // SelectBlock.spec.mjs), so the rest of the suite keeps the legacy
  // whole-document SELECT_ALL semantics that selectAll()/clearEditor() rely
  // on. This setting is always written to the URL so the app default never
  // leaks into an e2e run.
  appSettings.selectBlock = !!selectBlock;

  appSettings.isShadowDOM = !!isShadowDOM;

  const urlParams = appSettingsToURLParams(appSettings);
  const url = `http://localhost:${E2E_PORT}/${
    isCollab ? 'split/' : ''
  }?${urlParams.toString()}`;

  // Start listening for uncaught page errors *before* navigating so that a
  // failure during the editor's initial build (e.g. a misconfigured or
  // conflicting extension set) fails the test fast, instead of silently
  // waiting for the editor selector until the long per-test timeout -- which,
  // multiplied across retries and every test in a mode, can hang a whole CI
  // shard for hours.
  const pageError = rejectOnPageError(page);

  if (isShadowDOM) {
    // Walk open shadow roots to find the editor's contentEditable. Used by
    // shadow DOM specs that synthesize events at a node inside the shadow
    // tree; document.querySelector does not pierce shadow boundaries.
    await page.addInitScript(() => {
      window.__findShadowEditor = function findEditor(root) {
        const direct = root.querySelector(
          'div[contenteditable="true"][data-lexical-editor="true"]',
        );
        if (direct !== null) {
          return direct;
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot !== null) {
            const inner = findEditor(el.shadowRoot);
            if (inner !== null) {
              return inner;
            }
          }
        }
        return null;
      };
    });
  }

  await page.goto(url);

  await exposeLexicalEditor(page, pageError);
}

/**
 * Returns a promise that rejects as soon as the page emits an uncaught
 * ("pageerror") exception, so callers can race it against an editor-ready
 * wait and fail fast when the app crashes on load instead of timing out.
 * Attach this *before* navigating so an error thrown during the initial
 * render is not missed.
 *
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<never>}
 */
function rejectOnPageError(page) {
  const promise = new Promise((_resolve, reject) => {
    page.on('pageerror', error => {
      reject(
        new Error(
          'The page threw an uncaught error before the editor was ready. ' +
            'This usually means the editor failed to build for this mode ' +
            '(check the extension configuration):\n' +
            (error.stack || error.message || String(error)),
        ),
      );
    });
  });
  // The race below may not be attached yet when the error fires (it can throw
  // during navigation), so swallow here to avoid an unhandled rejection; the
  // race still observes the same rejection when it awaits this promise.
  promise.catch(() => {});
  return promise;
}

/**
 * Wait for one collab iframe to finish booting: its toolbar toggle reports a
 * live provider ("Disconnect" is what it offers once connected) and the editor
 * has rendered at least one paragraph.
 *
 * @param {import('@playwright/test').Page} page
 * @param {'left' | 'right'} name the iframe's name attribute
 */
export async function waitForCollabFrame(page, name) {
  const frameLocator = page.frameLocator(`[name="${name}"]`);
  await expect(frameLocator.locator('.action-button.connect')).toHaveAttribute(
    'title',
    /Disconnect/,
    {timeout: 15000},
  );
  await expect(
    frameLocator.locator('[data-lexical-editor="true"] p').first(),
  ).toBeVisible({timeout: 15000});
}

/**
 * Reload a single collab iframe and wait until it has booted and reconnected.
 *
 * A bare `contentDocument.location.reload()` returns as soon as the navigation
 * is *scheduled*, so a following `assertHTML` has to absorb the whole reload —
 * bundle fetch, editor mount, websocket connect and the initial Yjs sync —
 * inside its own 5s polling budget. On a loaded CI runner that overruns, and
 * the assertion fails while the frame is still booting (the contenteditable
 * isn't in the DOM yet), which is an intermittent failure that has nothing to
 * do with what the test is checking. Wait for the navigation to actually start
 * and for the frame to come back up, so the assertion that follows measures the
 * restored document rather than the page load.
 *
 * @param {import('@playwright/test').Page} page
 * @param {'left' | 'right'} name the iframe's name attribute
 */
export async function reloadCollabFrame(page, name) {
  const navigated = page.waitForEvent(
    'framenavigated',
    frame => frame.name() === name,
  );
  await page.evaluate(frameName => {
    document
      .querySelector(`iframe[name="${frameName}"]`)
      .contentDocument.location.reload();
  }, name);
  await navigated;
  await waitForCollabFrame(page, name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {Promise<never> | null} pageError a promise that rejects if the page
 *   throws an uncaught error, so a broken load fails fast instead of waiting
 *   for the editor selector until the test timeout. See {@link rejectOnPageError}.
 */
async function exposeLexicalEditor(page, pageError = null) {
  if (IS_COLLAB) {
    // The split view loads the playground in two iframes that connect to a
    // single shared y-websocket server. Under parallel test load one frame
    // occasionally fails to boot/activate collab within the timeout (its
    // ".action-button.connect" toolbar button never appears, or the websocket
    // connect/backoff runs long) -- the dominant residual source of @flaky
    // collab failures. Reload and retry a few times so a transient
    // boot/connect hiccup during setup doesn't fail the whole test.
    const waitForCollabFramesReady = () =>
      Promise.all(
        ['left', 'right'].map(name => waitForCollabFrame(page, name)),
      );
    for (let attempt = 0; ; attempt++) {
      try {
        await waitForCollabFramesReady();
        break;
      } catch (err) {
        if (attempt >= 2) {
          throw err;
        }
        await page.reload();
      }
    }
    // Ensure that they started up with the correct empty state
    await assertHTML(
      page,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <br data-lexical-managed-linebreak="true" />
        </p>
      `,
    );
  }
  const leftFrame = getPageOrFrame(page);
  await Promise.race(
    [leftFrame.waitForSelector('.tree-view-output pre'), pageError].filter(
      Boolean,
    ),
  );
  await leftFrame.evaluate(() => {
    // querySelector does not pierce shadow roots, so descend into any open
    // shadow trees to support the "Render in Shadow DOM" playground setting.
    const findEditorElement = root => {
      const found = root.querySelector('[data-lexical-editor="true"]');
      if (found !== null) {
        return found;
      }
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot !== null) {
          const inner = findEditorElement(element.shadowRoot);
          if (inner !== null) {
            return inner;
          }
        }
      }
      return null;
    };
    window.lexicalEditor = findEditorElement(document).__lexicalEditor;
  });
}

export const test = base.extend({
  hasLinkAttributes: false,
  isCharLimit: false,
  isCharLimitUtf8: false,
  /** @type {number | false} */
  isCollab: IS_COLLAB_V1 ? 1 : IS_COLLAB_V2 ? 2 : false,
  isMaxLength: false,
  isPlainText: IS_PLAIN_TEXT,
  isRichText: IS_RICH_TEXT,
  selectionAlwaysOnDisplay: false,
  shouldAllowHighlightingWithBrackets: false,
  shouldUseLexicalContextMenu: false,
});

export {expect} from '@playwright/test';

function appSettingsToURLParams(appSettings) {
  const params = new URLSearchParams();
  Object.entries(appSettings).forEach(([setting, value]) => {
    params.append(setting, value);
  });
  return params;
}

export async function repeat(times, cb) {
  for (let i = 0; i < times; i++) {
    await cb();
  }
}

export async function clickSelectors(page, selectors) {
  for (let i = 0; i < selectors.length; i++) {
    await click(page, selectors[i]);
  }
}

function removeSafariLinebreakImgHack(actualHtml) {
  return E2E_BROWSER === 'webkit'
    ? actualHtml.replaceAll(
        /<img (?:[^>]+ )?data-lexical-managed-linebreak="true"(?: [^>]+)?>/g,
        '',
      )
    : actualHtml;
}

/**
 * The reconciler parks a zero-size, out-of-flow `<img>` outside a leading or
 * trailing block DecoratorNode so browsers keep painting the selection
 * highlight for a range that ends on that boundary (#8922). It is invisible
 * scaffolding, so keep it out of the HTML the specs assert on.
 */
function removeDecoratorBoundaryAnchors(actualHtml) {
  return actualHtml.replaceAll(
    /<img (?:[^>]+ )?data-lexical-decorator-boundary="true"(?: [^>]+)?>/g,
    '',
  );
}

function removeDropTargetAttributes(actualHtml) {
  return actualHtml.replaceAll(/ data-drop-target-for-element="true"/g, '');
}

function removeStickyScrollbar(actualHtml) {
  return actualHtml
    .replace(/<div[^>]*\baria-hidden="true"[^>]*><div[^>]*><\/div><\/div>/g, '')
    .replace(/\s*data-lexical-sticky-scrollbar="true"/g, '')
    .replace(/\s*style="scrollbar-width: none;?"/g, '');
}

/**
 * @param {import('@playwright/test').Page | import('@playwright/test').Frame} pageOrFrame
 */
async function assertHTMLOnPageOrFrame(
  pageOrFrame,
  expectedHtml,
  ignoreClasses,
  ignoreInlineStyles,
  ignoreDir,
  frameName,
  actualHtmlModificationsCallback = actualHtml => actualHtml,
) {
  const expected = await prettifyHTML(expectedHtml.replace(/\n/gm, ''), {
    ignoreClasses,
    ignoreDir,
    ignoreInlineStyles,
  });
  return await expect(async () => {
    const actualHtml = removeStickyScrollbar(
      removeDropTargetAttributes(
        removeDecoratorBoundaryAnchors(
          removeSafariLinebreakImgHack(
            await pageOrFrame
              .locator('div[contenteditable="true"]')
              .first()
              .innerHTML(),
          ),
        ),
      ),
    );
    let actual = await prettifyHTML(actualHtml.replace(/\n/gm, ''), {
      ignoreClasses,
      ignoreDir,
      ignoreInlineStyles,
    });

    actual = await actualHtmlModificationsCallback(actual);

    expect(
      actual,
      `innerHTML of contenteditable in ${frameName} did not match`,
    ).toEqual(expected);
  }).toPass({intervals: [100, 250, 500], timeout: 5000});
}

/**
 * @function
 * @template T
 * @param {() => T | Promise<T>}
 * @returns {Promise<T>}
 */
export async function withExclusiveClipboardAccess(f) {
  const release = await lockfile.lock('.', {
    lockfilePath: '.playwright-clipboard.lock',
    retries: 5,
  });
  try {
    return f();
  } finally {
    await release();
  }
}

/**
 * @param {import('@playwright/test').Page} page
 */
export async function assertHTML(
  page,
  expectedHtml,
  expectedHtmlFrameRight = expectedHtml,
  {ignoreClasses = false, ignoreInlineStyles = false, ignoreDir = false} = {},
  actualHtmlModificationsCallback,
) {
  if (IS_COLLAB) {
    await Promise.all([
      assertHTMLOnPageOrFrame(
        page.frame('left'),
        expectedHtml,
        ignoreClasses,
        ignoreInlineStyles,
        ignoreDir,
        'left frame',
        actualHtmlModificationsCallback,
      ),
      assertHTMLOnPageOrFrame(
        page.frame('right'),
        expectedHtmlFrameRight,
        ignoreClasses,
        ignoreInlineStyles,
        ignoreDir,
        'right frame',
        actualHtmlModificationsCallback,
      ),
    ]);
  } else {
    await assertHTMLOnPageOrFrame(
      page,
      expectedHtml,
      ignoreClasses,
      ignoreInlineStyles,
      ignoreDir,
      'page',
      actualHtmlModificationsCallback,
    );
  }
}

/**
 * @param {import('@playwright/test').Page} page
 */
export async function assertTableHTML(
  page,
  expectedHtml,
  expectedHtmlFrameRight = undefined,
  options = undefined,
  ...args
) {
  return await assertHTML(
    page,
    IS_TABLE_HORIZONTAL_SCROLL
      ? wrapTableHtml(expectedHtml, options)
      : expectedHtml,
    IS_TABLE_HORIZONTAL_SCROLL && expectedHtmlFrameRight !== undefined
      ? wrapTableHtml(expectedHtmlFrameRight, options)
      : expectedHtmlFrameRight,
    options,
    ...args,
  );
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {import('@playwright/test').Page | import('@playwright/test').Frame}
 */
export function getPageOrFrame(page) {
  return IS_COLLAB ? page.frame('left') : page;
}

export async function assertTableSelectionCoordinates(page, coordinates) {
  const pageOrFrame = getPageOrFrame(page);

  const {_anchor, _focus} = await pageOrFrame.evaluate(() => {
    const editor = window.lexicalEditor;
    const editorState = editor.getEditorState();
    const selection = editorState._selection;
    if (!selection.tableKey) {
      throw new Error('Expected table selection');
    }
    const anchorElement = editor.getElementByKey(selection.anchor.key);
    const focusElement = editor.getElementByKey(selection.focus.key);
    return {
      _anchor: {
        x: anchorElement._cell?.x,
        y: anchorElement._cell?.y,
      },
      _focus: {
        x: focusElement._cell?.x,
        y: focusElement._cell?.y,
      },
    };
  });

  if (coordinates.anchor) {
    if (coordinates.anchor.x !== undefined) {
      expect(_anchor.x).toEqual(coordinates.anchor.x);
    }
    if (coordinates.anchor.y !== undefined) {
      expect(_anchor.y).toEqual(coordinates.anchor.y);
    }
  }
  if (coordinates.focus) {
    if (coordinates.focus.x !== undefined) {
      expect(_focus.x).toEqual(coordinates.focus.x);
    }
    if (coordinates.focus.y !== undefined) {
      expect(_focus.y).toEqual(coordinates.focus.y);
    }
  }
}

async function assertSelectionOnPageOrFrame(page, expected) {
  // Assert the selection of the editor matches the snapshot
  const selection = await page.evaluate(() => {
    const rootElement = document.querySelector('div[contenteditable="true"]');

    // The zero-size anchors the reconciler parks outside a leading / trailing
    // block decorator (#8922) occupy a DOM child slot but no lexical one, so
    // discount them from both paths and offsets.
    const boundaryAnchorsBefore = (parent, index) => {
      const children = parent.childNodes;
      let count = 0;
      for (let i = 0; i < index && i < children.length; i++) {
        const child = children[i];
        if (
          child.nodeType === Node.ELEMENT_NODE &&
          child.getAttribute('data-lexical-decorator-boundary') === 'true'
        ) {
          count++;
        }
      }
      return count;
    };

    const getPathFromNode = node => {
      const path = [];
      if (node === rootElement) {
        return [];
      }
      while (node !== null) {
        const parent = node.parentNode;
        if (parent === null || node === rootElement) {
          break;
        }
        const index = Array.from(parent.childNodes).indexOf(node);
        path.push(index - boundaryAnchorsBefore(parent, index));
        node = parent;
      }
      return path.reverse();
    };

    const fixOffset = (node, offset) => {
      if (node && node.nodeType === Node.ELEMENT_NODE) {
        offset -= boundaryAnchorsBefore(node, offset);
      }
      // If the selection offset is at the br of a webkit img+br linebreak
      // then move the offset to the img so the tests are consistent across
      // browsers
      if (node && node.nodeType === Node.ELEMENT_NODE && offset > 0) {
        const child = node.children[offset - 1];
        if (
          child &&
          child.nodeType === Node.ELEMENT_NODE &&
          child.nodeName === 'IMG' &&
          child.getAttribute('data-lexical-managed-linebreak') === 'true'
        ) {
          return offset - 1;
        }
      }
      return offset;
    };

    const {anchorNode, anchorOffset, focusNode, focusOffset} =
      window.getSelection();

    return {
      anchorOffset: fixOffset(anchorNode, anchorOffset),
      anchorPath: getPathFromNode(anchorNode),
      focusOffset: fixOffset(focusNode, focusOffset),
      focusPath: getPathFromNode(focusNode),
    };
  });
  expect(selection.anchorPath).toEqual(expected.anchorPath);
  expect(selection.focusPath).toEqual(expected.focusPath);
  if (Array.isArray(expected.anchorOffset)) {
    const [start, end] = expected.anchorOffset;
    expect(selection.anchorOffset).toBeGreaterThanOrEqual(start);
    expect(selection.anchorOffset).toBeLessThanOrEqual(end);
  } else {
    expect(selection.anchorOffset).toEqual(expected.anchorOffset);
  }
  if (Array.isArray(expected.focusOffset)) {
    const [start, end] = expected.focusOffset;
    expect(selection.focusOffset).toBeGreaterThanOrEqual(start);
    expect(selection.focusOffset).toBeLessThanOrEqual(end);
  } else {
    expect(selection.focusOffset).toEqual(expected.focusOffset);
  }
}

export async function assertSelection(page, expected) {
  await assertSelectionOnPageOrFrame(getPageOrFrame(page), expected);
}

export async function isMac(page) {
  return page.evaluate(
    () =>
      typeof window !== 'undefined' &&
      /Mac|iPod|iPhone|iPad/.test(window.navigator.platform),
  );
}

export async function supportsBeforeInput(page) {
  return page.evaluate(() => {
    if ('InputEvent' in window) {
      return 'getTargetRanges' in new window.InputEvent('input');
    }
    return false;
  });
}

export async function keyDownCtrlOrMeta(page) {
  if (await isMac(page)) {
    await page.keyboard.down('Meta');
  } else {
    await page.keyboard.down('Control');
  }
}

export async function keyUpCtrlOrMeta(page) {
  if (await isMac(page)) {
    await page.keyboard.up('Meta');
  } else {
    await page.keyboard.up('Control');
  }
}

export async function keyDownCtrlOrAlt(page) {
  if (await isMac(page)) {
    await page.keyboard.down('Alt');
  } else {
    await page.keyboard.down('Control');
  }
}

export async function keyUpCtrlOrAlt(page) {
  if (await isMac(page)) {
    await page.keyboard.up('Alt');
  } else {
    await page.keyboard.up('Control');
  }
}

async function copyToClipboardPageOrFrame(pageOrFrame) {
  return await pageOrFrame.evaluate(() => {
    // document.querySelector doesn't pierce shadow roots; descend into any
    // open shadow trees so this works for the "Render in Shadow DOM"
    // playground setting too. Match `data-lexical-editor` rather than any
    // contenteditable so we don't accidentally grab a comment/draft input
    // that also has contenteditable=true.
    const findEditor = root => {
      const direct = root.querySelector(
        'div[contenteditable="true"][data-lexical-editor="true"]',
      );
      if (direct !== null) {
        return direct;
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot !== null) {
          const inner = findEditor(el.shadowRoot);
          if (inner !== null) {
            return inner;
          }
        }
      }
      return null;
    };
    const clipboardData = {};
    const editor = findEditor(document);
    const copyEvent = new ClipboardEvent('copy');
    Object.defineProperty(copyEvent, 'clipboardData', {
      value: {
        setData(type, value) {
          clipboardData[type] = value;
        },
      },
    });
    editor.dispatchEvent(copyEvent);
    return clipboardData;
  });
}

export async function copyToClipboard(page) {
  return await copyToClipboardPageOrFrame(getPageOrFrame(page));
}

async function pasteWithClipboardDataFromPageOrFrame(
  pageOrFrame,
  clipboardData,
  editorSelector,
) {
  const canUseBeforeInput = await supportsBeforeInput(pageOrFrame);
  await pageOrFrame.evaluate(
    async ({
      clipboardData: _clipboardData,
      canUseBeforeInput: _canUseBeforeInput,
      editorSelector: _editorSelector,
    }) => {
      const files = [];
      for (const [clipboardKey, clipboardValue] of Object.entries(
        _clipboardData,
      )) {
        if (clipboardKey.startsWith('playwright/base64')) {
          delete _clipboardData[clipboardKey];
          const [base64, type] = clipboardValue;
          const res = await fetch(base64);
          const blob = await res.blob();
          files.push(new File([blob], 'file', {type}));
        }
      }
      let eventClipboardData;
      if (files.length > 0) {
        eventClipboardData = {
          files,
          getData(type, value) {
            return _clipboardData[type];
          },
          types: [...Object.keys(_clipboardData), 'Files'],
        };
      } else {
        eventClipboardData = {
          files,
          getData(type, value) {
            return _clipboardData[type];
          },
          types: Object.keys(_clipboardData),
        };
      }

      // document.querySelector doesn't pierce shadow roots; descend into any
      // open shadow trees so paste works for the "Render in Shadow DOM"
      // playground setting too. Match `data-lexical-editor` (not just any
      // contenteditable) so a draft/comment input doesn't shadow the real
      // editor when activeElement is not contenteditable.
      const findEditor = root => {
        const direct = root.querySelector(
          'div[contenteditable="true"][data-lexical-editor="true"]',
        );
        if (direct !== null) {
          return direct;
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot !== null) {
            const inner = findEditor(el.shadowRoot);
            if (inner !== null) {
              return inner;
            }
          }
        }
        return null;
      };
      const activeElement = document.activeElement;
      const editor =
        activeElement &&
        activeElement.isContentEditable &&
        activeElement.matches(_editorSelector)
          ? activeElement
          : findEditor(document);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: eventClipboardData,
      });
      editor.dispatchEvent(pasteEvent);
      if (!pasteEvent.defaultPrevented) {
        if (_canUseBeforeInput) {
          const inputEvent = new InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
          });
          Object.defineProperty(inputEvent, 'inputType', {
            value: 'insertFromPaste',
          });
          Object.defineProperty(inputEvent, 'dataTransfer', {
            value: eventClipboardData,
          });
          editor.dispatchEvent(inputEvent);
        }
      }
    },
    {canUseBeforeInput, clipboardData, editorSelector},
  );
}

/**
 * @param {import('@playwright/test').Page} page
 */
export async function pasteFromClipboard(
  page,
  clipboardData,
  editorSelector = 'div[contenteditable="true"]',
) {
  if (clipboardData === undefined) {
    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('v');
    await keyUpCtrlOrMeta(page);
    return;
  }
  await pasteWithClipboardDataFromPageOrFrame(
    getPageOrFrame(page),
    clipboardData,
    editorSelector,
  );
}

export async function sleep(delay) {
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Force a new undo group (a "merge boundary") deterministically — a drop-in
 * replacement for `sleep(mergeWindow + overhead)`. Works in both editor modes
 * and picks the right mechanism automatically:
 *
 * - **Local history** (`@lexical/history`): coalesces consecutive same-type
 *   edits while `now() < prevChangeTime + delay`. We drive the extension's
 *   `now` output signal directly — the lever called out in the task — freezing
 *   it `delay + overheadMs` past its current value. The next edit is then
 *   guaranteed to exceed the merge window (new boundary), while later edits
 *   observe a fixed time so genuinely fast edits still coalesce as in
 *   production. History reads `now` via `peek()`, so reassigning the signal
 *   neither re-registers history nor disturbs in-progress merge bookkeeping.
 * - **Collab** (Yjs `UndoManager`, which `@lexical/history` is disabled in
 *   favor of): the manager coalesces changes within its own `captureTimeout`
 *   using `Date.now()`, which isn't injectable. Its public `stopCapturing()`
 *   resets the window (`lastChange = 0`) so the next change starts a fresh
 *   stack item — the deterministic equivalent of advancing past the window.
 *   The manager is published on the editor by `useYjsUndoManager`; see
 *   `Symbol.for('@lexical/yjs/UndoManager')`.
 *
 * Both replace wall-clock sleeps, which are slow and, under CI load, flaky: a
 * timer that fires late can coalesce edits meant to stay separate (or vice
 * versa).
 *
 * @param {import('@playwright/test').Page} page
 * @param {number} [overheadMs] slack added past the local-history `delay`,
 *   mirroring the old `sleep(delay + 50)` convention.
 */
export async function advanceHistoryClock(page, overheadMs = 50) {
  await evaluate(
    page,
    overhead => {
      const editor = document.querySelector(
        '[data-lexical-editor="true"]',
      ).__lexicalEditor;
      // Collab: reset the Yjs UndoManager's capture window.
      const undoManager = editor[Symbol.for('@lexical/yjs/UndoManager')];
      if (undoManager) {
        undoManager.stopCapturing();
        return;
      }
      // Local history: freeze `now` past the merge delay.
      const builder = editor[Symbol.for('@lexical/extension/LexicalBuilder')];
      const output = builder?.extensionNameMap.get('@lexical/history/History')
        ?.state?.output;
      if (output && !output.disabled.value) {
        const frozen = output.now.peek()() + output.delay.peek() + overhead;
        output.now.value = () => frozen;
        return;
      }
      throw new Error(
        'advanceHistoryClock: no active undo mechanism found on the editor ' +
          '(expected the Yjs UndoManager in collab, or an enabled ' +
          '@lexical/history extension otherwise)',
      );
    },
    overheadMs,
  );
}

/**
 * Make collaborative undo grouping deterministic by removing the Yjs
 * `UndoManager`'s wall-clock capture window for the editor under test.
 *
 * In collab, `@lexical/history` is disabled in favor of the Yjs `UndoManager`,
 * which coalesces consecutive local edits into a single undo stack item only
 * while each lands within `captureTimeout` (500ms by default) of the previous
 * one, measured with `Date.now()`. Unlike the local-history clock that
 * {@link advanceHistoryClock} drives, that timer isn't injectable — so under CI
 * load a stall longer than the window silently splits one logical edit group
 * across several stack items. A later `undo()` then reverts only the last
 * fragment, which is the intermittent "expected an empty paragraph, received
 * leftover typed text / a leftover list item" failure this guards against.
 *
 * Setting `captureTimeout` to Infinity drops the time dimension entirely:
 * grouping is then governed solely by explicit boundaries — `advanceHistoryClock`
 * (which calls `stopCapturing()`) and the `stopCapturing()` the `UndoManager`
 * performs automatically after every undo/redo. Both reset `lastChange` to 0 so
 * the next edit opens a fresh stack item, while everything in between always
 * coalesces regardless of timing. This makes "type a burst, then undo it as a
 * unit" reliable without changing any behavior the tests assert: a run that
 * happened to stay under the 500ms window already grouped the same way.
 *
 * No-op outside collab, where `advanceHistoryClock` already drives a
 * deterministic clock.
 *
 * @param {import('@playwright/test').Page} page
 */
export async function freezeCollabUndoGrouping(page) {
  if (!IS_COLLAB) {
    return;
  }
  // Collab connects asynchronously, so the UndoManager may not be published the
  // instant the editor mounts — poll until it is, then disable the capture
  // window in place. The predicate's mutation is intentional and idempotent: it
  // returns true (ending the poll) only on the tick it runs.
  await getPageOrFrame(page).waitForFunction(() => {
    const editor = document.querySelector(
      '[data-lexical-editor="true"]',
    )?.__lexicalEditor;
    const undoManager = editor?.[Symbol.for('@lexical/yjs/UndoManager')];
    if (!undoManager) {
      return false;
    }
    undoManager.captureTimeout = Infinity;
    return true;
  });
}

// Fair time for the browser to process a newly inserted image
export async function sleepInsertImage(count = 1) {
  return await sleep(1000 * count);
}

/**
 * @param {import('@playwright/test').Page} page
 */
export async function focusEditor(page, parentSelector = '.editor-shell') {
  const locator = getEditorElement(page, parentSelector);
  await locator.focus();
}

export async function getHTML(page, selector = 'div[contenteditable="true"]') {
  return await locate(page, selector).innerHTML();
}

export function getEditorElement(page, parentSelector = '.editor-shell') {
  const selector = `${parentSelector} div[contenteditable="true"]`;
  return locate(page, selector).first();
}

export async function waitForSelector(page, selector, options) {
  await getPageOrFrame(page).waitForSelector(selector, options);
}

/**
 * Wait until `optionText` is the *highlighted* (aria-selected) option in the
 * typeahead / mentions menu, so a subsequent `Enter` deterministically commits
 * it.
 *
 * The mentions lookup is asynchronous and incremental: while e.g. "@Luke" is
 * being typed, the partial query "Lu" also matches options that sort earlier —
 * the "Lu" results list "Agent Kallus" (kal**lu**s) at index 0 and only list
 * "Luke Skywalker" at index 2. Those intermediate result sets resolve on their
 * own timers, so waiting merely for the option *text* to be present and then
 * pressing Enter (which commits the highlighted index 0) is racy: under load
 * the Enter can land while an intermediate list is showing and commit the wrong
 * option. Waiting for the option to be highlighted is deterministic because the
 * settled list always highlights the intended option at index 0.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} optionText
 * @param {Parameters<import('@playwright/test').Page['waitForSelector']>[1]} [options]
 */
export async function waitForTypeaheadMenuOption(page, optionText, options) {
  await waitForSelector(
    page,
    `#typeahead-menu ul li[aria-selected="true"]:has-text("${optionText}")`,
    options,
  );
}

export function locate(page, selector) {
  return getPageOrFrame(page).locator(selector);
}

export async function selectorBoundingBox(page, selector) {
  return await locate(page, selector).boundingBox();
}

export async function click(page, selector, options) {
  const frame = getPageOrFrame(page);
  await frame.waitForSelector(selector, options);
  await frame.click(selector, options);
}

export async function doubleClick(page, selector, options) {
  const frame = getPageOrFrame(page);
  await frame.waitForSelector(selector, options);
  await frame.dblclick(selector, options);
}

export async function focus(page, selector, options) {
  await locate(page, selector).focus(options);
}

export async function fill(page, selector, value) {
  await locate(page, selector).fill(value);
}

export async function selectOption(page, selector, options) {
  await getPageOrFrame(page).selectOption(selector, options);
}

export async function textContent(page, selector, options) {
  return await getPageOrFrame(page).textContent(selector, options);
}

export async function evaluate(page, fn, args) {
  return await getPageOrFrame(page).evaluate(fn, args);
}

export async function clearEditor(page) {
  await selectAll(page);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
}

export async function insertSampleImage(page, modifier) {
  await selectFromInsertDropdown(page, '.image');
  if (modifier === 'alt') {
    await page.keyboard.down('Alt');
  }
  await click(page, 'button[data-test-id="image-modal-option-sample"]');
  if (modifier === 'alt') {
    await page.keyboard.up('Alt');
  }
}

export async function insertUrlImage(page, url, altText) {
  await selectFromInsertDropdown(page, '.image');
  await click(page, 'button[data-test-id="image-modal-option-url"]');
  await focus(page, 'input[data-test-id="image-modal-url-input"]');
  await page.keyboard.type(url);
  if (altText) {
    await focus(page, 'input[data-test-id="image-modal-alt-text-input"]');
    await page.keyboard.type(altText);
  }
  await click(page, 'button[data-test-id="image-modal-confirm-btn"]');
}

export async function insertUploadImage(page, files, altText) {
  await selectFromInsertDropdown(page, '.image');
  await click(page, 'button[data-test-id="image-modal-option-file"]');

  const frame = getPageOrFrame(page);
  await frame.setInputFiles(
    'input[data-test-id="image-modal-file-upload"]',
    files,
  );

  if (altText) {
    await focus(page, 'input[data-test-id="image-modal-alt-text-input"]');
    await page.keyboard.type(altText);
  }
  await click(page, 'button[data-test-id="image-modal-file-upload-btn"]');
}

export async function insertYouTubeEmbed(page, url) {
  await selectFromInsertDropdown(page, '.youtube');
  await focus(page, 'input[data-test-id="youtube-video-embed-modal-url"]');
  await page.keyboard.type(url);
  await click(
    page,
    'button[data-test-id="youtube-video-embed-modal-submit-btn"]',
  );
}

export async function insertHorizontalRule(page) {
  await selectFromInsertDropdown(page, '.horizontal-rule');
}

export async function insertDateTime(page) {
  await selectFromInsertDropdown(page, '.calendar');
  await sleep(500);
}

export function getExpectedDateTimeHtml({selected = false, formats = []} = {}) {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // DateTimeNode displays a limited set of formats
  const formatToClassname = {
    bold: 'bold',
    highlight: 'highlight',
    italic: 'italic',
    strikethrough: 'strikethrough',
    underline: 'underline',
  };

  return html`
    <span
      contenteditable="false"
      style="display: inline-block;"
      data-lexical-datetime="${date.toString()}"
      data-lexical-decorator="true">
      <div
        class="dateTimePill ${selected ? 'selected' : ''} ${formats
          .map(f => formatToClassname[f] || '')
          .join(' ')}">
        ${date.toDateString()}
      </div>
    </span>
  `;
}

export async function insertImageCaption(page, caption) {
  await click(page, '.editor-image img');
  await click(page, '.image-caption-button');
  await waitForSelector(page, '.editor-image img.focused', {
    state: 'detached',
  });
  await focusEditor(page, '.image-caption-container');
  await page.keyboard.type(caption);
}

export async function mouseMoveToSelector(page, selector) {
  const {x, width, y, height} = await selectorBoundingBox(page, selector);
  await page.mouse.move(x + width / 2, y + height / 2);
}

export async function dragMouse(
  page,
  fromBoundingBox,
  toBoundingBox,
  opts = {},
) {
  const {
    positionStart = 'middle',
    positionEnd = 'middle',
    offsetEnd = {x: 0, y: 0},
    mouseDown = true,
    mouseUp = true,
    slow = false,
  } = opts;
  let fromX = fromBoundingBox.x;
  let fromY = fromBoundingBox.y;
  if (positionStart === 'middle') {
    fromX += fromBoundingBox.width / 2;
    fromY += fromBoundingBox.height / 2;
  } else if (positionStart === 'end') {
    fromX += fromBoundingBox.width;
    fromY += fromBoundingBox.height;
  }
  let toX = toBoundingBox.x + (offsetEnd.x ?? 0);
  let toY = toBoundingBox.y + (offsetEnd.y ?? 0);
  if (positionEnd === 'middle') {
    toX += toBoundingBox.width / 2;
    toY += toBoundingBox.height / 2;
  } else if (positionEnd === 'end') {
    toX += toBoundingBox.width;
    toY += toBoundingBox.height;
  }

  await page.mouse.move(fromX, fromY);
  if (mouseDown) {
    await page.mouse.down();
  }
  await page.mouse.move(toX, toY, slow ? 10 : 1);
  if (mouseUp) {
    await page.mouse.up();
  }
}

export async function dragImage(
  page,
  toSelector,
  positionStart = 'middle',
  positionEnd = 'middle',
) {
  await dragMouse(
    page,
    await selectorBoundingBox(page, '.editor-image img'),
    await selectorBoundingBox(page, toSelector),
    {positionEnd, positionStart},
  );
}

export async function prettifyHTML(
  string,
  {ignoreClasses, ignoreInlineStyles, ignoreDir} = {},
) {
  let output = string;

  if (ignoreClasses) {
    output = output.replace(/\sclass="([^"]*)"/g, '');
  }

  if (ignoreInlineStyles) {
    output = output.replace(/\sstyle="([^"]*)"/g, '');
  }

  if (ignoreDir) {
    output = output.replace(/\sdir="([^"]*)"/g, '');
  }

  output = output.replace(/\s__playwright_target__="[^"]+"/, '');

  return await prettier.format(output, {
    attributeGroups: ['$DEFAULT', '^data-'],
    attributeSort: 'asc',
    bracketSameLine: true,
    htmlWhitespaceSensitivity: 'ignore',
    parser: 'html',
    plugins: ['prettier-plugin-organize-attributes'],
  });
}

// This function does not suppose to do anything, it's only used as a trigger
// for prettier auto-formatting (https://prettier.io/blog/2020/08/24/2.1.0.html#api)
export function html(partials, ...params) {
  let output = '';
  for (let i = 0; i < partials.length; i++) {
    output += partials[i];
    if (i < partials.length - 1) {
      output += params[i];
    }
  }
  return output;
}

export async function selectFromAdditionalStylesDropdown(page, selector) {
  await click(
    page,
    '.toolbar-item[aria-label="Formatting options for additional text styles"]',
  );
  await click(page, '.dropdown ' + selector);
}

export async function selectFromBackgroundColorPicker(page) {
  await click(page, '.toolbar-item[aria-label="Formatting background color"]');
  await click(page, '.color-picker-basic-color button:first-child'); //Defaulted to red
}

export async function selectFromColorPicker(page) {
  await click(page, '.toolbar-item[aria-label="Formatting text color"]');
  await click(page, '.color-picker-basic-color button:first-child'); //Defaulted to red
}
export async function selectFromFormatDropdown(page, selector) {
  await click(
    page,
    '.toolbar-item[aria-label="Formatting options for text style"]',
  );
  await click(page, '.dropdown ' + selector);
}

export async function selectFromInsertDropdown(page, selector) {
  await click(
    page,
    '.toolbar-item[aria-label="Insert specialized editor node"]',
  );
  await click(page, '.dropdown ' + selector);
}

export async function selectFromAlignDropdown(page, selector) {
  await click(
    page,
    '.toolbar-item[aria-label="Formatting options for text alignment"]',
  );
  await click(page, '.dropdown ' + selector);
}

export async function selectFromTableDropdown(page, selector) {
  await click(page, '.toolbar-item[aria-label="Open table toolkit"]');
  await click(page, '.dropdown ' + selector);
}

export async function insertTable(page, rows = 2, columns = 3) {
  const leftFrame = getPageOrFrame(page);
  await selectFromInsertDropdown(page, '.item .table');
  if (rows !== null) {
    await leftFrame
      .locator('input[data-test-id="table-modal-rows"]')
      .fill(String(rows));
  }
  if (columns !== null) {
    await leftFrame
      .locator('input[data-test-id="table-modal-columns"]')
      .fill(String(columns));
  }
  await click(
    page,
    'div[data-test-id="table-model-confirm-insert"] > .Button__root',
  );
}

export async function insertCollapsible(page) {
  await selectFromInsertDropdown(page, '.item .caret-right');
}

export async function selectCellFromTableCoord(page, coord, isHeader = false) {
  const leftFrame = getPageOrFrame(page);
  if (IS_COLLAB) {
    await focusEditor(page);
  }

  const cell = await leftFrame.locator(
    `table:first-of-type > :nth-match(tr, ${coord.y + 1}) > ${
      isHeader ? 'th' : 'td'
    }:nth-child(${coord.x + 1})`,
  );
  await cell.click();
}

export async function selectCellsFromTableCords(
  page,
  firstCords,
  secondCords,
  isFirstHeader = false,
  isSecondHeader = false,
) {
  const leftFrame = getPageOrFrame(page);
  if (IS_COLLAB) {
    await focusEditor(page);
  }

  const firstRowFirstColumnCell = await leftFrame.locator(
    `table:first-of-type > :nth-match(tr, ${firstCords.y + 1}) > ${
      isFirstHeader ? 'th' : 'td'
    }:nth-child(${firstCords.x + 1})`,
  );
  const secondRowSecondCell = await leftFrame.locator(
    `table:first-of-type > :nth-match(tr, ${secondCords.y + 1}) > ${
      isSecondHeader ? 'th' : 'td'
    }:nth-child(${secondCords.x + 1})`,
  );

  await firstRowFirstColumnCell.click();
  await page.keyboard.down('Shift');
  await secondRowSecondCell.click();
  await page.keyboard.up('Shift');

  // const firstBox = await firstRowFirstColumnCell.boundingBox();
  // const secondBox = await secondRowSecondCell.boundingBox();
  // await dragMouse(page, firstBox, secondBox, {slow: true});
}

export async function clickTableCellActiveButton(page) {
  await click(
    page,
    '.table-cell-action-button-container--active > .table-cell-action-button',
  );
}

export async function insertTableRowAbove(page) {
  await clickTableCellActiveButton(page);
  await click(page, '.item[data-test-id="table-insert-row-above"]');
}

export async function insertTableRowBelow(page) {
  await clickTableCellActiveButton(page);
  await click(page, '.item[data-test-id="table-insert-row-below"]');
}

export async function insertTableColumnBefore(page) {
  await clickTableCellActiveButton(page);
  await click(page, '.item[data-test-id="table-insert-column-before"]');
}

export async function insertTableColumnAfter(page) {
  await clickTableCellActiveButton(page);
  await click(page, '.item[data-test-id="table-insert-column-after"]');
}

export async function resizeTableCell(page, selector, width = 0, height = 0) {
  await click(page, selector);
  const resizerBoundingBox = await selectorBoundingBox(
    page,
    '.TableCellResizer__resizer:first-child',
  );
  const x = resizerBoundingBox.x + resizerBoundingBox.width / 2;
  const y = resizerBoundingBox.y + resizerBoundingBox.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + width, y + height);
  await page.mouse.up();
}

export async function mergeTableCells(page) {
  await clickTableCellActiveButton(page);
  await click(page, '.item[data-test-id="table-merge-cells"]');
}

export async function unmergeTableCell(page) {
  await clickTableCellActiveButton(page);
  await click(page, '.item[data-test-id="table-unmerge-cells"]');
}

export async function toggleColumnHeader(page) {
  await clickTableCellActiveButton(page);
  await click(page, '.item[data-test-id="table-column-header"]');
}

export async function toggleRowHeader(page) {
  await clickTableCellActiveButton(page);
  await click(page, '.item[data-test-id="table-row-header"]');
}

export async function deleteTableRows(page) {
  await clickTableCellActiveButton(page);
  await click(page, '.item[data-test-id="table-delete-rows"]');
}

export async function deleteTableColumns(page) {
  await clickTableCellActiveButton(page);
  await click(page, '.item[data-test-id="table-delete-columns"]');
}

export async function deleteTable(page) {
  await clickTableCellActiveButton(page);
  await click(page, '.item[data-test-id="table-delete"]');
}

export async function setBackgroundColor(page) {
  await clickTableCellActiveButton(page);
  await click(page, '.item[data-test-id="table-background-color"]');
}

export async function enableCompositionKeyEvents(page) {
  const targetPage = getPageOrFrame(page);
  await targetPage.evaluate(() => {
    window.addEventListener(
      'compositionstart',
      () => {
        document.activeElement.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Unidentified',
            keyCode: 220,
          }),
        );
      },
      true,
    );
  });
}

/**
 * CDP-based IME composition helper for e2e tests.
 *
 * Plays an IME composition sequence through Chrome DevTools Protocol,
 * replacing the verbose per-step client.send() calls that are
 * copy-pasted across Composition.spec tests.
 *
 * @param {import('@playwright/test').CDPSession} client
 * @param {string[]} steps - Intermediate composing text at each keystroke.
 * @param {string} [commitText] - Final committed text. Defaults to last step.
 */
export async function imeCompose(client, steps, commitText) {
  const finalText = commitText ?? steps[steps.length - 1];
  for (const text of steps) {
    await client.send('Input.imeSetComposition', {
      selectionEnd: text.length,
      selectionStart: text.length,
      text,
    });
  }
  await client.send('Input.insertText', {text: finalText});
}

// Pre-built Hiragana sequences used across multiple e2e tests.
export const HIRAGANA_SUSHI = {
  commitText: 'すし',
  steps: ['ｓ', 'す', 'すｓ', 'すｓｈ', 'すし'],
};

export const HIRAGANA_MOJIA = {
  commitText: 'もじあ',
  steps: ['m', 'も', 'もj', 'もじ', 'もじあ'],
};

/**
 * Types "すし もじあ" using CDP IME — the full sequence used in most
 * Composition.spec tests.
 */
export async function typeSushiMojia(client, page) {
  await imeCompose(client, HIRAGANA_SUSHI.steps, HIRAGANA_SUSHI.commitText);
  await client.send('Input.insertText', {text: ' '});
  await imeCompose(client, HIRAGANA_MOJIA.steps, HIRAGANA_MOJIA.commitText);
}

export async function pressToggleBold(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.press('b');
  await keyUpCtrlOrMeta(page);
}

export async function pressToggleItalic(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.press('i');
  await keyUpCtrlOrMeta(page);
}

export async function pressToggleUnderline(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.press('u');
  await keyUpCtrlOrMeta(page);
}

export async function dragDraggableMenuTo(
  page,
  toSelector,
  positionStart = 'middle',
  positionEnd = 'middle',
) {
  await dragMouse(
    page,
    await selectorBoundingBox(page, '.draggable-block-menu'),
    await selectorBoundingBox(page, toSelector),
    {positionEnd, positionStart},
  );
}

export async function pressInsertLinkButton(page) {
  await click(page, '.toolbar-item[aria-label="Insert link"]');
}

/**
 * Creates a selection object to assert against that is human readable and self-describing.
 *
 * Selections are composed of an anchorPath (the start) and a focusPath (the end).
 * Once you traverse each path, you use the respective offsets to find the exact location of the cursor.
 * So offsets are relative to their path. For example, if the anchorPath is [0, 1, 2] and the anchorOffset is 3,
 * then the cursor is at the 4th character of the 3rd element of the 2nd element of the 1st element.
 *
 * @example
 * const expectedSelection = createHumanReadableSelection('the full text of the last cell', {
 *   anchorOffset: {desc: 'beginning of cell', value: 0},
 *   anchorPath: [
 *     {desc: 'index of table in root', value: 1},
 *     {desc: 'first table row', value: 0},
 *     {desc: 'first cell', value: 0},
 *   ],
 *   focusOffset: {desc: 'full text length', value: 9},
 *   focusPath: [
 *     {desc: 'index of last paragraph', value: 2},
 *     {desc: 'index of first span', value: 0},
 *     {desc: 'index of text block', value: 0},
 *   ],
 * });
 */
export function createHumanReadableSelection(_overview, dto) {
  return {
    anchorOffset: dto.anchorOffset.value,
    anchorPath: dto.anchorPath.map(p => p.value),
    focusOffset: dto.focusOffset.value,
    focusPath: dto.focusPath.map(p => p.value),
  };
}
