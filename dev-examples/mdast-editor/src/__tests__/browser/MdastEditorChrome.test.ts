/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {buildEditorFromExtensions} from '@lexical/extension';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  MdastCommonMarkExtension,
  MdastExportExtension,
  MdastGfmExtension,
} from '@lexical/mdast';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  defineExtension,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, onTestFinished, test, vi} from 'vitest';

import {
  INSERT_ALERT_COMMAND,
  MdastAlertExtension,
} from '../../extensions/MdastAlertExtension';
import {
  INSERT_COLLAPSIBLE_COMMAND,
  MdastCollapsibleExtension,
} from '../../extensions/MdastCollapsibleExtension';
import {
  $isFootnoteDefinitionNode,
  INSERT_FOOTNOTE_COMMAND,
  MdastFootnoteExtension,
} from '../../extensions/MdastFootnoteExtension';
import {
  FORMAT_KBD_COMMAND,
  MdastKbdExtension,
} from '../../extensions/MdastKbdExtension';

// The in-lexical chrome these extensions render — the collapsible's chevron
// and the alert title's dropdown — is driven by real DOM events and, for the
// dropdown, by DOM inserted OUTSIDE of reconciliation (guarded by
// setDOMUnmanaged against the mutation observer). Those interactions need a
// real mounted editor in a real browser, so they live in the `browser`
// vitest project rather than jsdom.

function mountEditor(markdown: string): {
  editor: LexicalEditor;
  root: HTMLElement;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const contentEditable = document.createElement('div');
  contentEditable.contentEditable = 'true';
  container.appendChild(contentEditable);

  const editor = buildEditorFromExtensions(
    defineExtension({
      $initialEditorState: () => {
        $convertFromMarkdownString(markdown);
      },
      dependencies: [
        MdastCommonMarkExtension,
        MdastGfmExtension,
        MdastExportExtension,
        MdastCollapsibleExtension,
        MdastAlertExtension,
        MdastFootnoteExtension,
        MdastKbdExtension,
        RichTextExtension,
      ],
      name: '[mdast-editor-example-chrome-test]',
    }),
  );
  editor.setRootElement(contentEditable);

  onTestFinished(() => {
    editor.setRootElement(null);
    document.body.removeChild(container);
  });

  return {editor, root: contentEditable};
}

function markdownOf(editor: LexicalEditor): string {
  return editor.read(() => $convertToMarkdownString());
}

describe('collapsible chevron', () => {
  const ENCODING =
    '<details><summary>\nThe *summary*\n</summary>\n\nBody\n</details>';

  test('toggles the open NodeState and the data-open attribute', async () => {
    const {editor, root} = mountEditor(ENCODING);
    const host = root.querySelector<HTMLElement>('.collapsible-container');
    expect(host).not.toBeNull();
    // No `open` attribute in the source: imported closed.
    expect(host!.getAttribute('data-open')).toBeNull();

    const toggle = root.querySelector<HTMLElement>('.collapsible-toggle');
    expect(toggle).not.toBeNull();
    toggle!.click();
    await vi.waitFor(() =>
      expect(host!.getAttribute('data-open')).toBe('true'),
    );
    expect(markdownOf(editor)).toContain('<details open>');

    toggle!.click();
    await vi.waitFor(() => expect(host!.getAttribute('data-open')).toBeNull());
    expect(markdownOf(editor)).toContain('<details>');
  });

  test('reveals the summary slot in the summary row', () => {
    const {root} = mountEditor(ENCODING);
    const slot = root.querySelector<HTMLElement>(
      '.collapsible-summary-row > [data-lexical-slot="summary"]',
    );
    expect(slot).not.toBeNull();
    expect(slot!.textContent).toBe('The summary');
  });
});

