# Lexical Plugins

:::tip

Most of these plugins are available as modern
[Lexical Extensions](../extensions/intro.md), which do not require separate
configuration and can have more efficient implementations.
You should prefer using extensions over plugins where available, and
[migrate](../extensions/migration.mdx) any project to extensions with
LexicalExtensionComposer or LexicalExtensionEditorComposer if it is still
using LexicalComposer.

:::

React-based plugins use a Lexical editor instance from `<LexicalExtensionComposer>` or `<LexicalComposer>` (legacy) context:

```js
import {LexicalComposer} from '@lexical/react/LexicalComposer';
import {PlainTextPlugin} from '@lexical/react/LexicalPlainTextPlugin';
import {ContentEditable} from '@lexical/react/LexicalContentEditable';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {HistoryPlugin} from '@lexical/react/LexicalHistoryPlugin';
import {OnChangePlugin} from '@lexical/react/LexicalOnChangePlugin';
```

```jsx
const initialConfig = {
  namespace: 'MyEditor',
  theme,
  onError,
};

<LexicalComposer initialConfig={initialConfig}>
  <PlainTextPlugin
    contentEditable={
      <ContentEditable placeholder={<div>Enter some text...</div>} />
    }
    ErrorBoundary={LexicalErrorBoundary}
  />
  <HistoryPlugin />
  <OnChangePlugin onChange={onChange} />
  ...
</LexicalComposer>;
```

> Note: Many plugins might require you to register the one or many Lexical nodes in order for the plugin to work. You can do this by passing a reference to the node to the `nodes` array in your initial editor configuration.

```jsx
const initialConfig = {
  namespace: 'MyEditor',
  theme,
  nodes: [ListNode, ListItemNode], // Pass the references to the nodes here
  onError,
};
```

### `LexicalPlainTextPlugin`

React wrapper for `@lexical/plain-text` that adds major features for plain text editing, including typing, deletion and copy/pasting.

```jsx
<PlainTextPlugin
  contentEditable={
    <ContentEditable
      aria-placeholder={'Enter some text...'}
      placeholder={<div>Enter some text...</div>}
    />
  }
  ErrorBoundary={LexicalErrorBoundary}
/>
```

:::tip

