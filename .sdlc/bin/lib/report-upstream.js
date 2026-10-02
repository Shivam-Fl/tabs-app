// A framework defect a project hit, reported where the framework lives — whether the project could
// fix it or not.
//
// Self-fix lands what it may (plumbing) and raises a PR on the framework when it holds a token.
// Everything else — a rule, a prompt, a fix that would not prove, a project with no token — stopped
// at a person in that project, and the framework never heard of it. Now each framework defect a
// triage names is reported on the framework's repository: filed there, or added to the issue that is
// already open for it, when the project holds a token (SDLC_UPSTREAM_TOKEN — a classic token with
// public_repo, since a repository's own GITHUB_TOKEN cannot open an issue anywhere else); without
// one, as a link that opens the report prefilled for a person to send.
//
// What leaves the project is the framework's side only: the file, what the triage said is wrong
// with it, the fix it proposed, and what happened. Credentials and addresses are scrubbed, and the
// project is not named unless `self_fix.name_project` says so.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { gh } from './actions.js';

const SECRETS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:sk|oc_sk|sk-ant|xox[abp])[-_][A-Za-z0-9_-]{12,}\b/g, /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /https?:\/\/[^\s/@]+:[^\s/@]+@/g, /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
];
/** Text from a project's logs, safe to post where anyone can read it. */
export const scrub = (s, max = 1500) => {
  const t = SECRETS.reduce((acc, re) => acc.replace(re, '[redacted]'), String(s ?? '')).trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** The same defect, however a triage worded it: the file and the failure's own signature. */
export function fingerprint({ file, signature, what }) {
  const key = `${file ?? ''}\n${String(signature || what || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** Which framework, at which commit, from the install's own record. */
export function frameworkOf(cfg = {}, manifestPath = '.sdlc/manifest.json') {
  let m = {};
  try { if (existsSync(manifestPath)) m = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* none */ }
  return { repo: cfg.self_fix?.framework_repo || m.source_repo || null, sha: m.source_sha || null };
}

export function report({ defect, outcome, stage, version, project }) {
  const fp = fingerprint(defect);
  const title = `Self-heal: ${scrub(defect.file, 120)} — ${scrub(defect.what, 140).split('\n')[0]}`;
  const body = [
    `A project running the pipeline hit a defect in the framework itself${project ? ` (\`${project}\`)` : ''}.`,
    '',
    `**Where:** \`${scrub(defect.file, 200)}\`${version ? ` at framework \`${String(version).slice(0, 12)}\`` : ''}${stage ? ` · the \`${stage}\` stage failed on it` : ''}`,
    '',
    `**What is wrong:** ${scrub(defect.what)}`,
    '',
    `**The fix its triage proposed:** ${scrub(defect.fix)}`,
    '',
    `**What happened there:** ${scrub(outcome, 1200)}`,
    '',
    `Fingerprint: \`${fp}\` — later reports of this defect are added here rather than filed again.`,
    '',
    '_Filed by the pipeline\'s self-heal. Only the framework\'s side is included: no logs, no project data, credentials scrubbed._',
  ].join('\n');
  return { fp, title, body };
}

/**
 * Report one defect upstream. Returns `{ filed | added: url }` with a token, `{ link }` without
 * one, or `{ skipped: why }`. Never throws: a report that could not be made costs the report only.
 */
export async function reportUpstream({ cfg = {}, defect, outcome, stage, project, token = process.env.SDLC_UPSTREAM_TOKEN }) {
  if (cfg.self_fix?.report_upstream === false) return { skipped: 'self_fix.report_upstream is off' };
  if (!defect?.file) return { skipped: 'no framework file was named' };
  const fw = frameworkOf(cfg);
  if (!fw.repo) return { skipped: 'this install does not record which framework it came from' };
  const named = cfg.self_fix?.name_project ? project : null;
  const { fp, title, body } = report({ defect, outcome, stage, version: fw.sha, project: named });

  if (!token) {
    const q = (s) => encodeURIComponent(s);
    return { link: `https://github.com/${fw.repo}/issues/new?title=${q(title)}&body=${q(body.slice(0, 5000))}` };
  }
  const as = { env: { ...process.env, GH_TOKEN: token } };
  try {
    const found = JSON.parse(await gh(['api', '-X', 'GET', 'search/issues', '-f',
      `q=repo:${fw.repo} is:issue is:open "${fp}"`, '--jq', '[.items[] | {number, html_url}]'], as) || '[]');
    if (found.length) {
      await gh(['issue', 'comment', String(found[0].number), '-R', fw.repo, '--body',
        `Seen again${named ? ` in \`${named}\`` : ' in another project'}${fw.sha ? ` at framework \`${fw.sha.slice(0, 12)}\`` : ''}` +
        `${stage ? `, in the \`${stage}\` stage` : ''}. ${scrub(outcome, 1200)}`], as);
      return { added: found[0].html_url };
    }
    const url = (await gh(['issue', 'create', '-R', fw.repo, '--title', title, '--body', body], as)).trim();
    return { filed: url };
  } catch (e) {
    return { skipped: `could not reach ${fw.repo}: ${String(e.message).split('\n')[0]}` };
  }
}

/** One line for the project's own comment, saying where the report went. */
export function reportLine(r) {
  if (r.filed) return `Reported to the framework: ${r.filed}`;
  if (r.added) return `Added to the framework's open report of this defect: ${r.added}`;
  if (r.link) return `[Report this to the framework](${r.link}) — prefilled, one click. A \`SDLC_UPSTREAM_TOKEN\` secret (a classic token with public_repo) files it automatically.`;
  return `Not reported to the framework: ${r.skipped}.`;
}
