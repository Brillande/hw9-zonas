// Funciones del dispositivo: segundo plano, pantalla encendida, voz y pitidos.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { KeepAwake } from '@capacitor-community/keep-awake';

const Workout = registerPlugin('Workout');

export const isNative = Capacitor.isNativePlatform();

// Android: servicio en primer plano, la app sigue midiendo con la pantalla apagada.
// Web (opcional, webAudio): el sonido pasa por el reproductor multimedia de más
// abajo, que es lo único que el navegador deja sonar con la pantalla apagada.
export function backgroundMode(on, { webAudio = false } = {}) {
  if (isNative) {
    (on ? Workout.start() : Workout.stop()).catch(() => {});
  } else if (on && webAudio) {
    mediaStart();
  } else {
    mediaStop();
  }
}

export function keepScreenOn(on) {
  (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep()).catch(() => {});
}

// `clips` es el mismo aviso como lista de audios pregrabados, para el
// reproductor multimedia de la web. En Android y en ese reproductor la voz
// baja la música de otras apps mientras suena.
export function speak(text, clips = []) {
  if (isNative) {
    Workout.speak({ text }).catch(() => {});
  } else if (media?.active && clips.length) {
    mediaSpeak(text, clips);
  } else {
    browserSpeak(text);
  }
}

function browserSpeak(text) {
  if (!('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'es-ES';
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

let audio = null;

// Debe llamarse desde un gesto del usuario para que el audio quede habilitado.
export function unlockAudio() {
  try {
    audio ??= new AudioContext();
    audio.resume();
  } catch {}
}

export function beep(frequency, seconds) {
  if (media?.active) return mediaBeep(frequency, seconds);
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.25, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + seconds);
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + seconds);
}

// ---------- Reproductor multimedia de la web ----------
//
// Con la pantalla apagada Chrome solo mantiene viva una página que no deja de
// reproducir audio, así que todo pasa por un único <audio>: silencio en bucle
// y, cuando toca, un aviso (pitido + voz pregrabada) montado como UN solo audio.
// Comportamiento medido en Chrome para Android, del que depende el diseño:
//  - Un audio de hasta 5 s pide a Android atenuar la música de otras apps
//    mientras suena; uno más largo la pausaría. De ahí MAX_ITEM_S.
//  - El silencio en bucle no pide nada: la música de otras apps sigue igual.
//  - Si otra app toma el control del audio en mitad de un aviso, Chrome pausa
//    el elemento. Hay que reanudarlo: sin audio la página se congela al minuto.

// Avisos pregrabados (public/voice, generados con scripts/make-voice.ps1).
const VOICE_CLIPS = [
  'below', 'sube', 'baja', 'en_objetivo', 'estas_below', 'paso', 'calentamiento', 'enfriamiento', 'fin',
  ...[1, 2, 3, 4, 5].flatMap((n) => [`zona${n}`, `objetivo${n}`, `estas${n}`]),
];
const SAMPLE_RATE = 22050;
const LEAD_IN_S = 0.45; // silencio inicial: da tiempo a que Android baje la música antes de la voz
const GAP_S = 0.18; // pausa entre las frases de un aviso
const MAX_ITEM_S = 4.8;
const RESUME_DELAY_MS = 400;
const RESUME_BACKOFF_MS = 5000;

let media = null;

function mediaStart() {
  if (!media) {
    const el = new Audio();
    media = {
      el,
      queue: [], // { kind: 'voice' | 'beep', samples }
      busy: null, // tipo de lo que suena ahora; null = silencio
      active: false,
      stopping: false,
      pending: 0, // avisos esperando a que carguen los audios
      pendingTone: null,
      itemUrl: null,
      clips: new Map(), // id → Float32Array
      ready: Promise.resolve(),
      resumeTimer: null,
      lastResume: 0,
      // 8 bits y 30 s a propósito: es el formato con el que se midió que Chrome
      // no pide el control del audio.
      silentUrl: wavUrl(new Float32Array(30 * 8000), 8000, 8),
    };
    el.addEventListener('ended', mediaNext);
    el.addEventListener('error', () => media.busy && mediaNext());
    // Una pausa que no es el final de un aviso ni cosa nuestra viene del sistema.
    el.addEventListener('pause', () => media.active && !el.ended && mediaResumeSoon());
    document.addEventListener('visibilitychange', () => !document.hidden && mediaResume());
  }
  if (media.clips.size < VOICE_CLIPS.length) media.ready = loadClips();
  media.active = true;
  media.stopping = false;
  media.queue = [];
  media.pendingTone = null;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'Entrenamiento en curso', artist: 'HW9 Zonas' });
  }
  mediaNext();
}

// Se decodifican al empezar, con la app en pantalla: en segundo plano el
// navegador puede dejar las descargas a medias.
async function loadClips() {
  const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const missing = VOICE_CLIPS.filter((id) => !media.clips.has(id));
  await Promise.all(
    missing.map(async (id) => {
      try {
        const encoded = await (await fetch(`voice/${id}.mp3`)).arrayBuffer();
        media.clips.set(id, (await decoder.decodeAudioData(encoded)).getChannelData(0));
      } catch {}
    }),
  );
}

