# React and Lexical Extension

Lexical Extension vastly improved support for non-React usage, but
did not make any compromises when supporting React.

## Minimal migration to LexicalExtensionComposer

Migrating your application from `LexicalComposer` to
`LexicalExtensionComposer` is straightforward, but has
two things to consider.

### Convert your `initialConfig` to an `extension`

Before:
```tsx
const initialConfig = {
  namespace: 'MyEditor',
  nodes: [QuoteNode, HeadingNode],
  theme,
  editorState(editor) {
    editor.update($initialEditorState, {tag: HISTORY_MERGE_TAG});
  },
  // This is the default when using Lexical Extension
  onError(err) {
    throw err;
  },
};
```

After:
```tsx
// Be careful to make sure that this is a stable reference, either by defining it
// at the top-level of a module or by using something like `useRef` or `useState`
// to create it. Any time this object changes, the editor will be recreated.
const appExtension = defineExtension({
  name: 'MyEditor',
  namespace: 'MyEditor',
  nodes: () => [QuoteNode, HeadingNode],
  theme,
  $initialEditorState,
});
```

### Switch from LexicalComposer to LexicalExtensionComposer

Before:
```tsx
<LexicalComposer initialConfig={initialConfig}>
    <RichTextPlugin
        contentEditable={<ContentEditable />}
        ErrorBoundary={LexicalErrorBoundary}
    />
    {/* other legacy React plugins */}
</LexicalComposer>
```

After:
```tsx
<LexicalExtensionComposer extension={appExtension} contentEditable={null}>
    <RichTextPlugin
        contentEditable={<ContentEditable />}
        ErrorBoundary={LexicalErrorBoundary}
    />
    {/* other legacy React plugins */}
</LexicalExtensionComposer>
```

