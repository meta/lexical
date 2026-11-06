/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$getClipboardDataFromSelection} from '@lexical/clipboard';
import {
  buildEditorFromExtensions,
  type LexicalEditorWithDispose,
} from '@lexical/extension';
import {
  $generateHtmlFromNodes,
  $generateNodesFromDOMViaExtension,
} from '@lexical/html';
import {ListExtension} from '@lexical/list';
import {
  $convertFromMarkdownString,
  $convertSelectionToMarkdownString,
  $convertToMarkdownString,
  MdastCommonMarkExtension,
  MdastExtension,
  MdastGfmExtension,
} from '@lexical/mdast';
import {$isQuoteNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $getSlot,
  $isElementNode,
  $isParagraphNode,
  $isTabNode,
  $isTextNode,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {HtmlTextFormatExtension} from '../../extensions/HtmlTextFormatExtension';
import {
  INSERT_ALERT_COMMAND,
  MdastAlertExtension,
} from '../../extensions/MdastAlertExtension';
import {
  CollapsibleNode,
  INSERT_COLLAPSIBLE_COMMAND,
  MdastCollapsibleExtension,
} from '../../extensions/MdastCollapsibleExtension';
import {
  $findFootnoteDefinition,
  $isFootnoteRefNode,
  $isFootnotesNode,
  $removeFootnoteDefinition,
  FOOTNOTES_SLOT,
  INSERT_FOOTNOTE_COMMAND,
  MdastFootnoteExtension,
} from '../../extensions/MdastFootnoteExtension';
import {
  $isKbdNode,
  FORMAT_KBD_COMMAND,
  MdastKbdExtension,
} from '../../extensions/MdastKbdExtension';

function createEditor(): LexicalEditorWithDispose {
  // The caller is responsible for disposal (with `using`). Mirrors
  // MdastEditorExtension minus the app plumbing (persistence, toolbar
  // signals, shiki highlighting) that is irrelevant to the constructs
  // under test.
  return buildEditorFromExtensions(
    defineExtension({
      dependencies: [
        MdastCommonMarkExtension,
        MdastGfmExtension,
        MdastExtension,
        MdastCollapsibleExtension,
        MdastKbdExtension,
        MdastAlertExtension,
        MdastFootnoteExtension,
        HtmlTextFormatExtension,
        RichTextExtension,
        ListExtension,
      ],
      name: '[mdast-editor-example-test]',
    }),
  );
}

function importExport(markdown: string): string {
  using editor = createEditor();
  editor.update(
    () => {
      $convertFromMarkdownString(markdown);
    },
    {discrete: true},
  );
  return editor.read(() => $convertToMarkdownString());
}

function $firstChild(): LexicalNode | null {
  return $getRoot().getFirstChild();
}

/**
 * The `alertType` NodeState is module-private to MdastAlertExtension by
 * design; the serialized editor state is its public observable surface.
 * It is not registered flat on QuoteNode, so it serializes under the `$`
 * state key of the first root-level quote node — and only when set, since
 * NodeState omits default values (`null` here), so a plain quote yields
 * `undefined`.
 */
function alertTypeOf(editor: LexicalEditor): unknown {
  interface SerializedProbe {
    type: string;
    children?: SerializedProbe[];
    $?: {alertType?: unknown};
  }
  const root = editor.getEditorState().toJSON()
    .root as unknown as SerializedProbe;
  const quote = (root.children || []).find(child => child.type === 'quote');
  return quote && quote.$ ? quote.$.alertType : undefined;
}

describe('CollapsibleNode', () => {
  const ENCODING = [
    '<details><summary>',
    'The *summary* line',
    '</summary>',
    '',
    'Body **content**',
    '</details>',
  ].join('\n');

  it('imports the GFM-style encoding into a collapsible', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(ENCODING);
      },
      {discrete: true},
    );
    editor.read(() => {
      const collapsible = $firstChild();
      expect(collapsible).toBeInstanceOf(CollapsibleNode);
      if (!(collapsible instanceof CollapsibleNode)) {
        return;
      }
      // No `open` attribute imports as closed.
      expect(collapsible.isOpen()).toBe(false);
      const summary = $getSlot(collapsible, 'summary');
      expect(summary && summary.getTextContent()).toBe('The summary line');
      // getTextContent includes the slot value ahead of the body children.
      expect(collapsible.getTextContent()).toBe('The summary lineBody content');
      const body = collapsible.getFirstChild();
      expect(body && body.getTextContent()).toBe('Body content');
    });
  });

  it('round-trips the encoding as a fixed point', () => {
    const out = importExport(ENCODING);
    expect(out).toBe(ENCODING);
    expect(importExport(out)).toBe(out);
  });

  it('imports and re-exports the open attribute', () => {
    const openEncoding = ENCODING.replace('<details>', '<details open>');
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(openEncoding);
      },
      {discrete: true},
    );
    editor.read(() => {
      expect(($firstChild() as CollapsibleNode).isOpen()).toBe(true);
    });
    expect(editor.read(() => $convertToMarkdownString())).toBe(openEncoding);
  });

  it('setOpen accepts a value or an updater', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(ENCODING);
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const collapsible = $firstChild() as CollapsibleNode;
        collapsible.setOpen(true);
        expect(collapsible.isOpen()).toBe(true);
        collapsible.setOpen(open => !open);
        expect(collapsible.isOpen()).toBe(false);
      },
      {discrete: true},
    );
  });

  it('exports clipboard HTML with the summary content and no marker', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(ENCODING);
      },
      {discrete: true},
    );
    const html = editor.read(() => $generateHtmlFromNodes(editor));
    expect(html).toContain('<details>');
    // The slot content serializes for the clipboard (with its formatting)...
    expect(html).toMatch(/<summary>.*<em[^>]*>summary<\/em>.*<\/summary>/);
    // ...but the internal Markdown-substitution marker must not leak.
    expect(html).not.toContain('data-lexical-slot');
  });

  it('INSERT_COLLAPSIBLE_COMMAND inserts an open section with a summary slot', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $getRoot().selectEnd();
      },
      {discrete: true},
    );
    editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND);
    editor.read(() => {
      const collapsible = $getRoot()
        .getChildren()
        .find(child => child instanceof CollapsibleNode);
      expect(collapsible).toBeInstanceOf(CollapsibleNode);
      if (!(collapsible instanceof CollapsibleNode)) {
        return;
      }
      expect(collapsible.isOpen()).toBe(true);
      expect($isElementNode($getSlot(collapsible, 'summary'))).toBe(true);
      expect($isParagraphNode(collapsible.getFirstChild())).toBe(true);
    });
  });
});

