/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node

import {buildEditorFromExtensions} from '@lexical/extension';
import {createEditor, defineExtension, LexicalWarning} from 'lexical';
import {describe, expect, test} from 'vitest';

describe('LexicalWarning', () => {
  test('is an Error with a code and data', () => {
    const warning = new LexicalWarning('@example/pkg/thing', 'a thing', {
      n: 1,
    });
    expect(warning).toBeInstanceOf(Error);
    expect(warning).toBeInstanceOf(LexicalWarning);
    expect(warning.name).toBe('LexicalWarning');
    expect(warning.message).toBe('a thing');
    expect(warning.code).toBe('@example/pkg/thing');
    expect(warning.data).toEqual({n: 1});
    expect(String(warning)).toBe('LexicalWarning: a thing');
    expect(new LexicalWarning('@example/pkg/other', 'no data').data).toBe(
      undefined,
    );
  });

  test('accepts any code (a switch needs a default branch)', () => {
    const describeCode = (code: string): string => {
      switch (code) {
        case '@example/pkg/known':
          return 'known';
        default:
          return 'other';
      }
    };
    expect(
      describeCode(new LexicalWarning('@example/pkg/known', '').code),
    ).toBe('known');
    expect(describeCode('@example/pkg/new-code')).toBe('other');
  });

  test("is passed to the editor's onWarn as it is", () => {
    const seen: Error[] = [];
    const editor = createEditor({onWarn: error => seen.push(error)});
    const warning = new LexicalWarning('@example/pkg/thing', 'a thing');
    editor._onWarn(warning);
    expect(seen).toEqual([warning]);
    expect(seen[0]).toBe(warning);

    const fromExtension: [Error, unknown][] = [];
    const built = buildEditorFromExtensions(
      defineExtension({
        name: '@example/app',
        onWarn: (error, ed) => fromExtension.push([error, ed]),
      }),
    );
    built._onWarn(warning);
    expect(fromExtension).toEqual([[warning, built]]);
    built.dispose();
  });
});
