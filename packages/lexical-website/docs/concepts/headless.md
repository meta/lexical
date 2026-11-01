# Running Without a Browser

The DOM is only needed to show an editor on screen. Because every read and
update goes through the editor state, Lexical also works where there is no
browser DOM:

- **With no DOM at all.** An editor that has no root element skips
  reconciliation and DOM selection entirely, so you can build one with
  `buildEditorFromExtensions()` and never call `setRootElement()`. Adding
  `HeadlessExtension` from `@lexical/headless` makes that explicit: attaching a
  root element then throws, and nested editors are headless too. Updates,
  transforms, listeners, commands, and JSON serialization all still work,
  which is enough to process documents on a server, apply changes from a
  collaboration backend, or write tests.
- **With a virtual DOM** such as happy-dom or jsdom, for the features that
  create DOM nodes, like HTML import and export. `withDOM()` from
  `@lexical/headless/dom` runs a callback with a temporary happy-dom window,
  for example to convert HTML on a server.

## Example: converting saved JSON to HTML on a server

```ts
import {buildEditorFromExtensions} from '@lexical/extension';
import {HeadlessExtension} from '@lexical/headless';
import {withDOM} from '@lexical/headless/dom';
import {$generateHtmlFromNodes} from '@lexical/html';
import {RichTextExtension} from '@lexical/rich-text';
import {defineExtension} from 'lexical';

const editor = buildEditorFromExtensions(
  defineExtension({
    dependencies: [HeadlessExtension, RichTextExtension],
    name: '@my-app/server-editor',
  }),
);

export function jsonToHtml(json: string): string {
  editor.setEditorState(editor.parseEditorState(json));
  return withDOM(() => editor.read(() => $generateHtmlFromNodes(editor)));
}
```

The editor must have the same node types registered as the editor that saved
the JSON, which is why it uses the same extensions. JSON and Markdown
conversion do not need `withDOM()`.

## `createHeadlessEditor()`

Before extensions, headless editors were created with `createHeadlessEditor()`
from `@lexical/headless`. It still works, and it makes DOM-only methods such as
`registerRootListener` and `registerMutationListener` throw. Because many
extensions register those listeners, use `HeadlessExtension` with
`buildEditorFromExtensions()` in new code.