describe('KbdNode', () => {
  it('imports an inline <kbd> run and round-trips it', () => {
    const source = 'Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy.';
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(source);
      },
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $firstChild();
      expect($isElementNode(paragraph)).toBe(true);
      const kbds = ($isElementNode(paragraph) ? paragraph.getChildren() : [])
        .filter($isKbdNode)
        .map(node => node.getTextContent());
      expect(kbds).toEqual(['Ctrl', 'C']);
    });
    expect(editor.read(() => $convertToMarkdownString())).toBe(source);
  });

  it('keeps Markdown formatting inside the tags', () => {
    const source = 'press <kbd>**⌘K**</kbd>';
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(source);
      },
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $firstChild() as ElementNode;
      const kbd = paragraph.getChildren().find($isKbdNode);
      const text = kbd ? kbd.getFirstChild() : null;
      expect($isTextNode(text) && text.hasFormat('bold')).toBe(true);
    });
    expect(editor.read(() => $convertToMarkdownString())).toBe(source);
  });

  it('FORMAT_KBD_COMMAND wraps the selection and unwraps from within', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('select me please');
      },
      {discrete: true},
    );
    editor.update(
      () => {
        const paragraph = $firstChild();
        const text = $isElementNode(paragraph)
          ? paragraph.getFirstChild()
          : null;
        if ($isTextNode(text)) {
          // "me"
          text.select(7, 9);
        }
      },
      {discrete: true},
    );
    editor.dispatchCommand(FORMAT_KBD_COMMAND);
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      'select <kbd>me</kbd> please',
    );
    // Put the caret inside the key and toggle it back off.
    editor.update(
      () => {
        const paragraph = $firstChild() as ElementNode;
        const kbd = paragraph.getChildren().find($isKbdNode);
        const text = kbd ? kbd.getFirstChild() : null;
        if ($isTextNode(text)) {
          text.select(1, 1);
        }
      },
      {discrete: true},
    );
    editor.dispatchCommand(FORMAT_KBD_COMMAND);
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      'select me please',
    );
  });
});

