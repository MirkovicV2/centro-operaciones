// 7: access for more than one person through Tailscale Serve. Pure functions; the
// dashboard loads the file once and asks these on every request.
export const ACCESS_ROLES = Object.freeze(['admin', 'ejecutar', 'revisar']);
// POST routes only an admin may use: configuration, auto-run switches and project destinations.
export const ADMIN_ONLY_POST_PATHS = Object.freeze([/^\/api\/config$/, /^\/api\/auto-run$/, /^\/api\/projects$/, /^\/api\/projects\/[a-zA-Z0-9_-]+\/update$/]);
const HOSTNAME = /^(?:[a-z0-9-]+\.){2,}ts\.net$/;
const LOGIN = /^[^\s@]{1,200}@[^\s@]{1,200}$|^[A-Za-z0-9._-]{1,200}$/;

/** Accepts the legacy { hostname, login } file and the new { hostname, users: [{ login, role }] } one. */
export function parseTailscaleAccess(content) {
  const value = typeof content === 'string' ? JSON.parse(content) : content;
  const { hostname } = value ?? {};
  if (!HOSTNAME.test(hostname ?? '')) throw new Error('Configuración de acceso Tailscale inválida.');
  const users = new Map();
  if (typeof value.login === 'string' && value.login.trim()) users.set(value.login, 'admin');
  if (value.users !== undefined) {
    if (!Array.isArray(value.users) || !value.users.length) throw new Error('Configuración de acceso Tailscale inválida: users debe ser una lista con al menos una cuenta.');
    for (const user of value.users) {
      if (!user || typeof user.login !== 'string' || !LOGIN.test(user.login.trim()) || !ACCESS_ROLES.includes(user.role)) {
        throw new Error('Configuración de acceso Tailscale inválida: cada usuario necesita login y role (admin, ejecutar o revisar).');
      }
      if (users.has(user.login.trim()) && users.get(user.login.trim()) !== user.role) throw new Error('Configuración de acceso Tailscale inválida: cuenta repetida con roles distintos.');
      users.set(user.login.trim(), user.role);
    }
  }
  if (!users.size) throw new Error('Configuración de acceso Tailscale inválida.');
  // `login` keeps the first admin for code that still reads the legacy field.
  const login = value.login || [...users].find(([, role]) => role === 'admin')?.[0] || [...users.keys()][0];
  return { hostname, login, users };
}

export function roleAllows(role, method, pathname) {
  if (!ACCESS_ROLES.includes(role)) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  if (role === 'revisar') return false;
  if (role === 'admin') return true;
  return !ADMIN_ONLY_POST_PATHS.some(pattern => pattern.test(pathname));
}

export function assertRoleAllows(role, method, pathname) {
  if (roleAllows(role, method, pathname)) return;
  const reason = role === 'revisar' ? 'El rol revisar solo consulta; no puede lanzar, reintentar, aprobar ni cerrar encargos.'
    : 'Esta acción requiere el rol admin.';
  throw Object.assign(new Error(reason), { status: 403, code: 'role_forbidden' });
}