This is a minimal migration, in most cases you can migrate plug-in usage to
extension dependencies. For example, by using
[RichTextExtension](/docs/api/modules/lexical_rich-text#richtextextension) instead of
`RichTextPlugin`:

```tsx
const appExtension = defineExtension({
  name: 'MyEditor',
  namespace: 'MyEditor',
  dependencies: [RichTextExtension],
  theme,
  $initialEditorState,
});
```

```tsx
<LexicalExtensionComposer extension={appExtension}>
  {/* By default the contentEditable is the first child, defaulting to <ContentEditable /> */}
  {/* other legacy React plugins */}
</LexicalExtensionComposer>
```

## Managing the editor yourself with LexicalExtensionEditorComposer

`LexicalExtensionComposer` builds its editor from `extension` and disposes it
when the component unmounts. When you want to own that lifecycle instead,
such as a nested editor that belongs to a node (like the caption in the
playground's `StickyComponent`), an editor shared with non-React code, or one
that should outlive the component, build the editor yourself and render it
with
[`LexicalExtensionEditorComposer`](/docs/api/modules/lexical_react_LexicalExtensionEditorComposer).

The editor must include `ReactProviderExtension` and `ReactExtension`, which
`LexicalExtensionComposer` otherwise adds for you:

```tsx
import {buildEditorFromExtensions, defineExtension} from '@lexical/extension';
import {LexicalExtensionEditorComposer} from '@lexical/react/LexicalExtensionEditorComposer';
import {ReactExtension} from '@lexical/react/ReactExtension';
import {ReactProviderExtension} from '@lexical/react/ReactProviderExtension';
import {RichTextExtension} from '@lexical/rich-text';

// Built once, at module scope, so it is not re-created on every render
const editor = buildEditorFromExtensions(
  defineExtension({
    dependencies: [ReactProviderExtension, ReactExtension, RichTextExtension],
    name: '@my-app/editor',
  }),
);

function App() {
  return (
    <LexicalExtensionEditorComposer initialEditor={editor}>
      {/* The ContentEditable is rendered by ReactExtension, as with LexicalExtensionComposer */}
      {/* other legacy React plugins */}
    </LexicalExtensionEditorComposer>
  );
}
```

`LexicalExtensionEditorComposer` never disposes the editor, so call
`editor.dispose()` yourself when you are done with it. Keep the
`initialEditor` prop stable (module scope, `useMemo`, or state held by a
node), and render a given editor in only one place at a time, since an editor
has only one root element.

## React Plug-ins (Legacy)

These just work as-is, by rendering them as children of your composer. You may
wish to package them as an extension for easier re-use, or consider refactoring
them to work without React. See [Extension Decorators](#extension-decorators)
and [Output Components](#output-components), and
[React Independence](#react-independence) for strategies to repackage or
refactor your legacy plug-ins.

## Extension Decorators

A common use case for legacy react plug-ins is to render some React component,
but the position of that component in the document is not important. Some use
cases for this are when the component is simply an effect that always returns
`null`, or it is rendering something like a portal. There's no need for users
to manually decide where these components are rendered, so Lexical's
ReactExtension maintains an array of these to render automatically.

 ```tsx
 // This is exactly how you would write a legacy React plug-in
function LogEditorPlugin() {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    console.log(editor);
  }, [editor]);
  return null;
}
// This is how you would declare the plugin as an extension
// that depends on React and renders this plug-in as a decorator
export const LogEditorExtension = defineExtension({
  name: "@example/LogEditor",
  dependencies: [
    configExtension(ReactExtension, {
      decorators: [<LogEditorPlugin />]
    }),
  ],
});
```

## Output Components

In situations where it is important for the user to decide exactly where an
extension's component is rendered in the React document, the convention is
to provide an Output Component.

Here we have the TreeViewExtension which defines an Output Component to render
the TreeView with the specified configuration.

```tsx
export function TreeViewExtensionComponent(
  props: Partial<TreeViewConfig>,
): JSX.Element {
  const [editor] = useLexicalComposerContext();
  return (
    <TreeView
      editor={editor}
      {...useExtensionDependency(TreeViewExtension).config}
      {...props}
    />
  );
}

export const TreeViewExtension = defineExtension({
  build: () => ({Component: TreeViewExtensionComponent}),
  config,
  dependencies: [ReactExtension],
  name: '@lexical/react/TreeView',
});
```

This extension component can be acquired with the
[useExtensionComponent](/docs/api/modules/lexical_react_useExtensionComponent#useextensioncomponent)
hook or the [ExtensionComponent](/docs/api/modules/lexical_react_ExtensionComponent#extensioncomponent) component.

```tsx
return (
  <ExtensionComponent
    lexical:extension={TreeViewExtension}
    viewClassName="tree-view-output" />
);
```

```tsx
const TreeViewComponent = useExtensionComponent(TreeViewExtension);
return (<TreeViewComponent viewClassName="tree-view-output" />);
```

## React Independence

Many legacy plug-ins are merely a `useEffect` wrapper, these tend to not
need React at all. For example:

Before:
```tsx
export function CheckListPlugin(): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return registerCheckList(editor);
  }, [editor]);
  return null;
}
```

After:
```tsx
export const CheckListExtension = defineExtension({
  name: "@lexical/list/CheckList",
  register: registerCheckList,
});
```

## Using React extensions and plug-ins without JSX

[ReactPluginHostExtension](/docs/api/modules/lexical_react_ReactPluginHostExtension#reactpluginhostextension)
is an extension that allows you to mount the a React root at a
specific DOM element in your app so that applications that are
not natively React can still take advantage of existing legacy
plug-ins and extensions that depend on React.

While this does mean your application will include the React runtime, you
don't have to use JSX or have any other React infrastructure in your app.

See
[extension-vanilla-react-plugin-host](https://github.com/meta/lexical/blob/main/examples/extension-vanilla-react-plugin-host/src/main.ts)
[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/meta/lexical/tree/main/examples/?file=src%2Fmain.ts)
for usage of this extension and its API
