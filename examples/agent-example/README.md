# AI Agent Example

A React + Tailwind CSS rich text editor with AI agent functionality powered by [transformers.js](https://huggingface.co/docs/transformers.js). The AI runs entirely in the browser using WebAssembly — no server required.

Based on the [website-toolbar](../website-toolbar) example with added AI capabilities.

## Features

- **Rich text editing** with block types (headings, quotes), formatting (bold, italic, underline), and alignment
- **AI Generate** — click "Generate" to have the AI write a new paragraph, streamed token-by-token into the editor
- **Extract Entities** — detect people, places, and organizations in the text and replace them with interactive decorator nodes (PlaceNode links to Google Maps, PersonNode and OrgNode link to Google search)
- **Abort** — click "Stop" or press Escape to cancel an in-progress AI operation
- **Dark mode** toggle

## How it works

Uses two models running via `@huggingface/transformers` in a Web Worker with the WASM backend for broad compatibility, including Safari on iOS:

- [SmolLM2-135M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct) (q4 quantized, ~70MB) for text generation
- [Xenova/bert-base-NER](https://huggingface.co/Xenova/bert-base-NER) for named entity recognition (people, places, organizations)

Models are loaded lazily on first use. Generated text streams directly into the editor as tokens arrive. Extracted entities are converted into color-coded decorator nodes with contextual links.

> **Note:** SmolLM2-135M is a small language model. Results are best-effort and meant as a demonstration of browser-based AI integration with Lexical.

## Run it locally

```bash
pnpm i && pnpm run dev
```

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/meta/lexical/tree/main/examples/agent-example?file=src/main.tsx)
