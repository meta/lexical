/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {$convertToMarkdownString} from '@lexical/mdast';
import {ExtensionComponent} from '@lexical/react/ExtensionComponent';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {TreeViewExtension} from '@lexical/react/TreeViewExtension';
import {configExtension, defineExtension} from 'lexical';
import {useState} from 'react';

import {
  docShareUrl,
  MarkdownPersistenceExtension,
  markdownShareUrl,
  RESET_MARKDOWN_COMMAND,
} from './extensions/MarkdownPersistenceExtension';
import {ToolbarStateExtension} from './extensions/ToolbarStateExtension';
import {MarkdownSourcePlugin} from './plugins/MarkdownSourcePlugin';
import {ToolbarPlugin} from './plugins/ToolbarPlugin';

const STORAGE_KEY = '@lexical/dev-mdast-editor-example/document';

const DEMO_MARKDOWN = `# Mdast Editor

This is a **WYSIWYG** editor built on [@lexical/mdast](https://github.com/meta/lexical),
which parses with *micromark* — the same CommonMark + GFM parser used by remark —
and keeps the markdown on the right in sync as you type.

## Try the inline shortcuts

- \`# \`, \`## \`, \`### \` for headings
- \`**bold**\`, \`*italic*\`, \`***both***\`, \`~~strikethrough~~\`
- Wrap text in \`backticks\` for inline code
- \`[text](url)\` for links
- \`- \` or \`1. \` for lists, \`- [ ] \` / \`- [x] \` for check lists
- \`> \` for a blockquote, \` \`\`\`js \` + Enter for a code block

## Round-trip fidelity

The original syntax is preserved on the nodes, so most of what you paste
comes back as written — bullet styles, code fences, setext headings, hard breaks:

> Blockquotes survive round-trips,
> including *inline formatting*.

Formats Markdown can't express travel as inline HTML: <u>underline</u>, <mark>highlight</mark>, H<sub>2</sub>O, e=mc<sup>2</sup>, and <span style="color: red;">styled text</span>.

Custom inline nodes ride the same mechanism — press <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy, or <kbd>**⌘K**</kbd> with Markdown inside the tags.

Footnotes[^1] live in a \`footnotes\` slot on the RootNode — outside the
document's children — and serialize to the end of the Markdown[^details].
Type \`[^another]\` to mint one.

1. Ordered list item one
2. Ordered list item two

- [x] Streaming shortcuts share the import grammar
- [x] Syntax preserved via NodeState
- [ ] Ship it

## Tables

GFM tables round-trip as tables: the first row is the header, a line
break in a cell is written as \`<br>\`, and a column is written with the
alignment of its header cell's content (Table > Align left, center or
right in the header). Merged cells (from a pasted HTML table) are written
as near as GFM allows, and a body cell's own alignment is dropped:

| Syntax    | Description           | Width |
| --------- | --------------------- | ----: |
| Header    | Title<br>on two lines |     6 |
| Paragraph | \`a \\| b\` and **bold** |    10 |

## Alerts

GitHub-style alerts are plain blockquotes with a \`[!TYPE]\` marker: the
type is NodeState on the ordinary quote node, and the chrome is a
\`DOMRenderExtension\` override — no custom node class. Click a title
to pick another type or convert back to a blockquote:

> [!NOTE]
> Useful information that users should know, even when skimming.

> [!WARNING]
> Critical content demanding immediate attention — with
> *inline formatting* and other **Markdown** intact.

## Collapsible sections

Raw HTML blocks import through the editor's HTML import rules — with
the Markdown blocks inside them intact, GitHub-style, and Markdown in the
text between the tags too, which GitHub leaves raw — so GFM-style
\`<details>\` blocks map to a collapsible node whose summary line is
edited in a named slot:

<details><summary>
This is the *summary* that shows when collapsed
</summary>

This is the *collapsed content* that's only visible when open
</details>

---

\`\`\`ts
const editor = buildEditorFromExtensions({
  name: 'editor',
  dependencies: [
    MdastCommonMarkExtension,
    MdastGfmExtension,
    MdastShortcutsExtension,
  ],
});
\`\`\`

[^1]: The reference is an inline node; this definition body is editable
    in the section below.

[^details]: Definitions hold *block* content, so lists and code work here.`;

