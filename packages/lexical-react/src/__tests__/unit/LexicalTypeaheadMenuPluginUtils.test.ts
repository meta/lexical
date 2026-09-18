/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {MenuOption as MenuOptionFromModule} from '@lexical/react/LexicalMenuOption';
import {MenuOption as MenuOptionFromNodeMenu} from '@lexical/react/LexicalNodeMenuPlugin';
import {
  MenuOption as MenuOptionFromTypeahead,
  SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND as fromPlugin,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';
import {SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND as fromUtils} from '@lexical/react/LexicalTypeaheadMenuPluginUtils';
import {describe, expect, test} from 'vitest';

import {
  MenuOption as MenuOptionFromShared,
  SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND as fromMenu,
} from '../../shared/LexicalMenu';

describe('SCROLL_TYPEAHEAD_OPTION_INTO_VIEW_COMMAND', () => {
  test('is one command, whichever module it is reached through', () => {
    // Commands are matched by object identity, so the command a consumer
    // dispatches has to be the very one the menu registers its handler
    // against — a second `createCommand` with the same name is a different
    // command that no handler will ever see.
    expect(fromPlugin).toBe(fromUtils);
    expect(fromMenu).toBe(fromUtils);
  });
});

describe('MenuOption', () => {
  test('is one class, whichever module it is reached through', () => {
    // The menu machinery and its consumers have to agree on the class, or an
    // `instanceof` — anyone's, now or later — silently answers false.
    expect(MenuOptionFromNodeMenu).toBe(MenuOptionFromModule);
    expect(MenuOptionFromTypeahead).toBe(MenuOptionFromModule);
    expect(MenuOptionFromShared).toBe(MenuOptionFromModule);
  });
});
