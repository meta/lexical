/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  defineExtension,
  FOCUS_COMMAND,
} from 'lexical';

const TAB_TO_FOCUS_INTERVAL = 100;

let lastTabKeyDownTimestamp = 0;
let hasRegisteredKeyDownListener = false;

function registerKeyTimeStampTracker() {
  window.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      // Tab
      if (event.key === 'Tab') {
        lastTabKeyDownTimestamp = event.timeStamp;
      }
    },
    true,
  );
}

export const TabFocusExtension = defineExtension({
  name: '@lexical/playground/TabFocus',
  register: editor => {
    if (!hasRegisteredKeyDownListener) {
      registerKeyTimeStampTracker();
      hasRegisteredKeyDownListener = true;
    }

    return editor.registerCommand(
      FOCUS_COMMAND,
      (event: FocusEvent) => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          if (
            lastTabKeyDownTimestamp + TAB_TO_FOCUS_INTERVAL >
            event.timeStamp
          ) {
            $setSelection(selection.clone());
          }
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
  },
});
