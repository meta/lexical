/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  E2E_BROWSER,
  IS_MAC,
  keyDownCtrlOrAlt,
  keyDownCtrlOrMeta,
  keyUpCtrlOrAlt,
  keyUpCtrlOrMeta,
  sleep,
} from '../utils/index.mjs';

/**
 * A delay value that is short enough yet not too short such that keypresses override each other.
 */
export const STANDARD_KEYPRESS_DELAY_MS = 100;

export async function moveToLineBeginning(page) {
  if (IS_MAC) {
    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('ArrowLeft');
    await keyUpCtrlOrMeta(page);
  } else {
    await page.keyboard.press('Home');
  }
}

export async function moveToLineEnd(page) {
  if (IS_MAC) {
    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('ArrowRight');
    await keyUpCtrlOrMeta(page);
  } else {
    await page.keyboard.press('End');
  }
}

export async function moveToEditorBeginning(page) {
  if (IS_MAC) {
    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('ArrowUp');
    await keyUpCtrlOrMeta(page);
  } else {
    await page.keyboard.press('PageUp');
    if (E2E_BROWSER === 'firefox') {
      await page.keyboard.press('Home');
    }
  }
}

export async function moveToEditorEnd(page) {
  if (IS_MAC) {
    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('ArrowDown');
    await keyUpCtrlOrMeta(page);
  } else {
    await page.keyboard.press('PageDown');
    if (E2E_BROWSER === 'firefox') {
      await page.keyboard.press('End');
    }
  }
}

export async function moveToPrevWord(page) {
  await keyDownCtrlOrAlt(page);
  await page.keyboard.press('ArrowLeft');
  await keyUpCtrlOrAlt(page);
}

export async function selectPrevWord(page) {
  await keyDownCtrlOrAlt(page);
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowLeft');
  await keyUpCtrlOrAlt(page);
  await page.keyboard.up('Shift');
}

export async function moveToNextWord(page) {
  await keyDownCtrlOrAlt(page);
  await page.keyboard.press('ArrowRight');
  await keyUpCtrlOrAlt(page);
}

export async function extendToNextWord(page) {
  await page.keyboard.down('Shift');
  await keyDownCtrlOrAlt(page);
  await page.keyboard.press('ArrowRight');
  await keyUpCtrlOrAlt(page);
  await page.keyboard.up('Shift');
}

export async function deleteNextWord(page) {
  await keyDownCtrlOrAlt(page);
  await page.keyboard.press('Delete');
  await keyUpCtrlOrAlt(page);
}

export async function deleteLineBackward(page) {
  if (!IS_MAC) {
    throw new Error('deleteLineBackward is only supported on Mac');
  }
  await page.keyboard.down('Meta');
  await page.keyboard.press('Backspace');
  await page.keyboard.up('Meta');
}

export async function deleteLineForward(page) {
  if (!IS_MAC) {
    throw new Error('deleteLineForward is only supported on Mac');
  }
  await page.keyboard.down('Meta');
  await page.keyboard.press('Delete');
  await page.keyboard.up('Meta');
}

export async function deleteBackward(page) {
  if (IS_MAC) {
    await page.keyboard.down('Control');
    await page.keyboard.press('h');
    await page.keyboard.up('Control');
  } else {
    await page.keyboard.press('Backspace');
  }
}

export async function deleteForward(page) {
  if (IS_MAC) {
    await page.keyboard.down('Control');
    await page.keyboard.press('d');
    await page.keyboard.up('Control');
  } else {
    await page.keyboard.press('Delete');
  }
}

export async function moveToParagraphBeginning(page) {
  if (IS_MAC) {
    await keyDownCtrlOrAlt(page);
    await page.keyboard.press('ArrowUp');
    await keyUpCtrlOrAlt(page);
  } else {
    await page.keyboard.press('Home');
  }
}

export async function moveToParagraphEnd(page) {
  if (IS_MAC) {
    await keyDownCtrlOrAlt(page);
    await page.keyboard.press('ArrowDown');
    await keyUpCtrlOrMeta(page);
  } else {
    await page.keyboard.press('End');
  }
}

export async function selectAll(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.press('a');
  await keyUpCtrlOrMeta(page);
}

export async function undo(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.press('z');
  await keyUpCtrlOrMeta(page);
}

export async function redo(page) {
  if (IS_MAC) {
    await page.keyboard.down('Meta');
    await page.keyboard.down('Shift');
    await page.keyboard.press('z');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Meta');
  } else {
    await page.keyboard.down('Control');
    await page.keyboard.press('y');
    await page.keyboard.up('Control');
  }
}

export async function moveLeft(page, numCharacters = 1, delayMs) {
  for (let i = 0; i < numCharacters; i++) {
    if (delayMs !== undefined) {
      await sleep(delayMs);
    }
    await page.keyboard.press('ArrowLeft');
  }
}

