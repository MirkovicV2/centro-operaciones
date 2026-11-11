// Windows only. Node aborts with «AssignProcessToJobObject: (87)» when a child cannot be added to the job
// object it keeps for its children. A known kernel bug makes every later child fail that way if the first
// child ever added was a Windows Store program; libuv 1.47 works around it, older Node versions do not.
// The panel died like that on 2026-11-11 a few seconds after starting (panel/data/dashboard.stderr.log).
// Which child triggered it was NOT identified, so this is a precaution, not a confirmed fix: it makes the
// first child a plain program (node itself) before anything else is launched. Import it first.
import { spawnSync } from 'node:child_process';

if (process.platform === 'win32') {
  try {
    const primed = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true, stdio: 'ignore', timeout: 15_000 });
    if (primed.error || primed.status !== 0) console.warn(`No se pudo preparar el grupo de procesos del panel: ${primed.error?.message ?? `código ${primed.status}`}`);
  } catch (error) { console.warn(`No se pudo preparar el grupo de procesos del panel: ${error.message}`); }
}
