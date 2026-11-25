import { HrMonitor, DemoMonitor, bluetoothAvailable } from './ble.js';
import { ZONES, zoneBounds, zoneFor, zoneColor, zoneLabel, maxHrOf } from './zones.js';
import { Session, routineDuration, expandSteps, formatDuration } from './session.js';
import { load, save, newId, MAX_HISTORY } from './storage.js';
import { initWeb, fillAds } from './web.js';
import { isNative, keepScreenOn, backgroundMode, speak, unlockAudio, beep } from './platform.js';
import { preparePoincare, detectEctopic, drawPoincare } from './rr-viz.js';

const HR_STALE_MS = 5000;
const CHART_MS = 5 * 60 * 1000;
const OFF_TARGET_HINT_S = 10;
const MIN_SAVED_SESSION_S = 10;
const ZONE_CONFIRM_S = 5; // la zona debe mantenerse este tiempo antes de anunciarla
const COACH_REPEAT_MS = 30000;
const COACH_AFTER_STEP_MS = 15000;
const STEP_SPEECH_MS = 6000;

const data = load();
const state = {
  monitor: null,
  status: 'disconnected',
  bpm: null,
  bpmAt: 0,
  battery: null,
  session: null,
  lastSummary: null,
  routineId: '',
  editing: null,
  live: [], // { ts, bpm } de los últimos 5 minutos
  lastTick: Date.now(),
  lastCountdown: 0,
  noticeTimer: null,
  coach: newCoach(),
  rrVizBuffer: [],
  lastPoincareRender: 0,
};

function newCoach() {
  return { zone: null, candidate: null, candidateSecs: 0, lastAt: 0, quietUntil: 0 };
}

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clampInt = (value, lo, hi) => Math.min(hi, Math.max(lo, parseInt(value, 10) || 0));
const bounds = () => zoneBounds(data.profile);
const currentBpm = () => (state.bpm && Date.now() - state.bpmAt < HR_STALE_MS ? state.bpm : null);
const persist = () => save(data);

function showNotice(text) {
  const el = $('notice');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(() => (el.hidden = true), 7000);
}

// Primer toque arma el botón; el segundo confirma.
function confirmed(btn) {
  if (btn.classList.contains('armed')) {
    btn.classList.remove('armed');
    btn.textContent = btn.dataset.label;
    return true;
  }
  btn.dataset.label = btn.textContent;
  btn.classList.add('armed');
  btn.textContent = '¿Seguro?';
  setTimeout(() => {
    if (!btn.classList.contains('armed')) return;
    btn.classList.remove('armed');
    btn.textContent = btn.dataset.label;
  }, 3000);
  return false;
}

// ---------- Conexión ----------

function attach(monitor) {
  state.monitor = monitor;
  monitor.addEventListener('hr', (e) => {
    state.bpm = e.detail.bpm || null;
    state.bpmAt = Date.now();
    if (e.detail.rr?.length) {
      state.rrVizBuffer.push(...e.detail.rr);
      if (state.rrVizBuffer.length > 200) state.rrVizBuffer.splice(0, state.rrVizBuffer.length - 200);
    }
    // Con la pantalla apagada Android frena los temporizadores de la web;
    // cada lectura de la banda hace avanzar el entrenamiento igualmente.
    if (state.session && Date.now() - state.lastTick >= 1000) tick();
    else renderHr();
  });
  monitor.addEventListener('battery', (e) => {
    state.battery = e.detail;
    renderConn();
  });
  monitor.addEventListener('status', (e) => {
    if (state.monitor !== monitor) return;
    state.status = e.detail;
    if (e.detail === 'disconnected') {
      state.monitor = null;
      state.battery = null;
      state.rrVizBuffer = [];
      $('poincare-card').hidden = true;
      $('ectopic-alert').hidden = true;
    }
    renderConn();
  });
}

async function connect(monitor) {
  attach(monitor);
  try {
    await monitor.connect();
  } catch (err) {
    if (state.monitor === monitor) state.monitor = null;
    state.status = 'disconnected';
    renderConn();
    const cancelled = err?.name === 'NotFoundError' || /cancel/i.test(err?.message || '');
    if (!cancelled) showNotice(`No se pudo conectar: ${err?.message || err}`);
  }
}

