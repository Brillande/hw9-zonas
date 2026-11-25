export function minimalRMSSD(rrMs) {
  const valid = rrMs.filter((v) => v >= 300 && v <= 2000);
  if (valid.length < 5) return null;
  let sumSq = 0;
  for (let i = 1; i < valid.length; i++) {
    const d = valid[i] - valid[i - 1];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / (valid.length - 1));
}

export function computeRecoveryScore(currentRmssd, baselineRmssd) {
  if (!baselineRmssd) return null;
  return Math.round(Math.min(100, Math.max(0, (currentRmssd / baselineRmssd) * 50)));
}

export function recoveryLabel(score) {
  if (score == null) return 'Sin datos';
  if (score < 30) return 'Fatigado · Descansa hoy';
  if (score <= 60) return 'Recuperándose · Entrena suave';
  if (score <= 80) return 'Listo · Puedes entrenar';
  return 'Óptimo · Día de intensidad';
}

export function recoveryColor(score) {
  if (score == null) return '#8b98a8';
  if (score < 30) return '#f85149';
  if (score <= 60) return '#f0883e';
  if (score <= 80) return '#3fb950';
  return '#3b9ae1';
}

export function updateBaseline(log, todayRmssd) {
  const today = new Date().toISOString().slice(0, 10);
  const updated = log.filter((e) => e.date !== today);
  updated.push({ date: today, rmssd: todayRmssd });
  while (updated.length > 7) updated.shift();
  return updated;
}

export function baselineAvg(log) {
  if (!log.length) return null;
  return log.reduce((sum, e) => sum + e.rmssd, 0) / log.length;
}

export const ZONE_WEIGHTS = [0, 1, 1.5, 2, 3, 4.5];

function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function weeklyLoad(history) {
  const now = new Date();
  const keys = new Set();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    keys.add(localDateKey(d));
  }
  let total = 0;
  for (const h of history) {
    if (!h.date) continue;
    const key = localDateKey(new Date(h.date));
    if (!keys.has(key)) continue;
    const secs = h.zoneSecs;
    if (!secs) continue;
    for (let i = 0; i < secs.length && i < ZONE_WEIGHTS.length; i++) {
      total += (secs[i] / 60) * ZONE_WEIGHTS[i];
    }
  }
  return Math.round(total);
}
