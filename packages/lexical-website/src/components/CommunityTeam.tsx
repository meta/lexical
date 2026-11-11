/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import Link from '@docusaurus/Link';
import Translate from '@docusaurus/Translate';
import teamData from '@site/src/data/team.json';
import React from 'react';

interface TeamMember {
  avatar: string;
  links: {
    github: string;
  };
  location?: string;
  name: string;
  org?: string;
  orgLink?: string;
  sponsor?: string;
  title?: string;
  username: string;
}

interface TeamSectionProps {
  title: React.ReactNode;
  description: React.ReactNode;
  members: TeamMember[];
}

function TeamMemberCard({member}: {member: TeamMember}) {
  return (
    <div className="relative flex items-start gap-4 rounded-lg border border-gray-200 p-4 transition-shadow hover:shadow-md dark:border-gray-700">
      {member.sponsor && (
        <Link
          to={member.sponsor}
          className="absolute top-3 right-3 flex items-center gap-1 rounded-full border border-pink-300 bg-pink-50 px-2.5 py-1 text-xs font-medium text-pink-700 transition-colors hover:bg-pink-100 dark:border-pink-800 dark:bg-pink-950 dark:text-pink-300 dark:hover:bg-pink-900"
          aria-label={`Sponsor ${member.name}`}>
          <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
          Sponsor
        </Link>
      )}
      <Link
        to={`https://github.com/meta/lexical/commits?author=${member.username}`}
        className="absolute right-3 bottom-3 text-gray-500 transition-colors hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        aria-label={`View ${member.name}'s commits`}>
        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 16 16">
          <path d="m.427 1.927 1.215 1.215a8.002 8.002 0 1 1-1.6 5.685.75.75 0 1 1 1.493-.154 6.5 6.5 0 1 0 1.18-4.458l1.358 1.358A.25.25 0 0 1 3.896 6H.25A.25.25 0 0 1 0 5.75V2.104a.25.25 0 0 1 .427-.177ZM7.75 4a.75.75 0 0 1 .75.75v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5A.75.75 0 0 1 7.75 4Z" />
        </svg>
      </Link>
      <img
        src={member.avatar}
        alt={member.name}
        className="h-16 w-16 shrink-0 rounded-full"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 className="m-0 truncate text-base font-semibold">{member.name}</h3>
        <Link
          to={member.links.github}
          className="flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100">
          <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
            <path
              fillRule="evenodd"
              d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
              clipRule="evenodd"
            />
          </svg>
          @{member.username}
        </Link>
        {member.title && (
          <p className="m-0 text-sm text-gray-600 dark:text-gray-400">
            {member.title}
          </p>
        )}
        {member.org && (
          <p className="m-0 flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400">
            <svg
              className="h-3.5 w-3.5"
              fill="currentColor"
              viewBox="0 0 16 16">
              <path d="M1.75 16A1.75 1.75 0 0 1 0 14.25V1.75C0 .784.784 0 1.75 0h8.5C11.216 0 12 .784 12 1.75v12.5c0 .085-.006.168-.018.25h2.268a.25.25 0 0 0 .25-.25V8.285a.25.25 0 0 0-.111-.208l-1.055-.703a.749.749 0 1 1 .832-1.248l1.055.703c.487.325.779.871.779 1.456v5.965A1.75 1.75 0 0 1 14.25 16h-3.5a.766.766 0 0 1-.197-.026c-.099.017-.2.026-.303.026h-3a.75.75 0 0 1-.75-.75V14h-1v1.25a.75.75 0 0 1-.75.75Zm-.25-1.75c0 .138.112.25.25.25H4v-1.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 .75.75v1.25h2.25a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25ZM3.75 6h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5ZM3 3.75A.75.75 0 0 1 3.75 3h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 3 3.75Zm4 3A.75.75 0 0 1 7.75 6h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 7 6.75ZM7.75 3h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5ZM3 9.75A.75.75 0 0 1 3.75 9h.5a.75.75 0 0 1 0 1.5h-.5A.75.75 0 0 1 3 9.75ZM7.75 9h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1 0-1.5Z" />
            </svg>
            {member.orgLink ? (
              <Link
                to={member.orgLink}
                className="text-blue-600 dark:text-blue-400">
                {member.org}
              </Link>
            ) : (
              <span>{member.org}</span>
            )}
          </p>
        )}
        {member.location && (
          <p className="m-0 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
            <svg
              className="h-3.5 w-3.5"
              fill="currentColor"
              viewBox="0 0 16 16">
              <path d="m12.596 11.596-3.535 3.536a1.5 1.5 0 0 1-2.122 0l-3.535-3.536a6.5 6.5 0 1 1 9.192-9.193 6.5 6.5 0 0 1 0 9.193Zm-1.06-8.132v-.001a5 5 0 1 0-7.072 7.072L8 14.07l3.536-3.534a5 5 0 0 0 0-7.072ZM8 9a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 9Z" />
            </svg>
            {member.location}
          </p>
        )}
      </div>
    </div>
  );
}

function TeamSection({title, description, members}: TeamSectionProps) {
  return (
    <div className="mb-16 lg:flex lg:gap-8">
      <div className="mb-8 lg:sticky lg:top-24 lg:mb-0 lg:h-fit lg:w-64 lg:shrink-0">
        <h2 className="mb-4 text-2xl font-bold">{title}</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {description}
        </p>
      </div>
      <div className="flex flex-1 flex-col gap-3">
        {members.map(member => (
          <TeamMemberCard key={member.username} member={member} />
        ))}
      </div>
    </div>
  );
}

export default function CommunityTeam() {
  return (
    <div>
      <div className="mb-12">
        <h2>
          <Translate
            id="pages.community.team.header"
            description="Header for team section">
            Meet the Team
          </Translate>
        </h2>
        <p>
          <Translate
            id="pages.community.team.description"
            description="Description of team section">
            The development of Lexical is led by a core team of maintainers from
            Meta and the open source community. We are grateful for the
            contributions of all our community members who help make Lexical
            better every day.
          </Translate>
        </p>
      </div>

      <TeamSection
        title={
          <Translate
            id="pages.community.team.core.title"
            description="Core team section title">
            Core Team
          </Translate>
        }
        description={
          <Translate
            id="pages.community.team.core.description"
            description="Core team section description">
            Core team members actively maintain the project and have made
            significant contributions to Lexical, with a long-term commitment to
            its success and the community.
          </Translate>
        }
        members={teamData.core}
      />

      <TeamSection
        title={
          <Translate
            id="pages.community.team.emeriti.title"
            description="Core team emeriti section title">
            Core Team Emeriti
          </Translate>
        }
        description={
          <Translate
            id="pages.community.team.emeriti.description"
            description="Core team emeriti section description">
            We honor some no-longer-active core team members who helped shape
            Lexical into what it is today.
          </Translate>
        }
        members={teamData.emeriti}
      />

      <TeamSection
        title={
          <Translate
            id="pages.community.team.distinguished.title"
            description="Distinguished contributors section title">
            Distinguished Contributors
          </Translate>
        }
        description={
          <Translate
            id="pages.community.team.distinguished.description"
            description="Distinguished contributors section description">
            These community members have made exceptional contributions to
            Lexical through significant code contributions, documentation, or
            community support.
          </Translate>
        }
        members={teamData.distinguished}
      />
    </div>
  );
}
