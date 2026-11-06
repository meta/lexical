/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {PlainTextExtension} from '@lexical/plain-text';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  defineExtension,
  IS_APPLE,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, test} from 'vitest';
import {server} from 'vitest/browser';

import {EmojiNode} from '../../nodes/EmojiNode';
import {EmojisExtension} from '../../plugins/EmojisExtension';
import {assertSelection, press, setupEditor, typeText} from './utils';

const browserName = server.browser;
const IS_WINDOWS = /Win/.test(navigator.platform);
const emojiExtension = defineExtension({
  dependencies: [EmojisExtension],
  name: '[navigation-emoji]',
  nodes: () => [EmojiNode],
});
const paragraphs = [
  'Lorem Ipsum is simply dummy text of the printing and typesetting industry.',
  'It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. ',
  'It was popularised in the 1960s with the release of Letraset sheets containing lorem ipsum passages.',
];
// Typing across paragraph boundaries only needs a few words. Keep the longer
// fixture above for the line/word navigation tests that initialize it directly.
const typedParagraphs = [
  'First paragraph.',
  'Second paragraph.',
  'Third paragraph.',
];
async function setupParagraphs(
  editor: LexicalEditor,
  isRichText: boolean,
  type: boolean,
) {
  if (type) {
    for (const [i, text] of typedParagraphs.entries()) {
      if (i > 0) await press('Enter');
      await typeText(text);
    }
  } else {
    editor.update(
      () => {
        const root = $getRoot().clear();
        if (isRichText) {
          for (const text of paragraphs)
            root.append($createParagraphNode().append($createTextNode(text)));
        } else {
          const paragraph = $createParagraphNode();
          for (const [i, text] of paragraphs.entries()) {
            if (i > 0) paragraph.append($createLineBreakNode());
            paragraph.append($createTextNode(text));
          }
          root.append(paragraph);
        }
        root.selectEnd();
      },
      {discrete: true},
    );
  }
}
const moveToLineBeginning = () => press(IS_APPLE ? 'Meta+ArrowLeft' : 'Home');
const moveToLineEnd = () => press(IS_APPLE ? 'Meta+ArrowRight' : 'End');
async function moveToEditorBeginning() {
  await press(IS_APPLE ? 'Meta+ArrowUp' : 'PageUp');
  if (!IS_APPLE && browserName === 'firefox') await press('Home');
}
async function moveToEditorEnd() {
  await press(IS_APPLE ? 'Meta+ArrowDown' : 'PageDown');
  if (!IS_APPLE && browserName === 'firefox') await press('End');
}
const moveToPrevWord = () =>
  press(IS_APPLE ? 'Alt+ArrowLeft' : 'Control+ArrowLeft');
const moveToNextWord = () =>
  press(IS_APPLE ? 'Alt+ArrowRight' : 'Control+ArrowRight');
const moveToParagraphBeginning = () => press(IS_APPLE ? 'Alt+ArrowUp' : 'Home');
const moveToParagraphEnd = () => press(IS_APPLE ? 'Alt+ArrowDown' : 'End');
const selectCharacters = (direction: 'left' | 'right', count = 1) =>
  press(direction === 'left' ? 'Shift+ArrowLeft' : 'Shift+ArrowRight', count);
const toggleBold = () => press('ControlOrMeta+b');