Use [PlainTextExtension](/docs/api/modules/lexical_plain-text#plaintextextension) when using extensions

:::

### Configuring an error boundary for React extensions

The `ErrorBoundary` prop on `PlainTextPlugin` and `RichTextPlugin` is configured
through `ReactExtension` when using `PlainTextExtension` or
`RichTextExtension`. Add a configured `ReactExtension` to the root extension's
dependencies:

```tsx
import {configExtension, defineExtension} from 'lexical';
import {PlainTextExtension} from '@lexical/plain-text';
import {ReactExtension} from '@lexical/react/ReactExtension';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import type {ReactElement} from 'react';

type ErrorBoundaryProps = {
  children: ReactElement;
  onError: (error: Error) => void;
};

function CustomErrorBoundary({children, onError}: ErrorBoundaryProps) {
  return (
    <LexicalErrorBoundary
      fallback={<div>Something went wrong.</div>}
      onError={onError}>
      {children}
    </LexicalErrorBoundary>
  );
}

const editorExtension = defineExtension({
  name: 'MyEditor',
  dependencies: [
    PlainTextExtension,
    configExtension(ReactExtension, {
      ErrorBoundary: CustomErrorBoundary,
    }),
  ],
});
```

If you do not provide `ErrorBoundary`, `ReactExtension` uses its default
`LexicalErrorBoundary`. Replace `CustomErrorBoundary` with
`LexicalErrorBoundary` when the default fallback and error reporting are
sufficient.

### `LexicalRichTextPlugin`

React wrapper for `@lexical/rich-text` that adds major features for rich text editing, including typing, deletion, copy/pasting, indent/outdent and bold/italic/underline/strikethrough text formatting.

```jsx
<RichTextPlugin
  contentEditable={
    <ContentEditable
      aria-placeholder={'Enter some text...'}
      placeholder={<div>Enter some text...</div>}
    />
  }
  ErrorBoundary={LexicalErrorBoundary}
/>
```

:::tip

Use [RichTextExtension](/docs/api/modules/lexical_rich-text#richtextextension) when using extensions

:::

### `LexicalAutoFocusPlugin`

Automatically focuses the editor when the component mounts and optionally places the cursor at the start or end of the root content.

```jsx
<AutoFocusPlugin defaultSelection="rootEnd" />
```

:::tip

Use [AutoFocusExtension](/docs/api/modules/lexical_extension#autofocusextension) when using extensions

:::

### `LexicalOnChangePlugin`

Plugin that calls `onChange` whenever Lexical state is updated. Using `ignoreHistoryMergeTagChange` (`true` by default) and `ignoreSelectionChange` (`false` by default) can give more granular control over changes that are causing `onChange` call.

```jsx
<OnChangePlugin onChange={onChange} />
```

:::tip

When using extensions, subscribe to [EditorStateExtension](/docs/api/modules/lexical_extension#editorstateextension) for a signal-based equivalent

:::

### `LexicalHistoryPlugin`

React wrapper for `@lexical/history` that adds support for history stack management and `undo` / `redo` commands.

```jsx
<HistoryPlugin />
```

:::tip

Use [HistoryExtension](/docs/api/modules/lexical_history#historyextension) when using extensions

:::

### `LexicalLinkPlugin`

React wrapper for `@lexical/link` that adds support for links, including `$toggleLink` command support that toggles link for selected text.

```jsx
<LinkPlugin />
```

:::tip

Use [LinkExtension](/docs/api/modules/lexical_link#linkextension) when using extensions

:::

### `LexicalClickableLinkPlugin`

Makes `LinkNode` elements in the editor clickable, navigating to the link URL on click. Set `disabled` to `true` to turn off the behavior, or `newTab` to control whether links open in a new tab.

> Note: Requires `LinkNode` from `@lexical/link` to be registered.

```jsx
<ClickableLinkPlugin newTab={true} disabled={false} />
```

:::tip

Use [ClickableLinkExtension](/docs/api/modules/lexical_link#clickablelinkextension) when using extensions

:::

### `LexicalListPlugin`

React wrapper for `@lexical/list` that adds support for lists (ordered and unordered)

```jsx
<ListPlugin />
```

:::tip

Use [ListExtension](/docs/api/modules/lexical_list#listextension) when using extensions

:::

### `LexicalCheckListPlugin`

React wrapper for `@lexical/list` that adds support for check lists. Note that it requires some css to render check/uncheck marks. See PlaygroundEditorTheme.css for details.

```jsx
<CheckListPlugin />
```

:::tip

Use [CheckListExtension](/docs/api/modules/lexical_list#checklistextension) when using extensions

:::

### `LexicalTablePlugin`

[![See API Documentation](/img/see-api-documentation.svg)](/docs/api/modules/lexical_react_LexicalTablePlugin)

React wrapper for `@lexical/table` that adds support for tables.

```jsx
<TablePlugin />
```

:::tip

Use [TableExtension](/docs/api/modules/lexical_table#tableextension) when using extensions

:::

Table commands (inserting or deleting rows and columns, merging and
unmerging cells, pasting a table into a table) first pad the short rows of a
ragged table, such as one left by concurrent collaborative edits, with empty
cells; see [`$padTableRows`](/docs/api/modules/lexical_table#padtablerows).

### `LexicalHorizontalRulePlugin`

Registers a command handler for `INSERT_HORIZONTAL_RULE_COMMAND`. When dispatched, it inserts a `HorizontalRuleNode` at the current selection.

> Note: Requires `HorizontalRuleNode` to be registered. This plugin is deprecated in favor of `HorizontalRuleExtension` from `@lexical/extension`.

```jsx
import {HorizontalRuleNode} from '@lexical/react/LexicalHorizontalRuleNode';

const config = {nodes: [HorizontalRuleNode]};

<HorizontalRulePlugin />
```

:::tip

Use [HorizontalRuleExtension](/docs/api/modules/lexical_extension#horizontalruleextension) when using extensions

:::

### `LexicalTabIndentationPlugin`

Plugin that allows tab indentation in combination with `@lexical/rich-text`.

```jsx
<TabIndentationPlugin />
```

:::tip

Use [TabIndentationExtension](/docs/api/modules/lexical_extension#tabindentationextension) when using extensions

:::

### `LexicalHashtagPlugin`

Automatically detects hashtag patterns (e.g., `#hello`) in text as the user types and converts them into `HashtagNode` instances with distinct styling.

> Note: Requires `HashtagNode` from `@lexical/hashtag` to be registered.

```jsx
import {HashtagNode} from '@lexical/hashtag';

const config = {nodes: [HashtagNode]};

<HashtagPlugin />
```

:::tip

Use [HashtagExtension](/docs/api/modules/lexical_hashtag#hashtagextension) when using extensions

:::

### `LexicalAutoLinkPlugin`

Plugin will convert text into links based on passed matchers list. In example below whenever user types url-like string it will automatically convert it into a link node

> Note: Requires `AutoLinkNode` from `@lexical/link` to be registered.

```jsx
const URL_MATCHER =
  /((https?:\/\/(www\.)?)|(www\.))[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;

const MATCHERS = [
  (text) => {
    const match = URL_MATCHER.exec(text);
    if (match === null) {
      return null;
    }
    const fullMatch = match[0];
    return {
      index: match.index,
      length: fullMatch.length,
      text: fullMatch,
      url: fullMatch.startsWith('http') ? fullMatch : `https://${fullMatch}`,
      // attributes: { rel: 'noreferrer', target: '_blank' }, // Optional link attributes
    };
  },
];

...

<AutoLinkPlugin matchers={MATCHERS} />
```

:::tip

Use [AutoLinkExtension](/docs/api/modules/lexical_link#autolinkextension) when using extensions

:::

### `LexicalAutoEmbedPlugin`

Watches for pasted links that match any of the provided embed configurations (e.g., YouTube, Twitter URLs). When a match is found, it shows a menu offering to replace the link with an embedded node.

> Note: Requires `LinkNode` and `AutoLinkNode` from `@lexical/link` to be registered.

```jsx
import {LexicalAutoEmbedPlugin, AutoEmbedOption} from '@lexical/react/LexicalAutoEmbedPlugin';
import type {EmbedConfig} from '@lexical/react/LexicalAutoEmbedPlugin';

const YouTubeEmbedConfig = {
  type: 'youtube',
  parseUrl: (url) => {
    const match = url.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/);
    return match ? {url, id: match[1]} : null;
  },
  insertNode: (editor, result) => {
    // Insert your custom embed node here
  },
};

<LexicalAutoEmbedPlugin
  embedConfigs={[YouTubeEmbedConfig]}
  onOpenEmbedModalForConfig={(config) => {/* open modal */}}
  getMenuOptions={(config, embedFn, dismissFn) => [
    new AutoEmbedOption('Embed', {onSelect: embedFn}),
    new AutoEmbedOption('Dismiss', {onSelect: dismissFn}),
  ]}
/>
```

The optional `$disableMenuFor` predicate suppresses the menu for specific locations, e.g. inside nodes that only accept inline content. It receives the matched `AutoLinkNode`; when it returns true the menu is not shown and the pasted link is left as-is. The predicate can inspect the node's ancestors, e.g. with `$getNearestNodeOfType` from `@lexical/utils`.

```jsx
<LexicalAutoEmbedPlugin
  embedConfigs={[YouTubeEmbedConfig]}
  $disableMenuFor={(linkNode) =>
    $getNearestNodeOfType(linkNode, InlineOnlyNode) !== null
  }
  // ...
/>
```

### `LexicalCharacterLimitPlugin`

Tracks the number of characters in the editor and renders a count of remaining characters. Uses `OverflowNode` to visually indicate when the limit is exceeded.

> Note: Requires `OverflowNode` from `@lexical/overflow` to be registered.

```jsx
import {CharacterLimitPlugin} from '@lexical/react/LexicalCharacterLimitPlugin';

<CharacterLimitPlugin charset="UTF-16" maxLength={280} />
```

:::tip

Use [OverflowExtension](/docs/api/modules/lexical_overflow#overflowextension) when using extensions

:::

### `LexicalClearEditorPlugin`

Adds `clearEditor` command support to clear editor's content.

```jsx
<ClearEditorPlugin />
```

:::tip

Use [ClearEditorExtension](/docs/api/modules/lexical_extension#cleareditorextension) when using extensions

:::

### `LexicalMarkdownShortcutPlugin`

Adds markdown shortcut support: headings, lists, code blocks, quotes, links and inline styles (bold, italic, strikethrough).

```jsx
<MarkdownShortcutPlugin />
```

### `LexicalTableOfContentsPlugin`

This plugin allows you to render a table of contents for a page from the headings from the editor. It listens to any deletions or modifications to those headings and updates the table of contents. Additionally, it's able to track any newly added headings and inserts them in the table of contents once they are created. This plugin also supports lazy loading - so you can defer adding the plugin until when the user needs it.

In order to use `TableOfContentsPlugin`, you need to pass a callback function in its children. This callback function gives you access to the up-to-date data of the table of contents. You can access this data through a single parameter for the callback which comes in the form of an array of arrays `[[headingKey, headingTextContent, headingTag], [], [], ...]`

`headingKey`: Unique key that identifies the heading.
`headingTextContent`: A string of the exact text of the heading.
`headingTag`: The heading's tag — `'h1'` through `'h6'`. Every heading in the document is listed; the plugin does not filter by level.

```jsx
<TableOfContentsPlugin>
  {(tableOfContentsArray) => {
    return (
      <MyCustomTableOfContentsPlugin tableOfContents={tableOfContentsArray} />
    );
  }}
</TableOfContentsPlugin>
```

### `LexicalEditorRefPlugin`

Allows you to get a ref to the underlying editor instance outside of LexicalComposer, which is convenient when you want to interact with the editor
from a separate part of your application.

```jsx
const editorRef = useRef(null);
<EditorRefPlugin editorRef={editorRef} />;
```

### `LexicalCollaborationPlugin`

Integrates Yjs-based real-time collaborative editing into Lexical. Creates a Yjs binding between the editor state and a shared Yjs document, renders remote user cursors, and provides collaborative undo/redo history.

```jsx
import {LexicalCollaboration} from '@lexical/react/LexicalCollaborationContext';
import {CollaborationPlugin} from '@lexical/react/LexicalCollaborationPlugin';
import {WebsocketProvider} from 'y-websocket';
import {Doc} from 'yjs';

function createProvider(id, yjsDocMap) {
  const doc = new Doc();
  yjsDocMap.set(id, doc);
  return new WebsocketProvider('ws://localhost:1234', id, doc);
}

<LexicalCollaboration>
  <LexicalComposer initialConfig={initialConfig}>
    <CollaborationPlugin
      id="my-document"
      providerFactory={createProvider}
      shouldBootstrap={true}
      username="Alice"
      cursorColor="#FF0000"
    />
  </LexicalComposer>
</LexicalCollaboration>
```

### `LexicalDraggableBlockPlugin`

Adds a draggable block handle that appears next to top-level block nodes when hovered. Users can drag and drop blocks to reorder them. A target line indicates the drop position.

> Note: This plugin is experimental.

```jsx
import {DraggableBlockPlugin_EXPERIMENTAL} from '@lexical/react/LexicalDraggableBlockPlugin';

const menuRef = useRef(null);
const targetLineRef = useRef(null);

<DraggableBlockPlugin_EXPERIMENTAL
  anchorElem={document.body}
  menuRef={menuRef}
  targetLineRef={targetLineRef}
  menuComponent={<div ref={menuRef} className="drag-handle">::</div>}
  targetLineComponent={<div ref={targetLineRef} className="target-line" />}
  isOnMenu={(el) => menuRef.current?.contains(el) ?? false}
/>
```

### `LexicalNodeEventPlugin`

Attaches a DOM event listener on the editor root element that fires only when the event target corresponds to a node of the specified type.

```jsx
import {NodeEventPlugin} from '@lexical/react/LexicalNodeEventPlugin';

<NodeEventPlugin
  nodeType={ImageNode}
  eventType="click"
  eventListener={(event, editor, nodeKey) => {
    console.log('Clicked on node:', nodeKey);
  }}
/>
```

### `LexicalNodeMenuPlugin`

Renders a menu anchored to a specific Lexical node identified by `nodeKey`. Provides keyboard navigation (arrow keys, enter, escape) through the menu options.

```jsx
import {LexicalNodeMenuPlugin, MenuOption} from '@lexical/react/LexicalNodeMenuPlugin';

<LexicalNodeMenuPlugin
  nodeKey={selectedNodeKey}
  options={menuOptions}
  onSelectOption={(option, textNode, closeMenu) => {
    option.action();
    closeMenu();
  }}
  menuRenderFn={(anchorRef, {options, selectedIndex, selectOptionAndCleanUp}) =>
    anchorRef.current
      ? createPortal(
          <ul>
            {options.map((opt, i) => (
              <li key={opt.key} onClick={() => selectOptionAndCleanUp(opt)}>
                {opt.title}
              </li>
            ))}
          </ul>,
          anchorRef.current,
        )
      : null
  }
  onClose={() => setSelectedNodeKey(null)}
/>
```

### `LexicalTypeaheadMenuPlugin`

Provides a typeahead/autocomplete menu that appears when the user types a trigger character (e.g., `@` for mentions, `:` for emoji). It listens to text changes, runs a trigger function against text before the cursor, and when a match is found, positions a menu at the trigger location.

```jsx
import {
  LexicalTypeaheadMenuPlugin,
  useBasicTypeaheadTriggerMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin';

const triggerMatch = useBasicTypeaheadTriggerMatch('@', {minLength: 1});

<LexicalTypeaheadMenuPlugin
  triggerFn={triggerMatch}
  options={mentionOptions}
  onQueryChange={setQuery}
  onSelectOption={(option, textNode, closeMenu) => {
    editor.update(() => {
      const mentionNode = $createMentionNode(option.name);
      if (textNode) {
        textNode.replace(mentionNode);
      }
      closeMenu();
    });
  }}
  menuRenderFn={(anchorRef, {options, selectedIndex, selectOptionAndCleanUp}) =>
    anchorRef.current
      ? createPortal(
          <ul className="typeahead-menu">
            {options.map((opt, i) => (
              <li
                key={opt.key}
                className={i === selectedIndex ? 'selected' : ''}
                onClick={() => selectOptionAndCleanUp(opt)}>
                {opt.name}
              </li>
            ))}
          </ul>,
          anchorRef.current,
        )
      : null
  }
/>
```

### `LexicalSelectionAlwaysOnDisplay`

By default, browser text selection becomes invisible when clicking away from the editor. This plugin ensures the selection remains visible.

```jsx
<SelectionAlwaysOnDisplay />
```

:::tip

Use [SelectionAlwaysOnDisplayExtension](/docs/api/modules/lexical_extension#selectionalwaysondisplayextension) when using extensions

:::