// Deja terminar lo que esté sonando o por sonar (el aviso de fin de entrenamiento).
function mediaStop() {
  if (!media?.active) return;
  if (media.busy || media.queue.length || media.pending || media.pendingTone) media.stopping = true;
  else mediaFinish();
}

function mediaFinish() {
  media.active = false;
  media.stopping = false;
  media.busy = null;
  clearTimeout(media.resumeTimer);
  media.el.pause();
  releaseItemUrl();
}

function releaseItemUrl() {
  if (media.itemUrl) URL.revokeObjectURL(media.itemUrl);
  media.itemUrl = null;
}

function mediaNext() {
  if (!media.active) return;
  releaseItemUrl();
  const item = media.queue.shift();
  if (!item && media.stopping && !media.pending && !media.pendingTone) return mediaFinish();
  media.busy = item ? item.kind : null;
  media.el.loop = !item;
  media.el.src = item ? (media.itemUrl = wavUrl(item.samples, SAMPLE_RATE, 16)) : media.silentUrl;
  // AbortError es normal: un aviso nuevo ha sustituido a este antes de empezar.
  media.el.play().catch((err) => err.name !== 'AbortError' && mediaResumeSoon());
}

function mediaResumeSoon() {
  clearTimeout(media.resumeTimer);
  const wait = Date.now() - media.lastResume < RESUME_BACKOFF_MS ? RESUME_BACKOFF_MS : RESUME_DELAY_MS;
  media.resumeTimer = setTimeout(mediaResume, wait);
}

// Vuelve al silencio en bucle. El aviso interrumpido se pierde; el siguiente ya sonará.
function mediaResume() {
  if (!media.active || !media.el.paused) return;
  media.lastResume = Date.now();
  media.queue = [];
  mediaNext();
}

function mediaSpeak(text, clips) {
  const tone = media.pendingTone;
  media.pendingTone = null;
  media.pending++;
  media.ready.then(() => {
    media.pending--;
    if (!media.active) return;
    const voice = clips.map((id) => media.clips.get(id)).filter(Boolean);
    if (!voice.length) browserSpeak(text); // sin audios descargados, al menos la voz del navegador
    media.queue = splitItems(tone ? [tone, ...voice] : voice).map((samples) => ({ kind: 'voice', samples }));
    // Un aviso nuevo corta al anterior, pero no a un pitido suelto, que dura décimas.
    if (media.busy !== 'beep') mediaNext();
  });
}

function mediaBeep(frequency, seconds) {
  media.pendingTone = toneSamples(frequency, seconds);
  // Si en esta misma pasada llega un speak(), el pitido va dentro de su aviso
  // (un solo audio); si no, suena solo, salvo que haya una voz en curso.
  queueMicrotask(() => {
    const tone = media.pendingTone;
    media.pendingTone = null;
    if (!tone || !media.active || media.busy || media.queue.length) return;
    media.queue = [{ kind: 'beep', samples: joinParts([tone], 0.05) }];
    mediaNext();
  });
}

function toneSamples(frequency, seconds) {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.5 * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE) * (1 - i / samples.length);
  }
  return samples;
}

// Reparte las frases de un aviso en audios de menos de MAX_ITEM_S (casi siempre uno).
function splitItems(parts) {
  const max = MAX_ITEM_S - LEAD_IN_S;
  const items = [];
  let group = [];
  let seconds = 0;
  for (const part of parts) {
    const partSeconds = part.length / SAMPLE_RATE + GAP_S;
    if (group.length && seconds + partSeconds > max) {
      items.push(joinParts(group, LEAD_IN_S));
      group = [];
      seconds = 0;
    }
    group.push(part);
    seconds += partSeconds;
  }
  if (group.length) items.push(joinParts(group, LEAD_IN_S));
  return items;
}

function joinParts(parts, leadSeconds) {
  const lead = Math.round(leadSeconds * SAMPLE_RATE);
  const gap = Math.round(GAP_S * SAMPLE_RATE);
  const out = new Float32Array(parts.reduce((n, p) => n + p.length + gap, lead));
  let offset = lead;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length + gap;
  }
  return out;
}

// WAV mono de 8 o 16 bits a partir de muestras entre −1 y 1.
function wavUrl(samples, rate, bits) {
  const bytes = bits / 8;
  const size = samples.length * bytes;
  const buffer = new ArrayBuffer(44 + size);
  const view = new DataView(buffer);
  const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + size, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * bytes, true);
  view.setUint16(32, bytes, true);
  view.setUint16(34, bits, true);
  text(36, 'data');
  view.setUint32(40, size, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    if (bits === 8) view.setUint8(44 + i, Math.round(128 + 127 * s));
    else view.setInt16(44 + i * 2, Math.round(32767 * s), true);
  }
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}
