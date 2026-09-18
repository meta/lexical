<p align="center">
  <a href="https://lexical.dev"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://lexical.dev/img/logo-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="https://lexical.dev/img/logo.svg" />
  <img alt="Lexical" src="https://lexical.dev/img/logo.svg" height="60" />
</picture></a>
</p>

<p align="center">
  An extensible text editor framework that provides excellent reliability, accessibility and performance.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/lexical"><img alt="NPM Version" src="https://img.shields.io/npm/v/lexical?color=43be15&label="/></a>
  <a href="https://www.npmjs.com/package/lexical"><img alt="NPM Downloads" src="https://img.shields.io/npm/dw/lexical"/></a>
  <a href="https://github.com/facebook/lexical/actions/workflows/tests.yml"><img alt="Build Status" src="https://img.shields.io/github/actions/workflow/status/facebook/lexical/tests.yml"/></a>
  <a href="https://discord.gg/KmG4wQnnD9"><img alt="Discord" src="https://img.shields.io/discord/953974421008293909"/></a>
</p>

<p align="center">
  <a href="https://lexical.dev/docs/intro">Documentation</a> | <a href="https://lexical.dev/docs/getting-started/quick-start">Getting Started</a> | <a href="https://playground.lexical.dev">Playground</a> | <a href="https://lexical.dev/gallery">Gallery</a>
</p>

<br />

## Features

- **Framework Agnostic Core** - Works with any UI framework, with official [React bindings](https://lexical.dev/docs/getting-started/react)
- **Reliable & Accessible** - Built-in accessibility support and WCAG compliance
- **Extensible** - Plugin-based architecture with powerful extension points
- **Immutable State Model** - Time-travel ready with built-in undo/redo
- **Collaborative Editing** - Real-time collaboration via [Yjs](https://github.com/yjs/yjs) integration
- **Serialization** - Import/export from JSON, Markdown, and HTML
- **Rich Content** - Support for tables, lists, code blocks, images, and custom nodes
- **Cross-browser** - Firefox 115+, Safari 15+, Chrome 86+ (see [Supported Browsers](https://lexical.dev/docs/getting-started/supported-browsers))
- **Type Safe** - Written in TypeScript with comprehensive type definitions

## Quick Start

For framework-agnostic usage, start with the
[Vanilla JS quick start](https://lexical.dev/docs/getting-started/quick-start)
or the
[Vanilla JS example](https://stackblitz.com/github/facebook/lexical/tree/main/examples/vanilla-js?file=src%2Fmain.ts).

For React applications, install Lexical with the official React bindings:

```bash
npm install lexical @lexical/react
```

```jsx
import { $getRoot, $getSelection } from 'lexical';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';

const initialConfig = {
  namespace: 'MyEditor',
  onError: (error) => console.error(error),
};

function Editor() {
  return (
    <LexicalComposer initialConfig={initialConfig}>
      <PlainTextPlugin
        contentEditable={<ContentEditable />}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
    </LexicalComposer>
  );
}
```

Try it yourself:
- [Plain Text Example](https://stackblitz.com/github/facebook/lexical/tree/main/examples/react-plain-text?file=src%2FApp.tsx&terminalHeight=0&ctl=1&showSidebar=0&devtoolsheight=0&view=preview)
- [Rich Text Example](https://stackblitz.com/github/facebook/lexical/tree/main/examples/react-rich?file=src%2FApp.tsx&terminalHeight=0&ctl=1&showSidebar=0&devtoolsheight=0&view=preview)

## Development

```bash
# Install dependencies
pnpm install

# Start playground dev server
pnpm run start

# Run tests
pnpm run test-unit
pnpm run test-e2e-chromium

# Lint and type check
pnpm run ci-check
```

See [CONTRIBUTING.md](https://github.com/facebook/lexical/blob/main/CONTRIBUTING.md) for detailed development guidelines.

## Documentation

- **User Guide**: [lexical.dev/docs/intro](https://lexical.dev/docs/intro)
- **API Reference**: [lexical.dev/docs/api](https://lexical.dev/docs/api/modules/lexical)
- **Developer Guide**: [AGENTS.md](https://github.com/facebook/lexical/blob/main/AGENTS.md) - Architecture and development workflows
- **Examples**: [examples/](https://github.com/facebook/lexical/tree/main/examples) - Sample implementations

## Community & Support

- **Discord**: Join our [Discord server](https://discord.gg/KmG4wQnnD9) for announcements, questions, discussions
- **Issues**: Report bugs and request features on [GitHub Issues](https://github.com/facebook/lexical/issues)
- **Release Notes**: Release notes are available in [Github Releases](https://github.com/facebook/lexical/releases)

## Browser Support

| Browser | Version |
|---------|---------|
| Chrome  | 86+     |
| Firefox | 115+    |
| Safari  | 15+     |
| Edge    | 86+     |

## Contributors

We welcome contributions! Please read our [Contributing Guide](https://github.com/facebook/lexical/blob/main/CONTRIBUTING.md) to learn about our development process and how to propose bugfixes and improvements.

<a href="https://github.com/facebook/lexical/graphs/contributors"><img src="https://contrib.rocks/image?repo=facebook/lexical" /></a>

## License

[MIT](https://github.com/facebook/lexical/blob/main/LICENSE) License Copyright ©2026 Meta Platforms, Inc.