const theme = {
  code: 'my-2 block rounded-md bg-zinc-100 p-3 font-mono text-sm whitespace-pre dark:bg-zinc-900',
  heading: {
    h1: 'mb-2 text-3xl font-bold',
    h2: 'mb-2 text-2xl font-bold',
    h3: 'mb-1 text-xl font-semibold',
  },
  link: 'text-blue-600 underline dark:text-blue-400',
  list: {
    checklist: 'list-none pl-0',
    listitem: 'mx-6 my-0.5',
    listitemChecked:
      'relative list-none pl-6 line-through text-zinc-500 before:absolute before:top-0.5 before:left-0 before:flex before:h-4 before:w-4 before:items-center before:justify-center before:rounded-sm before:border before:border-solid before:border-zinc-400 before:bg-blue-500 before:text-[10px] before:leading-none before:text-white before:content-["✓"]',
    listitemUnchecked:
      'relative list-none pl-6 before:absolute before:top-0.5 before:left-0 before:h-4 before:w-4 before:rounded-sm before:border before:border-solid before:border-zinc-400 before:bg-transparent before:content-[""]',
    nested: {
      listitem: 'list-none',
    },
    ol: 'm-0 list-decimal pl-6',
    ul: 'm-0 list-disc pl-6',
  },
  paragraph: 'my-1',
  quote:
    'my-2 border-l-4 border-solid border-zinc-300 pl-3 text-zinc-600 dark:border-zinc-600 dark:text-zinc-300',
  table: 'my-2 border-collapse',
  tableCell:
    'min-w-16 border border-solid border-zinc-300 px-2 py-1 text-start align-top dark:border-zinc-600',
  tableCellHeader: 'bg-zinc-100 font-semibold dark:bg-zinc-800',
  // Over tableCellHeader's background.
  tableCellSelected: 'bg-blue-100! dark:bg-blue-900/40!',
  tableScrollableWrapper: 'overflow-x-auto',
  tableSelection: 'table-selection',
  text: {
    bold: 'font-bold',
    code: 'rounded bg-zinc-200/70 px-1 py-0.5 font-mono text-[0.9em] dark:bg-zinc-700/60',
    highlight: 'rounded-sm bg-yellow-200/80 px-0.5 dark:bg-yellow-500/30',
    italic: 'italic',
    strikethrough: 'line-through',
    subscript: 'align-sub text-[0.8em]',
    superscript: 'align-super text-[0.8em]',
    underline: 'underline',
    underlineStrikethrough: 'underline line-through',
  },
};

const mdastEditorExtension = defineExtension({
  dependencies: [
    configExtension(MarkdownPersistenceExtension, {
      defaultMarkdown: DEMO_MARKDOWN,
      storageKey: STORAGE_KEY,
    }),
    ToolbarStateExtension,
    // The devtools panel below the editor: the same debug view the
    // playground shows, as an extension output component (its default
    // config carries the tree-view-output/debug-* class names).
    TreeViewExtension,
  ],
  name: '@lexical/dev-mdast-editor-example/Editor',
  namespace: '@lexical/dev-mdast-editor-example',
  theme,
});

const paneButtonClass =
  'cursor-pointer rounded-md border border-solid border-transparent bg-transparent px-2 py-0.5 text-[10px] font-medium tracking-wide text-zinc-500 normal-case transition-colors duration-150 enabled:hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:enabled:hover:bg-zinc-700';

