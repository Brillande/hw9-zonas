// Zonas de frecuencia cardiaca (modelo clásico de 5 zonas).

export const ZONES = [
  { id: 1, label: 'Z1 · Recuperación', lo: 0.5, hi: 0.6, color: '#7f8fa6' },
  { id: 2, label: 'Z2 · Base aeróbica', lo: 0.6, hi: 0.7, color: '#3b9ae1' },
  { id: 3, label: 'Z3 · Aeróbico', lo: 0.7, hi: 0.8, color: '#3fb950' },
  { id: 4, label: 'Z4 · Umbral', lo: 0.8, hi: 0.9, color: '#f0883e' },
  { id: 5, label: 'Z5 · Máximo', lo: 0.9, hi: 1.0, color: '#f85149' },
];

export const BELOW_COLOR = '#4b5563';

export const zoneColor = (z) => (z ? ZONES[z - 1].color : BELOW_COLOR);
export const zoneLabel = (z) => (z ? ZONES[z - 1].label : 'Por debajo de Z1');

// FC máxima: la manual si existe, si no 220 − edad.
export const maxHrOf = (profile) => profile.maxHr || 220 - profile.age;

// Límites en ppm de cada zona. Con método Karvonen (y FC de reposo) se aplica
// el porcentaje sobre la reserva cardiaca; si no, sobre la FC máxima.
// profile.zoneLows (inicio de cada zona escrito a mano) manda sobre el cálculo.
export function zoneBounds(profile) {
  const max = maxHrOf(profile);
  const rest = profile.method === 'karvonen' && profile.restHr ? profile.restHr : 0;
  // Redondeo hacia arriba: una zona empieza en el primer pulso que alcanza su
  // porcentaje. Se opera con enteros para que 114,0 no acabe siendo 115.
  const at = (pct) => rest + Math.ceil(((max - rest) * Math.round(pct * 100)) / 100);
  const custom = Array.isArray(profile.zoneLows) && profile.zoneLows.length === ZONES.length;
  const lows = custom ? profile.zoneLows : ZONES.map((z) => at(z.lo));
  return ZONES.map((z, i) => ({
    id: z.id,
    low: lows[i],
    high: i < ZONES.length - 1 ? lows[i + 1] - 1 : Math.max(max, lows[i]),
  }));
}

// 0 = por debajo de Z1; por encima del máximo sigue siendo Z5.
export function zoneFor(bpm, bounds) {
  let zone = 0;
  for (const b of bounds) if (bpm >= b.low) zone = b.id;
  return zone;
}
