/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * Shared gallery example definitions used by both the website gallery page
 * and the screenshot capture script.
 *
 * To add a new example:
 * 1. Add an entry here with the example's `dir` name and metadata.
 * 2. Set `waitForSelector` to enable automated screenshot capture.
 * 3. Run `pnpm run capture-gallery-screenshots` to generate the image.
 */

export interface GalleryExample {
  /** Directory name under examples/ */
  dir: string;
  /** Display title on the gallery card */
  title: string;
  /** Short description shown on the gallery card */
  description: string;
  /** Filter tags (e.g. 'opensource', 'favorite') */
  tags: string[];
  /** Query string appended to the StackBlitz URL */
  stackblitzQuery: string;
  /**
   * CSS selector to wait for before taking a screenshot.
   * If set, the capture script will screenshot this example and
   * the gallery card will use the local image.
   * If omitted, the gallery falls back to the Slorber screenshot API.
   */
  waitForSelector?: string;
  /**
   * Vite config file to use when starting the dev server.
   * Defaults to 'vite.config.monorepo.ts' if it exists in the
   * example directory, otherwise 'vite.config.ts'.
   */
  viteConfig?: string;
}

/** Helper to build a StackBlitz URI from an example and a prefix */
export function buildStackBlitzUri(
  example: GalleryExample,
  stackblitzPrefix: string,
): string {
  return `${stackblitzPrefix}examples/${example.dir}?${example.stackblitzQuery}`;
}

/** Helper to get the local screenshot path for an example (if available) */
export function getScreenshotPreview(
  example: GalleryExample,
): string | undefined {
  return example.waitForSelector
    ? `/img/gallery/${example.dir}.png`
    : undefined;
}

export const galleryExamples: GalleryExample[] = [
  {
    description: 'Learn how to create an editor with Emojis',
    dir: 'vanilla-js-plugin',
    stackblitzQuery:
      'file=src%2Femoji-plugin%2FEmojiExtension.ts&terminalHeight=0&ctl=0',
    tags: ['opensource', 'extension', 'vanilla', 'emoji'],
    title: 'Emoji Extension',
    waitForSelector: '[data-lexical-editor]',
  },
  {
    description: 'Learn how to create an editor with Real Time Collaboration',
    dir: 'react-rich-collab',
    stackblitzQuery: 'ctl=0&file=src%2Fmain.tsx&terminalHeight=0',
    tags: ['opensource', 'favorite', 'react', 'collab', 'toolbar'],
    title: 'Collab RichText',
    // Editor is inside iframes, so wait for the iframe elements instead
    waitForSelector: 'iframe[name="left"]',
  },
  {
    description: 'Learn how to create an editor with Tables',
    dir: 'react-table',
    stackblitzQuery: 'file=src%2Fmain.tsx&terminalHeight=0&ctl=0',
    tags: ['opensource', 'react', 'tables', 'toolbar'],
    title: 'TablePlugin',
    waitForSelector: '[data-lexical-editor]',
  },
  {
    description: 'Tables using the Extension architecture',
    dir: 'extension-react-table',
    stackblitzQuery: 'file=src%2Fmain.tsx&terminalHeight=0&ctl=0',
    tags: ['opensource', 'extension', 'favorite', 'react', 'tables', 'toolbar'],
    title: 'Extension: React Table',
    waitForSelector: '[data-lexical-editor]',
  },
  {
    description: 'SSR and hydration with Svelte 5 and the Extension API',
    dir: 'extension-sveltekit-ssr-hydration',
    stackblitzQuery:
      'file=src%2Froutes%2F%2Bpage.svelte&terminalHeight=0&ctl=0',
    tags: ['opensource', 'svelte', 'ssr', 'extension', 'tailwind', 'simple'],
    title: 'Extension: SvelteKit SSR',
    viteConfig: 'vite.config.ts',
    waitForSelector: '[data-lexical-editor]',
  },
  {
    description: 'Mount React plugins into a vanilla JS Extension editor',
    dir: 'extension-vanilla-react-plugin-host',
    stackblitzQuery: 'file=src%2Fmain.ts&terminalHeight=0&ctl=0',
    tags: ['opensource', 'vanilla', 'react', 'extension', 'tailwind'],
    title: 'Extension: React Plugin Host',
    waitForSelector: '[data-lexical-editor]',
  },
  {
    description: 'Split-view markdown WYSIWYG editor with live preview',
    dir: 'markdown-editor',
    stackblitzQuery: 'file=src%2Fmain.tsx&terminalHeight=0&ctl=0',
    tags: [
      'opensource',
      'favorite',
      'react',
      'extension',
      'tailwind',
      'toolbar',
      'markdown',
    ],
    title: 'Markdown Editor',
    viteConfig: 'vite.config.ts',
    waitForSelector: '[data-lexical-editor]',
  },
  {
    description: 'Vanilla JS checklist editor with Extensions and Tailwind',
    dir: 'extension-vanilla-tailwind',
    stackblitzQuery: 'file=src%2Fmain.ts&terminalHeight=0&ctl=0',
    tags: ['opensource', 'vanilla', 'extension', 'tailwind', 'simple'],
    title: 'Extension: Vanilla Tailwind',
    waitForSelector: '[data-lexical-editor]',
  },
  {
    description:
      'AI-powered editor with paragraph generation and named entity recognition',
    dir: 'agent-example',
    stackblitzQuery: 'file=src%2Fmain.tsx&terminalHeight=0&ctl=0',
    tags: [
      'opensource',
      'extension',
      'agent',
      'ai',
      'react',
      'favorite',
      'tailwind',
      'toolbar',
    ],
    title: 'AI Agent Editor',
    viteConfig: 'vite.config.ts',
    waitForSelector: '[data-lexical-editor]',
  },
  {
    description: 'Chat interface with multiple rich text editor instances',
    dir: 'website-chat',
    stackblitzQuery: 'file=src%2Fmain.tsx&terminalHeight=0&ctl=0',
    tags: [
      'opensource',
      'extension',
      'react',
      'chat',
      'favorite',
      'tailwind',
      'emoji',
    ],
    title: 'Chat',
    viteConfig: 'vite.config.ts',
    waitForSelector: '[data-lexical-editor]',
  },
  {
    description:
      'Notion-style editor with slash commands and drag-and-drop blocks',
    dir: 'website-notion',
    stackblitzQuery: 'file=src%2Fmain.tsx&terminalHeight=0&ctl=0',
    tags: ['opensource', 'favorite', 'block', 'react', 'extension', 'tailwind'],
    title: 'Notion-style block editor',
    viteConfig: 'vite.config.ts',
    waitForSelector: '[data-lexical-editor]',
  },
  {
    description: 'Simple rich text input with hashtag support',
    dir: 'website-rich-input',
    stackblitzQuery: 'file=src%2Fmain.tsx&terminalHeight=0&ctl=0',
    tags: [
      'opensource',
      'favorite',
      'react',
      'extension',
      'tailwind',
      'simple',
    ],
    title: 'Rich Input',
    viteConfig: 'vite.config.ts',
    waitForSelector: '[data-lexical-editor]',
  },
  {
    description: 'Rich text editor with a formatting toolbar',
    dir: 'website-toolbar',
    stackblitzQuery: 'file=src%2Fmain.tsx&terminalHeight=0&ctl=0',
    tags: [
      'opensource',
      'favorite',
      'react',
      'extension',
      'tailwind',
      'toolbar',
      'simple',
    ],
    title: 'Toolbar',
    viteConfig: 'vite.config.ts',
    waitForSelector: '[data-lexical-editor]',
  },
];
