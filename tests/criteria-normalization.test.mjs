import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalCriterion, criterionId, acceptanceCriteriaIds, matchesCriterion, validateDelivery, parseDelivery, deliveryInstructions } from '../workflow-contract.mjs';
import { verifyUnicodeDeliveryTransport } from '../orca-delivery-transport.mjs';
import { saveStageReport } from '../orca-evidence.mjs';
import { assertDeliveryTransportProof } from '../queue.mjs';

// Improvement 30 (D5): a reviewer writing without accents left job 8 of EOC-E2E-01
// in delivery_acceptance_missing. Criteria compare by canonical text and any supplied
// id must agree. Recovery of such a report does not need a Codex session archive.
const identity = { jobId: 'criteria-job', jobAttempt: 1, stage: 'reviewer', runId: 'run_criteria001', taskId: 'task_criteria001', dispatchId: 'ctx_criteria001' };
const criteria = ["slugify('') devuelve la cadena vacía ''", 'Añadir mediante botón y tecla Enter.'];
const report = (acceptance, extra = {}) => ({ version: 1, ...identity, outcome: 'completed', scope: 'complete', approval: 'approved', summary: 'Revision aprobada.',
  acceptance, evidence: ['npm test 6/6'], questions: [], decisions: [], ...extra });
const passed = (criterion, extra = {}) => ({ criterion, status: 'passed', evidence: 'Comprobado.', ...extra });
const sha = value => createHash('sha256').update(value).digest('hex');

test('canonical criteria ignore accents, case and spacing but not different words', () => {
  assert.equal(canonicalCriterion('  Añadir   mediante BOTÓN y tecla Enter. '), 'anadir mediante boton y tecla enter.');
  assert.equal(canonicalCriterion('cadena vacía'), canonicalCriterion('cadena vacia'));
  assert.equal(canonicalCriterion('Ñandú'), canonicalCriterion('nandu'));
  assert.equal(canonicalCriterion('é'), canonicalCriterion('é'));
  assert.notEqual(canonicalCriterion('cadena vacía'), canonicalCriterion('cadena llena'));
  assert.notEqual(canonicalCriterion('A?adir'), canonicalCriterion('Añadir'));
  assert.match(criterionId('Añadir'), /^crit_[a-f0-9]{16}$/);
  assert.equal(criterionId('Añadir mediante botón'), criterionId('anadir  mediante BOTON'));
  assert.notEqual(criterionId('Añadir mediante botón'), criterionId('Quitar mediante botón'));
  assert.deepEqual(acceptanceCriteriaIds(['a', 'b']).map(item => item.criterion), ['a', 'b']);
  assert.equal(matchesCriterion({ criterion: 'otro', criterionId: criterionId('Añadir') }, 'añadir'), false);
  assert.equal(matchesCriterion({ criterion: 'añadir', criterionId: criterionId('otro') }, 'añadir'), false, 'an explicit id must match the text');
  assert.equal(matchesCriterion(null, 'x'), false);
});

test('a QA or review report without accents, with another case or with stable ids covers the contract criteria', () => {
  const expected = { ...identity, acceptance: criteria };
  const ascii = report([passed("slugify('') devuelve la cadena vacia ''"), passed('anadir mediante boton y tecla enter.')]);
  assert.equal(validateDelivery(ascii, expected).approval, 'approved');
  const byId = report(criteria.map(criterion => passed(canonicalCriterion(criterion), { criterionId: criterionId(criterion) })));
  const unrelated = report([passed(criteria[0]), passed('El fondo es azul.', { criterionId: criterionId(criteria[1]) })]);
  assert.throws(() => validateDelivery(unrelated, expected), { code: 'delivery_acceptance_missing' });
  assert.equal(validateDelivery(byId, expected).acceptance[0].criterionId, criterionId(criteria[0]));
  const spaced = report([passed("SLUGIFY('')   devuelve la cadena vacía ''"), passed(criteria[1])]);
  assert.doesNotThrow(() => validateDelivery(spaced, expected));
  // Negatives: a different criterion, a wrong id, a damaged transport ('?') and a malformed id.
  assert.throws(() => validateDelivery(report([passed(criteria[0]), passed('Quitar mediante botón y tecla Enter.')]), expected), { code: 'delivery_acceptance_missing' });
  assert.throws(() => validateDelivery(report([passed(criteria[0]), passed(criteria[1], { criterionId: criterionId('otro') })]), expected), { code: 'delivery_acceptance_missing' });
  assert.throws(() => validateDelivery(report([passed(criteria[0]), passed('A?adir mediante bot?n y tecla Enter.')]), expected), { code: 'delivery_acceptance_missing' });
  assert.throws(() => validateDelivery(report([passed(criteria[0], { criterionId: 'nope' }), passed(criteria[1])]), expected), { code: 'delivery_invalid' });
  // Legacy exact-text deliveries keep working unchanged.
  assert.equal(validateDelivery(report(criteria.map(criterion => passed(criterion))), expected).acceptance.length, 2);
});

