/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {TabIndentationExtension} from '@lexical/extension';
import {RichTextExtension} from '@lexical/rich-text';
import {test} from 'vitest';

import {ShortcutsExtension} from '../../plugins/ShortcutsExtension';
import {
  assertHTML,
  assertSelection,
  html,
  press,
  setupEditor,
  typeText,
} from './utils';

const toggleLowercase = () => press('Control+Shift+1');
const toggleUppercase = () => press('Control+Shift+2');
const toggleCapitalize = () => press('Control+Shift+3');

test(`Can create italic text using the shortcut`, async () => {
  const {root} = setupEditor([
    RichTextExtension,
    ShortcutsExtension,
    TabIndentationExtension,
  ]);
  await typeText('Hello');
  await press('ControlOrMeta+i');
  await typeText(' World');
  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Hello</span>
        <em class="PlaygroundEditorTheme__textItalic" data-lexical-text="true">
          World
        </em>
      </p>
    `,
  );
  await assertSelection(root, {
    anchorOffset: 6,
    anchorPath: [0, 1, 0],
    focusOffset: 6,
    focusPath: [0, 1, 0],
  });

  await press('ControlOrMeta+i');
  await typeText('!');
  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Hello</span>
        <em class="PlaygroundEditorTheme__textItalic" data-lexical-text="true">
          World
        </em>
        <span data-lexical-text="true">!</span>
      </p>
    `,
  );
  await assertSelection(root, {
    anchorOffset: 1,
    anchorPath: [0, 2, 0],
    focusOffset: 1,
    focusPath: [0, 2, 0],
  });
});
test(`Can select text and boldify it with the shortcut`, async () => {
  const {root} = setupEditor([
    RichTextExtension,
    ShortcutsExtension,
    TabIndentationExtension,
  ]);
  await typeText('Hello world!');
  await press('ArrowLeft');
  await press('Shift+ArrowLeft', 5);
  await assertSelection(root, {
    anchorOffset: 11,
    anchorPath: [0, 0, 0],
    focusOffset: 6,
    focusPath: [0, 0, 0],
  });

  await press('ControlOrMeta+b');
  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Hello</span>
        <strong
          class="PlaygroundEditorTheme__textBold"
          data-lexical-text="true">
          world
        </strong>
        <span data-lexical-text="true">!</span>
      </p>
    `,
  );
  await assertSelection(root, {
    anchorOffset: 5,
    anchorPath: [0, 1, 0],
    focusOffset: 0,
    focusPath: [0, 1, 0],
  });

  await press('ControlOrMeta+b');
  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Hello world!</span>
      </p>
    `,
  );
  await assertSelection(root, {
    anchorOffset: 11,
    anchorPath: [0, 0, 0],
    focusOffset: 6,
    focusPath: [0, 0, 0],
  });
});
test(`Can select text and italicify it with the shortcut`, async () => {
  const {root} = setupEditor([
    RichTextExtension,
    ShortcutsExtension,
    TabIndentationExtension,
  ]);
  await typeText('Hello world!');
  await press('ArrowLeft');
  await press('Shift+ArrowLeft', 5);
  await assertSelection(root, {
    anchorOffset: 11,
    anchorPath: [0, 0, 0],
    focusOffset: 6,
    focusPath: [0, 0, 0],
  });

  await press('ControlOrMeta+i');
  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Hello</span>
        <em class="PlaygroundEditorTheme__textItalic" data-lexical-text="true">
          world
        </em>
        <span data-lexical-text="true">!</span>
      </p>
    `,
  );
  await assertSelection(root, {
    anchorOffset: 5,
    anchorPath: [0, 1, 0],
    focusOffset: 0,
    focusPath: [0, 1, 0],
  });

  await press('ControlOrMeta+i');
  await assertHTML(
    root,
    html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">Hello world!</span>
      </p>
    `,
  );
  await assertSelection(root, {
    anchorOffset: 11,
    anchorPath: [0, 0, 0],
    focusOffset: 6,
    focusPath: [0, 0, 0],
  });
});
const capitalizationFormats = [
  {
    applyCapitalization: toggleLowercase,
    className: 'PlaygroundEditorTheme__textLowercase',
    format: 'lowercase',
  },
  {
    applyCapitalization: toggleUppercase,
    className: 'PlaygroundEditorTheme__textUppercase',
    format: 'uppercase',
  },
  {
    applyCapitalization: toggleCapitalize,
    className: 'PlaygroundEditorTheme__textCapitalize',
    format: 'capitalize',
  },
];
capitalizationFormats.forEach(({className, format, applyCapitalization}) => {
  test(`Can select text and change it to ${format}`, async () => {
    const {root} = setupEditor([
      RichTextExtension,
      ShortcutsExtension,
      TabIndentationExtension,
    ]);
    await typeText('Hello world!');
    await press('ArrowLeft');
    await press('Shift+ArrowLeft', 5);

    await assertSelection(root, {
      anchorOffset: 11,
      anchorPath: [0, 0, 0],
      focusOffset: 6,
      focusPath: [0, 0, 0],
    });

    await applyCapitalization();
    await assertHTML(
      root,
      html`
        <p class="PlaygroundEditorTheme__paragraph" dir="auto">
          <span data-lexical-text="true">Hello</span>
          <span class="${className}" data-lexical-text="true">world</span>
          <span data-lexical-text="true">!</span>
        </p>
      `,
    );

    await assertSelection(root, {
      anchorOffset: 5,
      anchorPath: [0, 1, 0],
      focusOffset: 0,
      focusPath: [0, 1, 0],
    });
  });
});
const capitalizationResettingTestCases = [
  {
    expectedFinalHTML: html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span class="$formatClassName" data-lexical-text="true">Hello</span>
        <span data-lexical-text="true">world!</span>
      </p>
    `,
    key: 'Space',
  },
  {
    expectedFinalHTML: html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span class="$formatClassName" data-lexical-text="true">Hello</span>
        <span
          class="PlaygroundEditorTheme__tabNode"
          data-lexical-text="true"></span>
        <span data-lexical-text="true">world!</span>
      </p>
    `,
    key: 'Tab',
  },
  {
    expectedFinalHTML: html`
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span class="$formatClassName" data-lexical-text="true">Hello</span>
      </p>
      <p class="PlaygroundEditorTheme__paragraph" dir="auto">
        <span data-lexical-text="true">world!</span>
      </p>
    `,
    key: 'Enter',
  },
];
capitalizationFormats.forEach(({format, className, applyCapitalization}) => {
  capitalizationResettingTestCases.forEach(({key, expectedFinalHTML}) => {
    test(`Pressing ${key} resets ${format} format`, async () => {
      const {root} = setupEditor([
        RichTextExtension,
        ShortcutsExtension,
        TabIndentationExtension,
      ]);

      await applyCapitalization();
      await typeText('Hello');

      await assertHTML(
        root,
        html`
          <p class="PlaygroundEditorTheme__paragraph" dir="auto">
            <span class="${className}" data-lexical-text="true">Hello</span>
          </p>
        `,
      );

      // Pressing the key should reset the format
      await press(key);
      await typeText(' world!');

      await assertHTML(
        root,
        expectedFinalHTML.replace('$formatClassName', className),
      );
    });
  });
});
