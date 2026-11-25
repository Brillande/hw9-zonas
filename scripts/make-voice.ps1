# Genera los avisos de voz pregrabados de la versión web (public/voice/*.mp3)
# con una voz en español de Windows y ffmpeg. La web los usa cuando el ajuste
# "Sonido con la pantalla apagada" está activo; la app Android no los necesita.
#
# Uso (Windows PowerShell 5, que es el que trae System.Speech). Este archivo
# debe guardarse como UTF-8 con BOM para que PowerShell 5 lea bien los acentos:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\make-voice.ps1

Add-Type -AssemblyName System.Speech

$clips = [ordered]@{
  below        = 'Por debajo de zona uno.'
  sube         = 'Sube el ritmo.'
  baja         = 'Baja el ritmo.'
  en_objetivo  = 'En objetivo. Mantén el ritmo.'
  estas_below  = 'Estás por debajo de zona uno.'
  paso         = 'Cambio de paso.'
  calentamiento = 'Calentamiento.'
  enfriamiento = 'Enfriamiento.'
  fin          = 'Entrenamiento terminado.'
}
foreach ($n in 1..5) {
  $clips["zona$n"] = "Zona $n."
  $clips["objetivo$n"] = "Objetivo zona $n."
  $clips["estas$n"] = "Estás en zona $n."
}

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'es*' } | Select-Object -First 1
if (-not $voice) { throw 'No hay ninguna voz en español instalada en Windows.' }
$synth.SelectVoice($voice.VoiceInfo.Name)
$synth.Rate = 1
Write-Host "Voz: $($voice.VoiceInfo.Name)"

$out = Join-Path $PSScriptRoot '..\public\voice'
New-Item -ItemType Directory -Force $out | Out-Null
$wav = Join-Path $env:TEMP 'hw9-voice.wav'

# Los avisos se encadenan en un solo audio que no puede pasar de 5 s (a partir
# de ahí Chrome lo trata como música y pausa a las demás apps), así que se
# recortan los silencios de ambos extremos. Además se comprime y se sube el
# volumen para que la voz se entienda por encima de la música atenuada.
$trim = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02'
$filter = "$trim,areverse,$trim,areverse,acompressor=threshold=-20dB:ratio=4:attack=3:release=60"
$processed = Join-Path $env:TEMP 'hw9-voice-processed.wav'
$invariant = [cultureinfo]::InvariantCulture

foreach ($id in $clips.Keys) {
  $synth.SetOutputToWaveFile($wav)
  $synth.Speak($clips[$id])
  $synth.SetOutputToNull()
  & ffmpeg -y -loglevel error -i $wav -af $filter -ac 1 -ar 22050 $processed
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg falló con $id" }
  # Segundo paso: lleva el pico de cada aviso a -1 dB para que todos suenen igual de fuerte.
  $detect = (& ffmpeg -hide_banner -nostats -i $processed -af volumedetect -f null NUL 2>&1 | Out-String)
  $peak = [double]::Parse([regex]::Match($detect, 'max_volume: (-?[\d.]+) dB').Groups[1].Value, $invariant)
  $gain = (-1.0 - $peak).ToString('0.0', $invariant)
  & ffmpeg -y -loglevel error -i $processed -af "volume=${gain}dB" -ac 1 -ar 22050 -b:a 64k (Join-Path $out "$id.mp3")
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg falló con $id" }
}
Remove-Item $wav, $processed -ErrorAction SilentlyContinue
Write-Host "Generados $($clips.Count) avisos en $out"