describe('alert title dropdown', () => {
  const ALERT = '> [!NOTE]\n> body text';

  function openMenu(root: HTMLElement): HTMLElement {
    const title = root.querySelector<HTMLElement>('.markdown-alert-title');
    expect(title).not.toBeNull();
    title!.click();
    const menu = title!.querySelector<HTMLElement>('.markdown-alert-menu');
    expect(menu).not.toBeNull();
    return menu!;
  }

  test('renders the chrome for an imported alert', () => {
    const {root} = mountEditor(ALERT);
    const quote = root.querySelector<HTMLElement>('.markdown-alert');
    expect(quote).not.toBeNull();
    expect(quote!.classList.contains('markdown-alert-note')).toBe(true);
    expect(
      quote!.querySelector('.markdown-alert-title-label')!.textContent,
    ).toBe('Note');
  });

  test('the menu survives inside the editor DOM (setDOMUnmanaged)', async () => {
    const {editor, root} = mountEditor(ALERT);
    const menu = openMenu(root);
    // The menu is click-time DOM inside the contentEditable; without the
    // unmanaged marking the mutation observer would evict it. Give the
    // observer a chance, including across an unrelated reconciliation.
    await new Promise(resolve => setTimeout(resolve, 50));
    editor.update(() => {});
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(menu.isConnected).toBe(true);
  });

  test('lists the five types in GitHub order plus convert', () => {
    const {root} = mountEditor(ALERT);
    const menu = openMenu(root);
    const items = Array.from(
      menu.querySelectorAll('.markdown-alert-menu-item'),
    ).map(item => item.textContent);
    expect(items).toEqual([
      'Note',
      'Tip',
      'Important',
      'Warning',
      'Caution',
      'Convert to blockquote',
    ]);
    expect(
      menu.querySelector('.markdown-alert-menu-item.is-current')!.textContent,
    ).toBe('Note');
  });

  test('selecting a type updates the chrome and the Markdown', async () => {
    const {editor, root} = mountEditor(ALERT);
    const menu = openMenu(root);
    const tip = Array.from(
      menu.querySelectorAll<HTMLElement>('.markdown-alert-menu-item'),
    ).find(item => item.textContent === 'Tip');
    tip!.click();
    await vi.waitFor(() => {
      expect(root.querySelector('.markdown-alert-tip')).not.toBeNull();
      expect(
        root.querySelector('.markdown-alert-title-label')!.textContent,
      ).toBe('Tip');
    });
    expect(root.querySelector('.markdown-alert-menu')).toBeNull();
    expect(markdownOf(editor)).toBe('> [!TIP]\n> body text');
  });

  test('an outside pointerdown dismisses without changes', () => {
    const {editor, root} = mountEditor(ALERT);
    openMenu(root);
    document.body.dispatchEvent(
      new PointerEvent('pointerdown', {bubbles: true}),
    );
    expect(root.querySelector('.markdown-alert-menu')).toBeNull();
    expect(markdownOf(editor)).toBe(ALERT);
  });

  test('Escape dismisses without changes', () => {
    const {editor, root} = mountEditor(ALERT);
    openMenu(root);
    document.dispatchEvent(
      new KeyboardEvent('keydown', {bubbles: true, key: 'Escape'}),
    );
    expect(root.querySelector('.markdown-alert-menu')).toBeNull();
    expect(markdownOf(editor)).toBe(ALERT);
  });

  test('convert to blockquote strips the chrome and the marker', async () => {
    const {editor, root} = mountEditor(ALERT);
    const menu = openMenu(root);
    const convert = Array.from(
      menu.querySelectorAll<HTMLElement>('.markdown-alert-menu-item'),
    ).find(item => item.textContent === 'Convert to blockquote');
    convert!.click();
    await vi.waitFor(() => {
      expect(root.querySelector('.markdown-alert')).toBeNull();
      expect(root.querySelector('.markdown-alert-title')).toBeNull();
    });
    expect(markdownOf(editor)).toBe('> body text');
  });
});

