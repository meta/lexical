# Node Replacement

Node Replacement allow you to replace all instances of a given node in your editor with instances of a subclass.

## Use Case

:::note

In earlier versions of this documentation, "Node Replacement" was called "Node Overrides".
We've changed the name to match the terms used in the implementation.

:::

:::tip

If your use case only requires adding ad-hoc data to existing nodes, you may be able to use the [NodeState](node-state.md) API instead of subclassing and node replacement.

:::

Some of the most commonly used Lexical Nodes are owned and maintained by the core library. For example, ParagraphNode, HeadingNode, QuoteNode, List(Item)Node etc - these are all provided by Lexical packages, which provides an easier out-of-the-box experience for some editor features, but makes it difficult to override their behavior. For instance, if you wanted to change the behavior of ListNode, you would typically extend the class and override the methods. However, how would you tell Lexical to use *your* ListNode subclass in `ListExtension` instead of using the core ListNode? That's where Node Replacement can help.


Node Replacement allow you to replace all instances of a given node in your editor with instances of a different node class. This can be done through the `nodes` of an extension:

```ts
const CustomParagraphExtension = defineExtension({
  name: '@my-app/CustomParagraph',
  nodes: () => [
    // Don't forget to register your custom node separately!
    CustomParagraphNode,
    {
      replace: ParagraphNode,
      with: (node: ParagraphNode) => {
        return $createCustomParagraphNode();
      },
      withKlass: CustomParagraphNode,
    },
  ],
});
```
In the snippet above,
- `replace`: Specifies the core node type to be replaced. 
- `with`: Defines a transformation function to replace instances of the original node to the custom node.  
- `withKlass`: This option ensures that behaviors associated with the original node type work seamlessly with the replacement. For instance, node transforms or mutation listeners targeting ParagraphNode will also apply to CustomParagraphNode when withKlass is specified. Without this option, the custom node might not fully integrate with the editor's built-in features, leading to unexpected behavior.

Once this is done, Lexical will replace all ParagraphNode instances with CustomParagraphNode instances. One important use case for this feature is overriding the serialization behavior of core nodes. Check out the full example below.

## Node Replacement Example

This example demonstrates using Node Replacement to replace all `ParagraphNode` with a `CustomParagraphNode` that overrides `createDOM`.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/meta/lexical/tree/main/examples/node-replacement?file=src/main.tsx)

<iframe width="100%" height="600" src="https://stackblitz.com/github/meta/lexical/tree/main/examples/node-replacement?embed=1&file=src%2FApp.tsx&terminalHeight=0&ctl=1&showSidebar=0&devtoolsheight=0&view=preview" sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts" title="Node Replacement Example"></iframe>