describe('alerts', () => {
  it.each([
    // The canonical form is a fixed point.
    ['> [!NOTE]\n> body *em* text', '> [!NOTE]\n> body *em* text'],
    // Case-insensitive per current GitHub; export normalizes to uppercase.
    ['> [!note]\n> lower', '> [!NOTE]\n> lower'],
    // Marker-only first paragraph joins to the canonical shape.
    ['> [!CAUTION]\n>\n> after blank', '> [!CAUTION]\n> after blank'],
    // Unknown types stay plain quotes (the bracket escapes like any text).
    ['> [!INFO]\n> not an alert', '> \\[!INFO]\n> not an alert'],
    // Content on the marker line is not an alert on GitHub.
    ['> [!NOTE] same line', '> \\[!NOTE] same line'],
    // Block content in the body.
    [
      '> [!IMPORTANT]\n> intro\n>\n> - one\n> - two',
      '> [!IMPORTANT]\n> intro\n>\n> - one\n> - two',
    ],
  ])('round-trips %j', (source, expected) => {
    expect(importExport(source)).toBe(expected);
    // The output is a fixed point of the round trip.
    expect(importExport(expected)).toBe(expected);
  });

  it('imports the marker as NodeState on a shadow-root QuoteNode', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('> [!WARNING]\n> body');
      },
      {discrete: true},
    );
    editor.read(() => {
      const quote = $firstChild();
      expect($isQuoteNode(quote)).toBe(true);
      if (!$isQuoteNode(quote)) {
        return;
      }
      expect(quote.isShadowRoot()).toBe(true);
      expect(quote.getTextContent()).not.toContain('[!WARNING]');
    });
    expect(alertTypeOf(editor)).toBe('warning');
  });

  it('INSERT_ALERT_COMMAND inserts a typed alert with an editable body', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $getRoot().selectEnd();
      },
      {discrete: true},
    );
    editor.dispatchCommand(INSERT_ALERT_COMMAND, 'tip');
    editor.read(() => {
      const quote = $getRoot().getChildren().find($isQuoteNode);
      expect(quote).toBeDefined();
      expect($isParagraphNode(quote!.getFirstChild())).toBe(true);
    });
    expect(alertTypeOf(editor)).toBe('tip');
    expect(editor.read(() => $convertToMarkdownString())).toContain('> [!TIP]');
  });

  it('exports clipboard HTML as GitHub-rendered alert markup', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('> [!NOTE]\n> body');
      },
      {discrete: true},
    );
    const html = editor.read(() => $generateHtmlFromNodes(editor));
    expect(html).toContain('markdown-alert-note');
    expect(html).toContain('<p class="markdown-alert-title">Note</p>');
  });

  it('imports GitHub-rendered alert markup, stripping the title chrome', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const dom = new DOMParser().parseFromString(
          '<div class="markdown-alert markdown-alert-caution"><p class="markdown-alert-title">Caution</p><p>pasted <strong>body</strong></p></div>',
          'text/html',
        );
        $getRoot()
          .clear()
          .append(...$generateNodesFromDOMViaExtension(dom));
      },
      {discrete: true},
    );
    editor.read(() => {
      const quote = $firstChild();
      expect($isQuoteNode(quote)).toBe(true);
      if (!$isQuoteNode(quote)) {
        return;
      }
      // The fixed title is chrome, not content.
      expect(quote.getTextContent()).toBe('pasted body');
    });
    expect(alertTypeOf(editor)).toBe('caution');
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      '> [!CAUTION]\n> pasted **body**',
    );
  });

  it('leaves plain blockquotes alone (shadow-root import branch)', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('> just a *quote*');
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($isQuoteNode($firstChild())).toBe(true);
    });
    expect(alertTypeOf(editor)).toBeUndefined();
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      '> just a *quote*',
    );
  });
});