describe('footnotes', () => {
  test('footnotes render at the document bottom from the root slot', () => {
    const {editor, root} = mountEditor(
      'body[^a] text\n\n[^a]: the note\n\ntrailing paragraph',
    );
    // The ref is inline chrome in the body.
    const ref = root.querySelector<HTMLElement>('.footnote-ref');
    expect(ref).not.toBeNull();
    expect(ref!.textContent).toBe('a');
    // The section renders inside the bottom anchor — the root's LAST
    // element — even though the source put the definition mid-document.
    const last = root.lastElementChild!;
    expect(last.classList.contains('footnotes-anchor')).toBe(true);
    expect(last.querySelector('.footnote-def-label')!.textContent).toBe('a');
    // And the definitions are appended to the serialized Markdown's end.
    expect(markdownOf(editor)).toBe(
      'body[^a] text\n\ntrailing paragraph\n\n[^a]: the note',
    );
  });

  test('removing the last definition drops the section and its refs', async () => {
    const {editor, root} = mountEditor(
      'body[^a] and[^a] again\n\n[^a]: the note',
    );
    root.querySelector<HTMLElement>('.footnote-def-remove')!.click();
    await vi.waitFor(() => {
      expect(root.querySelector('.footnotes')).toBeNull();
      // The deletion cascades: every reference to the label goes too.
      expect(root.querySelector('.footnote-ref')).toBeNull();
    });
    expect(markdownOf(editor)).toBe('body and again');
  });

  test('exposes GitHub/DAISY-style anchors, ids, and roles', async () => {
    const {root} = mountEditor('first[^a] one\n\nsecond[^a] two\n\n[^a]: note');
    // The section and its title (the accessible name every ref points at).
    const section = root.querySelector<HTMLElement>('.footnotes')!;
    expect(section.getAttribute('role')).toBe('doc-endnotes');
    expect(root.querySelector('.footnotes-title')!.id).toBe('footnote-label');
    // The definition is the fragment target of the ref anchors.
    const definition = root.querySelector<HTMLElement>('.footnote-def')!;
    expect(definition.id).toBe('fn-a');
    expect(definition.getAttribute('role')).toBe('doc-endnote');
    // Refs are real fragment links with per-label ordinal ids.
    const refs = Array.from(
      root.querySelectorAll<HTMLAnchorElement>('.footnote-ref a'),
    );
    expect(refs.map(a => a.getAttribute('href'))).toEqual(['#fn-a', '#fn-a']);
    expect(refs.map(a => a.getAttribute('role'))).toEqual([
      'doc-noteref',
      'doc-noteref',
    ]);
    expect(refs.map(a => a.getAttribute('aria-describedby'))).toEqual([
      'footnote-label',
      'footnote-label',
    ]);
    // Ids are assigned by the update listener in document order.
    await vi.waitFor(() => {
      expect(refs.map(a => a.id)).toEqual(['fnref-a', 'fnref-a-2']);
    });
    // Backlinks target those ids.
    await vi.waitFor(() => {
      const backlinks = Array.from(
        root.querySelectorAll<HTMLAnchorElement>('.footnote-def-backlink'),
      );
      expect(backlinks.map(a => a.getAttribute('href'))).toEqual([
        '#fnref-a',
        '#fnref-a-2',
      ]);
      expect(backlinks.map(a => a.getAttribute('role'))).toEqual([
        'doc-backlink',
        'doc-backlink',
      ]);
    });
  });

  test('clicking a ref moves the caret into the definition body', async () => {
    const {editor, root} = mountEditor('body[^a]\n\n[^a]: the note');
    // The click is inside the waitFor, so the *interaction* retries rather
    // than only the observation. The selection follow-up rides on the
    // fragment navigation's settle signal, and the navigation's focus fixup
    // can land later still (observed intermittently on the windows/firefox
    // CI runners), clobbering a single application; deferring the follow-up
    // past the signal just changes who loses that race. A repeat click is a
    // same-fragment navigation, which takes the timeout fallback and
    // re-applies — the same recovery a person gets by clicking again.
    await vi.waitFor(() => {
      root.querySelector<HTMLElement>('.footnote-ref a')!.click();
      const inDefinition = editor.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }
        const anchorNode = selection.anchor.getNode();
        return (
          $isFootnoteDefinitionNode(anchorNode) ||
          anchorNode.getParents().some($isFootnoteDefinitionNode)
        );
      });
      expect(inDefinition).toBe(true);
    });
  });

  test('a real copy event carries the selected refs definitions in the HTML', () => {
    const {editor, root} = mountEditor(
      'one[^a] and[^b] more\n\n[^a]: note a\n\n[^b]: note b',
    );
    // A DOM selection left over from another test would sit outside this
    // editor, and the copy handler correctly refuses to serialize in that
    // state — clear it so only the lexical selection below matters.
    window.getSelection()!.removeAllRanges();
    editor.update(
      () => {
        const paragraph = $getRoot().getFirstChild();
        const texts = (
          $isElementNode(paragraph) ? paragraph.getChildren() : []
        ).filter($isTextNode);
        // 'one' through ' and': covers [^a], not [^b].
        const selection = $createRangeSelection();
        selection.anchor.set(texts[0].getKey(), 0, 'text');
        selection.focus.set(texts[1].getKey(), 4, 'text');
        $setSelection(selection);
      },
      {discrete: true},
    );
    const event = new ClipboardEvent('copy', {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    root.dispatchEvent(event);
    // Read the results back through the EVENT's DataTransfer: Chromium
    // keeps the object passed to the constructor, but Firefox clones it,
    // so the DataTransfer the handler wrote into is only reachable here.
    const html = event.clipboardData!.getData('text/html');
    expect(html).toContain('data-footnote-ref="a"');
    expect(html).toContain('data-footnote-def="a"');
    expect(html).toContain('note a');
    expect(html).not.toContain('note b');
  });

  test('one backlink per reference after the note text, each jumping to its ref', async () => {
    const {editor, root} = mountEditor(
      'first[^a] one\n\nsecond[^a] two\n\n[^a]: note',
    );
    // Two references -> two backlinks (`↩` and `↩²`), rendered inside the
    // note body's last paragraph, GitHub-style.
    await vi.waitFor(() => {
      expect(root.querySelectorAll('.footnote-def-backlink').length).toBe(2);
    });
    const container = root.querySelector<HTMLElement>(
      '.footnote-def-backlinks',
    )!;
    expect(container.parentElement!.tagName).toBe('P');
    expect(container.closest('.footnote-def-content')).not.toBeNull();
    const backlinks = Array.from(
      container.querySelectorAll<HTMLElement>('.footnote-def-backlink'),
    );
    expect(backlinks[1].querySelector('sup')!.textContent).toBe('2');
    const $anchorBlockText = () =>
      editor.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return '';
        }
        const top = selection.anchor.getNode().getTopLevelElement();
        return top === null ? '' : top.getTextContent();
      });
    // Click inside the waitFor for the same reason as the ref-click test:
    // retry the interaction, not just the observation.
    await vi.waitFor(() => {
      backlinks[0].click();
      expect($anchorBlockText()).toContain('first');
    });
    await vi.waitFor(() => {
      backlinks[1].click();
      expect($anchorBlockText()).toContain('second');
    });
  });
});