function toggleConnection() {
  if (state.monitor) return state.monitor.disconnect();
  if (!bluetoothAvailable()) {
    return showNotice('Este navegador no tiene Bluetooth. Usa la app Android o Chrome, o prueba el modo demo en Ajustes.');
  }
  connect(new HrMonitor());
}

function toggleDemo() {
  if (state.monitor instanceof DemoMonitor) return state.monitor.disconnect();
  if (state.monitor) state.monitor.disconnect();
  connect(new DemoMonitor(() => maxHrOf(data.profile)));
  showView('train');
}

function renderConn() {
  const labels = {
    disconnected: 'Desconectado',
    connecting: 'Conectando…',
    reconnecting: 'Reconectando…',
    connected: `Conectado · ${state.monitor?.name ?? ''}`,
  };
  const chip = $('conn-status');
  chip.textContent = labels[state.status];
  chip.className = `chip ${state.status === 'connected' ? 'on' : state.status === 'disconnected' ? '' : 'wait'}`;
  $('battery').hidden = state.battery == null;
  $('battery').textContent = `Batería ${state.battery} %`;
  $('btn-connect').textContent = state.monitor ? 'Desconectar' : 'Conectar banda';
  $('btn-connect').classList.toggle('primary', !state.monitor);
  $('btn-demo').textContent = state.monitor instanceof DemoMonitor ? 'Desactivar modo demo' : 'Activar modo demo';
}

// ---------- Pulso y zonas ----------

function renderZoneBar() {
  $('zone-bar').innerHTML = bounds()
    .map((b) => `<div class="zone-seg" data-zone="${b.id}" style="--c:${zoneColor(b.id)}"><b>Z${b.id}</b>${b.low}–${b.high}</div>`)
    .join('');
  $('zone-table').innerHTML = bounds()
    .map(
      (b, i) => `<div class="zone-table-row" style="--c:${zoneColor(b.id)}">${zoneLabel(b.id)}
        <span><input type="number" inputmode="numeric" min="30" max="240" data-zone-low="${i}" value="${b.low}" aria-label="Inicio de Z${b.id}"> – ${b.high} ppm</span>
      </div>`,
    )
    .join('');
  $('btn-zones-reset').hidden = !data.profile.zoneLows;
}

// Cambia a mano dónde empieza una zona; a partir de ahí las cinco quedan fijas.
function onZoneLowChange(input) {
  const lows = bounds().map((b) => b.low);
  lows[Number(input.dataset.zoneLow)] = parseInt(input.value, 10);
  const valid = lows.every((low, i) => low >= 30 && low <= 240 && (i === 0 || low > lows[i - 1]));
  if (valid) {
    data.profile.zoneLows = lows;
    persist();
  } else {
    showNotice('Cada zona debe empezar por encima de la anterior (entre 30 y 240 ppm).');
  }
  renderZoneBar();
  renderHr();
}

function resetZones() {
  data.profile.zoneLows = null;
  persist();
  renderZoneBar();
  renderHr();
}

function renderHr() {
  const bpm = currentBpm();
  const zone = bpm ? zoneFor(bpm, bounds()) : null;
  $('hr-bpm').textContent = bpm ?? '--';
  $('hr-card').style.setProperty('--zone-color', zoneColor(zone));
  $('hr-zone').textContent = bpm ? zoneLabel(zone) : 'Sin señal';
  $('hr-pct').textContent = bpm ? `${Math.round((bpm / maxHrOf(data.profile)) * 100)} % de tu FC máxima` : '';
  for (const seg of $('zone-bar').children) seg.classList.toggle('active', Number(seg.dataset.zone) === zone);
}

function zoneTimesHtml(zoneSecs) {
  const total = zoneSecs.reduce((a, b) => a + b, 0) || 1;
  const zones = [5, 4, 3, 2, 1];
  if (zoneSecs[0] > 0) zones.push(0);
  return zones
    .map(
      (z) => `<div class="zt-row" style="--c:${zoneColor(z)}">
        <span>${z ? `Z${z}` : '<Z1'}</span>
        <div class="zt-track"><div class="zt-fill" style="width:${(zoneSecs[z] / total) * 100}%"></div></div>
        <span>${formatDuration(zoneSecs[z])}</span>
      </div>`,
    )
    .join('');
}