describe('footnotes', () => {
  it.each([
    ['body[^a] text\n\n[^a]: the note', 'body[^a] text\n\n[^a]: the note'],
    // Multi-block definitions keep their continuation indent.
    [
      'x[^n]\n\n[^n]: first para\n\n    second *block*',
      'x[^n]\n\n[^n]: first para\n\n    second *block*',
    ],
    // Unreferenced definitions survive: an editor preserves content.
    [
      'no refs here\n\n[^orphan]: kept anyway',
      'no refs here\n\n[^orphan]: kept anyway',
    ],
    // A bold italic ref merges with the bold italic text around it.
    ['***x[^a] y***\n\n[^a]: n', '***x[^a] y***\n\n[^a]: n'],
    ['**a *b[^a]***\n\n[^a]: n', '**a *b[^a]***\n\n[^a]: n'],
    ['**_x_[^a]**\n\n[^a]: n', '**_x_[^a]**\n\n[^a]: n'],
    ['**a *b[^a]c***\n\n[^a]: n', '**a *b[^a]c***\n\n[^a]: n'],
    ['**x *[^a]y***\n\n[^a]: n', '**x *[^a]y***\n\n[^a]: n'],
    ['**x _[^a]_**_z_\n\n[^a]: n', '**x _[^a]_**_z_\n\n[^a]: n'],
    ['*x __[^a]__*__z__\n\n[^a]: n', '*x __[^a]__*__z__\n\n[^a]: n'],
    ['~~a **b[^a]**~~ c\n\n[^a]: n', '~~a **b[^a]**~~ c\n\n[^a]: n'],
    ['*ld*~~***llo[^a]***~~\n\n[^a]: n', '*ld*~~***llo[^a]***~~\n\n[^a]: n'],
    [
      '*ld*~~***llo***~~ x[^a]\n\n[^a]: n',
      '*ld*~~***llo***~~ x[^a]\n\n[^a]: n',
    ],
    // Undefined refs stay literal, GitHub-style.
    ['no def[^ghost] here', 'no def\\[^ghost] here'],
    // Definitions serialize at the END regardless of source position.
    [
      '[^early]: defined first\n\nbody[^early] text',
      'body[^early] text\n\n[^early]: defined first',
    ],
  ])('round-trips %j', (source, expected) => {
    expect(importExport(source)).toBe(expected);
    expect(importExport(expected)).toBe(expected);
  });

  it.each([
    // A ref alone in the emphasis.
    'x **[^a]** y\n\n[^a]: note',
    // A ref sharing the emphasis with text: the ref exports through its own
    // handler (outside the text-run accumulator), so without the adjacent
    // same-type phrasing merge this would serialize as the broken
    // `**x****[^a]**`.
    '**x[^a]**\n\n[^a]: note',
    '*em[^a]* and ~~gone[^a]~~\n\n[^a]: note',
  ])('formatted references round-trip %j', source => {
    expect(importExport(source)).toBe(source);
  });

  it('a surrounding format imports onto the ref (DecoratorTextNode)', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('**bold[^a]**\n\n[^a]: note');
      },
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $firstChild();
      const ref = (
        $isElementNode(paragraph) ? paragraph.getChildren() : []
      ).find($isFootnoteRefNode);
      expect(ref).toBeDefined();
      expect(ref!.hasFormat('bold')).toBe(true);
      expect(ref!.hasFormat('italic')).toBe(false);
    });
  });

  it('imports refs inline and relocates definitions to the root slot', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('body[^a] text\n\n[^a]: the *note*');
      },
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $firstChild();
      expect($isElementNode(paragraph)).toBe(true);
      const ref = (
        $isElementNode(paragraph) ? paragraph.getChildren() : []
      ).find($isFootnoteRefNode);
      expect(ref).toBeDefined();
      expect(ref!.getLabel()).toBe('a');
      // No definition remains in the document flow (the root's own text
      // includes slot values, so check the children channel only)...
      const bodyText = $getRoot()
        .getChildren()
        .map(child => child.getTextContent())
        .join('');
      expect(bodyText).not.toContain('note');
      // ...it lives in the FootnotesNode on the root's footnotes slot.
      const footnotes = $getSlot($getRoot(), FOOTNOTES_SLOT);
      expect($isFootnotesNode(footnotes)).toBe(true);
      const definition = $findFootnoteDefinition('a');
      expect(definition).not.toBeNull();
      expect(definition!.getTextContent()).toBe('the note');
    });
  });

  it('matches definitions case-insensitively', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('body[^Note]\n\n[^note]: text');
      },
      {discrete: true},
    );
    editor.read(() => {
      expect($findFootnoteDefinition('NOTE')).not.toBeNull();
    });
  });

  it('INSERT_FOOTNOTE_COMMAND mints an auto-numbered ref and definition', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('text[^1]\n\n[^1]: taken');
        $getRoot().getFirstChild()!.selectEnd();
      },
      {discrete: true},
    );
    editor.dispatchCommand(INSERT_FOOTNOTE_COMMAND);
    // `1` is taken, so the new footnote is `2` — and the caret moved into
    // its definition body.
    editor.read(() => {
      expect($findFootnoteDefinition('2')).not.toBeNull();
    });
    const out = editor.read(() => $convertToMarkdownString());
    expect(out).toContain('[^2]');
    expect(out).toContain('[^2]:');
  });

  it('the [^label] typing shortcut materializes a ref and definition', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('see');
      },
      {discrete: true},
    );
    // Simulate typing: append the raw syntax with a collapsed caret at its
    // end; the update listener materializes it after the commit.
    editor.update(
      () => {
        const paragraph = $firstChild();
        const text = $isElementNode(paragraph)
          ? paragraph.getFirstChild()
          : null;
        if ($isTextNode(text)) {
          const next = text.setTextContent('see[^q]');
          next.select(7, 7);
        }
      },
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $firstChild();
      const ref = (
        $isElementNode(paragraph) ? paragraph.getChildren() : []
      ).find($isFootnoteRefNode);
      expect(ref).toBeDefined();
      expect(ref!.getLabel()).toBe('q');
      expect($findFootnoteDefinition('q')).not.toBeNull();
    });
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      'see[^q]\n\n[^q]:',
    );
  });

  it('$removeFootnoteDefinition cascades to the references', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          'one[^a] two[^a] other[^b]\n\n[^a]: gone\n\n[^b]: kept',
        );
      },
      {discrete: true},
    );
    // What the × button in the definition's marker chrome runs: the
    // definition goes, and every `[^a]` marker in the body goes with it.
    editor.update(
      () => {
        $removeFootnoteDefinition($findFootnoteDefinition('a')!);
      },
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      'one two other[^b]\n\n[^b]: kept',
    );
  });

  it('a selection export carries only the definitions its refs use', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          'one[^a] mid[^b] end\n\n[^a]: note a\n\n[^b]: note b\n\n[^c]: orphan',
        );
      },
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $firstChild();
      const texts = (
        $isElementNode(paragraph) ? paragraph.getChildren() : []
      ).filter($isTextNode);
      // From the start of 'one' to just after ' mid': [^a] is inside the
      // selection, [^b] is not, and [^c] is referenced nowhere.
      const selection = $createRangeSelection();
      selection.anchor.set(texts[0].getKey(), 0, 'text');
      selection.focus.set(texts[1].getKey(), 4, 'text');
      expect($convertSelectionToMarkdownString(selection)).toBe(
        'one[^a] mid\n\n[^a]: note a',
      );
      // No refs selected -> no definitions appended (the whole-document
      // export still keeps all three, the orphan included).
      const noRefs = $createRangeSelection();
      noRefs.anchor.set(texts[2].getKey(), 1, 'text');
      noRefs.focus.set(texts[2].getKey(), 4, 'text');
      expect($convertSelectionToMarkdownString(noRefs)).toBe('end');
      expect($convertToMarkdownString()).toBe(
        'one[^a] mid[^b] end\n\n[^a]: note a\n\n[^b]: note b\n\n[^c]: orphan',
      );
    });
  });

  it('clipboard HTML from a ref selection appends its definition', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString(
          'one[^a] x[^b]\n\n[^a]: note a\n\n[^b]: note b',
        );
      },
      {discrete: true},
    );
    const data = editor.read(() => {
      const paragraph = $firstChild();
      const texts = (
        $isElementNode(paragraph) ? paragraph.getChildren() : []
      ).filter($isTextNode);
      const selection = $createRangeSelection();
      selection.anchor.set(texts[0].getKey(), 0, 'text');
      selection.focus.set(texts[1].getKey(), 2, 'text');
      return $getClipboardDataFromSelection(selection);
    });
    const html = data['text/html']!;
    expect(html).toContain('data-footnote-ref="a"');
    expect(html).toContain('data-footnote-def="a"');
    expect(html).toContain('note a');
    // [^b] was outside the selection: neither its ref nor its note copies.
    expect(html).not.toContain('note b');
  });

  it('imports the definition envelope from clipboard HTML', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const dom = new DOMParser().parseFromString(
          '<p>body <sup data-footnote-ref="z">[^z]</sup></p>' +
            '<div data-footnote-def="z">' +
            '<span data-footnote-def-label>[^z]: </span>' +
            '<p>note z</p></div>',
          'text/html',
        );
        $getRoot()
          .clear()
          .append(...$generateNodesFromDOMViaExtension(dom));
      },
      {discrete: true},
    );
    // The pasted definition relocated into the footnotes slot (the marker
    // span stayed chrome), and the ref points at it.
    expect(editor.read(() => $convertToMarkdownString())).toBe(
      'body [^z]\n\n[^z]: note z',
    );
  });

  it('exports the ref as clipboard HTML and imports it back', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('x[^r]\n\n[^r]: note');
      },
      {discrete: true},
    );
    const html = editor.read(() => $generateHtmlFromNodes(editor));
    expect(html).toContain('data-footnote-ref="r"');
    editor.update(
      () => {
        const dom = new DOMParser().parseFromString(
          '<p>pasted <sup data-footnote-ref="r">[^r]</sup></p>',
          'text/html',
        );
        $getRoot()
          .clear()
          .append(...$generateNodesFromDOMViaExtension(dom));
      },
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $firstChild();
      const ref = (
        $isElementNode(paragraph) ? paragraph.getChildren() : []
      ).find($isFootnoteRefNode);
      expect(ref).toBeDefined();
      expect(ref!.getLabel()).toBe('r');
    });
  });
});

