// Every check that gates an agent's artifact, in one place.
//
// A gate that enforces a rule the agent was never told about fails a finished run, and on
// growth-os that was the commonest stall of all: a retested bug cited on its test, a fixture kind
// outside an enum, a HAR recorded where the check did not look, API cases with no screenshot, a
// plan naming a reserved path, evidence cited from the evidence directory rather than the repo
// root. Each was found by a live run, fixed one at a time, and the next one was waiting.
//
// So the agent runs the gate itself before it finishes: preflight.mjs takes this list and runs,
// on the files the agent wrote, exactly what the job runs on them afterwards — and every agent
// that writes one of these is told to (claude-args.mjs). A mismatch costs a turn inside the
// session instead of a run, a triage and a person. The job's own run stays the gate; this is the
// same check, earlier. A workflow gate that is not in this list fails a test
// (tests/gate-checks.test.js), so the two cannot drift apart.
//
//   schema  the file's schema, through the loader every acting script uses (lib/artifact.js),
//           and QA's internal consistency for a report
//   then    the scripts the job runs after the schema, with PREFLIGHT=1 so none of them writes
export const GATES = {
  'work-order': { file: 'work-order.json', then: [
    ['check-forbidden.mjs', '--file', 'work-order.json'],
    ['check-split-criteria.mjs'],
  ] },
  stop: { file: 'stop.json' },
  'qa-report': { file: 'qa-report.json', then: [['check-evidence.mjs']] },
  'plan-review': { file: 'plan-review.json' },
  'review-correctness': { file: 'review/correctness.json' },
  'review-design': { file: 'review/design.json' },
  triage: { file: 'triage.json' },
  breakdown: { file: 'breakdown.json' },
  survey: { file: 'survey.json' },
  'project-brief': { file: 'project-brief.json' },
  'flow-plan': { file: 'flow-plan.json' },
  'self-fix-consult': { file: 'self-fix-consult.json' },
};

/** The roles whose output is gated here, and so are told to run the preflight. */
export const GATED_ROLES = ['plan', 'plan_arbiter', 'plan_reviewer', 'debug', 'review_correctness', 'review_design',
  'qa', 'root_cause', 'triage', 'maintainer', 'project', 'router'];

// What an agent's session RETURNS — the artifact it exists to produce, held to its schema by the
// SDK and written to its file by the step after it.
//
// The artifacts were files the agent had to remember to write, and the agents forgot: a QA run that
// had built and run a 10-case suite, a root-cause that ran 110 turns, an arbiter, a council proposer
// — each finished "successfully" with no file, and an hour of work was re-paid from the top. With
// --json-schema (claude-args.mjs --output) the SDK will not end the session until the result
// validates, and fails the step when it cannot; a step after it writes the file from that result.
//
//   key        a GATES key, or one of the extra outputs below
//   a|b        a choice: the result is one object with exactly one of the keys (`work_order`,
//              `stop`), and only that one is written
export const EXTRA_OUTPUTS = {
  proposal: { file: 'plan/proposal.json', schema: 'work-order' },
  critique: { file: 'plan/critique.json', schema: { type: 'object' } },
  'review-md': { file: 'review/review.md', text: true,
    schema: { type: 'object', required: ['markdown'], additionalProperties: false,
      properties: { markdown: { type: 'string', minLength: 40 } } } },
};

const strip = (v) => (Array.isArray(v) ? v.map(strip)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v)
    .filter(([k]) => !['description', 'examples', '$comment', '$id', 'title'].includes(k)).map(([k, x]) => [k, strip(x)]))
  : v);

/**
 * The schema a session's result is held to and the files it becomes, for an --output spec.
 * `readSchema(name)` returns a schema from .sdlc/schemas. Descriptions are dropped: the packs say
 * what each field means, and the schema travels inside a shell-quoted argument.
 */
export function outputSpec(spec, readSchema) {
  const keys = String(spec).split('|').map((k) => k.trim()).filter(Boolean);
  if (!keys.length) throw new Error('no output named');
  const one = (k) => {
    const extra = EXTRA_OUTPUTS[k];
    if (extra) {
      return { file: extra.file, text: Boolean(extra.text),
        schema: strip(typeof extra.schema === 'string' ? readSchema(extra.schema) : extra.schema) };
    }
    if (!GATES[k]) throw new Error(`"${k}" is not an output this pipeline knows`);
    return { file: GATES[k].file, text: false, schema: strip(readSchema(k)) };
  };
  if (keys.length === 1) {
    const o = one(keys[0]);
    // A text output's result is { markdown }; a JSON output's result is the artifact itself.
    return { schema: o.schema, files: [[o.text ? 'markdown' : '.', o.file, o.text ? 'text' : 'json']] };
  }
  const prop = (k) => k.replace(/-/g, '_');
  const parts = keys.map((k) => [prop(k), one(k)]);
  return {
    schema: { type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 1,
      properties: Object.fromEntries(parts.map(([p, o]) => [p, o.schema])) },
    files: parts.map(([p, o]) => [p, o.file, 'json']),
  };
}