function drawChart() {
  const canvas = $('chart');
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w) return; // vista oculta
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const b = bounds();
  const lo = b[0].low - 15;
  const hi = b[4].high + 5;
  const y = (bpm) => h - ((Math.min(Math.max(bpm, lo), hi) - lo) / (hi - lo)) * h;
  b.forEach((zone, i) => {
    const top = y(i < b.length - 1 ? b[i + 1].low : hi);
    ctx.fillStyle = `${zoneColor(zone.id)}33`;
    ctx.fillRect(0, top, w, y(zone.low) - top);
  });

  const now = Date.now();
  ctx.beginPath();
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#e6edf3';
  let prevTs = 0;
  for (const p of state.live) {
    const x = w - ((now - p.ts) / CHART_MS) * w;
    if (p.ts - prevTs > HR_STALE_MS) ctx.moveTo(x, y(p.bpm));
    else ctx.lineTo(x, y(p.bpm));
    prevTs = p.ts;
  }
  ctx.stroke();
}

// ---------- Entrenamiento ----------

const selectedRoutine = () => data.routines.find((r) => r.id === state.routineId) || null;

function renderRoutineSelect() {
  if (!selectedRoutine()) state.routineId = '';
  $('routine-select').innerHTML =
    '<option value="">Sesión libre (solo medir)</option>' +
    data.routines.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  $('routine-select').value = state.routineId;
  const routine = selectedRoutine();
  $('routine-summary').textContent = routine
    ? `${expandSteps(routine).length} pasos · ${formatDuration(routineDuration(routine))}`
    : 'Sin pasos: mide tu pulso y el tiempo en cada zona.';
}

function spokenDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const parts = [];
  if (m) parts.push(`${m} ${m === 1 ? 'minuto' : 'minutos'}`);
  if (s) parts.push(`${s} segundos`);
  return parts.join(' y ');
}

function announceStep() {
  const step = state.session?.step;
  if (!step) return;
  beep(880, 0.4);
  if (data.profile.voice) {
    // Los nombres de paso son libres, así que la versión pregrabada usa un aviso genérico.
    const nameClip = { Calentamiento: 'calentamiento', Enfriamiento: 'enfriamiento' }[step.name] ?? 'paso';
    speak(
      `${step.name}. ${spokenDuration(step.duration)}${step.zone ? `, zona ${step.zone}` : ''}.`,
      step.zone ? [nameClip, `objetivo${step.zone}`] : [nameClip],
    );
  }
  // Deja terminar el anuncio del paso y da margen para adaptarse al nuevo objetivo.
  const now = Date.now();
  state.coach.quietUntil = now + STEP_SPEECH_MS;
  state.coach.lastAt = now + COACH_AFTER_STEP_MS - COACH_REPEAT_MS;
}

// Avisos por voz: anuncia cada cambio de zona y, si hay zona objetivo,
// indica subir o bajar el ritmo y lo repite mientras sigas fuera.
function coach(session, bpm, dt, now) {
  if (!data.profile.voice || session.paused || !bpm) return;
  const c = state.coach;
  const zone = zoneFor(bpm, session.bounds);
  const target = session.step?.zone || 0;
  const offTarget = !!target && zone !== target;
  const advice = offTarget ? `${zone < target ? 'Sube' : 'Baja'} el ritmo, objetivo zona ${target}.` : '';
  const adviceClips = offTarget ? [zone < target ? 'sube' : 'baja', `objetivo${target}`] : [];

  if (zone === c.zone) {
    c.candidate = null;
  } else {
    c.candidateSecs = zone === c.candidate ? c.candidateSecs + dt : 0;
    c.candidate = zone;
    if (c.candidateSecs >= ZONE_CONFIRM_S && now >= c.quietUntil) {
      c.zone = zone;
      c.candidate = null;
      c.lastAt = now;
      const name = zone ? `Zona ${zone}.` : 'Por debajo de zona 1.';
      const nameClip = zone ? `zona${zone}` : 'below';
      if (!target) speak(name, [nameClip]);
      else if (offTarget) speak(`${name} ${advice}`, [nameClip, ...adviceClips]);
      else speak(`${name} En objetivo, mantén el ritmo.`, [nameClip, 'en_objetivo']);
      return;
    }
  }
  if (advice && session.offTargetSecs >= OFF_TARGET_HINT_S && now - c.lastAt >= COACH_REPEAT_MS && now >= c.quietUntil) {
    c.lastAt = now;
    speak(`${advice} Estás ${zone ? `en zona ${zone}` : 'por debajo de zona 1'}.`, [
      ...adviceClips,
      zone ? `estas${zone}` : 'estas_below',
    ]);
  }
}

