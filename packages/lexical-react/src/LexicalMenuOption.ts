/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX, RefObject} from 'react';

/**
 * The base class for an item shown in a {@link LexicalTypeaheadMenuPlugin} or
 * {@link LexicalNodeMenuPlugin} menu. Each option has a unique `key` and a `ref`
 * to its rendered element (used for scrolling and keyboard navigation).
 * Subclass it to attach your own data such as a label or callback.
 *
 * Its own module, and not `shared/LexicalMenu`, because that module is not an
 * entry point: it is inlined into every entry that reaches it, which would give
 * each of them a different `MenuOption` class. Its own module rather than one
 * of the plugin entry points, because those export React components — anything
 * importing this from one of them sits behind that component's Fast Refresh
 * boundary and is invalidated whenever the component changes.
 */
export class MenuOption {
  key: string;
  ref?: RefObject<HTMLElement | null>;
  icon?: JSX.Element;
  title?: JSX.Element | string;

  constructor(key: string) {
    this.key = key;
    this.ref = {current: null};
    this.setRefElement = this.setRefElement.bind(this);
  }

  setRefElement(element: HTMLElement | null) {
    this.ref = {current: element};
  }
}
