/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  mountReactPluginHost,
  ReactPluginHostExtension,
} from '@lexical/react/ReactPluginHostExtension';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $getRoot,
  $getSlot,
  $isElementNode,
  $isParagraphNode,
  defineExtension,
  IS_APPLE,
} from 'lexical';
import {act} from 'react';
import {expect, onTestFinished, test} from 'vitest';
import {userEvent} from 'vitest/browser';

import {SlotContainerNode} from '../../nodes/SlotContainerNode';
import {CardExtension, INSERT_CARD_COMMAND} from '../../plugins/CardExtension';
import {CardNode} from '../../plugins/CardExtension/CardNode';
import {
  INSERT_PULLQUOTE_COMMAND,
  PullQuoteExtension,
} from '../../plugins/PullQuoteExtension';
import {PullQuoteNode} from '../../plugins/PullQuoteExtension/PullQuoteNode';
import {
  INSERT_REVIEW_COMMAND,
  ReactReviewExtension,
} from '../../plugins/ReviewExtension';
import theme from '../../themes/PlaygroundEditorTheme';
import {press as nativePress, typeText as nativeTypeText} from './utils';

const press = (chord: string) => act(() => nativePress(chord));
const typeText = (text: string) => act(() => nativeTypeText(text));

const extension = defineExtension({
  dependencies: [
    RichTextExtension,
    CardExtension,
    PullQuoteExtension,
    ReactReviewExtension,
    ReactPluginHostExtension,
  ],
  name: '[slot-host-navigation]',
  nodes: () => [CardNode, PullQuoteNode, SlotContainerNode],
  theme,
});

const hosts = {
  Card: {
    command: INSERT_CARD_COMMAND,
    first: '[data-lexical-slot="title"] p',
    last: '.lexical-card-node > p',
    selector: '.lexical-card-node',
  },
  PullQuote: {
    command: INSERT_PULLQUOTE_COMMAND,
    first: '[data-lexical-slot="quote"] p:first-child',
    last: '[data-lexical-slot="attribution"] p',
    selector: '.lexical-pullquote-node',
  },
  Review: {
    command: INSERT_REVIEW_COMMAND,
    first: '.lexical-review-children p:first-child',
    last: '.lexical-review-author [data-lexical-slot="author"] p',
    selector: '.lexical-review-node',
  },
};

async function setup(kind: keyof typeof hosts) {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  root.style.cssText = 'white-space: pre-wrap; width: 600px; font: 15px Arial';
  const plugins = document.createElement('div');
  document.body.append(root, plugins);
  const editor = buildEditorFromExtensions(extension);
  onTestFinished(async () => {
    await act(async () => editor.dispose());
    root.remove();
    plugins.remove();
    window.getSelection()?.removeAllRanges();
  });
  await act(async () => {
    mountReactPluginHost(editor, plugins);
    editor.setRootElement(root);
    editor.update(
      () => {
        $getRoot().clear().append($createParagraphNode());
        $getRoot().selectEnd();
      },
      {discrete: true},
    );
    editor.dispatchCommand(hosts[kind].command, undefined);
  });
  await expect.poll(() => root.querySelector(hosts[kind].first)).not.toBeNull();
  window.focus();
  return {editor, root};
}

async function click(root: HTMLElement, selector: string) {
  await act(() => userEvent.click(root.querySelector<HTMLElement>(selector)!));
}

function caretIn(root: HTMLElement, selector: string) {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  return (
    !!selection?.isCollapsed &&
    !!node &&
    !!root.querySelector(selector)?.contains(node)
  );
}

for (const kind of ['Review', 'Card', 'PullQuote'] as const) {
  test.each(['before', 'after'] as const)(
    `${kind}: arrow escape inserts a paragraph %s the edge host`,
    async side => {
      const {editor, root} = await setup(kind);
      const config = hosts[kind];
      const selector = side === 'before' ? config.first : config.last;
      await click(root, selector);
      if (kind !== 'PullQuote') {
        await typeText(
          kind === 'Review'
            ? side === 'before'
              ? 'Body'
              : 'Jane'
            : side === 'before'
              ? 'Title'
              : 'Body',
        );
      }
      const originalText = root.querySelector(config.selector)!.textContent;
      if (side === 'after') {
        await act(async () => {
          editor.update(
            () => {
              const last = $getRoot().getLastChild();
              if ($isParagraphNode(last) && last.getTextContent() === '')
                last.remove();
            },
            {discrete: true},
          );
        });
        await click(root, selector);
      }
      // A click can land on a later wrapped line. The precondition for
      // escaping above a host is the start of the entire quote.
      if (kind === 'PullQuote' && side === 'before') {
        await act(async () => {
          editor.update(
            () => {
              const quote = $getSlot(
                $getRoot().getFirstChildOrThrow(),
                'quote',
              );
              if ($isElementNode(quote)) quote.selectStart();
            },
            {discrete: true},
          );
        });
      } else
        await press(
          side === 'before'
            ? IS_APPLE
              ? 'Meta+ArrowLeft'
              : 'Home'
            : IS_APPLE
              ? 'Meta+ArrowRight'
              : 'End',
        );
      await press(side === 'before' ? 'ArrowUp' : 'ArrowDown');
      await typeText(side === 'before' ? 'Before' : 'After');
      const host = root.querySelector(config.selector)!;
      await expect
        .poll(
          () =>
            (side === 'before'
              ? host.previousElementSibling
              : host.nextElementSibling
            )?.textContent,
        )
        .toBe(side === 'before' ? 'Before' : 'After');
      expect(host.textContent).toBe(originalText);
      expect(
        caretIn(
          root,
          side === 'before'
            ? ':scope > p:first-child'
            : ':scope > p:last-child',
        ),
      ).toBe(true);
    },
  );
}

// Review renders its body before its author slot; PullQuote renders quote
// before attribution. Cross-island navigation must follow rendered order.
for (const kind of ['Review', 'PullQuote'] as const) {
  test.each(['down', 'up'] as const)(
    `${kind}: arrow %s crosses regions without inserting a block`,
    async direction => {
      const {editor, root} = await setup(kind);
      const config = hosts[kind];
      if (kind === 'Review') {
        await click(root, config.first);
        await typeText('Body');
        await click(root, config.last);
        await typeText('Jane');
      }
      if (kind === 'Review' && direction === 'down') {
        await act(async () => {
          editor.update(() => $getRoot().getLastChildOrThrow().remove(), {
            discrete: true,
          });
        });
      }
      const before = root.children.length;
      await click(root, direction === 'down' ? config.first : config.last);
      if (kind === 'PullQuote' && direction === 'down') {
        // The seeded quote wraps; use its actual end, as in the E2E case.
        await act(async () => {
          editor.update(
            () => {
              const slot = $getSlot($getRoot().getFirstChildOrThrow(), 'quote');
              if ($isElementNode(slot)) slot.selectEnd();
            },
            {discrete: true},
          );
        });
      } else {
        await press(
          direction === 'down'
            ? IS_APPLE
              ? 'Meta+ArrowRight'
              : 'End'
            : IS_APPLE
              ? 'Meta+ArrowLeft'
              : 'Home',
        );
      }
      await press(direction === 'down' ? 'ArrowDown' : 'ArrowUp');
      await expect
        .poll(() =>
          caretIn(root, direction === 'down' ? config.last : config.first),
        )
        .toBe(true);
      expect(root.children.length).toBe(before);
    },
  );
}
