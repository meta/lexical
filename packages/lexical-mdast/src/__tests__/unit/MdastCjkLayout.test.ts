/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {configExtension, defineExtension} from 'lexical';
import {gfmStrikethrough} from 'micromark-extension-gfm-strikethrough';
import {expect, it, onTestFinished, vi} from 'vitest';

import {$convertFromMarkdownString, MdastExtension} from '../../index';

// The first CJK-friendly import a module builds checks, in development, that
// micromark reads the text beside a marker as the import expects, and warns
// where it does not, so this runs in a file of its own.
it('builds a CJK-friendly import without a layout warning', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  onTestFinished(() => warn.mockRestore());
  // With a strikethrough of its own, which reads `~` as micromark does and
  // which the check leaves out.
  const editor = buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        configExtension(MdastExtension, {
          micromarkExtensions: [gfmStrikethrough()],
        }),
      ],
      name: '[test]',
    }),
  );
  onTestFinished(() => editor.dispose());
  // The other inputs put a marker beside a tab or a NUL, which micromark
  // reads as codes of their own, so the import classifies the code itself
  // and does not slice the text around it.
  for (const markdown of [
    'Hello**🎉 launch**',
    'a\t**x**',
    'a\0**x**',
    '**x**\t',
    '**x**\0',
  ]) {
    editor.update(() => $convertFromMarkdownString(markdown), {
      discrete: true,
    });
  }
  expect(warn).not.toHaveBeenCalled();
});
