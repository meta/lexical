/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Options as DocsPluginOptions} from '@docusaurus/plugin-content-docs';
import type {Config, PluginModule} from '@docusaurus/types';

import tailwindcssPostcss from '@tailwindcss/postcss';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {themes} from 'prism-react-renderer';

import {packagesManager} from '../../scripts/shared/packagesManager.mjs';
import copyPageButtonPlugin from './plugins/copy-page-button/index.mjs';
import packageDocsPlugin from './plugins/package-docs/index.mjs';
import slugifyPlugin from './src/plugins/lexical-remark-slugify-anchors/index.js';

type SidebarItemsGenerator = NonNullable<
  DocsPluginOptions['sidebarItemsGenerator']
>;
type NormalizedSidebarItem = Awaited<ReturnType<SidebarItemsGenerator>>[number];

// Use import.meta.url (not import.meta.dirname) for jiti v1 compatibility
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {github: lightCodeTheme, dracula: darkCodeTheme} = themes;

/**
 * Build webpack resolve.alias entries that map each lexical package's module
 * name to the corresponding pre-built dist file.
 *
 * Requires `pnpm run build` to have been run first (dist/ files must exist).
 *
 * @returns {Record<string, string>}
 */
function buildLexicalWebpackAliases() {
  if (process.env.FB_INTERNAL) {
    return {};
  }
  const aliases: Record<string, string> = {};

  for (const pkg of packagesManager.getPublicPackages()) {
    for (const [
      name,
      moduleExports,
    ] of pkg.getNormalizedNpmModuleExportEntries()) {
      const candidates = [
        moduleExports.import.development,
        moduleExports.import.default,
        moduleExports.require.development,
        moduleExports.require.default,
      ].flatMap(fn => {
        if (!fn) {
          return [];
        }
        const rel = fn.replace(/^\.\//, '');
        return [pkg.resolve('dist', rel), pkg.resolve(rel)];
      });
      const resolved = candidates.find(f => fs.existsSync(f));
      if (!resolved) {
        throw new Error(
          `Missing dist file for ${name}. Run \`pnpm run build\` first.\n` +
            `Tried: ${candidates.join(', ')}`,
        );
      }
      aliases[`${name}$`] = resolved;
    }
  }

  return aliases;
}

const TITLE = 'Lexical';
const GITHUB_REPO_URL = 'https://github.com/facebook/lexical'; // TODO: Update when repo name updated
const DISCORD_URL = 'https://discord.gg/KmG4wQnnD9';

function sourceLinkOptions() {
  const sourceLinkTemplate = `${GITHUB_REPO_URL}/tree/{gitRevision}/{path}#L{line}`;
  return {
    disableGit: true,
    gitRevision: 'main',
    sourceLinkTemplate,
  };
}

const docLabels: Record<string, string | undefined> = {
  'api/index': 'Readme',
  'api/modules': 'Table of Contents',
};

function categoryOrder(lowercaseLabel: string) {
  switch (lowercaseLabel) {
    case 'Modules':
      return 0;
    case 'Classes':
      return 1;
    case 'Interfaces':
      return 2;
    default:
      return Infinity;
  }
}

function capitalizeLabel(label: string) {
  // modules, classes, interfaces -> Modules, Classes, Interfaces
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function sidebarSort(a: NormalizedSidebarItem, b: NormalizedSidebarItem) {
  // Categories always come last and have their own defined sort order
  // Otherwise leave the sort as-is
  if (a.type === 'category' && b.type === 'category') {
    return categoryOrder(a.label!) - categoryOrder(b.label!);
  } else if (a.type === 'category') {
    return 1;
  } else if (b.type === 'category') {
    return -1;
  } else {
    return 0;
  }
}

/**
 * Map an 'api/modules/...' id back to the original module name without
 * loading the markdown and parsing the frontmatter.
 */
function idToModuleName(id: string) {
  return id
    .replace(/^api\/modules\//i, '')
    .replace(/^lexical_react_/, '@lexical/react/')
    .replace(/^lexical_/, '@lexical/')
    .replace(/_/g, '-');
}

/**
 * Map an 'api/{category}/{fileId}.ClassName' to the class or interface name.
 * These are already capitalized and always preceded by a '.'.
 */
function classOrInterfaceIdToLabel(id: string) {
  return id.replace(/^[^.]+./, '');
}

const sidebarItemsGenerator: SidebarItemsGenerator = async ({
  defaultSidebarItemsGenerator,
  ...args
}) => {
  const items = await defaultSidebarItemsGenerator(args);
  if (args.item.dirName === 'api') {
    return items
      .map(sidebarItem => {
        if (sidebarItem.type === 'doc' && sidebarItem.id in docLabels) {
          return {...sidebarItem, label: docLabels[sidebarItem.id]};
        } else if (sidebarItem.type !== 'category') {
          return sidebarItem;
        }
        const groupedItems: NormalizedSidebarItem[] = [];
        for (const item of sidebarItem.items) {
          if (item.type === 'doc' && item.id.match(/^api\/modules\//i)) {
            const label = idToModuleName(item.id);
            const lastItem = groupedItems.at(-1);
            if (
              lastItem &&
              lastItem.type === 'category' &&
              lastItem.label === label
            ) {
              lastItem.link = {
                id: item.id,
                type: 'doc',
              };
              continue;
            }
            const m = /^(@lexical\/[^/]+)\/(.*)$/.exec(label);
            if (m) {
              const groupedItem = {...item, label: m[2]};
              if (
                lastItem &&
                lastItem.type === 'category' &&
                lastItem.label === m[1]
              ) {
                lastItem.items.push(groupedItem);
              } else {
                groupedItems.push({
                  items: [groupedItem],
                  label: m[1],
                  type: 'category',
                });
              }
              continue;
            }
            groupedItems.push({...item, label});
          } else if (item.type === 'doc') {
            groupedItems.push({
              ...item,
              label: classOrInterfaceIdToLabel(item.id),
            });
          } else if (item.type === 'category') {
            groupedItems.push({
              ...item,
              label: idToModuleName(item.label),
            });
          } else {
            groupedItems.push(item);
          }
        }
        return {
          ...sidebarItem,
          items: groupedItems,
          label: capitalizeLabel(sidebarItem.label),
        };
      })
      .sort(sidebarSort);
  }
  return items;
};

const parseFrontMatter: NonNullable<
  Config['markdown']
>['parseFrontMatter'] = async params => {
  const result = await params.defaultParseFrontMatter(params);
  if (params.filePath.endsWith('/docs/api/modules.md')) {
    Object.assign(result.frontMatter, {
      custom_edit_url: null,
      hide_table_of_contents: true,
      id: 'modules',
      title: '@lexical/monorepo',
    });
  } else if (params.filePath.endsWith('/docs/api/index.md')) {
    Object.assign(result.frontMatter, {
      custom_edit_url: null,
      id: 'index',
      title: '@lexical/monorepo',
    });
  }
  return result;
};

const docusaurusPluginTypedocConfig = {
  ...sourceLinkOptions(),
  customAnchorsFormat: 'curlyBrace',
  entryPoints: process.env.FB_INTERNAL
    ? []
    : packagesManager
        .getPublicPackages()
        .flatMap(pkg =>
          pkg
            .getExportedNpmModuleEntries()
            .map(entry =>
              path.relative(
                __dirname,
                pkg.resolve('src', entry.sourceFileName),
              ),
            ),
        ),
  excludeInternal: true,
  plugin: [
    'typedoc-plugin-no-inherit',
    path.resolve(
      __dirname,
      'src/plugins/lexical-typedoc-plugin-module-name/index.mjs',
    ),
    path.resolve(
      __dirname,
      'src/plugins/lexical-typedoc-plugin-legacy-router/index.mjs',
    ),
    'typedoc-plugin-rename-defaults',
  ],
  router: 'legacy',
  sidebar: {pretty: true},
  skipErrorChecking: true,
  tsconfig: '../../tsconfig.build.json',
  useCustomAnchors: true,
  watch: process.env.TYPEDOC_WATCH === 'true',
};

const GIT_COMMIT_SHA = process.env.VERCEL_GIT_COMMIT_SHA || 'main';
const GIT_COMMIT_REF = process.env.VERCEL_GIT_COMMIT_REF || 'main';
const GIT_REPO_OWNER = process.env.VERCEL_GIT_REPO_OWNER || 'facebook';
const GIT_REPO_SLUG = process.env.VERCEL_GIT_REPO_SLUG || 'lexical';
const STACKBLITZ_PREFIX = `https://stackblitz.com/github/${GIT_REPO_OWNER}/${GIT_REPO_SLUG}/tree/${
  // Vercel does not set owner and slug correctly for fork PRs so we can't trust the ref by default
  (GIT_COMMIT_REF === 'main' && !process.env.VERCEL_GIT_PULL_REQUEST_ID) ||
  GIT_COMMIT_REF.endsWith('__release')
    ? GIT_COMMIT_REF
    : GIT_COMMIT_SHA
}/`;

const config: Config = {
  baseUrl: '/',

  customFields: {
    GIT_COMMIT_REF,
    GIT_REPO_OWNER,
    GIT_REPO_SLUG,
    STACKBLITZ_PREFIX,
  },

  favicon: 'img/favicon.ico',

  future: {
    // See https://docusaurus.io/blog/releases/3.8
    faster: true,
    v4: {
      removeLegacyPostBuildHeadAttribute: true, // required
    },
  },

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
    mermaid: true,
    parseFrontMatter,
    preprocessor: ({fileContent}: {fileContent: string}) =>
      fileContent.replaceAll(
        'https://stackblitz.com/github/facebook/lexical/tree/main/',
        STACKBLITZ_PREFIX,
      ),
  },

  onBrokenAnchors: 'throw',
  // These are false positives when linking from API docs
  onBrokenLinks: 'ignore',
  organizationName: 'facebook',
  plugins: [
    process.env.FB_INTERNAL
      ? null
      : [
          packageDocsPlugin,
          {
            baseDir: path.resolve(__dirname, '..'),
            editUrl: `${GITHUB_REPO_URL}/tree/main/packages/`,
            packageFrontMatter: {
              lexical: [
                'sidebar_position: 1',
                'sidebar_label: lexical (core)',
              ].join('\n'),
            },
            targetDir: path.resolve(__dirname, 'docs/packages'),
          },
        ],
    './plugins/webpack-buffer',
    copyPageButtonPlugin,
    async function webpackLexicalModules() {
      return {
        configureWebpack(_config, _isServer, {currentBundler}) {
          const alias: Record<string, string | false | string[]> = {
            ...buildLexicalWebpackAliases(),
            '@examples/agent-example': path.resolve(
              __dirname,
              '../../examples/agent-example/src',
            ),
            '@examples/website-chat': path.resolve(
              __dirname,
              '../../examples/website-chat/src',
            ),
            '@examples/website-notion': path.resolve(
              __dirname,
              '../../examples/website-notion/src',
            ),
            '@examples/website-rich-input': path.resolve(
              __dirname,
              '../../examples/website-rich-input/src',
            ),
            '@examples/website-toolbar': path.resolve(
              __dirname,
              '../../examples/website-toolbar/src',
            ),
            '@huggingface/transformers': path.resolve(
              __dirname,
              'node_modules/@huggingface/transformers/dist/transformers.web.js',
            ),
            // transformers.web.js imports `onnxruntime-common` directly, but
            // it is only a transitive dep through onnxruntime-web. Resolve it
            // explicitly so webpack can find it under pnpm's strict layout.
            'onnxruntime-common': require.resolve('onnxruntime-common', {
              paths: [
                path.dirname(
                  require.resolve('onnxruntime-web', {
                    paths: [
                      path.dirname(
                        require.resolve('@huggingface/transformers'),
                      ),
                    ],
                  }),
                ),
              ],
            }),
            'onnxruntime-node': false,
            sharp: false,
          };
          return {
            plugins: [
              // FB_INTERNAL only exists in Meta's internal build. Define it for
              // the browser bundle so client code (e.g. ErrorCodePage) can read
              // process.env.FB_INTERNAL without a ReferenceError on `process`.
              new currentBundler.instance.DefinePlugin({
                'process.env.FB_INTERNAL': JSON.stringify(
                  process.env.FB_INTERNAL ?? '',
                ),
              }),
            ],
            resolve: {alias},
          };
        },
        name: 'webpack-lexical-modules',
      };
    } satisfies PluginModule,
    ['docusaurus-plugin-typedoc', docusaurusPluginTypedocConfig],
    async function tailwindcss() {
      return {
        configurePostCss(postcssOptions) {
          postcssOptions.plugins.push(tailwindcssPostcss);
          return postcssOptions;
        },
        name: 'docusaurus-tailwindcss',
      };
    } satisfies PluginModule,
    [
      '@docusaurus/plugin-client-redirects',
      {
        redirects: [
          {
            from: '/2024-recap',
            to: 'https://github.com/facebook/lexical/discussions/7220',
          },
        ],
      },
    ],
  ].filter(plugin => plugin != null),
  presets: [
    [
      'classic',
      {
        blog: false,
        docs: {
          beforeDefaultRemarkPlugins: [slugifyPlugin],
          editUrl: `${GITHUB_REPO_URL}/tree/main/packages/lexical-website/`,
          path: 'docs',
          sidebarItemsGenerator,
          sidebarPath: require.resolve('./sidebars.js'),
        },
        gtag: {
          trackingID: 'G-7C6YYBYBBT',
        },
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      },
    ],
  ],

  // Usually your GitHub org/user name.
  projectName: 'lexical',

  tagline: 'A text editor framework that does things differently',

  themeConfig: {
    docs: {
      sidebar: {
        autoCollapseCategories: true,
        hideable: true,
      },
    },
    image: 'img/opengraph-image.png',
    navbar: {
      items: [
        {
          label: 'Playground',
          position: 'left',
          to: 'https://playground.lexical.dev/',
        },
        {
          label: 'Docs',
          position: 'left',
          sidebarId: 'docs',
          type: 'docSidebar',
        },
        process.env.FB_INTERNAL
          ? {
              href: 'https://lexical.dev/docs/api/',
              label: 'API',
              position: 'left',
            }
          : {
              label: 'API',
              position: 'left',
              sidebarId: 'api',
              type: 'docSidebar',
            },

        {label: 'Community', position: 'left', to: '/community'},
        {
          label: 'Demos',
          position: 'left',
          to: '/gallery',
        },
        {
          'aria-label': 'GitHub',
          className: 'icon-link icon-link-mask icon-link-github',
          position: 'right',
          to: GITHUB_REPO_URL,
        },
        {
          'aria-label': 'Discord',
          className: 'icon-link icon-link-mask icon-link-discord',
          position: 'right',
          to: DISCORD_URL,
        },
      ].filter(item => item != null),
      logo: {
        alt: 'Lexical',
        height: 12,
        src: 'img/logo.svg',
        srcDark: 'img/logo-dark.svg',
      },
    },
    prism: {
      darkTheme: darkCodeTheme,
      theme: lightCodeTheme,
    },
  },

  themes: [
    '@docusaurus/theme-mermaid',
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        // `hashed` is recommended as long-term-cache of index file is possible.
        hashed: true,
        indexBlog: false,
        language: ['en'],
      },
    ],
  ],

  title: TITLE,
  url: 'https://lexical.dev',
};

export default config;
