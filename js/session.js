// Motor del entrenamiento: avance de pasos y estadísticas. Sin DOM.

import { zoneFor } from './zones.js';

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Rutina → lista plana de pasos: calentamiento, bloque × rondas, enfriamiento.
export function expandSteps(routine) {
  if (!routine) return [];
  const rounds = Math.max(1, routine.rounds || 1);
  const steps = [];
  if (routine.warmup > 0) steps.push({ name: 'Calentamiento', duration: routine.warmup, zone: routine.warmupZone ?? 1 });
  for (let round = 1; round <= rounds; round++) {
    for (const s of routine.steps) steps.push({ ...s, round, rounds });
  }
  if (routine.cooldown > 0) steps.push({ name: 'Enfriamiento', duration: routine.cooldown, zone: routine.cooldownZone ?? 1 });
  return steps;
}

export const routineDuration = (routine) => expandSteps(routine).reduce((sum, s) => sum + s.duration, 0);

export class Session {
  constructor({ routine = null, bounds, startedAt = Date.now() }) {
    this.routineName = routine ? routine.name : 'Sesión libre';
    this.steps = expandSteps(routine);
    this.bounds = bounds;
    this.startedAt = startedAt;
    this.elapsed = 0;
    this.stepIndex = 0;
    this.stepElapsed = 0;
    this.paused = false;
    this.done = false;
    this.zoneSecs = [0, 0, 0, 0, 0, 0]; // índice 0 = por debajo de Z1
    this.hrSecs = 0;
    this.hrSum = 0;
    this.maxBpm = 0;
    this.offTargetSecs = 0;
    this.energyStart = null;
    this.energy = 0;
  }

  get step() {
    return this.steps[this.stepIndex] || null;
  }

  get nextStep() {
    return this.steps[this.stepIndex + 1] || null;
  }

  get stepRemaining() {
    return this.step ? this.step.duration - this.stepElapsed : 0;
  }

  get avgBpm() {
    return this.hrSecs ? Math.round(this.hrSum / this.hrSecs) : 0;
  }

  // 'none' si el paso no tiene zona objetivo o no hay pulso.
  targetState(bpm) {
    const target = this.step?.zone;
    if (!target || !bpm) return 'none';
    const zone = zoneFor(bpm, this.bounds);
    return zone < target ? 'low' : zone > target ? 'high' : 'in';
  }

  // Avanza dt segundos con el pulso actual (o null si no hay señal).
  tick(dt, bpm) {
    if (this.paused || this.done || dt <= 0) return;
    this.elapsed += dt;
    if (bpm) {
      this.zoneSecs[zoneFor(bpm, this.bounds)] += dt;
      this.hrSecs += dt;
      this.hrSum += bpm * dt;
      this.maxBpm = Math.max(this.maxBpm, bpm);
    }
    const state = this.targetState(bpm);
    this.offTargetSecs = state === 'low' || state === 'high' ? this.offTargetSecs + dt : 0;

    if (!this.steps.length) return;
    this.stepElapsed += dt;
    while (this.step && this.stepElapsed >= this.step.duration) {
      this.stepElapsed -= this.step.duration;
      this.stepIndex++;
      this.offTargetSecs = 0;
    }
    if (!this.step) this.done = true;
  }

  skip() {
    if (!this.step) return;
    this.stepIndex++;
    this.stepElapsed = 0;
    this.offTargetSecs = 0;
    if (!this.step) this.done = true;
  }

  updateEnergy(energy) {
    if (energy == null) return;
    if (this.energyStart == null) this.energyStart = energy;
    this.energy = energy - this.energyStart;
  }

  summary() {
    return {
      date: this.startedAt,
      routineName: this.routineName,
      duration: Math.round(this.elapsed),
      avgBpm: this.avgBpm,
      maxBpm: this.maxBpm,
      zoneSecs: this.zoneSecs.map(Math.round),
      energy: this.energy,
    };
  }
}