describe('read-only', () => {
  const DOC = [
    '<details><summary>\nSummary\n</summary>\n\nBody\n</details>',
    '',
    '> [!NOTE]\n> alert body',
    '',
    'ref[^a]',
    '',
    '[^a]: note a',
  ].join('\n');

  test('the chevron still toggles, as view state only', async () => {
    const {editor, root} = mountEditor(DOC);
    const before = markdownOf(editor);
    editor.setEditable(false);
    const host = root.querySelector<HTMLElement>('.collapsible-container')!;
    expect(host.getAttribute('data-open')).toBeNull();
    root.querySelector<HTMLElement>('.collapsible-toggle')!.click();
    // The view opens synchronously (no editor update involved)...
    expect(host.getAttribute('data-open')).toBe('true');
    // ...and the document did not change.
    expect(markdownOf(editor)).toBe(before);
    // When editing resumes, the attribute resyncs from the NodeState.
    editor.setEditable(true);
    await vi.waitFor(() => expect(host.getAttribute('data-open')).toBeNull());
    expect(markdownOf(editor)).toBe(before);
  });

  test('the alert menu does not open', () => {
    const {editor, root} = mountEditor(DOC);
    editor.setEditable(false);
    root.querySelector<HTMLElement>('.markdown-alert-title')!.click();
    expect(root.querySelector('.markdown-alert-menu')).toBeNull();
  });

  test('footnote deletion is blocked', () => {
    const {editor, root} = mountEditor(DOC);
    const before = markdownOf(editor);
    editor.setEditable(false);
    root.querySelector<HTMLElement>('.footnote-def-remove')!.click();
    expect(root.querySelector('.footnote-def')).not.toBeNull();
    expect(root.querySelector('.footnote-ref')).not.toBeNull();
    expect(markdownOf(editor)).toBe(before);
  });

  test('mutating commands are inert; ref navigation still moves the selection', async () => {
    const {editor, root} = mountEditor(DOC);
    editor.update(
      () => {
        $getRoot().selectEnd();
      },
      {discrete: true},
    );
    const before = markdownOf(editor);
    editor.setEditable(false);
    editor.dispatchCommand(INSERT_FOOTNOTE_COMMAND);
    editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND);
    editor.dispatchCommand(INSERT_ALERT_COMMAND, 'note');
    editor.dispatchCommand(FORMAT_KBD_COMMAND);
    expect(markdownOf(editor)).toBe(before);
    // The one thing read-only still allows: moving the selection. The click
    // is inside the waitFor, so the interaction retries rather than only the
    // observation — see the ref-click test above.
    await vi.waitFor(() => {
      root.querySelector<HTMLElement>('.footnote-ref a')!.click();
      const inDefinition = editor.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }
        const anchorNode = selection.anchor.getNode();
        return (
          $isFootnoteDefinitionNode(anchorNode) ||
          anchorNode.getParents().some($isFootnoteDefinitionNode)
        );
      });
      expect(inDefinition).toBe(true);
    });
    expect(markdownOf(editor)).toBe(before);
  });
});
