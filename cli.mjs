#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addJob, loadState, runQueue, setBudget, retryJob, resolveJob, summarize, QueueError } from './queue.mjs';
import { createWorker } from './providers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HELP = `Centro de operaciones local — videojuegos (games) y agencia (agency)

node cli.mjs status
node cli.mjs add --business games|agency --kind analysis|code --title "Título" --prompt-file "instruccion.txt" [--id identificador]
  [--provider auto|api|codex] [--max-attempts 2] [--timeout-seconds 180] [--max-usd 0.10]
  Código: --workspace "${path.join(ROOT, 'workspaces', 'checkout-aislado')}" --isolated
node cli.mjs run                       Simulación: no ejecuta trabajadores ni modifica estado
node cli.mjs run --execute [--max-jobs 5]
node cli.mjs show --id IDENTIFICADOR
node cli.mjs retry --id IDENTIFICADOR --confirm-reviewed
node cli.mjs resolve --id IDENTIFICADOR --confirm-reviewed
node cli.mjs budget --usd LIMITE_TOTAL --model MODELO --input-per-million TARIFA --output-per-million TARIFA

No se ejecuta nada en segundo plano. El presupuesto API inicial es 0 USD.
Las tarifas y el gasto mostrado son estimaciones locales; consulta el consumo del proveedor.
Las instrucciones se guardan localmente. Nunca incluyas claves o contraseñas.
`;
const FLAGS = new Set(['execute', 'isolated', 'confirm-reviewed', 'help']);
const KNOWN = new Set([...FLAGS, 'business', 'kind', 'title', 'prompt-file', 'id', 'provider', 'max-attempts', 'timeout-seconds', 'max-usd', 'workspace', 'max-jobs', 'usd', 'model', 'input-per-million', 'output-per-million']);
function parse(args) {
  const command = args.shift() ?? 'help';
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (!flag.startsWith('--') || !KNOWN.has(flag.slice(2))) throw new QueueError(`Opción desconocida: ${flag}`);
    const key = flag.slice(2);
    if (key in options) throw new QueueError(`Opción repetida: ${flag}`);
    if (FLAGS.has(key)) options[key] = true;
    else { if (!args.length || args[0].startsWith('--')) throw new QueueError(`Falta el valor de ${flag}.`); options[key] = args.shift(); }
  }
  return { command, options };
}
const numeric = (value, fallback) => value === undefined ? fallback : Number(value);

async function main() {
  const { command, options: o } = parse(process.argv.slice(2));
  if (command === 'help' || o.help) { console.log(HELP); return; }
  let result;
  switch (command) {
    case 'status': result = summarize(await loadState(ROOT)); break;
    case 'show': {
      result = (await loadState(ROOT)).jobs.find(job => job.id === o.id);
      if (!result) throw new QueueError('No se encontró el trabajo.');
      break;
    }
    case 'add': {
      if (!o['prompt-file']) throw new QueueError('Indica --prompt-file con la instrucción del trabajo.');
      const promptPath = path.resolve(o['prompt-file']);
      if ((await fs.stat(promptPath)).size > 12_000) throw new QueueError('La instrucción supera los 12.000 bytes.');
      result = await addJob(ROOT, { id: o.id, business: o.business, kind: o.kind, title: o.title, prompt: await fs.readFile(promptPath, 'utf8'), provider: o.provider, workspace: o.workspace, isolated: o.isolated, maxAttempts: numeric(o['max-attempts'], 2), timeoutMs: numeric(o['timeout-seconds'], 180) * 1000, maxUsd: numeric(o['max-usd'], 0.1) });
      break;
    }
    case 'run': result = await runQueue(ROOT, { execute: !!o.execute, worker: createWorker(), maxJobs: numeric(o['max-jobs'], 5) }); break;
    case 'retry': result = await retryJob(ROOT, o.id, { confirm: !!o['confirm-reviewed'] }); break;
    case 'resolve': result = await resolveJob(ROOT, o.id, { confirm: !!o['confirm-reviewed'] }); break;
    case 'budget': result = await setBudget(ROOT, { limitUsd: numeric(o.usd, NaN), model: o.model, inputPerMillion: numeric(o['input-per-million'], NaN), outputPerMillion: numeric(o['output-per-million'], NaN) }); break;
    default: throw new QueueError('Comando desconocido. Usa node cli.mjs help.');
  }
  console.log(JSON.stringify(result, null, 2));
  if (command === 'run' && o.execute && (result.blockedNeedsAttention?.length || result.jobs?.some(job => job.state === 'needs_attention'))) process.exitCode = 2;
}
main().catch(error => {
  // Do not print raw provider bodies, process stderr, environment, or credentials.
  console.error(JSON.stringify({ error: error.code || 'operation_failed', message: error instanceof QueueError ? error.message : 'No se pudo completar la operación local. Comprueba archivos, permisos y opciones.' }));
  process.exitCode = 1;
});
