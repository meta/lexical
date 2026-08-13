# Included Extensions

[@lexical/a11y](/docs/api/modules/lexical_a11y)

Framework-agnostic accessibility extensions. See [Keyboard Accessibility](/docs/concepts/keyboard-accessibility) for the full contract and the matching `@lexical/react` adapters.

- [AriaLiveRegionExtension](/docs/api/modules/lexical_a11y#arialiveregionextension) - Owns a visually hidden `aria-live` region and exposes a stable `announce` sink (WAI-ARIA status messages, WCAG 4.1.3)
- [EditorModeAnnounceExtension](/docs/api/modules/lexical_a11y#editormodeannounceextension) - Announces editable / read-only transitions through the live region
- [FocusManagerExtension](/docs/api/modules/lexical_a11y#focusmanagerextension) - Editor ↔ toolbar focus jump (Alt+F10 to the toolbar, Escape back to the editor), reference-counted per toolbar
- [FocusTrapExtension](/docs/api/modules/lexical_a11y#focustrapextension) - Traps Tab / Shift+Tab focus inside one or more containers (modal dialogs), reference-counted per container
- [HistoryAnnounceExtension](/docs/api/modules/lexical_a11y#historyannounceextension) - Announces undo / redo through the live region
- [RovingTabIndexExtension](/docs/api/modules/lexical_a11y#rovingtabindexextension) - WAI-ARIA roving-tabindex pattern for toolbars / groups, reference-counted per container

[@lexical/clipboard](/docs/api/modules/lexical_clipboard)

- [ClipboardDOMImportExtension](/docs/api/modules/lexical_clipboard#clipboarddomimportextension) - Routes `text/html` pastes and drops through the `DOMImportExtension` pipeline (experimental)
- [ClipboardImportExtension](/docs/api/modules/lexical_clipboard#clipboardimportextension) - Configurable per-MIME-type clipboard import for paste and drop (experimental)
- [GetClipboardDataExtension](/docs/api/modules/lexical_clipboard#getclipboarddataextension) - Configurable serialization of the selection into clipboard MIME types for copy and drag

[@lexical/code](/docs/api/modules/lexical_code)

- [CodeExtension](/docs/api/modules/lexical_code#codeextension) - CodeNode (code blocks)
- [CodeIndentExtension](/docs/api/modules/lexical_code#codeindentextension) - CodeNode tab key indentation (code blocks)

[@lexical/code-prism](/docs/api/modules/lexical_code-prism)

- [CodePrismExtension](/docs/api/modules/lexical_code-prism#codeprismextension) - Highlighting with Prism for CodeNode

[@lexical/code-shiki](/docs/api/modules/lexical_code-shiki)

- [CodeShikiExtension](/docs/api/modules/lexical_code-shiki#codeshikiextension) - Highlighting with Shiki for CodeNode

[@lexical/dragon](/docs/api/modules/lexical_dragon)

- [DragonExtension](/docs/api/modules/lexical_dragon#dragonextension) - Dragon (speech to text) support, included by default with `RichTextExtension` and `PlainTextExtension`

[@lexical/extension](/docs/api/modules/lexical_extension)

- [AutoFocusExtension](/docs/api/modules/lexical_extension#autofocusextension) - Focus the editor when it is created (e.g. on page load)
- [ClearEditorExtension](/docs/api/modules/lexical_extension#cleareditorextension) - Implementation for the `CLEAR_EDITOR_COMMAND`
- [ClickAfterLastBlockExtension](/docs/api/modules/lexical_extension#clickafterlastblockextension) - Inserts a paragraph when clicking below a last block that can not accommodate the click (e.g. a DecoratorNode or TableNode)
- [DecoratorTextExtension](/docs/api/modules/lexical_extension#decoratortextextension) - DecoratorTextNode support, sets the format and CSS classes for the DOM container
- [EditorStateExtension](/docs/api/modules/lexical_extension#editorstateextension) - Provide EditorState as a signal (alternative to `registerUpdateListener`)
- [HorizontalRuleExtension](/docs/api/modules/lexical_extension#horizontalruleextension) - HorizontalRuleNode (`<hr>` tag)
- [IMEExtension](/docs/api/modules/lexical_extension#imeextension) - Centralizes IME composition state as signals
- [InitialStateExtension](/docs/api/modules/lexical_extension#initialstateextension) - Sets the initial state of the editor (always included)
- [NestedEditorExtension](/docs/api/modules/lexical_extension#nestededitorextension) - Configures an editor as a nested editor of a parent editor (theme inheritance, optionally editable state)
- [NodeSelectionExtension](/docs/api/modules/lexical_extension#nodeselectionextension) - Tracks selection, typically for DecoratorNodes
- [NodeSelectionDataSelectedExtension](/docs/api/modules/lexical_extension#nodeselectiondataselectedextension) - Mirrors a node's `NodeSelection` membership onto its host DOM as a `data-selected` attribute so CSS can outline selected `ElementNode` hosts; configured per node type (experimental)
- [NormalizeInlineElementsExtension](/docs/api/modules/lexical_extension#normalizeinlineelementsextension) - Removes empty inline elements, included by default with `RichTextExtension` and `PlainTextExtension`
- [NormalizeTripleClickSelectionExtension](/docs/api/modules/lexical_extension#normalizetripleclickselectionextension) - Corrects over-selection after triple click events, included by default with `RichTextExtension` and `PlainTextExtension`
- [PreventSelectAllExtension](/docs/api/modules/lexical_extension#preventselectallextension) - Prevents select all (Ctrl/Cmd+A) inside input/textarea elements from selecting the editor content, included by default with `SelectBlockExtension`
- [RootElementExtension](/docs/api/modules/lexical_extension#rootelementextension) - Exposes the editor's root element as a reactive `Signal<HTMLElement | null>`
- [SelectBlockExtension](/docs/api/modules/lexical_extension#selectblockextension) - Select all (Ctrl/Cmd+A) selects the nearest block element first, pressing it again selects the whole document
- [SelectionAlwaysOnDisplayExtension](/docs/api/modules/lexical_extension#selectionalwaysondisplayextension) - Highlights selected content even when the editor is not focused
- [TabIndentationExtension](/docs/api/modules/lexical_extension#tabindentationextension) - Changes Tab key to insert tabs and indent instead of natively focusing the next field
- [WatchEditableExtension](/docs/api/modules/lexical_extension#watcheditableextension) - Exposes the editor's editable state as a reactive `Signal<boolean>`

[@lexical/hashtag](/docs/api/modules/lexical_hashtag)

- [HashtagExtension](/docs/api/modules/lexical_hashtag#hashtagextension) - HashtagNode

[@lexical/history](/docs/api/modules/lexical_history)

- [HistoryExtension](/docs/api/modules/lexical_history#historyextension) - History support (undo/redo)
- [SharedHistoryExtension](/docs/api/modules/lexical_history#sharedhistoryextension) - History sharing between a parent editor and its nested editors

[@lexical/html](/docs/api/modules/lexical_html)

- [CoreImportExtension](/docs/api/modules/lexical_html#coreimportextension) - DOM import rules for the core nodes, included implicitly by node-providing extensions (experimental)
- [DOMImportExtension](/docs/api/modules/lexical_html#domimportextension) - Extension-based replacement for `importDOM`/`DOMConversion`, rules are compiled into a dispatcher at editor build time (experimental)
- [DOMRenderExtension](/docs/api/modules/lexical_html#domrenderextension) - Overrides the DOM render and export behavior for an editor (experimental)

[@lexical/link](/docs/api/modules/lexical_link)

- [AutoLinkExtension](/docs/api/modules/lexical_link#autolinkextension) - AutoLinkNode, note that matchers have to be manually configured
- [ClickableLinkExtension](/docs/api/modules/lexical_link#clickablelinkextension) - Toggle between lexical selection and native click to open behavior for links
- [LinkExtension](/docs/api/modules/lexical_link#linkextension) - LinkNode (`<a>` tag)

[@lexical/list](/docs/api/modules/lexical_list)

- [ListExtension](/docs/api/modules/lexical_list#listextension) - ListNode, ListItemNode
- [CheckListExtension](/docs/api/modules/lexical_list#checklistextension) - Checklist support for ListNode and ListItemNode

[@lexical/mark](/docs/api/modules/lexical_mark)

- [MarkExtension](/docs/api/modules/lexical_mark#markextension) - MarkNode

[@lexical/mdast](/docs/api/modules/lexical_mdast)

Experimental micromark/mdast-based Markdown support (every extension in this package is experimental). See [Markdown with @lexical/mdast](/docs/serialization/markdown-mdast) for the full story.

- [MdastImportExtension](/docs/api/modules/lexical_mdast#mdastimportextension) - The core registry: compiles the rules and grammar contributed by feature extensions, exposes `$convertFromMarkdownString` / `$convertFromMdast`
- [MdastExportExtension](/docs/api/modules/lexical_mdast#mdastexportextension) - Serialization back to Markdown (`$convertToMarkdownString` / `$convertToMdast`); separate from import so import-only editors don't bundle the serializer
- [MdastExtension](/docs/api/modules/lexical_mdast#mdastextension) - Bundle of `MdastImportExtension` + `MdastExportExtension`
- [MdastHeadingExtension](/docs/api/modules/lexical_mdast#mdastheadingextension) - ATX & setext headings (HeadingNode)
- [MdastBlockquoteExtension](/docs/api/modules/lexical_mdast#mdastblockquoteextension) - Block quotes (QuoteNode)
- [MdastRichTextExtension](/docs/api/modules/lexical_mdast#mdastrichtextextension) - Bundle of heading + blockquote
- [MdastListExtension](/docs/api/modules/lexical_mdast#mdastlistextension) - Ordered/unordered lists (ListNode, ListItemNode)
- [MdastTaskListExtension](/docs/api/modules/lexical_mdast#mdasttasklistextension) - GFM task lists (`- [x]`), layered on MdastListExtension
- [MdastCodeExtension](/docs/api/modules/lexical_mdast#mdastcodeextension) - Fenced & indented code blocks (CodeNode)
- [MdastLinkExtension](/docs/api/modules/lexical_mdast#mdastlinkextension) - Links, CommonMark autolinks, reference links (LinkNode)
- [MdastAutolinkLiteralExtension](/docs/api/modules/lexical_mdast#mdastautolinkliteralextension) - GFM literal autolinks (bare URLs in prose)
- [MdastHorizontalRuleExtension](/docs/api/modules/lexical_mdast#mdasthorizontalruleextension) - Thematic breaks (HorizontalRuleNode)
- [MdastStrikethroughExtension](/docs/api/modules/lexical_mdast#mdaststrikethroughextension) - GFM strikethrough (text format)
- [MdastTableExtension](/docs/api/modules/lexical_mdast#mdasttableextension) - GFM tables (TableNode, ...)
- [MdastCommonMarkExtension](/docs/api/modules/lexical_mdast#mdastcommonmarkextension) - Bundle of the six CommonMark extensions
- [MdastGfmExtension](/docs/api/modules/lexical_mdast#mdastgfmextension) - Bundle of the four GFM extensions
- [MdastShadowRootQuoteExtension](/docs/api/modules/lexical_mdast#mdastshadowrootquoteextension) - Opt-in: blockquotes as block containers with full-fidelity nested content
- [MdastHtmlExtension](/docs/api/modules/lexical_mdast#mdasthtmlextension) - Opt-in: raw HTML in Markdown routed through the `@lexical/html` DOM import rules (Markdown inside the tags included, GitHub-style), plus generic HTML-encoded export via `$exportViaDOM` / `rawHtmlBlock`
- [MdastShortcutsExtension](/docs/api/modules/lexical_mdast#mdastshortcutsextension) - Streaming Markdown typing shortcuts, driven by the same grammar as import

[@lexical/overflow](/docs/api/modules/lexical_overflow)

- [OverflowExtension](/docs/api/modules/lexical_overflow#overflowextension) - OverflowNode

[@lexical/plain-text](/docs/api/modules/lexical_plain-text)

- [PlainTextExtension](/docs/api/modules/lexical_plain-text#plaintextextension) - Plain text editor, the return key creates a LineBreakNode by default (one ParagraphNode per document)

`@lexical/react`

- [ReactExtension](/docs/api/modules/lexical_react_ReactExtension#reactextension)
- [ReactPluginHostExtension](/docs/api/modules/lexical_react_ReactPluginHostExtension#reactpluginhostextension)
- [ReactProviderExtension](/docs/api/modules/lexical_react_ReactProviderExtension#reactproviderextension)
- [TreeViewExtension](/docs/api/modules/lexical_react_TreeViewExtension#treeviewextension)

[@lexical/rich-text](/docs/api/modules/lexical_rich-text)

- [RichTextExtension](/docs/api/modules/lexical_rich-text#richtextextension) - Rich Text editor (QuoteNode, HeadingNode), the return key creates a ParagraphNode by default (multiple ParagraphNode per document). Includes configurable `escapeFormatTriggers` to escape text formatting (e.g. code) at text node boundaries, and `shouldHandlePasteAsFiles` to control whether files win over incidental text/HTML clipboard entries on paste

[@lexical/table](/docs/api/modules/lexical_table)

- [TableExtension](/docs/api/modules/lexical_table#tableextension) - TableNode, TableRowNode, TableCellNode

[@lexical/tailwind](/docs/api/modules/lexical_tailwind)

- [TailwindExtension](/docs/api/modules/lexical_tailwind#tailwindextension) - A theme configuration that uses Tailwind classes
