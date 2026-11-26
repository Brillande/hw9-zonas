// Exportación del historial a CSV (Excel, Numbers, Google Sheets). Sin DOM.
// Formato europeo: separador «;» y decimales con coma, que es lo que espera
// Excel en español; el BOM inicial hace que respete las tildes.

import { computeTRIMP } from './trimp.js';
import { formatDuration } from './session.js';

const SEP = ';';
const ZONE_COLUMNS = ['Bajo Z1 (min)', 'Z1 (min)', 'Z2 (min)', 'Z3 (min)', 'Z4 (min)', 'Z5 (min)'];
const HEADER = [
  'Fecha',
  'Hora',
  'Entrenamiento',
  'Duración',
  'Duración (min)',
  'FC media (ppm)',
  'FC máx (ppm)',
  'Calorías (kcal)',
  'Energía (kJ)',
  'TRIMP',
  ...ZONE_COLUMNS,
];

const pad = (n) => String(n).padStart(2, '0');
const decimal = (n) => String(Math.round(n * 10) / 10).replace('.', ',');
const minutes = (seconds) => decimal(seconds / 60);

function cell(value) {
  if (value == null || value === '') return '';
  let text = String(value);
  // Un texto que empieza por = + - @ lo ejecutaría Excel como fórmula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function row(h) {
  const d = new Date(h.date);
  const zones = Array.isArray(h.zoneSecs) ? h.zoneSecs : [];
  return [
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    h.routineName,
    formatDuration(h.duration || 0),
    minutes(h.duration || 0),
    h.avgBpm || '',
    h.maxBpm || '',
    h.calories || '',
    h.energy || '',
    zones.length ? decimal(computeTRIMP(zones)) : '',
    ...ZONE_COLUMNS.map((_, z) => (zones.length ? minutes(zones[z] || 0) : '')),
  ];
}

// Del más antiguo al más reciente, que es como se lee una hoja de cálculo.
export function historyToCsv(history) {
  const rows = [...history].sort((a, b) => a.date - b.date).map(row);
  return '﻿' + [HEADER, ...rows].map((r) => r.map(cell).join(SEP)).join('\r\n') + '\r\n';
}

export function exportFileName(now = new Date()) {
  return `hw9-entrenamientos-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}
