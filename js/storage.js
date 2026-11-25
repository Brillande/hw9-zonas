// Persistencia en localStorage: perfil, rutinas e historial.

const KEY = 'hw9zonas.v1';
export const MAX_HISTORY = 100;

export const newId = () => crypto.randomUUID();

// En Android el navegador corta la voz normal al apagar la pantalla, así que
// ahí el sonido en segundo plano de la versión web viene activado.
const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

function defaults() {
  return {
    profile: { age: 30, maxHr: null, restHr: null, method: 'max', voice: true, bgAudio: isAndroid, zoneLows: null, weight: null, sex: 'M' },
    routines: [
      {
        id: newId(),
        name: 'Base Z2 · 30 min',
        warmup: 300,
        cooldown: 300,
        rounds: 1,
        steps: [{ name: 'Rodaje suave', duration: 1200, zone: 2 }],
      },
      {
        id: newId(),
        name: 'Intervalos 4×4',
        warmup: 600,
        cooldown: 300,
        rounds: 4,
        steps: [
          { name: 'Fuerte', duration: 240, zone: 4 },
          { name: 'Recuperación', duration: 180, zone: 2 },
        ],
      },
    ],
    history: [],
    hrvBaseline: [],
  };
}

export function load() {
  const base = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (!saved) return base;
    return {
      profile: { ...base.profile, ...saved.profile },
      routines: Array.isArray(saved.routines) ? saved.routines : base.routines,
      history: Array.isArray(saved.history) ? saved.history : [],
      hrvBaseline: Array.isArray(saved.hrvBaseline) ? saved.hrvBaseline : [],
    };
  } catch {
    return base;
  }
}

export function save(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {}
}