function startSession() {
  unlockAudio();
  state.session = new Session({ routine: selectedRoutine(), bounds: bounds() });
  state.lastSummary = null;
  state.lastTick = Date.now();
  state.coach = newCoach();
  keepScreenOn(true);
  backgroundMode(true, { webAudio: data.profile.bgAudio });
  if (!state.monitor) showNotice('Sin banda conectada: se cronometra, pero no se registra el pulso.');
  announceStep();
  renderLive();
}

function finishSession() {
  const session = state.session;
  if (!session) return;
  state.session = null;
  keepScreenOn(false);
  const summary = { id: newId(), ...session.summary() };
  state.lastSummary = summary;
  if (summary.duration >= MIN_SAVED_SESSION_S) {
    data.history.unshift(summary);
    data.history.length = Math.min(data.history.length, MAX_HISTORY);
    persist();
    renderHistory();
  }
  beep(520, 0.8);
  if (data.profile.voice) speak('Entrenamiento terminado.', ['fin']);
  backgroundMode(false); // después del aviso final, para que llegue a sonar
  renderLive();
}

function renderZoneTimes() {
  const session = state.session;
  const summary = state.lastSummary;
  $('zone-times-card').hidden = !session && !summary;
  if (session) {
    $('zone-times-title').textContent = 'Tiempo en zonas';
    $('zone-times-summary').textContent = '';
    $('zone-times').innerHTML = zoneTimesHtml(session.zoneSecs);
  } else if (summary) {
    $('zone-times-title').textContent = 'Último entrenamiento';
    $('zone-times-summary').textContent =
      `${summary.routineName} · ${formatDuration(summary.duration)} · media ${summary.avgBpm || '--'} · máx ${summary.maxBpm || '--'} ppm`;
    $('zone-times').innerHTML = zoneTimesHtml(summary.zoneSecs);
  }
}

function renderLive() {
  const session = state.session;
  $('setup').hidden = !!session;
  $('live').hidden = !session;
  renderZoneTimes();
  if (!session) return;

  const step = session.step;
  $('step-box').hidden = !step;
  $('btn-skip').hidden = !step;
  if (step) {
    const round = step.rounds > 1 ? ` · Ronda ${step.round}/${step.rounds}` : '';
    $('step-count').textContent = `Paso ${session.stepIndex + 1}/${session.steps.length}${round}`;
    const target = step.zone ? session.bounds[step.zone - 1] : null;
    $('step-target').textContent = target ? `Objetivo Z${step.zone} · ${target.low}–${target.high}` : 'Libre';
    $('step-target').style.setProperty('--c', zoneColor(step.zone));
    $('step-name').textContent = step.name;
    $('step-remaining').textContent = formatDuration(Math.ceil(session.stepRemaining));
    const next = session.nextStep;
    $('step-next').textContent = next
      ? `Después: ${next.name} (${formatDuration(next.duration)}${next.zone ? `, Z${next.zone}` : ''})`
      : 'Último paso';

    const hint = $('step-hint');
    const targetState = session.targetState(currentBpm());
    const offTarget = session.offTargetSecs >= OFF_TARGET_HINT_S;
    hint.className = `hint ${targetState}`;
    if (session.paused) hint.textContent = 'En pausa';
    else if (targetState === 'in') hint.textContent = 'En zona ✓';
    else if (targetState === 'low' && offTarget) hint.textContent = 'Sube el ritmo ↑';
    else if (targetState === 'high' && offTarget) hint.textContent = 'Baja el ritmo ↓';
    else hint.textContent = '';
  }
  $('st-elapsed').textContent = formatDuration(session.elapsed);
  $('st-avg').textContent = session.avgBpm || '--';
  $('st-max').textContent = session.maxBpm || '--';
  $('btn-pause').textContent = session.paused ? 'Reanudar' : 'Pausar';
}

function renderPoincare() {
  const card = $('poincare-card');
  if (state.rrVizBuffer.length < 10) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const pData = preparePoincare(state.rrVizBuffer);
  if (!pData.length) return;
  const canvas = $('poincare');
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPoincare(ctx, pData, w, h);
}