export async function moveRight(page, numCharacters = 1, delayMs) {
  for (let i = 0; i < numCharacters; i++) {
    if (delayMs !== undefined) {
      await sleep(delayMs);
    }
    await page.keyboard.press('ArrowRight');
  }
}

export async function moveUp(page, numCharacters = 1, delayMs) {
  for (let i = 0; i < numCharacters; i++) {
    if (delayMs !== undefined) {
      await sleep(delayMs);
    }
    await page.keyboard.press('ArrowUp');
  }
}

export async function moveDown(page, numCharacters = 1, delayMs) {
  for (let i = 0; i < numCharacters; i++) {
    if (delayMs !== undefined) {
      await sleep(delayMs);
    }
    await page.keyboard.press('ArrowDown');
  }
}

export async function pressBackspace(page, numCharacters = 1, delayMs) {
  for (let i = 0; i < numCharacters; i++) {
    if (delayMs !== undefined) {
      await sleep(delayMs);
    }
    await page.keyboard.press('Backspace');
  }
}

export async function selectCharacters(page, direction, numCharacters = 1) {
  const moveFunction = direction === 'left' ? moveLeft : moveRight;
  await page.keyboard.down('Shift');
  await moveFunction(page, numCharacters);
  await page.keyboard.up('Shift');
}

export async function toggleBold(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.press('b');
  await keyUpCtrlOrMeta(page);
}

export async function toggleUnderline(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.press('u');
  await keyUpCtrlOrMeta(page);
}

export async function toggleItalic(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.press('i');
  await keyUpCtrlOrMeta(page);
}

export async function toggleInsertCodeBlock(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Shift');
  await page.keyboard.press('c');
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Shift');
}

export async function toggleLowercase(page) {
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press('1');
  await page.keyboard.up('Control');
  await page.keyboard.up('Shift');
}

export async function toggleUppercase(page) {
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press('2');
  await page.keyboard.up('Control');
  await page.keyboard.up('Shift');
}

export async function toggleCapitalize(page) {
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press('3');
  await page.keyboard.up('Control');
  await page.keyboard.up('Shift');
}

export async function toggleStrikethrough(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Shift');
  await page.keyboard.press('x');
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Shift');
}

export async function pressShiftEnter(page) {
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
}

export async function moveToStart(page) {
  if (IS_MAC) {
    await page.keyboard.down('Meta');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Meta');
  } else {
    await page.keyboard.press('Home');
  }
}

export async function moveToEnd(page) {
  if (IS_MAC) {
    await page.keyboard.down('Meta');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Meta');
  } else {
    await page.keyboard.press('End');
  }
}

export async function paste(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.press('KeyV');
  await keyUpCtrlOrMeta(page);
}

export async function toggleSubscript(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.press(',');
  await keyUpCtrlOrMeta(page);
}

export async function toggleSuperscript(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.press('.');
  await keyUpCtrlOrMeta(page);
}

export async function clearFormatting(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.press('\\');
  await keyUpCtrlOrMeta(page);
}

export async function leftAlign(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Shift');
  await page.keyboard.press('l');
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Shift');
}

export async function centerAlign(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Shift');
  await page.keyboard.press('e');
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Shift');
}

export async function rightAlign(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Shift');
  await page.keyboard.press('r');
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Shift');
}

export async function justifyAlign(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Shift');
  await page.keyboard.press('j');
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Shift');
}

export async function outdent(page, times = 1) {
  for (let i = 0; i < times; i++) {
    await keyDownCtrlOrMeta(page);
    await page.keyboard.press('[');
    await keyUpCtrlOrMeta(page);
  }
}

export async function indent(page, times = 1) {
  for (let i = 0; i < times; i++) {
    await keyDownCtrlOrMeta(page);
    await page.keyboard.press(']');
    await keyUpCtrlOrMeta(page);
  }
}

export async function applyNormalFormat(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Alt');
  await page.keyboard.press('0');
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Alt');
}

export async function applyHeading(page, level) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Alt');
  await page.keyboard.press(level.toString());
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Alt');
}

export async function toggleNumberedList(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Shift');
  await page.keyboard.press('7');
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Shift');
}

export async function toggleBulletList(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Shift');
  await page.keyboard.press('8');
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Shift');
}

export async function toggleChecklist(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Shift');
  await page.keyboard.press('9');
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Shift');
}

export async function applyQuoteBlock(page) {
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press('q');
  await page.keyboard.up('Control');
  await page.keyboard.up('Shift');
}

export async function applyCodeBlock(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Alt');
  await page.keyboard.press('c');
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Alt');
}

export async function increaseFontSize(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Shift');
  // shift + '.' becomes '>' on US keyboard layout. See https://keycode.info/
  await page.keyboard.press('>');
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Shift');
}

export async function decreaseFontSize(page) {
  await keyDownCtrlOrMeta(page);
  await page.keyboard.down('Shift');
  // shift + ',' becomes '<' on US keyboard layout. See https://keycode.info/
  await page.keyboard.press('<');
  await keyUpCtrlOrMeta(page);
  await page.keyboard.up('Shift');
}
