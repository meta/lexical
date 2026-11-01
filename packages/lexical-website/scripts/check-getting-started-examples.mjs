/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {chromium} from 'playwright';

import {startServer} from './serve-built-website.mjs';

const PAGES = [
  {examples: ['vanilla-js'], path: 'quick-start'},
  {examples: ['react-plain-text', 'react-rich'], path: 'react'},
  {examples: ['vanilla-js-plugin'], path: 'creating-plugin'},
  {examples: ['node-state-review'], path: 'node-state'},
];
const FILES = {
  'node-state-review': 'src/ReviewExtension.ts',
  'react-plain-text': 'src/App.tsx',
  'react-rich': 'src/App.tsx',
  'vanilla-js': 'src/main.ts',
  'vanilla-js-plugin': 'src/emoji-plugin/EmojiExtension.ts',
};

const require = createRequire(import.meta.url);
const {
  version: emojiVersion,
} = require('emoji-datasource-facebook/package.json');

const EMOJI_BASE_URL = `https://cdn.jsdelivr.net/npm/emoji-datasource-facebook@${emojiVersion}/img/facebook/64`;
const EMOJI_IMAGE =
  require.resolve('emoji-datasource-facebook/img/facebook/64/1f642.png');

async function main() {
  const server = await startServer();
  const prefixedServer = await startServer({baseUrl: '/lexical/'});
  const {port} = server.address();
  const baseURL = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage();
  // Exercise image success and failure without depending on CDN availability.
  await page.route(`${EMOJI_BASE_URL}/*.png`, route =>
    route.request().url().endsWith('/1f642.png')
      ? route.fulfill({contentType: 'image/png', path: EMOJI_IMAGE})
      : route.fulfill({status: 404}),
  );
  const errors = [];
  const stackblitzRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).hostname === 'stackblitz.com') {
      stackblitzRequests.push(request.url());
    }
  });

  try {
    for (const {examples, path} of PAGES) {
      await page.goto(`${baseURL}/docs/getting-started/${path}`, {
        waitUntil: 'load',
      });
      assert.equal(
        await page.locator('[data-doc-example]').count(),
        examples.length,
      );
      await expect(page.locator('iframe[src*="stackblitz"]')).toHaveCount(0);
      for (const example of examples) {
        const demo = page.locator(`[data-doc-example="${example}"]`);
        await demo.scrollIntoViewIfNeeded();
        const iframe = demo.locator('iframe');
        await expect(iframe).toHaveAttribute(
          'src',
          `/examples/${example}/?embed`,
        );
        const frame = iframe.contentFrame();
        const editor = frame.locator('[contenteditable="true"]');
        await expect(editor).toHaveCount(1);
        await expect(editor).toBeVisible();
        assert.equal(
          await page.evaluate(
            () =>
              document.activeElement &&
              document.activeElement.tagName === 'IFRAME',
          ),
          false,
          'An embedded editor must not steal focus',
        );
        const button = demo.getByRole('link', {name: 'Open in StackBlitz'});
        await expect(button).toHaveAttribute('target', '_blank');
        await expect(button).toHaveAttribute('rel', /noopener/);
        const url = new URL(await button.getAttribute('href'));
        assert.equal(url.hostname, 'stackblitz.com');
        assert.ok(url.pathname.endsWith(`/examples/${example}`));
        assert.equal(url.searchParams.get('file'), FILES[example]);
        assert.equal(url.searchParams.has('embed'), false);

        await editor.click();
        await editor.press('ControlOrMeta+a');
        await editor.pressSequentially('Hello from the documentation');
        await expect(editor).toHaveText('Hello from the documentation');
        if (example === 'react-rich') {
          await editor.press('ControlOrMeta+a');
          await frame
            .getByRole('button', {exact: true, name: 'Format Bold'})
            .click();
          await expect(editor.locator('strong')).toHaveText(
            'Hello from the documentation',
          );
          await frame.getByRole('button', {exact: true, name: 'Undo'}).click();
          await expect(editor.locator('strong')).toHaveCount(0);
          await editor.press('ControlOrMeta+a');
          await editor.evaluate(element => {
            const clipboardData = new DataTransfer();
            clipboardData.setData(
              'text/html',
              '<p><b><i><span style="font-size: 20px; color: rgb(255, 0, 0)">Styled text</span></i></b></p>',
            );
            element.dispatchEvent(
              new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData,
              }),
            );
          });
          await expect(editor).toHaveText('Styled text');
          await expect(editor.locator('strong')).toHaveCSS(
            'color',
            'rgb(255, 0, 0)',
          );
          await expect(editor.locator('strong')).toHaveCSS(
            'font-style',
            'italic',
          );
          await editor.press('ControlOrMeta+a');
          const exported = await editor.evaluate(element => {
            const clipboardData = new DataTransfer();
            element.dispatchEvent(
              new ClipboardEvent('copy', {
                bubbles: true,
                cancelable: true,
                clipboardData,
              }),
            );
            return clipboardData.getData('text/html');
          });
          assert.match(exported, /Styled text/);
          assert.match(exported, /<(strong|b)>/);
          assert.match(exported, /<(em|i)>/);
          assert.doesNotMatch(exported, /\s(?:style|class)=/);
          process.stdout.write(
            'PASS HTML styles: allowed import, clean export, retained formatting\n',
          );
        }
        if (example === 'vanilla-js-plugin') {
          await editor.press('ControlOrMeta+a');
          await editor.pressSequentially(':) ');
          const emoji = editor.locator('.emoji-node');
          await expect(emoji).toHaveCount(1);
          await expect(emoji).toHaveClass(/emoji-node-loaded/);
          const background = await emoji.evaluate(
            node => getComputedStyle(node).backgroundImage,
          );
          assert.equal(background, `url("${EMOJI_BASE_URL}/1f642.png")`);
          // Formatting clones the custom node; its schema must carry the ID.
          await editor.press('ControlOrMeta+a');
          await editor.press('ControlOrMeta+b');
          const state = frame.locator('#lexical-state');
          await expect(state).toHaveValue(/"format": 1/);
          const saved = await state.inputValue();
          const nodes = JSON.parse(saved).root.children.flatMap(
            node => node.children,
          );
          const serializedEmoji = nodes.find(node => node.type === 'emoji');
          assert.equal(serializedEmoji.unifiedID, '1f642');
          assert.equal(serializedEmoji.format, 1);
          assert.equal(serializedEmoji.mode, 'token');
          await expect(emoji).toHaveClass(/emoji-node-loaded/);
          const rendering = await editor.evaluate(element => {
            const instance = element.__lexicalEditor;
            const doc = element.ownerDocument;
            const dom = element.querySelector('.emoji-node');
            const createElement = doc.createElement;
            let imageCreations = 0;
            // Count even cached loads, which need not produce network requests.
            doc.createElement = function (tag, ...args) {
              if (tag === 'img') {
                imageCreations++;
              }
              return createElement.call(this, tag, ...args);
            };
            try {
              const clipboardData = new DataTransfer();
              element.dispatchEvent(
                new ClipboardEvent('copy', {
                  bubbles: true,
                  cancelable: true,
                  clipboardData,
                }),
              );
              const exportImages = imageCreations;
              const html = clipboardData.getData('text/html');
              imageCreations = 0;
              instance.update(
                () => {
                  const node = Array.from(
                    instance.getEditorState()._nodeMap.values(),
                  ).find(candidate => candidate.getType() === 'emoji');
                  node.setStyle('font-size: 18px; background-image: none;');
                },
                {discrete: true},
              );
              return {
                background: dom.style.backgroundImage,
                exportImages,
                html,
                loaded: dom.classList.contains('emoji-node-loaded'),
                sameDOM: dom === element.querySelector('.emoji-node'),
                styleImages: imageCreations,
              };
            } finally {
              doc.createElement = createElement;
            }
          });
          assert.equal(
            rendering.exportImages,
            0,
            'HTML export must not load images',
          );
          assert.match(rendering.html, /🙂/);
          assert.match(
            rendering.html,
            /data-emoji-id="1f642"/,
            'HTML export must preserve the emoji ID for import',
          );
          assert.match(rendering.html, /<(strong|b)>/);
          assert.doesNotMatch(
            rendering.html,
            /emoji-node|data-emoji-url|cdn\.jsdelivr/,
          );
          assert.equal(
            rendering.styleImages,
            0,
            'Style changes must reuse loaded images',
          );
          assert.equal(rendering.sameDOM, true);
          assert.equal(rendering.loaded, true);
          assert.equal(rendering.background, background);
          process.stdout.write(
            'PASS emoji: clean clipboard HTML, no export loads, stable image on style changes\n',
          );
          await editor.evaluate((element, json) => {
            const instance = element.__lexicalEditor;
            instance.setEditorState(instance.parseEditorState(json));
          }, saved);
          await expect(state).toHaveValue(saved);
          await expect(editor.locator('.emoji-node')).toHaveCount(1);
          // An unknown image ID must leave the native text visible.
          const missing = JSON.parse(saved);
          missing.root.children[0].children.find(
            node => node.type === 'emoji',
          ).unifiedID = 'missing';
          const missingImage = page.waitForResponse(
            `${EMOJI_BASE_URL}/missing.png`,
          );
          await editor.evaluate((element, json) => {
            const instance = element.__lexicalEditor;
            instance.setEditorState(instance.parseEditorState(json));
          }, JSON.stringify(missing));
          assert.equal((await missingImage).status(), 404);
          await expect(emoji).toHaveText('🙂');
          await expect(emoji).not.toHaveClass(/emoji-node-loaded/);
          await expect(emoji).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
          await expect(emoji).toHaveCSS('background-image', 'none');
          process.stdout.write(
            'PASS emoji: CDN image, clone, formatting, JSON round trip, missing-image fallback\n',
          );
          // Exercise the HTML path without Lexical's private clipboard JSON.
          await editor.click();
          await editor.press('ControlOrMeta+a');
          await editor.evaluate((element, html) => {
            const clipboardData = new DataTransfer();
            clipboardData.setData('text/html', html);
            element.dispatchEvent(
              new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData,
              }),
            );
          }, rendering.html);
          await expect(state).toHaveValue(/"unifiedID": "1f642"/);
          await expect(emoji).toHaveCount(1);

          const html = frame.getByLabel('HTML (export, edit, then import)');
          for (const [unifiedID, text, format] of [
            ['1f642', '🙂', 1],
            ['2764-fe0f', '❤️', 3],
            ['1f469-1f3fd-200d-1f4bb', '👩🏽‍💻', 0],
          ]) {
            const fixture = JSON.parse(saved);
            const node = fixture.root.children[0].children.find(
              child => child.type === 'emoji',
            );
            Object.assign(node, {format, text, unifiedID});
            await editor.evaluate((element, json) => {
              const instance = element.__lexicalEditor;
              instance.setEditorState(instance.parseEditorState(json));
            }, JSON.stringify(fixture));
            await frame
              .getByRole('button', {exact: true, name: 'Export HTML'})
              .click();
            assert.ok(
              (await html.inputValue()).includes(
                `data-emoji-id="${unifiedID}"`,
              ),
            );
            await frame
              .getByRole('button', {exact: true, name: 'Import HTML'})
              .click();
            await expect(emoji).toHaveText(text);
            const imported = JSON.parse(await state.inputValue())
              .root.children.flatMap(paragraph => paragraph.children)
              .find(child => child.type === 'emoji');
            assert.equal(imported.unifiedID, unifiedID);
            assert.equal(imported.text, text);
            assert.equal(imported.format ?? 0, format);
            assert.equal(imported.mode, 'token');
          }

          // Malformed IDs, out-of-range code points, and mismatched text must
          // retain the ordinary content instead of throwing or replacing it.
          for (const marker of [
            'data-emoji-id="invalid"',
            'data-emoji-id="110000"',
            'data-emoji-id="1f600"',
            '',
          ]) {
            await html.fill(
              `<p>Before <strong ${marker}>🙂</strong> after</p>`,
            );
            await frame
              .getByRole('button', {exact: true, name: 'Import HTML'})
              .click();
            await expect(emoji).toHaveCount(0);
            await expect(editor).toHaveText('Before 🙂 after');
            await expect(editor.locator('strong')).toHaveText('🙂');
          }
          process.stdout.write(
            'PASS emoji HTML: clipboard import, formatted and multi-code-point round trips, invalid attribute fallback\n',
          );
        }
        if (example === 'node-state-review') {
          const paragraph = editor.locator('p');
          const toggle = frame.getByRole('button', {name: 'Toggle reviewed'});
          await toggle.click();
          await expect(paragraph).toHaveAttribute('data-reviewed', 'true');
          await expect(frame.locator('#json')).toHaveValue(/"reviewed": true/);
          // Another update must carry the ad-hoc state across a clone.
          await editor.press('End');
          await editor.pressSequentially('!');
          await expect(paragraph).toHaveAttribute('data-reviewed', 'true');
          await frame.getByRole('button', {name: 'Export HTML'}).click();
          const html = frame.getByLabel('HTML (export, edit, then import)');
          await expect(html).toHaveValue(/data-reviewed="true"/);
          await paragraph.click();
          await toggle.click();
          await expect(paragraph).not.toHaveAttribute('data-reviewed');
          await expect(frame.locator('#json')).not.toHaveValue(
            /"reviewed": true/,
          );
          await frame.getByRole('button', {name: 'Import HTML'}).click();
          await expect(paragraph).toHaveAttribute('data-reviewed', 'true');
          await expect(paragraph).toHaveText('Hello from the documentation!');
          await expect(frame.locator('#json')).toHaveValue(/"reviewed": true/);
          // Nonmatching HTML attributes do not mark the paragraph as reviewed.
          await html.fill(
            '<p data-reviewed="false"><strong>Not reviewed</strong></p>',
          );
          await frame.getByRole('button', {name: 'Import HTML'}).click();
          await expect(paragraph).not.toHaveAttribute('data-reviewed');
          await expect(paragraph.locator('strong')).toHaveText('Not reviewed');
          // JSON import actually exercises reviewedState's booleanValue parser.
          const saved = JSON.parse(await frame.locator('#json').inputValue());
          for (const value of [true, false, 'true', 1, null, undefined]) {
            const json = structuredClone(saved);
            json.root.children[0].$ =
              value === undefined ? {} : {reviewed: value};
            await editor.evaluate((element, serialized) => {
              const instance = element.__lexicalEditor;
              instance.setEditorState(instance.parseEditorState(serialized));
            }, JSON.stringify(json));
            if (value === true) {
              await expect(paragraph).toHaveAttribute('data-reviewed', 'true');
              await expect(frame.locator('#json')).toHaveValue(
                /"reviewed": true/,
              );
            } else {
              await expect(paragraph).not.toHaveAttribute('data-reviewed');
              await expect(frame.locator('#json')).not.toHaveValue(
                /"reviewed"/,
              );
            }
          }
          process.stdout.write(
            'PASS NodeState: toggle, clone, boolean JSON validation, HTML export/import\n',
          );
          const disposed = await editor.evaluate(element => {
            const instance = element.__lexicalEditor;
            const doc = element.ownerDocument;
            instance.dispose();
            const htmlInput = doc.getElementById('html');
            htmlInput.value = 'Unchanged after disposal';
            const pointerEvent = new MouseEvent('mousedown', {
              cancelable: true,
            });
            doc.getElementById('toggle-reviewed').dispatchEvent(pointerEvent);
            doc.getElementById('export-html').click();
            return {
              html: htmlInput.value,
              prevented: pointerEvent.defaultPrevented,
            };
          });
          assert.deepEqual(disposed, {
            html: 'Unchanged after disposal',
            prevented: false,
          });
          process.stdout.write(
            'PASS NodeState: editor disposal removes toolbar handlers\n',
          );
        }
        // Focus the document again before checking the next lazy-loaded demo.
        await page.locator('h1').click();
        process.stdout.write(
          `PASS ${example}: hosted editor, typing, StackBlitz link\n`,
        );
      }
    }
    const prefixedURL = `http://127.0.0.1:${prefixedServer.address().port}/lexical`;
    for (const example of Object.keys(FILES)) {
      await page.goto(`${prefixedURL}/examples/${example}/?embed`);
      await expect(page.locator('[contenteditable="true"]')).toBeVisible();
      if (example.startsWith('react-')) {
        // StackBlitz also uses an iframe, but does not opt out with ?embed.
        await page.setContent(
          `<iframe src="${prefixedURL}/examples/${example}/"></iframe>`,
        );
        await expect(page.locator('iframe')).toBeFocused();
        await expect(
          page.frameLocator('iframe').locator('[contenteditable="true"]'),
        ).toBeFocused();
      }
    }
    process.stdout.write(
      'PASS examples: non-root base path, autofocus in preview iframes\n',
    );
    assert.deepEqual(errors, [], 'Documentation demos must not throw');
    assert.deepEqual(
      stackblitzRequests,
      [],
      'Reading the docs must not load StackBlitz',
    );
    process.stdout.write(
      'PASS getting started examples: no runtime errors or StackBlitz requests\n',
    );
  } finally {
    if (errors.length > 0) {
      console.error('Browser errors:', errors);
    }
    await browser.close();
    server.close();
    prefixedServer.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
