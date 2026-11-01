/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import Link from '@docusaurus/Link';
import Translate from '@docusaurus/Translate';
import DiscordLogoSvg from '@site/static/img/discord-logo-color.svg';
import GithubDarkSvg from '@site/static/img/github-mark-dark.svg';
import GithubLightSvg from '@site/static/img/github-mark-light.svg';
import React from 'react';

import ImageSwitcher from './ImageSwitcher';

interface CommunityLinkData {
  description: React.ReactNode;
  image: React.ReactNode;
  title: React.ReactNode;
  url: string;
}

const links: CommunityLinkData[] = [
  {
    description: (
      <Translate
        id="pages.community.links.github.description"
        description="Description of Github community">
        Want to add a new feature or get a bug fixed? Create a pull request or
        raise an issue.
      </Translate>
    ),
    image: <ImageSwitcher light={GithubLightSvg} dark={GithubDarkSvg} />,
    title: (
      <Translate
        id="pages.community.links.github.title"
        description="Hyperlink to Github">
        GitHub
      </Translate>
    ),
    url: 'https://github.com/meta/lexical',
  },
  {
    description: (
      <Translate
        id="pages.community.links.discord.description"
        description="Description of Discord community">
        Join our Discord to stay current on announcements, ask questions, and
        discuss upcoming features and plans together.
      </Translate>
    ),
    image: <ImageSwitcher light={DiscordLogoSvg} dark={DiscordLogoSvg} />,
    title: (
      <Translate
        id="pages.community.links.discord.title"
        description="Hyperlink to Discord">
        Discord
      </Translate>
    ),
    url: 'https://discord.gg/KmG4wQnnD9',
  },
];

interface CommunityLinkProps {
  title: React.ReactNode;
  url: string;
  description: React.ReactNode;
  image: React.ReactNode;
}

function CommunityLink({title, url, description, image}: CommunityLinkProps) {
  return (
    <div className="grid gap-4 lg:grid-cols-[min-content_auto] lg:gap-20 lg:pl-20">
      <div className="flex h-24 w-24 justify-center overflow-hidden">
        {image}
      </div>

      <div>
        <Link to={url}>
          <h2>{title}</h2>
        </Link>

        <p>{description}</p>
      </div>
    </div>
  );
}

export default function CommunityLinks() {
  return (
    <div>
      {links.map((link, index) => (
        <div key={index} className="mb-4">
          <CommunityLink {...link} />
        </div>
      ))}
    </div>
  );
}
