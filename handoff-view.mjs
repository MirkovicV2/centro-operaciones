// Role views of a stage delivery. The pipeline is hybrid (Claude develops, Codex verifies), so what each role
// receives is part of the independence guarantee:
//  - compactHandoff: the facts of a stage (statuses, evidence, findings, candidate) without repeating the criterion
//    text, which the contract already carries with its id, and without empty fields. Pointer to the full verified report kept.
//  - verifierView: what a verifier gets about the DEVELOPER's work. Evidence, candidate and findings, but not the
//    developer's own pass/fail claims or rationale, so QA/Review judge the candidate instead of the author's account.
import { handoffText } from './workflow-contract.mjs';

const reportPointer = artifact => artifact ? '\nInforme completo verificado: ' + artifact.path + '\nSHA256: ' + artifact.sha256 : '';
const present = value => Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';
const prune = object => Object.fromEntries(Object.entries(object).filter(([, value]) => present(value)));
const slim = item => prune({ criterionId: item.criterionId, status: item.status, evidence: item.evidence,
  ...(item.criterionId ? {} : { criterion: item.criterion }) });

export function compactHandoff(output) {
  if (!output?.delivery) return handoffText(output);
  const { summary, acceptance, decisions, evidence, questions, scope, outcome, findings, candidate } = output.delivery;
  return JSON.stringify(prune({ summary, outcome, scope, candidate, acceptance: (acceptance ?? []).map(slim), findings, evidence, decisions, questions }), null, 1)
    + reportPointer(output.artifact);
}

export function verifierView(output) {
  if (!output?.delivery) return handoffText(output);
  const { evidence, scope, outcome, findings, candidate } = output.delivery;
  return JSON.stringify(prune({ outcome, scope, candidate, evidence, findings }), null, 1)
    + '\nNo se incluyen el resumen ni las afirmaciones de cumplimiento del autor: verifica los criterios tú mismo contra el candidato.'
    + reportPointer(output.artifact);
}
