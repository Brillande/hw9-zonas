import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartRate } from '../js/hr-parse.js';
import { zoneBounds, zoneFor, maxHrOf } from '../js/zones.js';
import { Session, expandSteps, routineDuration, formatDuration } from '../js/session.js';
import { computeTRIMP, trimpLabel } from '../js/trimp.js';
import { caloriesPerMinute } from '../js/calories.js';
import { preparePoincare, detectEctopic } from '../js/rr-viz.js';
import { computeRMSSD, computeSDNN, computePNN50, filterRR } from '../js/hrv.js';

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

test('computeTRIMP: suma ponderada por zona', () => {
  assert.equal(computeTRIMP([0, 600, 600, 600, 300, 60]), 64.5);
});

test('computeTRIMP: todo por debajo de Z1 da cero', () => {
  assert.equal(computeTRIMP([3600, 0, 0, 0, 0, 0]), 0);
});

test('trimpLabel: etiquetas en castellano', () => {
  assert.equal(trimpLabel(0), 'Ligero');
  assert.equal(trimpLabel(49.9), 'Ligero');
  assert.equal(trimpLabel(50), 'Moderado');
  assert.equal(trimpLabel(100), 'Intenso');
  assert.equal(trimpLabel(199), 'Intenso');
  assert.equal(trimpLabel(200), 'Muy intenso');
  assert.equal(trimpLabel(500), 'Muy intenso');
});

test('caloriesPerMinute: fórmula masculina (Keytel 2005)', () => {
  const cal = caloriesPerMinute(150, 75, 30, true);
  assert.ok(cal > 14 && cal < 15, `esperado ~14-15, obtenido ${cal}`);
});

test('caloriesPerMinute: fórmula femenina (Keytel 2005)', () => {
  const cal = caloriesPerMinute(150, 60, 30, false);
  assert.ok(cal > 13 && cal < 14, `esperado ~13-14, obtenido ${cal}`);
});

test('caloriesPerMinute: devuelve 0 si falta el peso', () => {
  assert.equal(caloriesPerMinute(150, null, 30, true), 0);
});

test('caloriesPerMinute: devuelve 0 si falta la edad', () => {
  assert.equal(caloriesPerMinute(150, 75, null, true), 0);
});

test('Session acumula calorías con perfil completo', () => {
  const p = { age: 30, weight: 75, sex: 'M' };
  const s = new Session({ routine, bounds: zoneBounds(profile), profile: p });
  for (let i = 0; i < 60; i++) s.tick(1, 150);
  const sum = s.summary();
  assert.ok(sum.calories > 0, `calorías deberían ser positivas, obtenido ${sum.calories}`);
});

test('Session no acumula calorías sin peso en el perfil', () => {
  const p = { age: 30, weight: null, sex: 'M' };
  const s = new Session({ routine, bounds: zoneBounds(profile), profile: p });
  for (let i = 0; i < 60; i++) s.tick(1, 150);
  assert.equal(s.summary().calories, 0);
});

test('preparePoincare devuelve pares consecutivos', () => {
  const pairs = preparePoincare([800, 810, 790, 805]);
  assert.equal(pairs.length, 3);
  assert.deepEqual(pairs[0], { x: 800, y: 810 });
  assert.deepEqual(pairs[1], { x: 810, y: 790 });
  assert.deepEqual(pairs[2], { x: 790, y: 805 });
});

test('preparePoincare filtra valores fuera de rango fisiológico', () => {
  const pairs = preparePoincare([800, 200, 810, 2500, 790]);
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs[0], { x: 800, y: 810 });
  assert.deepEqual(pairs[1], { x: 810, y: 790 });
});

test('detectEctopic identifica latido aberrante', () => {
  const ectopics = detectEctopic([800, 810, 790, 805, 795, 400, 800]);
  assert.ok(ectopics.length > 0);
  const found = ectopics.find((e) => e.rr === 400);
  assert.ok(found, 'debe detectar el latido de 400 ms como ectópico');
  assert.equal(found.index, 5);
});

test('detectEctopic no marca latidos uniformes', () => {
  const ectopics = detectEctopic([800, 805, 798, 810, 802, 795, 808]);
  assert.equal(ectopics.length, 0);
});

test('detectEctopic devuelve vacío con menos de 5 valores', () => {
  assert.deepEqual(detectEctopic([800, 810, 790]), []);
});

// ---------- HRV ----------

test('computeRMSSD: valores conocidos', () => {
  const rr = [800, 810, 790, 805, 795];
  const rmssd = computeRMSSD(rr);
  assert.ok(rmssd >= 10 && rmssd <= 18, `RMSSD ${rmssd} fuera de rango esperado 10-18`);
});

test('computeRMSSD: devuelve null con menos de 5 intervalos', () => {
  assert.equal(computeRMSSD([800, 810, 790]), null);
  assert.equal(computeRMSSD([]), null);
});

test('filterRR: elimina valores fuera de rango fisiológico', () => {
  const result = filterRR([800, 200, 810, 2500, 790, 805, 795]);
  assert.ok(!result.includes(200), 'No debe incluir <300ms');
  assert.ok(!result.includes(2500), 'No debe incluir >2000ms');
  assert.ok(result.includes(800));
});

test('computePNN50: valores conocidos', () => {
  const rr = [800, 860, 800, 860, 800];
  const pnn50 = computePNN50(rr);
  assert.equal(pnn50, 100);
  const rr2 = [800, 810, 820, 830, 840];
  const pnn50b = computePNN50(rr2);
  assert.equal(pnn50b, 0);
});

test('computeSDNN: valores conocidos', () => {
  const rr = [800, 800, 800, 800, 800];
  assert.equal(computeSDNN(rr), 0);
  const rr2 = [800, 810, 790, 805, 795];
  const sdnn = computeSDNN(rr2);
  assert.ok(sdnn > 0, 'SDNN debe ser positivo para intervalos variables');
});