describe('read-only', () => {
  it('mutating commands are inert on a read-only editor', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('hello[^a]\n\n[^a]: note');
        $getRoot().selectEnd();
      },
      {discrete: true},
    );
    editor.setEditable(false);
    const before = editor.read(() => $convertToMarkdownString());
    editor.dispatchCommand(INSERT_FOOTNOTE_COMMAND);
    editor.dispatchCommand(INSERT_COLLAPSIBLE_COMMAND);
    editor.dispatchCommand(INSERT_ALERT_COMMAND, 'note');
    editor.dispatchCommand(FORMAT_KBD_COMMAND);
    expect(editor.read(() => $convertToMarkdownString())).toBe(before);
    // Selection changes stay allowed.
    editor.update(
      () => {
        $getRoot().selectStart();
      },
      {discrete: true},
    );
    expect(editor.read(() => $convertToMarkdownString())).toBe(before);
  });
});

describe('HtmlTextFormatExtension', () => {
  it('nests bold italic in an HTML format as the core text does', () => {
    expect(importExport('***x*** <u>***y***</u>')).toBe(
      '***x*** <u>***y***</u>',
    );
  });

  it('preserves a tab between formatted text through the custom text rule', () => {
    using editor = createEditor();
    editor.update(
      () => {
        const nodes = [
          $createTextNode('left'),
          $createTabNode(),
          $createTextNode('right'),
        ];
        for (const node of nodes) {
          node
            .toggleFormat('underline')
            .toggleFormat('bold')
            .setStyle('color: red;');
        }
        $getRoot()
          .clear()
          .append($createParagraphNode().append(...nodes));
      },
      {discrete: true},
    );
    const markdown = editor.read(() => $convertToMarkdownString());
    expect(markdown).toBe(
      '<u><span style="color: red;">**left**</span></u>' +
        '<u><span style="color: red;">**&#x9;**</span></u>' +
        '<u><span style="color: red;">**right**</span></u>',
    );
    editor.update(() => $convertFromMarkdownString(markdown), {discrete: true});
    editor.read(() => {
      const paragraph = $firstChild();
      expect($isElementNode(paragraph)).toBe(true);
      if ($isElementNode(paragraph)) {
        const children = paragraph.getChildren();
        expect(children.map(node => node.getTextContent())).toEqual([
          'left',
          '\t',
          'right',
        ]);
        expect($isTabNode(children[1])).toBe(true);
        for (const child of children) {
          expect($isTextNode(child) && child.hasFormat('underline')).toBe(true);
          expect($isTextNode(child) && child.hasFormat('bold')).toBe(true);
          expect($isTextNode(child) && child.getStyle()).toBe('color: red;');
        }
      }
    });
  });

  it('round-trips the formats Markdown cannot express', () => {
    const source =
      '<u>underline</u>, <mark>highlight</mark>, H<sub>2</sub>O, e=mc<sup>2</sup>, and <span style="color: red;">styled text</span>.';
    expect(importExport(source)).toBe(source);
  });

  it('composes html tags with Markdown formatting', () => {
    expect(importExport('<u>**both**</u>')).toBe('<u>**both**</u>');
  });

  it('imports allowlisted span styles onto the text', () => {
    using editor = createEditor();
    editor.update(
      () => {
        $convertFromMarkdownString('<span style="color: red;">styled</span>');
      },
      {discrete: true},
    );
    editor.read(() => {
      const paragraph = $firstChild();
      const text = $isElementNode(paragraph) ? paragraph.getFirstChild() : null;
      expect($isTextNode(text)).toBe(true);
      if ($isTextNode(text)) {
        expect(text.getStyle()).toContain('color: red');
      }
    });
  });
});
