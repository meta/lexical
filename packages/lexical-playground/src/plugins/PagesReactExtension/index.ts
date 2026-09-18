/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {ReactExtension} from '@lexical/react/ReactExtension';
import {defineExtension} from 'lexical';

import {PagesExtension} from '../PagesExtension';
import {PageSetupDropdownComponent} from './PageSetupDropdown';

export {
  PageSetupDropdownComponent,
  type PageSetupDropdownProps,
} from './PageSetupDropdown';

export const PagesReactExtension = defineExtension({
  build: () => ({Component: PageSetupDropdownComponent}),
  dependencies: [ReactExtension, PagesExtension],
  name: '@lexical/playground/PagesReact',
});