test('an explicit reviewer rejection names a contract criterion without accents and still closes the gate', () => {
  const blocked = report([passed(criteria[0]), { criterion: 'anadir mediante boton y tecla enter.', status: 'failed', evidence: 'Enter no añade.' }], { approval: 'blocked' });
  const parsed = parseDelivery(JSON.stringify(blocked), { ...identity, acceptance: criteria }, { required: true, preserveExplicitBlock: true });
  assert.equal(parsed.outcome, 'blocked');
  const unrelated = report([passed(criteria[0]), { criterion: 'otra cosa', status: 'failed', evidence: 'x' }], { approval: 'blocked' });
  assert.throws(() => parseDelivery(JSON.stringify(unrelated), { ...identity, acceptance: criteria }, { required: true, preserveExplicitBlock: true }), { code: 'delivery_invalid' });
});

test('the delivery instructions publish the stable id of every contract criterion', () => {
  const job = { id: 'criteria-job', attempts: 1, contract: { version: 1, acceptance: criteria } };
  const text = deliveryInstructions(job, 'reviewer', identity.runId);
  for (const criterion of criteria) assert.ok(text.includes(criterionId(criterion)), criterion);
  assert.ok(text.includes('criterionId'));
  assert.equal(deliveryInstructions({ id: 'x', attempts: 1, contract: { version: 1, acceptance: [] } }, 'qa', identity.runId).includes('ID ESTABLE'), false);
});

test('a stored report that validates under the normalized rules recovers without any session archive', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'criteria-recovery-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'checkout');
  const ascii = JSON.stringify(report([passed("slugify('') devuelve la cadena vacia ''"), passed('anadir mediante boton y tecla enter.')]));
  const artifact = await saveStageReport(root, identity, ascii, null);
  const job = { id: identity.jobId, workspace, attempts: 1, contract: { acceptance: criteria }, workflow: { runId: identity.runId, currentStage: 'reviewer',
    steps: [{ key: 'reviewer', ...identity, status: 'blocked', error: 'delivery_acceptance_missing', dispatchStatus: 'completed', dispatchSettled: true, taskInputAttempt: 1, artifact }] } };
  const step = job.workflow.steps[0];
  const command = async args => {
    if (args[1] === 'worker-show') return { ...identity, state: 'succeeded', liveness: 'exited', workspace };
    if (args[1] === 'inbox') return { messages: [{ id: 'msg_criteria001', type: 'worker_done', run_id: identity.runId, to_handle: `run:${identity.runId}`, payload: { ...identity, outcome: 'succeeded' }, body: ascii }] };
    assert.fail('Unexpected native command');
  };
  const readArchive = async () => assert.fail('The Codex session archive must not be consulted when the report itself validates.');
  const result = await verifyUnicodeDeliveryTransport(root, job, step, { command, readArchive });
  assert.equal(result.proof.kind, 'criteria_normalized');
  assert.equal(result.proof.transcriptSourceIdentity, 'stage-report:' + artifact.sha256);
  assert.equal(result.proof.receiptSha256, sha(ascii)); assert.equal(result.proof.transcriptSha256, sha(ascii));
  assert.equal(result.delivery.approval, 'approved'); assert.equal(result.text, ascii);
  const accepted = assertDeliveryTransportProof(job, result.proof);
  assert.equal(accepted.kind, 'criteria_normalized');
  assert.throws(() => assertDeliveryTransportProof(job, { ...result.proof, kind: 'other' }), { code: 'delivery_transport_unverified' });
  assert.throws(() => assertDeliveryTransportProof(job, { ...result.proof, originalArtifactSha256: 'f'.repeat(64) }), { code: 'delivery_transport_unverified' });
  // Genuine transport damage ('?' for every non-ASCII byte) still needs the archive.
  const damaged = JSON.stringify(report(criteria.map(criterion => passed(criterion)))).replace(/[^\x00-\x7f]/g, '?');
  const damagedArtifact = await saveStageReport(root, { ...identity, dispatchId: 'ctx_criteria002' }, damaged, null);
  const damagedStep = { ...step, dispatchId: 'ctx_criteria002', artifact: damagedArtifact };
  const damagedCommand = async args => {
    if (args[1] === 'worker-show') return { ...identity, dispatchId: 'ctx_criteria002', state: 'succeeded', liveness: 'exited', workspace };
    return { messages: [{ id: 'msg_criteria002', type: 'worker_done', run_id: identity.runId, to_handle: `run:${identity.runId}`, payload: { ...identity, dispatchId: 'ctx_criteria002', outcome: 'succeeded' }, body: damaged }] };
  };
  let archiveReads = 0;
  await assert.rejects(verifyUnicodeDeliveryTransport(root, { ...job, workflow: { ...job.workflow, steps: [damagedStep] } }, damagedStep, { command: damagedCommand,
    readArchive: async () => { archiveReads++; throw Object.assign(new Error('sin archivo'), { code: 'orca_archived_transcript_unverified' }); } }), /sin archivo/);
  assert.equal(archiveReads, 1);
});

