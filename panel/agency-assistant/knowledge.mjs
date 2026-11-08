import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const folder = 'Centro de Operaciones';
const businessNames = { agency: 'Agencia', games: 'Videojuegos' };

export async function readDashboardConfig(queueRoot) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(queueRoot, 'data', 'operations-dashboard.json'), 'utf8'));
    return {
      schema: 1,
      queueRoot: path.resolve(value.queueRoot || queueRoot),
      vaultPath: typeof value.vaultPath === 'string' ? value.vaultPath : '',
      autoRun: false,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, queueRoot: path.resolve(queueRoot), vaultPath: '', autoRun: false };
    throw new Error('No se pudo leer la configuración local del panel.');
  }
}

export async function saveDashboardConfig(queueRoot, value) {
  const queue = path.resolve(queueRoot);
  const inputPath = String(value.vaultPath || '').trim();
  if (!inputPath) throw new Error('Indica la ruta de la bóveda de Obsidian.');
  const vaultPath = path.resolve(inputPath);
  let realVault;
  try {
    realVault = await fs.realpath(vaultPath);
    const stat = await fs.stat(realVault);
    if (!stat.isDirectory()) throw new Error('not_a_directory');
    await fs.access(realVault, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error('Selecciona una carpeta de bóveda de Obsidian existente y con permiso de lectura y escritura.');
  }
  const config = { schema: 1, queueRoot: queue, vaultPath: realVault, autoRun: false, updatedAt: new Date().toISOString() };
  const destination = path.join(queue, 'data', 'operations-dashboard.json');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return config;
}

export function safeMarkdownText(value) {
  return String(value ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[CLAVE OCULTA]')
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[TOKEN OCULTO]')
    .replace(/(\b(?:api[_ -]?key|password|passwd|secret|token)\b\s*[:=]\s*)[^\s,;]+/gi, '$1[SECRETO OCULTO]');
}

function slug(value, max = 70) {
  return String(value ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'nota';
}

function yaml(value) {
  return JSON.stringify(String(value ?? ''));
}

async function writeUnique(vaultPath, relativePath, content) {
  const destination = path.join(vaultPath, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.writeFile(destination, content, { encoding: 'utf8', flag: 'wx' });
    return { created: true, path: relativePath.replaceAll(path.sep, '/') };
  } catch (error) {
    if (error.code === 'EEXIST') return { created: false, path: relativePath.replaceAll(path.sep, '/') };
    throw error;
  }
}

async function ensureIndexNotes(vaultPath) {
  const destination = path.join(vaultPath, folder, 'Índice automático.md');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  let existing = '';
  try { existing = await fs.readFile(destination, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const generatedStart = '<!-- centro-operaciones:auto:start -->';
  const generatedEnd = '<!-- centro-operaciones:auto:end -->';
  const links = [];
  for (const display of Object.values(businessNames)) {
    for (const type of ['Contexto', 'Ideas', 'Trabajos']) {
      const children = path.join(folder, type, display);
      try {
        for (const entry of await fs.readdir(path.join(vaultPath, children), { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.md')) links.push(`- [[${children.replaceAll(path.sep, '/')}/${entry.name.replace(/\.md$/i, '')}]]`);
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  try {
    for (const entry of await fs.readdir(path.join(vaultPath, folder, 'Mensajes', 'Telegram'), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) links.push(`- [[${folder}/Mensajes/Telegram/${entry.name.replace(/\.md$/i, '')}]]`);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const generated = `${generatedStart}\n${links.sort().join('\n') || '_Aún no hay notas._'}\n${generatedEnd}`;
  const startAt = existing.indexOf(generatedStart);
  const endAt = existing.indexOf(generatedEnd);
  if (startAt >= 0 && endAt > startAt) {
    existing = `${existing.slice(0, startAt)}${generated}${existing.slice(endAt + generatedEnd.length)}`;
  } else {
    existing = `${existing.trimEnd()}\n\n# Índice automático del Centro de Operaciones\n\n${generated}\n`;
  }
  await fs.writeFile(destination, existing, 'utf8');
}

export async function writeJobNote(queueRoot, job) {
  const config = await readDashboardConfig(queueRoot);
  if (!config.vaultPath) return { skipped: true, reason: 'vault_not_configured' };
  const business = businessNames[job.business] ? job.business : 'agency';
  const title = safeMarkdownText(job.title).replace(/[\r\n]/g, ' ').slice(0, 180);
  const result = safeMarkdownText(job.result?.text ?? JSON.stringify(job.result ?? {}, null, 2));
  const prompt = safeMarkdownText(job.prompt ?? '');
  const attempt = Number.isInteger(job.attempts) ? job.attempts : 0;
  const stateVersion = `${slug(job.state || 'desconocido', 20)}-intento-${attempt}`;
  const relative = path.join(folder, 'Trabajos', businessNames[business], `${slug(job.id, 50)}-${stateVersion}-${slug(job.title)}.md`);
  const note = [
    '---',
    `tipo: ${yaml('resultado-agente')}`,
    `empresa: ${yaml(business)}`,
    `proyecto_id: ${yaml(job.projectId ?? '')}`,
    `proyecto: ${yaml(job.projectName ?? '')}`,
    `trabajo: ${yaml(job.id)}`,
    `estado: ${yaml(job.state)}`,
    `proveedor: ${yaml(job.result?.provider ?? '')}`,
    `flujo_estado: ${yaml(job.workflow?.status ?? '')}`,
    `flujo_run: ${yaml(job.workflow?.runId ?? '')}`,
    `finalizado: ${yaml(job.finishedAt ?? new Date().toISOString())}`,
    `tags: [${yaml('centro-operaciones')}, ${yaml(business)}]`,
    '---',
    '',
    `# ${title}`,
    '',
    `Trabajo: \`${safeMarkdownText(job.id)}\`  `,
    `Empresa: ${businessNames[business]}  `,
    `Estado: ${job.state}  `,
    `Finalizado: ${job.finishedAt ?? '—'}`,
    `\n[[${folder}/Índice automático]]`,
    '',
    '## Encargo',
    '',
    prompt || '_Sin instrucción registrada._',
    '',
    '## Resultado del agente',
    '',
    result || '_El agente no devolvió texto._',
    '',
    ...(job.workflow?.steps?.length ? [
      '## Etapas del flujo de Orca',
      '',
      ...job.workflow.steps.map(step => [
        `### ${safeMarkdownText(step.label || step.profile || step.key)} — ${safeMarkdownText(step.status || 'pendiente')}`,
        '',
        `Perfil: ${safeMarkdownText(step.profile || '')}  `,
        `Dispatch: ${step.dispatchId ? `\`${safeMarkdownText(step.dispatchId)}\`` : 'sin confirmar'}  `,
        `Intento: ${Number.isInteger(step.attempt) ? step.attempt : '—'}  `,
        step.error ? `Motivo: ${safeMarkdownText(step.error)}  ` : '',
        step.summary ? safeMarkdownText(step.summary) : '_Sin resumen persistido._',
        '',
      ].filter(Boolean).join('\n')),
      '',
    ] : []),
  ].join('\n');
  const resultWritten = await writeUnique(config.vaultPath, relative, note);
  await ensureIndexNotes(config.vaultPath);
  return resultWritten;
}

export async function writeIdeaNote(queueRoot, idea) {
  const config = await readDashboardConfig(queueRoot);
  if (!config.vaultPath) throw new Error('Configura primero la bóveda de Obsidian en el panel.');
  if (!['agency', 'games'].includes(idea.business)) throw new Error('Indica agencia o videojuegos para guardar la idea.');
  const title = safeMarkdownText(idea.title || idea.text).replace(/[\r\n]/g, ' ').slice(0, 160);
  const content = safeMarkdownText(idea.text).slice(0, 6000);
  const date = new Date(idea.createdAt || Date.now()).toISOString().slice(0, 10);
  const relative = path.join(folder, 'Ideas', businessNames[idea.business], `${date}-${slug(idea.id, 18)}-${slug(title)}.md`);
  const note = [
    '---',
    `tipo: ${yaml('idea')}`,
    `empresa: ${yaml(idea.business)}`,
    `proyecto_id: ${yaml(idea.projectId ?? '')}`,
    `proyecto: ${yaml(idea.projectName ?? '')}`,
    `idea: ${yaml(idea.id)}`,
    `estado: ${yaml('capturada')}`,
    `creada: ${yaml(idea.createdAt || new Date().toISOString())}`,
    `tags: [${yaml('centro-operaciones')}, ${yaml('idea')}, ${yaml(idea.business)}]`,
    '---',
    '',
    `# ${title}`,
    '',
    content,
    '',
    `[[${folder}/Índice automático]]`,
    '',
  ].join('\n');
  const resultWritten = await writeUnique(config.vaultPath, relative, note);
  await ensureIndexNotes(config.vaultPath);
  return resultWritten;
}

export async function writeAnswerNote(queueRoot, question, answer) {
  const config = await readDashboardConfig(queueRoot);
  if (!config.vaultPath) return { skipped: true, reason: 'vault_not_configured' };
  const business = businessNames[question.business] ? question.business : 'agency';
  const relative = path.join(folder, 'Ideas', businessNames[business], `respuesta-${slug(question.id, 50)}.md`);
  const note = [
    '---',
    `tipo: ${yaml('respuesta-agente')}`,
    `empresa: ${yaml(business)}`,
    `pregunta: ${yaml(question.id)}`,
    `trabajo: ${yaml(question.jobId)}`,
    `creada: ${yaml(new Date().toISOString())}`,
    `tags: [${yaml('centro-operaciones')}, ${yaml('respuesta')}, ${yaml(business)}]`,
    '---',
    '',
    `# Respuesta para ${safeMarkdownText(question.title).slice(0, 140)}`,
    '',
    '## Pregunta del agente',
    '',
    safeMarkdownText(question.question),
    '',
    '## Respuesta de Daniel',
    '',
    safeMarkdownText(answer).slice(0, 4000),
    '',
    `Trabajo relacionado: [[${folder}/Trabajos/${businessNames[business]}/${slug(question.jobId, 50)}-${slug(question.title)}]]`,
    '',
    `[[${folder}/Índice automático]]`,
    '',
  ].join('\n');
  const resultWritten = await writeUnique(config.vaultPath, relative, note);
  await ensureIndexNotes(config.vaultPath);
  return resultWritten;
}

export async function writeMessageNote(queueRoot, message) {
  const config = await readDashboardConfig(queueRoot);
  if (!config.vaultPath) return { skipped: true, reason: 'vault_not_configured' };
  const content = safeMarkdownText(message.text).slice(0, 6000);
  const createdAt = message.createdAt || new Date().toISOString();
  const date = new Date(createdAt).toISOString().slice(0, 10);
  const relative = path.join(folder, 'Mensajes', 'Telegram', `${date}-${slug(message.id, 24)}.md`);
  const note = [
    '---',
    `tipo: ${yaml('mensaje-secretaria')}`,
    `mensaje: ${yaml(message.id)}`,
    `canal: ${yaml('Telegram')}`,
    `recibido: ${yaml(createdAt)}`,
    `tags: [${yaml('centro-operaciones')}, ${yaml('telegram')}, ${yaml('bandeja')}]`,
    '---',
    '',
    '# Mensaje recibido por Telegram',
    '',
    content,
    '',
    `[[${folder}/Índice automático]]`,
    '',
  ].join('\n');
  const written = await writeUnique(config.vaultPath, relative, note);
  await ensureIndexNotes(config.vaultPath);
  return written;
}

export async function readAgentContext(queueRoot, business, maxChars = 5000, projectId = '') {
  const config = await readDashboardConfig(queueRoot);
  if (!config.vaultPath || !['agency', 'games'].includes(business)) return '';
  const directories = ['Contexto', 'Ideas', 'Trabajos'].map(type => ({ type, directory: path.join(config.vaultPath, folder, type, businessNames[business]) }));
  const markdown = [];
  for (const { type, directory } of directories) {
    let files;
    try { files = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    markdown.push(...await Promise.all(files.filter(file => file.isFile() && file.name.endsWith('.md')).map(async file => ({
      name: path.join(directory, file.name),
      type,
      relative: path.relative(config.vaultPath, path.join(directory, file.name)).replace(/\\/g, '/'),
      mtime: (await fs.stat(path.join(directory, file.name))).mtimeMs,
    }))));
  }
  markdown.sort((a, b) => b.mtime - a.mtime);
  const selected = [];
  let remaining = maxChars;
  let included = 0;
  for (const { name, relative, type } of markdown) {
    if (included >= 24) break;
    if (remaining < 300) break;
    const raw = await fs.readFile(name, 'utf8');
    if (projectId && type !== 'Contexto') {
      const noteProjectId = raw.match(/^proyecto_id:\s*("(?:[^"\\]|\\.)*")\s*$/m)?.[1];
      if (!noteProjectId || JSON.parse(noteProjectId) !== projectId) continue;
    }
    const content = safeMarkdownText(raw).slice(0, Math.min(1200, remaining));
    selected.push(`### ${relative}\n${content}`);
    remaining -= content.length;
    included++;
  }
  const scope = projectId ? `el proyecto ${projectId}` : businessNames[business];
  return selected.length ? `Notas recientes de Obsidian para ${scope}:\n\n${selected.join('\n\n')}` : '';
}

async function markdownFiles(root, base = root, found = []) {
  if (found.length >= 1000) return found;
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return found; }
  for (const entry of entries) {
    if (found.length >= 1000) break;
    if (entry.name.startsWith('.') || ['node_modules', '.git'].includes(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) await markdownFiles(absolute, base, found);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(path.relative(base, absolute));
  }
  return found;
}

export async function buildKnowledgeGraph(queueRoot, business = '') {
  const config = await readDashboardConfig(queueRoot);
  if (!config.vaultPath) return { connected: false, nodes: [], edges: [] };
  const files = await markdownFiles(config.vaultPath);
  const byBase = new Map(files.map(file => [path.basename(file, path.extname(file)).toLowerCase(), file]));
  const byPath = new Map(files.map(file => [file.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase(), file]));
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();
  for (const file of files) {
    const relative = file.replace(/\\/g, '/').replace(/\.md$/i, '');
    const absolute = path.join(config.vaultPath, file);
    const stat = await fs.stat(absolute);
    if (stat.size > 256_000) continue;
    const content = await fs.readFile(absolute, 'utf8');
    if (business) {
      if (!['agency', 'games'].includes(business)) continue;
      const declared = content.match(/^empresa:\s*"?(agency|games)"?\s*$/m)?.[1];
      const ownedPath = ['Contexto', 'Ideas', 'Trabajos'].some(type => relative.startsWith(`${folder}/${type}/${businessNames[business]}/`));
      if (declared ? declared !== business : !ownedPath) continue;
    }
    const id = relative.toLowerCase();
    nodeIds.add(id);
    nodes.push({ id, path: file.replace(/\\/g, '/'), title: path.basename(file, path.extname(file)), group: relative.includes(`${folder}/Ideas/`) ? 'idea' : relative.includes(`${folder}/Trabajos/`) ? 'trabajo' : 'nota' });
    for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = match[1].split('|')[0].split('#')[0].trim();
      if (!target) continue;
      const targetPath = target.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
      const resolved = byPath.get(targetPath) || byBase.get(path.basename(targetPath));
      if (resolved) edges.push({ source: id, target: resolved.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase() });
    }
  }
  const unique = new Map();
  for (const edge of edges) if (nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target) unique.set(`${edge.source}\0${edge.target}`, edge);
  return { connected: true, nodes, edges: [...unique.values()] };
}
