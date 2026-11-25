import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartRate } from '../js/hr-parse.js';
import { zoneBounds, zoneFor, maxHrOf } from '../js/zones.js';
import { Session, expandSteps, routineDuration, formatDuration } from '../js/session.js';
import { minimalRMSSD, computeRecoveryScore, recoveryLabel, recoveryColor, updateBaseline, baselineAvg, weeklyLoad } from '../js/recovery.js';

const view = (...bytes) => new DataView(new Uint8Array(bytes).buffer);
const profile = { age: 30, maxHr: null, restHr: null, method: 'max' };

test('parseHeartRate: pulso de 8 bits', () => {
  assert.deepEqual(parseHeartRate(view(0x00, 72)), { bpm: 72, contact: null, rr: [] });
});

test('parseHeartRate: pulso de 16 bits, contacto e intervalos RR', () => {
  // flags: uint16 + contacto detectado + energía + RR
  const r = parseHeartRate(view(0x1f, 0x2c, 0x01, 0xaa, 0xbb, 0x00, 0x04, 0x00, 0x02));
  assert.equal(r.bpm, 300);
  assert.equal(r.contact, true);
  assert.deepEqual(r.rr, [1000, 500]);
});

test('zonas por % de FC máxima', () => {
  assert.equal(maxHrOf(profile), 190);
  const b = zoneBounds(profile);
  assert.deepEqual(b[0], { id: 1, low: 95, high: 113 });
  assert.deepEqual(b[4], { id: 5, low: 171, high: 190 });
  assert.equal(zoneFor(80, b), 0);
  assert.equal(zoneFor(95, b), 1);
  assert.equal(zoneFor(113, b), 1);
  assert.equal(zoneFor(114, b), 2);
  assert.equal(zoneFor(171, b), 5);
  assert.equal(zoneFor(210, b), 5);
});

test('el inicio de cada zona se redondea hacia arriba', () => {
  // 33 años → FC máx 187: 60 % = 112,2 → 113; 70 % = 130,9 → 131.
  const b = zoneBounds({ ...profile, age: 33 });
  assert.deepEqual(b.map((z) => z.low), [94, 113, 131, 150, 169]);
  assert.deepEqual(b[1], { id: 2, low: 113, high: 130 });
  assert.equal(b[4].high, 187);
});

test('zonas escritas a mano mandan sobre el cálculo', () => {
  const b = zoneBounds({ ...profile, age: 33, zoneLows: [94, 113, 133, 150, 168] });
  assert.deepEqual(b[0], { id: 1, low: 94, high: 112 });
  assert.deepEqual(b[1], { id: 2, low: 113, high: 132 });
  assert.deepEqual(b[4], { id: 5, low: 168, high: 187 });
  assert.equal(zoneFor(112, b), 1);
  assert.equal(zoneFor(113, b), 2);
  assert.equal(zoneFor(133, b), 3);
});

test('zonas Karvonen usan la reserva cardiaca', () => {
  const b = zoneBounds({ ...profile, maxHr: 200, restHr: 60, method: 'karvonen' });
  assert.equal(b[0].low, 130); // 60 + 140 × 0,5
  assert.equal(b[4].high, 200);
  // Sin FC en reposo se cae al % de FC máxima.
  assert.equal(zoneBounds({ ...profile, maxHr: 200, method: 'karvonen' })[0].low, 100);
});

const routine = {
  name: 'Test',
  warmup: 60,
  cooldown: 30,
  rounds: 2,
  steps: [
    { name: 'Fuerte', duration: 20, zone: 4 },
    { name: 'Suave', duration: 10, zone: 2 },
  ],
};

test('expandSteps: calentamiento, rondas y enfriamiento', () => {
  const steps = expandSteps(routine);
  assert.deepEqual(steps.map((s) => s.name), ['Calentamiento', 'Fuerte', 'Suave', 'Fuerte', 'Suave', 'Enfriamiento']);
  assert.equal(steps[3].round, 2);
  assert.equal(routineDuration(routine), 150);
  assert.deepEqual(expandSteps(null), []);
  // Zonas de calentamiento y enfriamiento: Z1 por defecto, configurables (0 = libre).
  assert.deepEqual([steps[0].zone, steps[5].zone], [1, 1]);
  const custom = expandSteps({ ...routine, warmupZone: 2, cooldownZone: 0 });
  assert.deepEqual([custom[0].zone, custom[5].zone], [2, 0]);
});