function renderEctopic() {
  const el = $('ectopic-alert');
  const ectopics = detectEctopic(state.rrVizBuffer);
  if (ectopics.length) {
    el.textContent = `⚠ Detectados ${ectopics.length} latidos irregulares en los últimos ${state.rrVizBuffer.length} latidos`;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function tick() {
  const now = Date.now();
  const dt = (now - state.lastTick) / 1000;
  state.lastTick = now;

  const bpm = currentBpm();
  if (bpm) state.live.push({ ts: now, bpm });
  while (state.live.length && now - state.live[0].ts > CHART_MS) state.live.shift();

  const session = state.session;
  if (session) {
    const stepBefore = session.stepIndex;
    session.tick(dt, bpm);
    if (session.done) {
      finishSession();
    } else {
      if (session.stepIndex !== stepBefore) announceStep();
      coach(session, bpm, dt, now);
      const left = Math.ceil(session.stepRemaining);
      if (session.step && !session.paused && left <= 3 && left !== state.lastCountdown) beep(660, 0.12);
      state.lastCountdown = left;
    }
  }
  renderHr();
  renderLive();
  drawChart();
  if (now - state.lastPoincareRender >= 5000) {
    state.lastPoincareRender = now;
    renderPoincare();
    renderEctopic();
  }
}

// ---------- Rutinas ----------

const blankStep = () => ({ name: 'Paso', duration: 60, zone: 3 });

function stripHtml(routine) {
  return expandSteps(routine)
    .map((s) => `<i style="flex:${s.duration};--c:${zoneColor(s.zone)}" title="${esc(s.name)}"></i>`)
    .join('');
}

function zoneOptions(selected) {
  return [0, 1, 2, 3, 4, 5]
    .map((z) => `<option value="${z}"${z === selected ? ' selected' : ''}>${z ? zoneLabel(z) : 'Libre (sin objetivo)'}</option>`)
    .join('');
}

function editorHtml(r) {
  const steps = r.steps
    .map(
      (s, i) => `<div class="step-row" data-i="${i}">
        <input data-sf="name" value="${esc(s.name)}" maxlength="30" placeholder="Nombre del paso" aria-label="Nombre del paso">
        <input data-sf="min" type="number" min="0" max="600" inputmode="numeric" value="${Math.floor(s.duration / 60)}" aria-label="Minutos" title="Minutos">
        <input data-sf="sec" type="number" min="0" max="59" inputmode="numeric" value="${s.duration % 60}" aria-label="Segundos" title="Segundos">
        <div class="step-ctl">
          <select data-sf="zone" aria-label="Zona objetivo">${zoneOptions(s.zone)}</select>
          <button class="btn small" data-act="step-up" aria-label="Subir paso"${i ? '' : ' disabled'}>↑</button>
          <button class="btn small danger" data-act="step-del" aria-label="Quitar paso">✕</button>
        </div>
      </div>`,
    )
    .join('');
  return `<div class="card">
    <h2>${r.isNew ? 'Nueva rutina' : 'Editar rutina'}</h2>
    <label class="field">Nombre
      <input data-f="name" value="${esc(r.name)}" maxlength="40" placeholder="Ej. Series en cuestas">
    </label>
    <div class="pair">
      <label class="field">Calentar (min)
        <input data-f="warmup" type="number" min="0" max="60" inputmode="numeric" value="${Math.round(r.warmup / 60)}">
      </label>
      <label class="field">Rondas
        <input data-f="rounds" type="number" min="1" max="50" inputmode="numeric" value="${r.rounds}">
      </label>
      <label class="field">Enfriar (min)
        <input data-f="cooldown" type="number" min="0" max="60" inputmode="numeric" value="${Math.round(r.cooldown / 60)}">
      </label>
    </div>
    <div class="pair two">
      <label class="field">Zona del calentamiento
        <select data-f="warmupZone">${zoneOptions(r.warmupZone ?? 1)}</select>
      </label>
      <label class="field">Zona del enfriamiento
        <select data-f="cooldownZone">${zoneOptions(r.cooldownZone ?? 1)}</select>
      </label>
    </div>
    <h2>Pasos de cada ronda (nombre · min · s)</h2>
    ${steps}
    <div class="row"><button class="btn" data-act="step-add">+ Añadir paso</button></div>
    <p id="editor-total" class="muted">Duración total: ${formatDuration(routineDuration(r))}</p>
    <p id="editor-error" class="error" hidden></p>
    <div class="row">
      <button class="btn primary" data-act="save">Guardar</button>
      <button class="btn" data-act="cancel">Cancelar</button>
    </div>
  </div>`;
}

function renderRoutines() {
  const el = $('routines-list');
  if (state.editing) {
    el.innerHTML = editorHtml(state.editing);
    return;
  }
  const cards = data.routines
    .map(
      (r) => `<div class="card">
        <div class="item-head">
          <h3>${esc(r.name)}</h3>
          <span class="muted">${formatDuration(routineDuration(r))}${r.rounds > 1 ? ` · ${r.rounds} rondas` : ''}</span>
        </div>
        <div class="strip">${stripHtml(r)}</div>
        <div class="row">
          <button class="btn primary small" data-act="use" data-id="${r.id}">Entrenar</button>
          <button class="btn small" data-act="edit" data-id="${r.id}">Editar</button>
          <button class="btn small" data-act="dup" data-id="${r.id}">Duplicar</button>
          <button class="btn small danger" data-act="del" data-id="${r.id}">Eliminar</button>
        </div>
      </div>`,
    )
    .join('');
  el.innerHTML =
    `<button class="btn primary big" data-act="new">+ Nueva rutina</button>` +
    (cards || '<p class="muted">Aún no tienes rutinas.</p>');
}

function saveEditing() {
  const r = state.editing;
  const name = r.name.trim();
  const error = !name
    ? 'Ponle un nombre a la rutina.'
    : !r.steps.length
      ? 'Añade al menos un paso.'
      : r.steps.some((s) => s.duration <= 0)
        ? 'Todos los pasos necesitan una duración mayor que cero.'
        : '';
  if (error) {
    $('editor-error').textContent = error;
    $('editor-error').hidden = false;
    return;
  }
  const routine = {
    id: r.id,
    name,
    warmup: r.warmup,
    cooldown: r.cooldown,
    warmupZone: r.warmupZone ?? 1,
    cooldownZone: r.cooldownZone ?? 1,
    rounds: r.rounds,
    steps: r.steps.map((s) => ({ name: s.name.trim() || 'Paso', duration: s.duration, zone: s.zone })),
  };
  const index = data.routines.findIndex((x) => x.id === r.id);
  if (index >= 0) data.routines[index] = routine;
  else data.routines.push(routine);
  state.editing = null;
  persist();
  renderRoutines();
  renderRoutineSelect();
}

function onRoutinesClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const routine = data.routines.find((r) => r.id === btn.dataset.id);
  const editing = state.editing;
  const stepIndex = Number(btn.closest('.step-row')?.dataset.i);

  if (act === 'new') {
    state.editing = { id: newId(), isNew: true, name: '', warmup: 300, cooldown: 300, rounds: 1, steps: [blankStep()] };
  } else if (act === 'edit') {
    state.editing = structuredClone(routine);
  } else if (act === 'dup') {
    data.routines.push({ ...structuredClone(routine), id: newId(), name: `${routine.name} (copia)` });
    persist();
  } else if (act === 'del') {
    if (!confirmed(btn)) return;
    data.routines = data.routines.filter((r) => r.id !== routine.id);
    persist();
  } else if (act === 'use') {
    state.routineId = routine.id;
    showView('train');
  } else if (act === 'step-add') {
    editing.steps.push(blankStep());
  } else if (act === 'step-del') {
    editing.steps.splice(stepIndex, 1);
  } else if (act === 'step-up') {
    editing.steps.splice(stepIndex - 1, 0, ...editing.steps.splice(stepIndex, 1));
  } else if (act === 'cancel') {
    state.editing = null;
  } else if (act === 'save') {
    return saveEditing();
  }
  renderRoutines();
  renderRoutineSelect();
}

// Los campos escriben en state.editing sin volver a pintar, para no perder el foco.
function onRoutinesInput(e) {
  const r = state.editing;
  if (!r) return;
  const t = e.target;
  if (t.dataset.f === 'name') r.name = t.value;
  else if (t.dataset.f === 'rounds') r.rounds = clampInt(t.value, 1, 50);
  else if (t.dataset.f === 'warmup') r.warmup = clampInt(t.value, 0, 60) * 60;
  else if (t.dataset.f === 'cooldown') r.cooldown = clampInt(t.value, 0, 60) * 60;
  else if (t.dataset.f === 'warmupZone') r.warmupZone = Number(t.value);
  else if (t.dataset.f === 'cooldownZone') r.cooldownZone = Number(t.value);
  else if (t.dataset.sf) {
    const row = t.closest('.step-row');
    const step = r.steps[Number(row.dataset.i)];
    if (t.dataset.sf === 'name') step.name = t.value;
    else if (t.dataset.sf === 'zone') step.zone = Number(t.value);
    else {
      step.duration =
        clampInt(row.querySelector('[data-sf="min"]').value, 0, 600) * 60 +
        clampInt(row.querySelector('[data-sf="sec"]').value, 0, 59);
    }
  }
  $('editor-total').textContent = `Duración total: ${formatDuration(routineDuration(r))}`;
}

// ---------- Historial ----------

function renderHistory() {
  $('history-list').innerHTML =
    data.history
      .map(
        (h) => `<div class="card">
          <div class="item-head">
            <h3>${esc(h.routineName)}</h3>
            <span class="muted">${new Date(h.date).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })}</span>
          </div>
          <p class="muted">${formatDuration(h.duration)} · media ${h.avgBpm || '--'} · máx ${h.maxBpm || '--'} ppm</p>
          ${zoneTimesHtml(h.zoneSecs)}
          <div class="row"><button class="btn small danger" data-act="del" data-id="${h.id}">Eliminar</button></div>
        </div>`,
      )
      .join('') || '<p class="muted">Aquí aparecerán tus entrenamientos al terminarlos.</p>';
}

function onHistoryClick(e) {
  const btn = e.target.closest('[data-act="del"]');
  if (!btn || !confirmed(btn)) return;
  data.history = data.history.filter((h) => h.id !== btn.dataset.id);
  persist();
  renderHistory();
}

// ---------- Ajustes ----------

function renderSettings() {
  const p = data.profile;
  $('set-age').value = p.age;
  $('set-max').value = p.maxHr ?? '';
  $('set-max').placeholder = `Estimada: ${220 - p.age}`;
  $('set-rest').value = p.restHr ?? '';
  $('set-method').value = p.method;
  $('set-voice').checked = p.voice;
  $('set-bg-audio').checked = !!p.bgAudio;
  $('set-bg-audio-row').hidden = isNative; // la app Android ya lo hace sin pausar la música
  $('set-method-note').hidden = !(p.method === 'karvonen' && !p.restHr);
}

function onSettingsChange(e) {
  if (e.target.dataset.zoneLow) return onZoneLowChange(e.target);
  const p = data.profile;
  const optional = (id, lo, hi) => {
    const n = parseInt($(id).value, 10);
    return n >= lo && n <= hi ? n : null;
  };
  p.age = optional('set-age', 10, 100) ?? p.age;
  p.maxHr = optional('set-max', 100, 240);
  p.restHr = optional('set-rest', 30, 120);
  p.method = $('set-method').value;
  p.voice = $('set-voice').checked;
  p.bgAudio = $('set-bg-audio').checked;
  persist();
  renderSettings();
  renderZoneBar();
  renderHr();
}

// ---------- Navegación ----------

function showView(name) {
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `view-${name}`;
  fillAds($(`view-${name}`));
  for (const tab of document.querySelectorAll('.tabs button')) tab.classList.toggle('active', tab.dataset.view === name);
  if (name === 'train') {
    renderRoutineSelect();
    drawChart();
  }
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const view = e.target.closest('button')?.dataset.view;
  if (view) showView(view);
});
$('btn-connect').addEventListener('click', toggleConnection);
$('btn-demo').addEventListener('click', toggleDemo);
$('routine-select').addEventListener('change', (e) => {
  state.routineId = e.target.value;
  renderRoutineSelect();
});
$('btn-start').addEventListener('click', startSession);
$('btn-pause').addEventListener('click', () => {
  state.session.paused = !state.session.paused;
  renderLive();
});
$('btn-skip').addEventListener('click', () => {
  const session = state.session;
  session.skip();
  if (session.done) finishSession();
  else announceStep();
  renderLive();
});
$('btn-finish').addEventListener('click', (e) => {
  if (confirmed(e.currentTarget)) finishSession();
});
$('routines-list').addEventListener('click', onRoutinesClick);
$('routines-list').addEventListener('input', onRoutinesInput);
$('history-list').addEventListener('click', onHistoryClick);
$('view-settings').addEventListener('change', onSettingsChange);
$('btn-zones-reset').addEventListener('click', resetZones);

initWeb();
renderConn();
renderZoneBar();
renderHr();
renderRoutineSelect();
renderLive();
renderRoutines();
renderHistory();
renderSettings();
setInterval(tick, 1000);