function ResetButton({disabled}: {disabled: boolean}) {
  const [editor] = useLexicalComposerContext();
  return (
    <button
      type="button"
      // Reset replaces the document, so it follows the pane's lock.
      disabled={disabled}
      onClick={() => editor.dispatchCommand(RESET_MARKDOWN_COMMAND)}
      className={paneButtonClass}>
      Reset
    </button>
  );
}

/**
 * The Markdown pane's own read-only lock. It is independent of the rich
 * text editor's read-only state (the toolbar lock): either side can be
 * locked while the other stays editable.
 */
function PaneLockButton({
  locked,
  onToggle,
}: {
  locked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={paneButtonClass}
      aria-label="Toggle Markdown read-only mode"
      title={locked ? 'Unlock Markdown editing' : 'Lock Markdown editing'}
      aria-pressed={locked}>
      {locked ? '\u{1F512}' : '\u{1F513}'}
    </button>
  );
}

// Repro links: put the current document in the URL hash (and on the
// clipboard) so a bug report can reproduce it with a plain link. Two
// encodings — `#md=` carries the Markdown source (hand-editable), `#doc=`
// carries the full editor state JSON in the playground's compressed
// convention (for shapes Markdown can't express).
function ShareButton({kind}: {kind: 'doc' | 'md'}) {
  const [editor] = useLexicalComposerContext();
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url =
      kind === 'md'
        ? markdownShareUrl(editor.read(() => $convertToMarkdownString()))
        : await docShareUrl(editor);
    window.history.replaceState({}, '', url);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // The URL bar still carries the link when the clipboard is denied.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" onClick={share} className={paneButtonClass}>
      {copied ? 'Copied!' : kind === 'md' ? 'Share MD' : 'Share JSON'}
    </button>
  );
}

export default function Editor() {
  const [sourceLocked, setSourceLocked] = useState(false);
  return (
    <LexicalExtensionComposer
      extension={mdastEditorExtension}
      contentEditable={null}>
      <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-solid border-black/10 dark:border-white/10 dark:bg-stone-800">
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
          <div className="relative flex min-h-0 flex-col border-b [border-bottom-style:solid] border-b-black/10 md:border-r md:border-b-0 md:[border-right-style:solid] md:border-r-black/10 dark:border-b-white/10 dark:md:border-r-white/10">
            <div className="flex h-11 shrink-0 items-center gap-1 border-b [border-bottom-style:solid] border-b-black/10 bg-zinc-50 px-2 dark:border-b-white/10 dark:bg-zinc-800">
              <ToolbarPlugin />
            </div>
            <div className="relative flex-1 overflow-auto">
              <ContentEditable
                className="min-h-full p-4 text-base leading-relaxed text-wrap outline-none"
                aria-label="Markdown editor"
                aria-placeholder="Start writing markdown..."
                placeholder={
                  <div className="pointer-events-none absolute top-4 left-4 text-zinc-400 select-none">
                    Start writing markdown...
                  </div>
                }
              />
            </div>
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="flex h-11 shrink-0 items-center justify-between border-b [border-bottom-style:solid] border-b-black/10 bg-zinc-50 px-4 dark:border-b-white/10 dark:bg-zinc-800">
              <span className="text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                Markdown
              </span>
              <div className="flex items-center gap-0.5">
                <ShareButton kind="md" />
                <ShareButton kind="doc" />
                <ResetButton disabled={sourceLocked} />
                <PaneLockButton
                  locked={sourceLocked}
                  onToggle={() => setSourceLocked(locked => !locked)}
                />
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-white dark:bg-stone-800">
              <MarkdownSourcePlugin readOnly={sourceLocked} />
            </div>
          </div>
        </div>
        <div className="shrink-0 border-t [border-top-style:solid] border-t-black/10 dark:border-t-white/10">
          <ExtensionComponent lexical:extension={TreeViewExtension} />
        </div>
      </div>
    </LexicalExtensionComposer>
  );
}
