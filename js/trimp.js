const WEIGHTS = [0, 1, 1.5, 2, 3, 4.5];

export function computeTRIMP(zoneSecs) {
  if (!zoneSecs) return 0;
  let total = 0;
  for (let i = 0; i < WEIGHTS.length; i++) {
    total += ((zoneSecs[i] || 0) / 60) * WEIGHTS[i];
  }
  return Math.round(total * 10) / 10;
}

export function trimpLabel(trimp) {
  if (trimp >= 200) return 'Muy intenso';
  if (trimp >= 100) return 'Intenso';
  if (trimp >= 50) return 'Moderado';
  return 'Ligero';
}
