

# Commands

Commands are a very powerful feature of Lexical that lets you register listeners for events like `KEY_ENTER_COMMAND` or `KEY_TAB_COMMAND` and contextually react to them _wherever_ & _however_ you'd like.

This pattern is useful for building [`Toolbars`](https://github.com/meta/lexical/blob/main/packages/lexical-playground/src/plugins/ToolbarPlugin/index.tsx) or complex extensions and nodes such as [tables](https://github.com/meta/lexical/tree/main/packages/lexical-table) which require special handling for `selection`, `keyboard events`, and more.

When registering a `command` you supply a `priority` and can return `true` to mark it as "handled", which stops other listeners from receiving the event. If a command isn't handled explicitly by you, it's likely handled by default in [`RichTextExtension`](https://github.com/meta/lexical/blob/main/packages/lexical-rich-text/src/index.ts) or [`PlainTextExtension`](https://github.com/meta/lexical/blob/main/packages/lexical-plain-text/src/index.ts).

## `createCommand(...)`

You can view the core commands in the [`lexical` API reference](/docs/api/modules/lexical#commands). Other packages define their own, listed under Commands in each package's API reference, such as [`TOGGLE_LINK_COMMAND`](/docs/api/modules/lexical_link#toggle_link_command) in `@lexical/link`. If you need a custom command for your own use case, check out the typed `createCommand(...)` function.

```js
const HELLO_WORLD_COMMAND: LexicalCommand<string> = createCommand('HELLO_WORLD');

editor.registerCommand(
  HELLO_WORLD_COMMAND,
  (payload: string) => {
    console.log(payload); // Hello World!
    return false;
  },
  COMMAND_PRIORITY_EDITOR,
);

editor.dispatchCommand(HELLO_WORLD_COMMAND, 'Hello World!');
```

## `editor.dispatchCommand(...)`

Commands can be dispatched from anywhere you have access to the `editor` such as a Toolbar Button, an event listener, or an extension, but most of the core commands are dispatched from [`LexicalEvents.ts`](https://github.com/meta/lexical/blob/main/packages/lexical/src/LexicalEvents.ts).

Calling `dispatchCommand` will implicitly call `editor.update` to trigger its command listeners if it was not called from inside `editor.update`.

Don't dispatch a command from inside a read-only context such as
`editor.read(fn)` or `editorState.read(fn)`. Command listeners usually change
the editor, so Lexical runs them in a separate writable update and
development builds log a warning when they detect this. Dispatch after the
read returns instead.

```js
editor.dispatchCommand(command, payload);
```

The `payload`s are typed via the `createCommand(...)` API, but they're usually a DOM `event` for commands dispatched from an event listener.

Here are some real examples from [`LexicalEvents.ts`](https://github.com/meta/lexical/blob/main/packages/lexical/src/LexicalEvents.ts).

```js
editor.dispatchCommand(KEY_ARROW_LEFT_COMMAND, event);
// ...
editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic');
```

And another example from the [`ToolbarPlugin`](https://github.com/meta/lexical/blob/main/packages/lexical-playground/src/plugins/ToolbarPlugin/index.tsx) in our Playground.

```js
const formatBulletList = () => {
  editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND);
};
```

Which is later handled by [`ListExtension`](https://github.com/meta/lexical/blob/main/packages/lexical-list/src/LexicalListExtension.ts) to insert the list into the editor.

```js
editor.registerCommand(
  INSERT_UNORDERED_LIST_COMMAND,
  () => {
    $insertList('bullet');
    return true;
  },
  COMMAND_PRIORITY_LOW,
);
```

## `editor.registerCommand(...)`

You can register a command from anywhere you have access to the `editor` object, but it's important that you remember to clean up the listener with its remove listener callback when it's no longer needed.

The command listener will always be called from an `editor.update`, so you may use dollar functions. You should not use
`editor.update` (and *never* call `editor.read(...)` or `editor.read('force-commit', ...)`) synchronously from within a command listener. It is safe to call
`editor.read('latest', ...)` or `editor.getEditorState().read` if you need to read the previous state after updates have already been made.

```js
const removeListener = editor.registerCommand(
  COMMAND,
  (payload) => boolean, // Return true to stop propagation.
  priority,
);
// ...
removeListener(); // Cleans up the listener.
```

The easiest way to get clean-up right is to register commands from an
[extension](/docs/extensions/defining-extensions)'s `register` function and
return the remove callback. The editor calls it when it is disposed. To
register several things, combine their callbacks with `mergeRegister` from
`@lexical/utils`.

```js
import {LinkExtension, TOGGLE_LINK_COMMAND} from '@lexical/link';
import {COMMAND_PRIORITY_BEFORE_EDITOR, defineExtension} from 'lexical';

export const LinkLoggerExtension = defineExtension({
  // The command it observes is handled by LinkExtension
  dependencies: [LinkExtension],
  name: '@my-app/LinkLogger',
  register: (editor) =>
    editor.registerCommand(
      TOGGLE_LINK_COMMAND,
      (payload) => {
        console.log('link', payload);
        return false; // let the link extension handle it too
      },
      // LinkExtension handles this command at COMMAND_PRIORITY_EDITOR and
      // returns true, so observe it at the BEFORE variant of that priority.
      COMMAND_PRIORITY_BEFORE_EDITOR,
    ),
});
```

A listener that only observes a command, like this one, needs to run before
the listener that handles it. Depending on the extension that handles it and
using the `COMMAND_PRIORITY_BEFORE_*` variant of its priority does that
without escalating to a higher priority. See
[Priorities and ordering](#priorities-and-ordering) below.

In a legacy React plugin, return the `registerCommand` call from a
`useEffect` instead.

And as seen above and below, `registerCommand`'s callback can return `true` to signal to the other listeners that the command has been handled and propagation will be stopped.

Here's a simplified example of handling a `KEY_TAB_COMMAND` from [`TabIndentationExtension`](https://github.com/meta/lexical/blob/main/packages/lexical-extension/src/TabIndentationExtension.ts), which is used to dispatch a `OUTDENT_CONTENT_COMMAND` or `INDENT_CONTENT_COMMAND`.

```js
editor.registerCommand(
  KEY_TAB_COMMAND,
  (payload) => {
    const event: KeyboardEvent = payload;
    event.preventDefault();
    return editor.dispatchCommand(
      event.shiftKey ? OUTDENT_CONTENT_COMMAND : INDENT_CONTENT_COMMAND,
    );
  },
  COMMAND_PRIORITY_EDITOR,
);
```

Note that the same `KEY_TAB_COMMAND` command is registered by [`LexicalTableSelectionHelpers.ts`](https://github.com/meta/lexical/blob/main/packages/lexical-table/src/LexicalTableSelectionHelpers.ts), which handles moving focus to the next or previous cell within a `TableNode`, but the priority is high (`COMMAND_PRIORITY_HIGH`) because this behavior is very important.

### Priorities and ordering

Command listeners are called in the following order until a listener returns `true`:

- From priority highest to lowest (critical, high, normal, low, editor)
- All `COMMAND_PRIORITY_BEFORE_${priority}` listeners, most recently registered first
- All `COMMAND_PRIORITY_${priority}` listeners, in registration order

:::note

The `COMMAND_PRIORITY_BEFORE_*` priorities make it much easier to override
default behavior without escalating the priority.

:::

It is best practice to use the lowest priority possible, so most commands will
be registered with `COMMAND_PRIORITY_EDITOR` for the default behavior, then
commands to override that behavior can be registered with
`COMMAND_PRIORITY_BEFORE_EDITOR`. The higher priorities mostly serve purposes
such as being able to observe-but-not-handle events and to support legacy code
that predates the availability of `COMMAND_PRIORITY_BEFORE_*`.

A modern lexical app will typically only need the
`COMMAND_PRIORITY_BEFORE_EDITOR` priority since the
last-registered-called-first ordering is suitable for almost all use cases. The
older priorities without BEFORE can be considered legacy and are primarily
offered for compatibility.

Here is the full ordering of priorities, from lowest to highest:

- `COMMAND_PRIORITY_EDITOR`
- `COMMAND_PRIORITY_BEFORE_EDITOR`
- `COMMAND_PRIORITY_LOW`
- `COMMAND_PRIORITY_BEFORE_LOW`
- `COMMAND_PRIORITY_NORMAL`
- `COMMAND_PRIORITY_BEFORE_NORMAL`
- `COMMAND_PRIORITY_HIGH`
- `COMMAND_PRIORITY_BEFORE_HIGH`
- `COMMAND_PRIORITY_CRITICAL`
- `COMMAND_PRIORITY_BEFORE_CRITICAL`
