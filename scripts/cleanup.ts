/**
 * Removes gists this suite leaked.
 *
 * Fixture teardown handles the normal case. This script covers what teardown
 * cannot: a killed process, a crashed CI runner, a network failure during
 * cleanup. It is the reason every artifact carries the `qa-auto` prefix.
 *
 *   npm run cleanup              # dry run, both accounts
 *   npm run cleanup -- --apply   # actually delete
 *   npm run cleanup -- --apply --older-than 0
 */
import { env } from '../src/config/env';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const olderThanHours = Number(
  args[args.indexOf('--older-than') + 1] ?? (args.includes('--older-than') ? '1' : '1'),
);

const PREFIX = 'qa-auto';

type Gist = { id: string; description: string | null; created_at: string; html_url: string };

async function githubFetch(token: string, path: string, init: RequestInit = {}) {
  return fetch(`${env.baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': env.apiVersion,
      Authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string>),
    },
  });
}

async function listAllGists(token: string): Promise<Gist[]> {
  const all: Gist[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await githubFetch(token, `/gists?per_page=100&page=${page}`);
    if (!response.ok) {
      throw new Error(`GET /gists -> ${response.status} ${await response.text()}`);
    }
    const batch = (await response.json()) as Gist[];
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

async function cleanupAccount(label: string, token: string): Promise<number> {
  const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000;
  const gists = await listAllGists(token);
  const orphans = gists.filter(
    (g) => g.description?.startsWith(PREFIX) && Date.parse(g.created_at) < cutoff,
  );

  console.log(
    `\n[${label}] ${gists.length} gists total, ${orphans.length} match "${PREFIX}*" and are older than ${olderThanHours}h`,
  );

  let deleted = 0;
  for (const gist of orphans) {
    if (!apply) {
      console.log(`  would delete ${gist.id}  ${gist.description}`);
      continue;
    }
    const response = await githubFetch(token, `/gists/${gist.id}`, { method: 'DELETE' });
    if (response.status === 204) {
      deleted += 1;
      console.log(`  deleted ${gist.id}  ${gist.description}`);
    } else {
      console.error(`  FAILED ${gist.id} -> ${response.status}`);
    }
  }
  return apply ? deleted : orphans.length;
}

async function main() {
  if (!apply) {
    console.log('Dry run — pass --apply to delete.');
  }

  const owner = await cleanupAccount('account A', env.tokenOwner);
  const other = await cleanupAccount('account B', env.tokenOther);

  console.log(`\n${apply ? 'Deleted' : 'Would delete'} ${owner + other} gists.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});