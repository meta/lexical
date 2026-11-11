/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/**
 * This script was used to seed the initial data for
 * https://github.com/meta/lexical/pull/8270
 * and may be removed later
 */

import fs from 'fs';
import {dirname, join} from 'path';
import {fileURLToPath} from 'url';

/**
 * A single team member as stored in team.json
 * @typedef {Object} TeamMember
 * @property {string} username the GitHub username
 * @property {string} name the GitHub display name
 */

/**
 * The shape of team.json
 * @typedef {Object} TeamData
 * @property {Array<TeamMember>} core
 * @property {Array<TeamMember>} emeriti
 * @property {Array<TeamMember>} distinguished
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ALL historical reviewers from PR scan (hardcoded - this is the complete list)
// Each entry is {name, username} where name is their GitHub display name
// Names from team.json will override these values if present
// This was generated from the find-all-pr-reviewers.mjs script.
const allHistoricalReviewers = [
  {name: 'Achim Weimert', username: 'a-xin'},
  {name: 'Abhijit Tomar', username: 'abhijitt'},
  {name: 'Acy Watson', username: 'acywatson'},
  {name: 'amyworrall', username: 'amyworrall'},
  {name: 'bailey-meta', username: 'bailey-meta'},
  {name: 'Tong Xi', username: 'btezzxxt'},
  {name: 'Daniel Lo Nigro', username: 'Daniel15'},
  {name: 'Ebad', username: 'ebads67'},
  {name: 'Bob Ippolito', username: 'etrepum'},
  {name: 'Maksim Horbachevsky', username: 'fantactuka'},
  {name: 'Luis Silva', username: 'Fetz'},
  {name: 'freddymeta', username: 'freddymeta'},
  {name: 'Max Haubenstock', username: 'haubey'},
  {name: 'Ivaylo Pavlov', username: 'ivailop7'},
  {name: 'Justin Haaheim', username: 'justinhaaheim'},
  {name: 'kraisler', username: 'kraisler'},
  {name: 'Yuncheng Lu', username: 'lilshady'},
  {name: 'Marc Laval', username: 'marclaval'},
  {name: 'Jaime Oyarzún Knittel', username: 'mitoyarzun'},
  {name: 'Niels Y.', username: 'nyogi'},
  {name: 'Sherry', username: 'potatowagon'},
  {name: 'Denys Mikhalenko', username: 'prontiol'},
  {name: 'Sahejkm', username: 'Sahejkm'},
  {name: 'Shubhanker Srivastava', username: 'Shubhankerism'},
  {name: 'Steven Luscher', username: 'steveluscher'},
  {name: 'Vlad Fedosov', username: 'StyleT'},
  {name: 'Daniel Teo', username: 'takuyakanbr'},
  {name: 'John Flockton', username: 'thegreatercurve'},
  {name: 'Dominic Gannaway', username: 'trueadm'},
  {name: 'Tyler Bainbridge', username: 'tylerjbainbridge'},
  {name: 'Yangshun Tay', username: 'yangshun'},
  {name: 'Gerard Rovira', username: 'zurfyx'},
];

// Read current team.json to categorize them
const teamDataPath = join(
  __dirname,
  '../packages/lexical-website/src/data/team.json',
);
const teamData = /** @type {TeamData} */ (
  JSON.parse(fs.readFileSync(teamDataPath, 'utf8'))
);

const coreUsernames = teamData.core.map(m => m.username);
const emeritiUsernames = teamData.emeriti.map(m => m.username);
const distinguishedUsernames = teamData.distinguished.map(m => m.username);

// Create a map of username -> display name
// Priority: team.json data, then hardcoded historical data
const usernameToName = new Map();

// First add all hardcoded names
allHistoricalReviewers.forEach(({name, username}) => {
  usernameToName.set(username, name);
});

// Then override with team.json data (which is more authoritative)
[...teamData.core, ...teamData.emeriti, ...teamData.distinguished].forEach(
  member => {
    usernameToName.set(member.username, member.name);
  },
);

/**
 * Helper function to format a reviewer with name and username
 * @param {string} username the GitHub username
 * @returns {string} the formatted "Display Name (@username)" string
 */
function formatReviewer(username) {
  const displayName = usernameToName.get(username);
  return `${displayName} (@${username})`;
}

// Categorize all historical reviewers
const core = allHistoricalReviewers
  .filter(r => coreUsernames.includes(r.username))
  .sort((a, b) =>
    a.username.toLowerCase().localeCompare(b.username.toLowerCase()),
  );
const emeriti = allHistoricalReviewers
  .filter(r => emeritiUsernames.includes(r.username))
  .sort((a, b) =>
    a.username.toLowerCase().localeCompare(b.username.toLowerCase()),
  );
const distinguished = allHistoricalReviewers
  .filter(r => distinguishedUsernames.includes(r.username))
  .sort((a, b) =>
    a.username.toLowerCase().localeCompare(b.username.toLowerCase()),
  );
const notInTeamData = allHistoricalReviewers
  .filter(
    r =>
      !coreUsernames.includes(r.username) &&
      !emeritiUsernames.includes(r.username) &&
      !distinguishedUsernames.includes(r.username),
  )
  .sort((a, b) =>
    a.username.toLowerCase().localeCompare(b.username.toLowerCase()),
  );

console.log('```markdown');
console.log(
  `## All Historical PR Reviewers (${allHistoricalReviewers.length} total)`,
);
console.log('');
console.log(`### ✅ Core Team (${core.length})`);
core.forEach(({username}) => {
  console.log(`- ${formatReviewer(username)}`);
});
console.log('');

console.log(`### 🎖️ Core Team Emeriti (${emeriti.length})`);
emeriti.forEach(({username}) => {
  console.log(`- ${formatReviewer(username)}`);
});
console.log('');

console.log(`### ⭐ Distinguished Contributors (${distinguished.length})`);
distinguished.forEach(({username}) => {
  console.log(`- ${formatReviewer(username)}`);
});
console.log('');

console.log(
  `### 📜 Historical - Not in Current Team Data (${notInTeamData.length})`,
);
notInTeamData.forEach(({username}) => {
  console.log(`- ${formatReviewer(username)}`);
});
console.log('');

console.log('---');
console.log('');
console.log(
  `**Summary:** ${allHistoricalReviewers.length} unique people have had PR approval access throughout Lexical's history`,
);
console.log(`- ${core.length} current core team members`);
console.log(`- ${emeriti.length} core team emeriti`);
console.log(
  `- ${distinguished.length} distinguished contributors (with >10 contributions)`,
);
console.log(
  `- ${notInTeamData.length} historical reviewers (not currently tracked in team data)`,
);
console.log('```');