test('a criterion the worker escaped twice still names the same criterion; another text or another id does not', async () => {
  const { matchesCriterion, criterionId, parseDelivery } = await import('../workflow-contract.mjs');
  const criterion = "`countWords('Hola mundo cruel') === 3`.";
  const escaped = '`countWords(\\u0027Hola mundo cruel\\u0027) === 3`.'; // what JSON.parse leaves when the worker wrote \\\\u0027
  assert.equal(matchesCriterion({ criterion: escaped, criterionId: criterionId(criterion) }, criterion), true);
  assert.equal(matchesCriterion({ criterion: escaped }, criterion), true);
  assert.equal(matchesCriterion({ criterion: 'Revisi\\u00f3n del c\\u00f3digo.' }, 'Revisión del código.'), true);
  assert.equal(matchesCriterion({ criterion: '`countWords(\\u0027Otra cosa\\u0027) === 3`.', criterionId: criterionId(criterion) }, criterion), false);
  assert.equal(matchesCriterion({ criterion: escaped, criterionId: 'crit_0000000000000000' }, criterion), false);
  // The real report: an approved review whose every string was escaped twice now validates as the approval it is.
  const identity = { jobId: 'job-escape-0001', jobAttempt: 1, stage: 'reviewer', runId: 'run_escape0001', taskId: 'task_escape0001', dispatchId: 'ctx_escape0001' };
  const body = { version: 1, ...identity, outcome: 'completed', scope: 'complete', approval: 'approved', summary: 'Revisi\\u00f3n de solo lectura. RESULTADO: APROBADO',
    acceptance: [{ criterion: escaped, criterionId: criterionId(criterion), status: 'passed', evidence: 'test/text.test.mjs:70; pasa' }], evidence: ['npm test: 18/18'], questions: [], decisions: [] };
  const delivery = parseDelivery('```centro-delivery\n' + JSON.stringify(body) + '\n```', { ...identity, acceptance: [criterion] }, { required: true, strictReview: true });
  assert.equal(delivery.approval, 'approved');
});

test('a criterion whose quotes were eaten by the shell still matches, but only with its exact id', async () => {
  const { matchesCriterion, criterionId, parseDelivery } = await import('../workflow-contract.mjs');
  const pairs = [["`reverse('abc') === 'cba'`.", '`reverse(abc) === cba`.'], ["`reverse('') === ''`.", '`reverse() === `.'], ["`reverse(42) === ''`.", '`reverse(42) === `.']];
  for (const [criterion, eaten] of pairs) {
    assert.equal(matchesCriterion({ criterion: eaten, criterionId: criterionId(criterion) }, criterion), true, eaten);
    assert.equal(matchesCriterion({ criterion: eaten }, criterion), false, 'without the id the text has to match');
    assert.equal(matchesCriterion({ criterion: eaten, criterionId: 'crit_0000000000000000' }, criterion), false);
  }
  assert.equal(matchesCriterion({ criterion: '`reverse(abd) === cba`.', criterionId: criterionId("`reverse('abc') === 'cba'`.") }, "`reverse('abc') === 'cba'`."), false, 'another word is another criterion');
  // The real QA report of the third pilot, as stored.
  const acceptance = ['`npm test` del sandbox pasa.', ...pairs.map(([criterion]) => criterion)];
  const identity = { jobId: 'idea-0f33595e-b7a0-46ee-8a42-d140074fc790-v1-code', jobAttempt: 1, stage: 'qa', runId: 'run_d6fadfc7e433', taskId: 'task_d81ff9cee2f5', dispatchId: 'ctx_773785a72173' };
  const body = { version: 1, ...identity, outcome: 'completed', scope: 'complete', approval: 'approved', summary: 'QA sin ediciones; npm test 22/22.',
    acceptance: [{ criterion: acceptance[0], criterionId: criterionId(acceptance[0]), status: 'passed', evidence: 'npm test: 22/22' },
      ...pairs.map(([criterion, eaten]) => ({ criterion: eaten, criterionId: criterionId(criterion), status: 'passed', evidence: 'test pasa' }))],
    evidence: ['npm test: 22/22'], questions: [], decisions: [], findings: [] };
  assert.equal(parseDelivery(JSON.stringify(body), { ...identity, acceptance }, { required: true, strictReview: true }).approval, 'approved');
});
