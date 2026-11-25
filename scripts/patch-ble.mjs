// Parche de @capacitor-community/bluetooth-le para la COOSPO HW9.
// Al conectar, la librería pide un MTU de 512 y espera la respuesta; la HW9
// nunca responde y la conexión caduca ("Connection timeout"). El pulso cabe
// en el MTU por defecto, así que se da la conexión por buena sin negociarlo.
// Se ejecuta en cada `npm install` (postinstall) y es idempotente.

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL(
  '../node_modules/@capacitor-community/bluetooth-le/android/src/main/java/com/capacitorjs/community/plugins/bluetoothle/Device.kt',
  import.meta.url,
);
const ORIGINAL = 'requestMtu(REQUEST_MTU)';
const PATCHED = 'resolve("connect", "Connected.") // HW9 Zonas: sin negociar MTU';

const source = readFileSync(FILE, 'utf8');
if (source.includes(PATCHED) || source.includes('HW9 Zonas')) {
  console.log('patch-ble: ya aplicado');
} else if (source.includes(ORIGINAL)) {
  writeFileSync(FILE, source.replace(ORIGINAL, PATCHED));
  console.log('patch-ble: aplicado');
} else {
  console.error('patch-ble: no se encontró el código esperado; revisa la versión de la librería');
  process.exit(1);
}