describe.each([true, false])(
  'native navigation (rich text: %s)',
  isRichText => {
    test('can type several paragraphs', async () => {
      const {editor, root} = setupEditor([
        isRichText ? RichTextExtension : PlainTextExtension,
        emojiExtension,
      ]);
      // Keep each sample line unwrapped so line navigation is independent of viewport size.
      root.style.width = '1400px';
      root.style.font = '15px Arial';

      await setupParagraphs(editor, isRichText, true);
      if (isRichText) {
        await assertSelection(root, {
          anchorOffset: 16,
          anchorPath: [2, 0, 0],
          focusOffset: 16,
          focusPath: [2, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 16,
          anchorPath: [0, 4, 0],
          focusOffset: 16,
          focusPath: [0, 4, 0],
        });
      }
      expect(
        Array.from(
          root.querySelectorAll('[data-lexical-text]'),
          element => element.textContent,
        ),
      ).toEqual(typedParagraphs);
    });
    test('can move to the beginning of the current line, then back to the end of the current line', async () => {
      const {editor, root} = setupEditor([
        isRichText ? RichTextExtension : PlainTextExtension,
        emojiExtension,
      ]);
      // Keep each sample line unwrapped so line navigation is independent of viewport size.
      root.style.width = '1400px';
      root.style.font = '15px Arial';

      await setupParagraphs(editor, isRichText, false);
      await moveToLineBeginning();
      if (isRichText) {
        await assertSelection(root, {
          anchorOffset: 0,
          anchorPath: [2, 0, 0],
          focusOffset: 0,
          focusPath: [2, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 0,
          anchorPath: [0, 4, 0],
          focusOffset: 0,
          focusPath: [0, 4, 0],
        });
      }
      await moveToLineEnd();
      if (isRichText) {
        await assertSelection(root, {
          anchorOffset: 100,
          anchorPath: [2, 0, 0],
          focusOffset: 100,
          focusPath: [2, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 100,
          anchorPath: [0, 4, 0],
          focusOffset: 100,
          focusPath: [0, 4, 0],
        });
      }
    });
    test('can move to the top of the editor', async () => {
      const {editor, root} = setupEditor([
        isRichText ? RichTextExtension : PlainTextExtension,
        emojiExtension,
      ]);
      // Keep each sample line unwrapped so line navigation is independent of viewport size.
      root.style.width = '1400px';
      root.style.font = '15px Arial';

      await setupParagraphs(editor, isRichText, false);
      await moveToEditorBeginning();
      await assertSelection(root, {
        anchorOffset: 0,
        anchorPath: [0, 0, 0],
        focusOffset: 0,
        focusPath: [0, 0, 0],
      });
    });
    test('can move one word to the right', async () => {
      const {editor, root} = setupEditor([
        isRichText ? RichTextExtension : PlainTextExtension,
        emojiExtension,
      ]);
      // Keep each sample line unwrapped so line navigation is independent of viewport size.
      root.style.width = '1400px';
      root.style.font = '15px Arial';

      await setupParagraphs(editor, isRichText, false);
      await moveToEditorBeginning();
      await moveToNextWord();
      if (browserName === 'firefox') {
        if (IS_WINDOWS) {
          await assertSelection(root, {
            anchorOffset: 6,
            anchorPath: [0, 0, 0],
            focusOffset: 6,
            focusPath: [0, 0, 0],
          });
        } else {
          await assertSelection(root, {
            anchorOffset: 5,
            anchorPath: [0, 0, 0],
            focusOffset: 5,
            focusPath: [0, 0, 0],
          });
        }
      } else if (!IS_WINDOWS) {
        await assertSelection(root, {
          anchorOffset: 5,
          anchorPath: [0, 0, 0],
          focusOffset: 5,
          focusPath: [0, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 6,
          anchorPath: [0, 0, 0],
          focusOffset: 6,
          focusPath: [0, 0, 0],
        });
      }
    });
    test('can move to the beginning of the previous word', async () => {
      const {editor, root} = setupEditor([
        isRichText ? RichTextExtension : PlainTextExtension,
        emojiExtension,
      ]);
      // Keep each sample line unwrapped so line navigation is independent of viewport size.
      root.style.width = '1400px';
      root.style.font = '15px Arial';

      await setupParagraphs(editor, isRichText, false);
      await moveToPrevWord();
      // Chrome stops words on punctuation, so we need to trigger
      // the left arrow key one more time.
      if (browserName === 'chromium') {
        await moveToPrevWord();
      }
      if (isRichText) {
        await assertSelection(root, {
          anchorOffset: 91,
          anchorPath: [2, 0, 0],
          focusOffset: 91,
          focusPath: [2, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 91,
          anchorPath: [0, 4, 0],
          focusOffset: 91,
          focusPath: [0, 4, 0],
        });
      }
      await moveToPrevWord();
      if (isRichText) {
        await assertSelection(root, {
          anchorOffset: 85,
          anchorPath: [2, 0, 0],
          focusOffset: 85,
          focusPath: [2, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 85,
          anchorPath: [0, 4, 0],
          focusOffset: 85,
          focusPath: [0, 4, 0],
        });
      }
    });
    test('can move to the bottom of the editor', async () => {
      const {editor, root} = setupEditor([
        isRichText ? RichTextExtension : PlainTextExtension,
        emojiExtension,
      ]);
      // Keep each sample line unwrapped so line navigation is independent of viewport size.
      root.style.width = '1400px';
      root.style.font = '15px Arial';

      await setupParagraphs(editor, isRichText, false);
      await moveToEditorBeginning();
      await moveToEditorEnd();
      if (isRichText) {
        await assertSelection(root, {
          anchorOffset: 100,
          anchorPath: [2, 0, 0],
          focusOffset: 100,
          focusPath: [2, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 100,
          anchorPath: [0, 4, 0],
          focusOffset: 100,
          focusPath: [0, 4, 0],
        });
      }
    });
    test('can move to the beginning of the current paragraph', async () => {
      const {editor, root} = setupEditor([
        isRichText ? RichTextExtension : PlainTextExtension,
        emojiExtension,
      ]);
      // Keep each sample line unwrapped so line navigation is independent of viewport size.
      root.style.width = '1400px';
      root.style.font = '15px Arial';

      await setupParagraphs(editor, isRichText, false);
      await moveToParagraphBeginning();
      if (!isRichText && IS_APPLE && browserName === 'firefox') {
        // Firefox on macOS represents this line boundary on the containing
        // paragraph, immediately before its last text span.
        await assertSelection(root, {
          anchorOffset: 4,
          anchorPath: [0],
          focusOffset: 4,
          focusPath: [0],
        });
      } else if (isRichText) {
        await assertSelection(root, {
          anchorOffset: 0,
          anchorPath: [2, 0, 0],
          focusOffset: 0,
          focusPath: [2, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 0,
          anchorPath: [0, 4, 0],
          focusOffset: 0,
          focusPath: [0, 4, 0],
        });
      }
    });
    test('can move to the top of the editor, then to the bottom of the current paragraph', async () => {
      const {editor, root} = setupEditor([
        isRichText ? RichTextExtension : PlainTextExtension,
        emojiExtension,
      ]);
      // Keep each sample line unwrapped so line navigation is independent of viewport size.
      root.style.width = '1400px';
      root.style.font = '15px Arial';

      await setupParagraphs(editor, isRichText, false);
      await moveToEditorBeginning();
      await moveToParagraphEnd();
      if (!isRichText && IS_APPLE && browserName === 'firefox') {
        // Equivalent to the end of the first span, immediately before <br>.
        await assertSelection(root, {
          anchorOffset: 1,
          anchorPath: [0],
          focusOffset: 1,
          focusPath: [0],
        });
      } else
        await assertSelection(root, {
          // Due to text rendering it can be in this range of offsets
          anchorOffset: [65, 74],

          anchorPath: [0, 0, 0],
          // Due to text rendering it can be in this range of offsets
          focusOffset: [65, 74],

          focusPath: [0, 0, 0],
        });
    });
    test('can navigate through the plain text word by word', async () => {
      const {root} = setupEditor([
        isRichText ? RichTextExtension : PlainTextExtension,
        emojiExtension,
      ]);
      // Keep each sample line unwrapped so line navigation is independent of viewport size.
      root.style.width = '1400px';
      root.style.font = '15px Arial';

      // type sample text
      await typeText('  123 abc 456  def  ');
      await assertSelection(root, {
        anchorOffset: 20,
        anchorPath: [0, 0, 0],
        focusOffset: 20,
        focusPath: [0, 0, 0],
      });
      // navigate through the text
      // 1 left
      await moveToPrevWord();
      await assertSelection(root, {
        anchorOffset: 15,
        anchorPath: [0, 0, 0],
        focusOffset: 15,
        focusPath: [0, 0, 0],
      });
      // 2 left
      await moveToPrevWord();
      await assertSelection(root, {
        anchorOffset: 10,
        anchorPath: [0, 0, 0],
        focusOffset: 10,
        focusPath: [0, 0, 0],
      });
      // 3 left
      await moveToPrevWord();
      await assertSelection(root, {
        anchorOffset: 6,
        anchorPath: [0, 0, 0],
        focusOffset: 6,
        focusPath: [0, 0, 0],
      });
      // 4 left
      await moveToPrevWord();
      await assertSelection(root, {
        anchorOffset: 2,
        anchorPath: [0, 0, 0],
        focusOffset: 2,
        focusPath: [0, 0, 0],
      });
      // 5 left
      await moveToPrevWord();
      await assertSelection(root, {
        anchorOffset: 0,
        anchorPath: [0, 0, 0],
        focusOffset: 0,
        focusPath: [0, 0, 0],
      });
      // 1 right
      await moveToNextWord();
      if (browserName === 'firefox') {
        if (IS_WINDOWS) {
          await assertSelection(root, {
            anchorOffset: 2,
            anchorPath: [0, 0, 0],
            focusOffset: 2,
            focusPath: [0, 0, 0],
          });
        } else {
          await assertSelection(root, {
            anchorOffset: 5,
            anchorPath: [0, 0, 0],
            focusOffset: 5,
            focusPath: [0, 0, 0],
          });
        }
      } else if (!IS_WINDOWS) {
        await assertSelection(root, {
          anchorOffset: 5,
          anchorPath: [0, 0, 0],
          focusOffset: 5,
          focusPath: [0, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 2,
          anchorPath: [0, 0, 0],
          focusOffset: 2,
          focusPath: [0, 0, 0],
        });
      }
      // 2 right
      await moveToNextWord();
      if (browserName === 'firefox') {
        if (IS_WINDOWS) {
          await assertSelection(root, {
            anchorOffset: 6,
            anchorPath: [0, 0, 0],
            focusOffset: 6,
            focusPath: [0, 0, 0],
          });
        } else {
          await assertSelection(root, {
            anchorOffset: 9,
            anchorPath: [0, 0, 0],
            focusOffset: 9,
            focusPath: [0, 0, 0],
          });
        }
      } else if (!IS_WINDOWS) {
        await assertSelection(root, {
          anchorOffset: 9,
          anchorPath: [0, 0, 0],
          focusOffset: 9,
          focusPath: [0, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 6,
          anchorPath: [0, 0, 0],
          focusOffset: 6,
          focusPath: [0, 0, 0],
        });
      }
      // 3 right
      await moveToNextWord();
      if (browserName === 'firefox') {
        if (IS_WINDOWS) {
          await assertSelection(root, {
            anchorOffset: 10,
            anchorPath: [0, 0, 0],
            focusOffset: 10,
            focusPath: [0, 0, 0],
          });
        } else {
          await assertSelection(root, {
            anchorOffset: 13,
            anchorPath: [0, 0, 0],
            focusOffset: 13,
            focusPath: [0, 0, 0],
          });
        }
      } else if (!IS_WINDOWS) {
        await assertSelection(root, {
          anchorOffset: 13,
          anchorPath: [0, 0, 0],
          focusOffset: 13,
          focusPath: [0, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 10,
          anchorPath: [0, 0, 0],
          focusOffset: 10,
          focusPath: [0, 0, 0],
        });
      }
      // 4 right
      await moveToNextWord();
      if (browserName === 'firefox') {
        if (IS_WINDOWS) {
          await assertSelection(root, {
            anchorOffset: 15,
            anchorPath: [0, 0, 0],
            focusOffset: 15,
            focusPath: [0, 0, 0],
          });
        } else {
          await assertSelection(root, {
            anchorOffset: 18,
            anchorPath: [0, 0, 0],
            focusOffset: 18,
            focusPath: [0, 0, 0],
          });
        }
      } else if (!IS_WINDOWS) {
        await assertSelection(root, {
          anchorOffset: 18,
          anchorPath: [0, 0, 0],
          focusOffset: 18,
          focusPath: [0, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 15,
          anchorPath: [0, 0, 0],
          focusOffset: 15,
          focusPath: [0, 0, 0],
        });
      }
      // 5 right
      await moveToNextWord();
      if (!IS_WINDOWS || browserName === 'firefox') {
        await assertSelection(root, {
          anchorOffset: 20,
          anchorPath: [0, 0, 0],
          focusOffset: 20,
          focusPath: [0, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 18,
          anchorPath: [0, 0, 0],
          focusOffset: 18,
          focusPath: [0, 0, 0],
        });

        // 6 right
        await moveToNextWord();
        await assertSelection(root, {
          anchorOffset: 20,
          anchorPath: [0, 0, 0],
          focusOffset: 20,
          focusPath: [0, 0, 0],
        });
      }
    });
    test('can navigate through the formatted text word by word', async () => {
      const {root} = setupEditor([
        isRichText ? RichTextExtension : PlainTextExtension,
        emojiExtension,
      ]);
      // Keep each sample line unwrapped so line navigation is independent of viewport size.
      root.style.width = '1400px';
      root.style.font = '15px Arial';

      // type sample text
      await typeText('  123 abc 456  def  ');
      await assertSelection(root, {
        anchorOffset: 20,
        anchorPath: [0, 0, 0],
        focusOffset: 20,
        focusPath: [0, 0, 0],
      });
      // This test relies on rich text formatting
      if (isRichText) {
        // select "de" and make it bold
        await moveToPrevWord();
        await selectCharacters('right', 2);
        await toggleBold();
        // select "ab" and make it bold
        await moveToPrevWord();
        await moveToPrevWord();
        await moveToPrevWord();
        await selectCharacters('right', 2);
        await toggleBold();
        await moveToLineEnd();
        await assertSelection(root, {
          anchorOffset: 3,
          anchorPath: [0, 4, 0],
          focusOffset: 3,
          focusPath: [0, 4, 0],
        });

        // navigate through the text
        // 1 left
        await moveToPrevWord();
        await assertSelection(root, {
          anchorOffset: 7,
          anchorPath: [0, 2, 0],
          focusOffset: 7,
          focusPath: [0, 2, 0],
        });
        // 2 left
        await moveToPrevWord();
        await assertSelection(root, {
          anchorOffset: 2,
          anchorPath: [0, 2, 0],
          focusOffset: 2,
          focusPath: [0, 2, 0],
        });
        // 3 left
        await moveToPrevWord();
        await assertSelection(root, {
          anchorOffset: 6,
          anchorPath: [0, 0, 0],
          focusOffset: 6,
          focusPath: [0, 0, 0],
        });
        // 4 left
        await moveToPrevWord();
        await assertSelection(root, {
          anchorOffset: 2,
          anchorPath: [0, 0, 0],
          focusOffset: 2,
          focusPath: [0, 0, 0],
        });
        // 5 left
        await moveToPrevWord();
        await assertSelection(root, {
          anchorOffset: 0,
          anchorPath: [0, 0, 0],
          focusOffset: 0,
          focusPath: [0, 0, 0],
        });
        // 1 right
        await moveToNextWord();
        if (IS_WINDOWS && browserName === 'chromium') {
          await assertSelection(root, {
            anchorOffset: 2,
            anchorPath: [0, 0, 0],
            focusOffset: 2,
            focusPath: [0, 0, 0],
          });
        } else if (browserName === 'firefox' && IS_WINDOWS) {
          await assertSelection(root, {
            anchorOffset: 2,
            anchorPath: [0, 0, 0],
            focusOffset: 2,
            focusPath: [0, 0, 0],
          });
        } else {
          await assertSelection(root, {
            anchorOffset: 5,
            anchorPath: [0, 0, 0],
            focusOffset: 5,
            focusPath: [0, 0, 0],
          });
        }
        // 2 right
        await moveToNextWord();
        if (browserName === 'webkit') {
          await assertSelection(root, {
            anchorOffset: 1,
            anchorPath: [0, 2, 0],
            focusOffset: 1,
            focusPath: [0, 2, 0],
          });
        } else if (browserName === 'firefox') {
          if (IS_WINDOWS) {
            await assertSelection(root, {
              anchorOffset: 0,
              anchorPath: [0, 1, 0],
              focusOffset: 0,
              focusPath: [0, 1, 0],
            });
          } else {
            await assertSelection(root, {
              anchorOffset: 1,
              anchorPath: [0, 2, 0],
              focusOffset: 1,
              focusPath: [0, 2, 0],
            });
          }
        } else {
          if (IS_WINDOWS) {
            await assertSelection(root, {
              anchorOffset: 6,
              anchorPath: [0, 0, 0],
              focusOffset: 6,
              focusPath: [0, 0, 0],
            });
          } else {
            await assertSelection(root, {
              anchorOffset: 1,
              anchorPath: [0, 2, 0],
              focusOffset: 1,
              focusPath: [0, 2, 0],
            });
          }
        }
        // 3 right
        await moveToNextWord();
        if (browserName === 'webkit') {
          await assertSelection(root, {
            anchorOffset: 5,
            anchorPath: [0, 2, 0],
            focusOffset: 5,
            focusPath: [0, 2, 0],
          });
        } else if (browserName === 'firefox') {
          if (IS_WINDOWS) {
            await assertSelection(root, {
              anchorOffset: 2,
              anchorPath: [0, 2, 0],
              focusOffset: 2,
              focusPath: [0, 2, 0],
            });
          } else {
            await assertSelection(root, {
              anchorOffset: 5,
              anchorPath: [0, 2, 0],
              focusOffset: 5,
              focusPath: [0, 2, 0],
            });
          }
        } else {
          if (IS_WINDOWS) {
            await assertSelection(root, {
              anchorOffset: 2,
              anchorPath: [0, 2, 0],
              focusOffset: 2,
              focusPath: [0, 2, 0],
            });
          } else {
            await assertSelection(root, {
              anchorOffset: 5,
              anchorPath: [0, 2, 0],
              focusOffset: 5,
              focusPath: [0, 2, 0],
            });
          }
        }
        // 4 right
        await moveToNextWord();
        if (browserName === 'webkit') {
          await assertSelection(root, {
            anchorOffset: 1,
            anchorPath: [0, 4, 0],
            focusOffset: 1,
            focusPath: [0, 4, 0],
          });
        } else if (browserName === 'firefox') {
          if (IS_WINDOWS) {
            await assertSelection(root, {
              anchorOffset: 0,
              anchorPath: [0, 3, 0],
              focusOffset: 0,
              focusPath: [0, 3, 0],
            });
          } else {
            await assertSelection(root, {
              anchorOffset: 1,
              anchorPath: [0, 4, 0],
              focusOffset: 1,
              focusPath: [0, 4, 0],
            });
          }
        } else {
          if (IS_WINDOWS) {
            await assertSelection(root, {
              anchorOffset: 7,
              anchorPath: [0, 2, 0],
              focusOffset: 7,
              focusPath: [0, 2, 0],
            });
          } else {
            await assertSelection(root, {
              anchorOffset: 1,
              anchorPath: [0, 4, 0],
              focusOffset: 1,
              focusPath: [0, 4, 0],
            });
          }
        }
        // 5 right
        await moveToNextWord();
        if (browserName === 'webkit') {
          await assertSelection(root, {
            anchorOffset: 3,
            anchorPath: [0, 4, 0],
            focusOffset: 3,
            focusPath: [0, 4, 0],
          });
        } else if (!IS_WINDOWS || browserName === 'firefox') {
          if (browserName === 'firefox') {
            if (IS_WINDOWS) {
              await assertSelection(root, {
                anchorOffset: 3,
                anchorPath: [0, 4, 0],
                focusOffset: 3,
                focusPath: [0, 4, 0],
              });
            } else {
              await assertSelection(root, {
                anchorOffset: 3,
                anchorPath: [0, 4, 0],
                focusOffset: 3,
                focusPath: [0, 4, 0],
              });
            }
          } else {
            await assertSelection(root, {
              anchorOffset: 3,
              anchorPath: [0, 4, 0],
              focusOffset: 3,
              focusPath: [0, 4, 0],
            });
          }
          // eslint-disable-next-line no-dupe-else-if -- pre-existing, needs refactoring
        } else if (!IS_WINDOWS) {
          await assertSelection(root, {
            anchorOffset: 1,
            anchorPath: [0, 4, 0],
            focusOffset: 1,
            focusPath: [0, 4, 0],
          });
          // 6 right
          await moveToNextWord();
          await assertSelection(root, {
            anchorOffset: 3,
            anchorPath: [0, 4, 0],
            focusOffset: 3,
            focusPath: [0, 4, 0],
          });
        } else {
          // 6 right
          await moveToNextWord();
          await assertSelection(root, {
            anchorOffset: 3,
            anchorPath: [0, 4, 0],
            focusOffset: 3,
            focusPath: [0, 4, 0],
          });
        }
      }
    });
    test('can navigate through the text with emoji word by word', async () => {
      const {root} = setupEditor([
        isRichText ? RichTextExtension : PlainTextExtension,
        emojiExtension,
      ]);
      // Keep each sample line unwrapped so line navigation is independent of viewport size.
      root.style.width = '1400px';
      root.style.font = '15px Arial';

      // type sample text
      await typeText('123:)456 abc:):)de fg');
      await assertSelection(root, {
        anchorOffset: 5,
        anchorPath: [0, 5, 0],
        focusOffset: 5,
        focusPath: [0, 5, 0],
      });
      // navigate through the text
      // 1 left
      await moveToPrevWord();
      await assertSelection(root, {
        anchorOffset: 3,
        anchorPath: [0, 5, 0],
        focusOffset: 3,
        focusPath: [0, 5, 0],
      });
      // 2 left
      await moveToPrevWord();
      if (browserName === 'firefox') {
        await assertSelection(root, {
          anchorOffset: 2,
          anchorPath: [0, 4, 0, 0],
          focusOffset: 2,
          focusPath: [0, 4, 0, 0],
        });
      } else if (browserName === 'webkit') {
        await assertSelection(root, {
          anchorOffset: 2,
          anchorPath: [0, 4, 0, 0],
          focusOffset: 2,
          focusPath: [0, 4, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 2,
          anchorPath: [0, 4, 0, 0],
          focusOffset: 2,
          focusPath: [0, 4, 0, 0],
        });
      }
      // 3 left
      await moveToPrevWord();
      if (browserName === 'webkit') {
        await assertSelection(root, {
          anchorOffset: 4,
          anchorPath: [0, 2, 0],
          focusOffset: 4,
          focusPath: [0, 2, 0],
        });
      } else if (browserName === 'firefox') {
        await assertSelection(root, {
          anchorOffset: 2,
          anchorPath: [0, 3, 0, 0],
          focusOffset: 2,
          focusPath: [0, 3, 0, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 7,
          anchorPath: [0, 2, 0],
          focusOffset: 7,
          focusPath: [0, 2, 0],
        });
      }
      // Non-Firefox requires more arrow presses
      if (browserName !== 'firefox') {
        // 4 left
        await moveToPrevWord();
        if (browserName === 'webkit') {
          await assertSelection(root, {
            anchorOffset: 2,
            anchorPath: [0, 1, 0, 0],
            focusOffset: 2,
            focusPath: [0, 1, 0, 0],
          });
        } else {
          await assertSelection(root, {
            anchorOffset: 4,
            anchorPath: [0, 2, 0],
            focusOffset: 4,
            focusPath: [0, 2, 0],
          });
        }
        // 5 left
        await moveToPrevWord();
        if (browserName === 'webkit') {
          await assertSelection(root, {
            anchorOffset: 0,
            anchorPath: [0, 0, 0],
            focusOffset: 0,
            focusPath: [0, 0, 0],
          });
        } else {
          await assertSelection(root, {
            anchorOffset: 2,
            anchorPath: [0, 1, 0, 0],
            focusOffset: 2,
            focusPath: [0, 1, 0, 0],
          });
        }
        // 6 left
        await moveToPrevWord();
        if (browserName === 'chromium') {
          await assertSelection(root, {
            anchorOffset: 3,
            anchorPath: [0, 0, 0],
            focusOffset: 3,
            focusPath: [0, 0, 0],
          });
        } else if (browserName === 'webkit') {
          await assertSelection(root, {
            anchorOffset: 0,
            anchorPath: [0, 0, 0],
            focusOffset: 0,
            focusPath: [0, 0, 0],
          });
        } else {
          await assertSelection(root, {
            anchorOffset: 0,
            anchorPath: [0, 2, 0],
            focusOffset: 0,
            focusPath: [0, 2, 0],
          });
        }

        // 7 left
        await moveToPrevWord();
        if (browserName === 'chromium') {
          await assertSelection(root, {
            anchorOffset: 0,
            anchorPath: [0, 0, 0],
            focusOffset: 0,
            focusPath: [0, 0, 0],
          });
        } else {
          await assertSelection(root, {
            anchorOffset: 0,
            anchorPath: [0, 0, 0],
            focusOffset: 0,
            focusPath: [0, 0, 0],
          });
        }

        // 8 left
        await moveToPrevWord();
        await assertSelection(root, {
          anchorOffset: 0,
          anchorPath: [0, 0, 0],
          focusOffset: 0,
          focusPath: [0, 0, 0],
        });
      }
      // 1 right
      await moveToNextWord();
      if (browserName === 'webkit') {
        await assertSelection(root, {
          anchorOffset: 3,
          anchorPath: [0, 0, 0],
          focusOffset: 3,
          focusPath: [0, 0, 0],
        });
      } else if (browserName === 'firefox') {
        await assertSelection(root, {
          anchorOffset: 0,
          anchorPath: [0, 5, 0],
          focusOffset: 0,
          focusPath: [0, 5, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 3,
          anchorPath: [0, 0, 0],
          focusOffset: 3,
          focusPath: [0, 0, 0],
        });
      }
      // 2 right
      await moveToNextWord();
      if (browserName === 'webkit') {
        await assertSelection(root, {
          anchorOffset: 3,
          anchorPath: [0, 2, 0],
          focusOffset: 3,
          focusPath: [0, 2, 0],
        });
      } else if (browserName === 'firefox') {
        if (IS_WINDOWS) {
          await assertSelection(root, {
            anchorOffset: 3,
            anchorPath: [0, 5, 0],
            focusOffset: 3,
            focusPath: [0, 5, 0],
          });
        } else {
          await assertSelection(root, {
            anchorOffset: 2,
            anchorPath: [0, 5, 0],
            focusOffset: 2,
            focusPath: [0, 5, 0],
          });
        }
      } else {
        await assertSelection(root, {
          anchorOffset: 2,
          anchorPath: [0, 1, 0, 0],
          focusOffset: 2,
          focusPath: [0, 1, 0, 0],
        });
      }
      // 3 right
      await moveToNextWord();
      if (browserName === 'webkit') {
        await assertSelection(root, {
          anchorOffset: 7,
          anchorPath: [0, 2, 0],
          focusOffset: 7,
          focusPath: [0, 2, 0],
        });
      } else if (browserName === 'firefox') {
        await assertSelection(root, {
          anchorOffset: 5,
          anchorPath: [0, 5, 0],
          focusOffset: 5,
          focusPath: [0, 5, 0],
        });
      } else if (IS_WINDOWS) {
        await assertSelection(root, {
          anchorOffset: 4,
          anchorPath: [0, 2, 0],
          focusOffset: 4,
          focusPath: [0, 2, 0],
        });
      } else {
        await assertSelection(root, {
          anchorOffset: 3,
          anchorPath: [0, 2, 0],
          focusOffset: 3,
          focusPath: [0, 2, 0],
        });
      }
      // 4 right
      await moveToNextWord();
      if (browserName === 'firefox') {
        await assertSelection(root, {
          anchorOffset: 5,
          anchorPath: [0, 5, 0],
          focusOffset: 5,
          focusPath: [0, 5, 0],
        });
      } else {
        // 5 right
        await moveToNextWord();
        if (browserName === 'webkit') {
          await assertSelection(root, {
            anchorOffset: 5,
            anchorPath: [0, 5, 0],
            focusOffset: 5,
            focusPath: [0, 5, 0],
          });
        } else if (IS_WINDOWS) {
          await assertSelection(root, {
            anchorOffset: 2,
            anchorPath: [0, 4, 0, 0],
            focusOffset: 2,
            focusPath: [0, 4, 0, 0],
          });

          // 6 right
          await moveToNextWord();
          await assertSelection(root, {
            anchorOffset: 3,
            anchorPath: [0, 5, 0],
            focusOffset: 3,
            focusPath: [0, 5, 0],
          });

          // 7 right
          await moveToNextWord();
          await assertSelection(root, {
            anchorOffset: 5,
            anchorPath: [0, 5, 0],
            focusOffset: 5,
            focusPath: [0, 5, 0],
          });
        } else {
          await assertSelection(root, {
            anchorOffset: 2,
            anchorPath: [0, 4, 0, 0],
            focusOffset: 2,
            focusPath: [0, 4, 0, 0],
          });

          // 6 right
          await moveToNextWord();
          await assertSelection(root, {
            anchorOffset: 2,
            anchorPath: [0, 5, 0],
            focusOffset: 2,
            focusPath: [0, 5, 0],
          });

          // 7 right
          await moveToNextWord();
          await assertSelection(root, {
            anchorOffset: 5,
            anchorPath: [0, 5, 0],
            focusOffset: 5,
            focusPath: [0, 5, 0],
          });
        }

        if (browserName === 'webkit') {
          // 6 right
          await moveToNextWord();
          await assertSelection(root, {
            anchorOffset: 5,
            anchorPath: [0, 5, 0],
            focusOffset: 5,
            focusPath: [0, 5, 0],
          });
        }
      }
    });
  },
);