test('Session: avanza pasos, acumula zonas y termina', () => {
  const s = new Session({ routine, bounds: zoneBounds(profile) });
  for (let i = 0; i < 60; i++) s.tick(1, 100); // Z1
  assert.equal(s.step.name, 'Fuerte');
  assert.equal(s.targetState(100), 'low');
  assert.equal(s.targetState(160), 'in');
  assert.equal(s.targetState(180), 'high');
  s.paused = true;
  s.tick(5, 160);
  assert.equal(s.elapsed, 60);
  s.paused = false;
  for (let i = 0; i < 20; i++) s.tick(1, 160); // Z4
  assert.equal(s.step.name, 'Suave');
  s.tick(45, null); // salto grande sin señal: cruza varios pasos
  assert.equal(s.step.name, 'Enfriamiento');
  s.skip();
  assert.equal(s.done, true);
  const sum = s.summary();
  assert.equal(sum.duration, 125);
  assert.equal(sum.zoneSecs[1], 60);
  assert.equal(sum.zoneSecs[4], 20);
  assert.equal(sum.maxBpm, 160);
  assert.equal(sum.avgBpm, 115);
});

test('Session libre no termina sola', () => {
  const s = new Session({ bounds: zoneBounds(profile) });
  s.tick(3600, 120);
  assert.equal(s.done, false);
  assert.equal(s.targetState(120), 'none');
});

test('formatDuration', () => {
  assert.equal(formatDuration(5), '0:05');
  assert.equal(formatDuration(125), '2:05');
  assert.equal(formatDuration(3725), '1:02:05');
});

// ---------- Recuperación y carga semanal ----------

test('minimalRMSSD calcula diferencias sucesivas', () => {
  const rmssd = minimalRMSSD([800, 810, 790, 805, 795]);
  assert.ok(rmssd >= 10 && rmssd <= 18, `RMSSD ${rmssd} fuera de rango esperado`);
});

test('minimalRMSSD necesita al menos 5 valores válidos', () => {
  assert.equal(minimalRMSSD([800, 810, 790]), null);
  assert.equal(minimalRMSSD([100, 110, 120, 130, 140]), null); // <300 ms, filtrados
});

test('computeRecoveryScore: igual a la línea base → 50', () => {
  assert.equal(computeRecoveryScore(40, 40), 50);
});

test('computeRecoveryScore: doble de la línea base → 100 (tope)', () => {
  assert.equal(computeRecoveryScore(80, 40), 100);
});

test('computeRecoveryScore: mitad de la línea base → 25', () => {
  assert.equal(computeRecoveryScore(20, 40), 25);
});

test('computeRecoveryScore: sin línea base → null', () => {
  assert.equal(computeRecoveryScore(40, null), null);
  assert.equal(computeRecoveryScore(40, 0), null);
});

test('recoveryLabel según rango de puntuación', () => {
  assert.equal(recoveryLabel(null), 'Sin datos');
  assert.equal(recoveryLabel(15), 'Fatigado · Descansa hoy');
  assert.equal(recoveryLabel(45), 'Recuperándose · Entrena suave');
  assert.equal(recoveryLabel(70), 'Listo · Puedes entrenar');
  assert.equal(recoveryLabel(90), 'Óptimo · Día de intensidad');
});

test('recoveryColor según rango de puntuación', () => {
  assert.equal(recoveryColor(null), '#8b98a8');
  assert.equal(recoveryColor(15), '#f85149');
  assert.equal(recoveryColor(45), '#f0883e');
  assert.equal(recoveryColor(70), '#3fb950');
  assert.equal(recoveryColor(90), '#3b9ae1');
});

test('weeklyLoad calcula carga ponderada de los últimos 7 días', () => {
  const now = new Date().toISOString();
  const history = [
    { date: now, zoneSecs: [0, 600, 300, 0, 0, 0] },
    { date: now, zoneSecs: [0, 0, 0, 120, 60, 0] },
  ];
  const load = weeklyLoad(history);
  // 600/60*1 + 300/60*1.5 + 120/60*2 + 60/60*3 = 10 + 7.5 + 4 + 3 = 24.5 → 25
  assert.equal(load, 25);
});

test('weeklyLoad ignora sesiones antiguas', () => {
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(weeklyLoad([{ date: old, zoneSecs: [0, 600, 0, 0, 0, 0] }]), 0);
});

test('updateBaseline añade entradas y recorta a 7', () => {
  const log = [];
  for (let i = 0; i < 9; i++) {
    log.push({ date: `2026-01-0${i + 1}`, rmssd: 30 + i });
  }
  const updated = updateBaseline(log, 50);
  assert.equal(updated.length, 7);
  assert.equal(updated[updated.length - 1].rmssd, 50);
});

test('updateBaseline actualiza si ya existe la misma fecha', () => {
  const log = [{ date: new Date().toISOString().slice(0, 10), rmssd: 30 }];
  const updated = updateBaseline(log, 45);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].rmssd, 45);
});

test('baselineAvg promedia las entradas', () => {
  const log = [
    { date: '2026-01-01', rmssd: 30 },
    { date: '2026-01-02', rmssd: 40 },
    { date: '2026-01-03', rmssd: 50 },
  ];
  assert.equal(baselineAvg(log), 40);
  assert.equal(baselineAvg([]), null);
});
