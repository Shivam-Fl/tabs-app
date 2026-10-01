#!/usr/bin/env node
// What the pipeline did on a repository, counted from what GitHub and the ledgers recorded — never
// from what an agent said about itself.
//
//   node .sdlc/bin/metrics.mjs <owner/repo> [--since 2026-10-02] [--json out.json]
//
// Human touches are counted the way a sceptic would: every comment, merge and commit by someone
// who is not the pipeline. Framework syncs are counted apart — they change the pipeline, not the
// product — and are listed, not hidden.
import { writeFileSync } from 'node:fs';
import { gh, flags, isPipelineAuthor } from './lib/actions.js';
import { listLedgers, readLedger } from './lib/state-io.js';

const isBot = (login) => isPipelineAuthor(login) || /\[bot\]$/.test(String(login ?? ''));
const mins = (a, b) => (a && b ? Math.max(0, (new Date(b) - new Date(a)) / 60000) : 0);
const AGENT_WORKFLOWS = /^sdlc-(plan|implement|review|qa|root-cause|triage|project|maintainer|self-fix|librarian|intake)$/;

/** Every number below, from data already fetched. Pure, so it is tested without GitHub. */
export function summarize({ since, issues = [], pulls = [], comments = [], commits = [], runs = [], ledgers = [], models = {} }) {
  const tickets = issues.filter((i) => !i.pull_request);
  const merged = pulls.filter((p) => p.merged_at);
  const product = merged.filter((p) => !/^memory\//.test(p.head?.ref ?? ''));
  const qa = comments.filter((c) => isBot(c.user?.login) && /^## QA — /.test(c.body ?? ''));
  const num = (c, re) => Number((c.body.match(re) ?? [])[1] ?? 0);
  const human = comments.filter((c) => !isBot(c.user?.login));
  const sync = (m) => /^chore: sync the framework/.test(m);
  const humanCommits = commits.filter((c) => !isBot(c.author?.login) && !sync(c.commit?.message ?? ''));
  const attempts = ledgers.reduce((a, l) => {
    for (const [k, v] of Object.entries(l.attempts ?? {})) a[k] = (a[k] ?? 0) + (Number(v) || 0);
    return a;
  }, {});
  const lastMerge = product.map((p) => p.merged_at).sort().at(-1) ?? null;
  const byWorkflow = runs.reduce((a, r) => ({ ...a, [r.name]: (a[r.name] ?? 0) + 1 }), {});

  return {
    since,
    wall_clock_hours: lastMerge ? +(mins(since, lastMerge) / 60).toFixed(1) : null,
    tickets: {
      total: tickets.length,
      filed_by_pipeline: tickets.filter((i) => isBot(i.user?.login)).length,
      filed_by_people: tickets.filter((i) => !isBot(i.user?.login)).length,
      closed_completed: tickets.filter((i) => i.state_reason === 'completed').length,
      open: tickets.filter((i) => i.state === 'open').length,
    },
    pull_requests: {
      merged: product.length,
      merged_by_pipeline: product.filter((p) => isBot(p.merged_by?.login)).length,
      lines_added: product.reduce((a, p) => a + (p.additions ?? 0), 0),
      lines_deleted: product.reduce((a, p) => a + (p.deletions ?? 0), 0),
      files_changed: product.reduce((a, p) => a + (p.changed_files ?? 0), 0),
      test_files_touched: product.reduce((a, p) => a + (p.test_files ?? 0), 0),
      memory_prs_merged: merged.length - product.length,
    },
    quality: {
      work_orders: comments.filter((c) => isBot(c.user?.login) && /^## Work order v\d+/.test(c.body ?? '')).length,
      plan_reviews: comments.filter((c) => isBot(c.user?.login) && /^## Plan review: /.test(c.body ?? '')).length,
      plan_rejections: comments.filter((c) => isBot(c.user?.login) && /^## Plan review: rejected/.test(c.body ?? '')).length,
      code_reviews: comments.filter((c) => isBot(c.user?.login) && /^## Review — /.test(c.body ?? '')).length,
      qa_runs: qa.length,
      qa_passed: qa.filter((c) => /🟢 pass/.test(c.body)).length,
      qa_failed: qa.filter((c) => /🔴 fail/.test(c.body)).length,
      qa_cases: qa.reduce((a, c) => a + num(c, /\*\*(\d+) cases\*\*/), 0),
      qa_bugs_found: qa.reduce((a, c) => a + num(c, /\*\*(\d+) bugs?\*\*/), 0),
    },
    effort: {
      attempts,
      workflow_runs: runs.length,
      agent_runs: runs.filter((r) => AGENT_WORKFLOWS.test(r.name)).length,
      actions_minutes: Math.round(runs.reduce((a, r) => a + mins(r.run_started_at, r.updated_at), 0)),
      by_workflow: byWorkflow,
    },
    human_touches: {
      comments: human.length,
      commands: human.filter((c) => /^\s*\/sdlc\b/.test(c.body ?? '')).length,
      merges: merged.filter((p) => !isBot(p.merged_by?.login)).length,
      commits: humanCommits.length,
      framework_syncs: commits.filter((c) => sync(c.commit?.message ?? '')).length,
      list: [
        ...human.map((c) => `${c.created_at} comment by @${c.user.login}: ${String(c.body).split('\n')[0].slice(0, 80)}`),
        ...merged.filter((p) => !isBot(p.merged_by?.login)).map((p) => `${p.merged_at} merge of #${p.number} by @${p.merged_by?.login}`),
        ...humanCommits.map((c) => `${c.commit.author?.date} commit by @${c.author?.login ?? c.commit.author?.name}: ${c.commit.message.split('\n')[0].slice(0, 80)}`),
      ].sort(),
    },
    models,
  };
}

export function markdown(m, repo) {
  const row = (k, v) => `| ${k} | ${v} |`;
  return [
    `## ${repo} — since ${m.since.slice(0, 16).replace('T', ' ')}`,
    '',
    '| | |', '|---|---|',
    row('Wall clock to last merge', m.wall_clock_hours == null ? '—' : `${m.wall_clock_hours} h`),
    row('Tickets', `${m.tickets.total} (${m.tickets.filed_by_pipeline} filed by the pipeline, ${m.tickets.filed_by_people} by people) · ${m.tickets.closed_completed} done · ${m.tickets.open} open`),
    row('PRs merged', `${m.pull_requests.merged} (${m.pull_requests.merged_by_pipeline} by the pipeline)`),
    row('Code', `+${m.pull_requests.lines_added} / −${m.pull_requests.lines_deleted} across ${m.pull_requests.files_changed} files · ${m.pull_requests.test_files_touched} test files`),
    row('Plans', `${m.quality.work_orders} work orders · ${m.quality.plan_reviews} plan reviews (${m.quality.plan_rejections} sent back)`),
    row('Code reviews', m.quality.code_reviews),
    row('QA', `${m.quality.qa_runs} runs (${m.quality.qa_passed} pass, ${m.quality.qa_failed} fail) · ${m.quality.qa_cases} cases · ${m.quality.qa_bugs_found} bugs found`),
    row('Agent runs', `${m.effort.agent_runs} of ${m.effort.workflow_runs} workflow runs · ${m.effort.actions_minutes} Actions minutes`),
    row('Human touches', `${m.human_touches.comments} comments (${m.human_touches.commands} /sdlc commands) · ${m.human_touches.merges} merges · ${m.human_touches.commits} commits`),
    row('Framework syncs', m.human_touches.framework_syncs),
    row('Models', [...new Set(Object.values(m.models))].join(', ') || '—'),
    '',
    ...(m.human_touches.list.length ? ['<details><summary>Every human touch</summary>', '', ...m.human_touches.list.map((l) => `- ${l}`), '', '</details>'] : []),
  ].join('\n');
}

async function pages(path) {
  const out = await gh(['api', '--paginate', path, '--jq', '.[]', '-H', 'Accept: application/vnd.github+json']);
  return out ? out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const repo = process.argv[2];
  const f = flags(process.argv.slice(3));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
    process.stderr.write('usage: metrics.mjs <owner/repo> [--since YYYY-MM-DD] [--json out.json]\n');
    process.exit(1);
  }
  const info = JSON.parse(await gh(['api', `repos/${repo}`]));
  const since = new Date(f.since && f.since !== true ? f.since : info.created_at).toISOString();
  const after = (t) => t && t >= since;

  const [issues, pulls, comments, commits] = await Promise.all([
    pages(`repos/${repo}/issues?state=all&per_page=100&since=${since}`).then((xs) => xs.filter((i) => after(i.created_at))),
    pages(`repos/${repo}/pulls?state=all&per_page=100`).then((xs) => xs.filter((p) => after(p.created_at))),
    pages(`repos/${repo}/issues/comments?per_page=100&since=${since}`).then((xs) => xs.filter((c) => after(c.created_at))),
    pages(`repos/${repo}/commits?per_page=100&since=${since}`),
  ]);
  // A day at a time: the runs API returns at most 1,000 runs for one query and says nothing when
  // it stops, and a busy pipeline does that in two days.
  const runs = [];
  for (let d = new Date(since.slice(0, 10)); d <= new Date(); d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    const out = await gh(['api', '--paginate', `repos/${repo}/actions/runs?per_page=100&created=${day}`,
      '--jq', '.workflow_runs[] | {name, conclusion, run_started_at, updated_at, created_at} | tojson']);
    runs.push(...out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => after(r.created_at)));
  }

  // Size and test files per merged PR: the list endpoint carries neither.
  for (const p of pulls.filter((x) => x.merged_at)) {
    const full = JSON.parse(await gh(['api', `repos/${repo}/pulls/${p.number}`]));
    const files = await pages(`repos/${repo}/pulls/${p.number}/files?per_page=100`);
    Object.assign(p, { additions: full.additions, deletions: full.deletions, changed_files: full.changed_files,
      merged_by: full.merged_by, test_files: files.filter((x) => /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(x.filename)).length });
  }
  const ledgers = [];
  for (const n of await listLedgers(repo)) {
    const { ledger } = await readLedger(repo, n);
    if (ledger && after(ledger.created_at)) ledgers.push(ledger);
  }
  let models = {};
  try {
    const { load } = await import('./lib/js-yaml.mjs');
    const cfg = load(Buffer.from(JSON.parse(await gh(['api', `repos/${repo}/contents/.sdlc/config.yml`])).content, 'base64').toString('utf8'));
    models = cfg?.runtime?.model ?? {};
  } catch { /* no config: not a pipeline repo, or not readable */ }

  const m = summarize({ since, issues, pulls, comments, commits, runs, ledgers, models });
  if (f.json && f.json !== true) writeFileSync(f.json, `${JSON.stringify({ repo, ...m }, null, 2)}\n`);
  process.stdout.write(`${markdown(m, repo)}\n`);
}
