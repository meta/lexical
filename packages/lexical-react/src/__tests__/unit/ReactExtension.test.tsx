/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

// @vitest-environment node
import {buildEditorFromExtensions} from '@lexical/extension';
import {ReactExtension} from '@lexical/react/ReactExtension';
import {ReactPluginHostExtension} from '@lexical/react/ReactPluginHostExtension';
import {describe, expect, it} from 'vitest';

describe('ReactExtension', () => {
  it('Requires a provider', () => {
    expect(() =>
      buildEditorFromExtensions({
        dependencies: [ReactExtension],
        name: '[root]',
      }),
    ).toThrow(
      'No ReactProviderExtension detected. You must use ReactPluginHostExtension or LexicalExtensionComposer to host React extensions. The following extensions depend on ReactExtension: [root]',
    );
  });
  it('Succeeds with a provider', () => {
    expect(
      buildEditorFromExtensions({
        dependencies: [ReactExtension, ReactPluginHostExtension],
        name: '[root]',
      }),
    ).toBeDefined();
  });
});
