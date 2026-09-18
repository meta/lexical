/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$isCodeNode} from '@lexical/code';
import {
  autoLinkEmailMatcher,
  AutoLinkExtension,
  autoLinkUrlMatcher,
} from '@lexical/link';
import {configExtension} from 'lexical';

export const PlaygroundAutoLinkExtension = configExtension(AutoLinkExtension, {
  excludeParents: [$isCodeNode],
  matchers: [autoLinkUrlMatcher, autoLinkEmailMatcher],
});
