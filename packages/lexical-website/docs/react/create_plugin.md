# Creating a React Plugin

In addition to using the Lexical React plugins offered by the core library, you can make your own plugins to extend or alter Lexical's functionality to suit your own use cases.

Lexical's React plugin interface is simple - just create a React component and add it as a child of your LexicalComposer component:

```jsx
 <LexicalComposer initialConfig={initialConfig}>
    <MyLexicalPlugin />
 </LexicalComposer>
```

If the Plugin introduces new nodes, they have to be registered in `initialConfig.nodes`:

```js
const initialConfig = {
  namespace: 'MyEditor',
  nodes: [MyLexicalNode],
};
```

```jsx
 <LexicalComposer initialConfig={initialConfig}>
    <MyLexicalPlugin />
 </LexicalComposer>
```

LexicalComposer provides access to the underlying LexicalEditor instance via React Context:

```jsx
//MyLexicalPlugin.js

export function MyLexicalPlugin(props) {
    const [editor] = useLexicalComposerContext();
    ...
}
```

With access to the Editor, your plugin can extend Lexical via [Commands](../concepts/commands.md), [Transforms](../concepts/transforms.md), or other APIs. For example, the [TwitterPlugin](https://github.com/meta/lexical/blob/0775ab929e65723433626fa8c25900941e7f232f/packages/lexical-playground/src/plugins/TwitterPlugin/index.ts#L18) embeds a tweet into the editor, fetching the data asynchronously from Twitter based on the provided Tweet ID:

```jsx
export const INSERT_TWEET_COMMAND: LexicalCommand<string> = createCommand();

export default function TwitterPlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor.hasNodes([TweetNode])) {
      throw new Error('TwitterPlugin: TweetNode not registered on editor (initialConfig.nodes)');
    }

    return editor.registerCommand<string>(
      INSERT_TWEET_COMMAND,
      (payload) => {
        const tweetNode = $createTweetNode(payload);
        $insertNodeToNearestRoot(tweetNode);

        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  }, [editor]);

  return null;
}
```

TwitterPlugin is just a React component that accesses the Lexical editor via React Context (useLexicalComposerContext). Using the LexicalEditor instance, this plugin does two things:

1. Verifies that there is a TweetNode registered on the editor (if you forget to register the node, you can't do #2)
2. registers a "command", passing a callback that will run when that command is dispatched. The command callback creates and inserts a TweetNode in the editor.

You can see how [TwitterPlugin is used in the playground](https://github.com/meta/lexical/blob/0775ab929e65723433626fa8c25900941e7f232f/packages/lexical-playground/src/Editor.tsx#L137). It's added as a child of a LexicalComposer component, which does the job of providing the Context necessary for access to the editor instance. To actually trigger this command callback and insert a [TweetNode](https://github.com/meta/lexical/blob/b0fa38615c03f1c4fc7c8c5ea26412b723770e55/packages/lexical-playground/src/nodes/TweetNode.tsx#L212), we have a [button](https://github.com/meta/lexical/blob/b0fa38615c03f1c4fc7c8c5ea26412b723770e55/packages/lexical-playground/src/plugins/ToolbarPlugin.tsx#L534) that "dispatches" the Tweet command we registered in the plugin.

While the TwitterPlugin registers a command that inserts a custom node, this is only one example of what can be done with a plugin. To get a better idea of what's possible, take a look at the [plugins defined in the playground](https://github.com/meta/lexical/tree/main/packages/lexical-playground/src/plugins).
