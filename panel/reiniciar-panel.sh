#!/usr/bin/env bash
# Pasa las pruebas del Centro y, solo si pasan y no hay ningun trabajo en marcha, reinicia el panel.
# Equivalente en Ubuntu de panel/reiniciar-panel.ps1.
# Uso: panel/reiniciar-panel.sh [--sin-pruebas]
# Deja el detalle en panel/data/reinicio-tests.log y el resultado en panel/data/reinicio-resultado.json.
# El panel se vuelve a lanzar con el mismo entorno que tenga esta terminal (p. ej. CENTRO_ORCA_AGENT=claude).
set -euo pipefail
panel_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$panel_root/.." && pwd)"
data_dir="$panel_root/data"; mkdir -p "$data_dir"
log="$data_dir/reinicio-tests.log"; result="$data_dir/reinicio-resultado.json"
state_url='http://127.0.0.1:4187/api/state'
step=inicio
save() { printf '{"step":"%s","ok":%s%s}\n' "$step" "$1" "${2:+,\"error\":\"$2\"}" > "$result"; }
fail() { step_msg="${1//\"/\'}"; save false "$step_msg"; echo "ERROR: $1" >&2; exit 1; }

command -v node >/dev/null || fail 'No se encuentra node en el PATH.'

if [ "${1:-}" != '--sin-pruebas' ]; then
  step=pruebas; save false
  echo 'Ejecutando las pruebas del Centro (puede tardar un minuto)...'
  (cd "$root" && node tests/run-tests.mjs > "$log" 2>&1) || fail "Las pruebas no pasan. El panel NO se ha reiniciado. Revisa $log"
  echo "Pruebas correctas: $(grep -m1 '^# pass' "$log" | cut -d' ' -f3) de $(grep -m1 '^# tests' "$log" | cut -d' ' -f3)."
fi

step=comprobar-panel; save false
if state="$(curl --fail --silent --max-time 90 "$state_url" 2>/dev/null)"; then
  read -r running pid <<<"$(printf '%s' "$state" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(Number(j.queue?.counts?.running??0),Number(j.settings?.runtime?.pid??0))})')"
  [ "$running" -eq 0 ] || fail "Hay $running trabajo(s) en marcha. No se reinicia el panel para no interrumpirlos."
  [ "$pid" -gt 0 ] || fail 'El panel no informa de su PID. No se toca.'
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'dashboard\.mjs' || fail "El PID $pid que indica el panel no es el panel. No se toca."
  step=parar; save false
  echo "Parando el panel (PID $pid)..."
  kill -TERM "$pid"
  for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  ! kill -0 "$pid" 2>/dev/null || fail "El panel (PID $pid) no se ha detenido."
else
  echo 'El panel no responde en 127.0.0.1:4187; se arranca uno nuevo.'
fi

step=arrancar; save false
echo 'Arrancando el panel...'
cd "$root"
nohup node panel/dashboard.mjs >> "$data_dir/dashboard.stdout.log" 2>> "$data_dir/dashboard.stderr.log" < /dev/null &
disown
curl --fail --silent --retry 20 --retry-connrefused --retry-delay 1 "$state_url" > /dev/null || fail 'El panel no quedo escuchando en 127.0.0.1:4187.'
step=hecho; save true
echo 'Panel reiniciado.'
