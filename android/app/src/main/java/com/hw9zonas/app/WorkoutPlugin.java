package com.hw9zonas.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;

// Puente con Android: servicio en primer plano del entrenamiento y avisos por voz.
@CapacitorPlugin(name = "Workout")
public class WorkoutPlugin extends Plugin {

    // Uso "guía de navegación": mientras suena, Android baja el volumen de la
    // música de otras apps en vez de pausarla, y la voz se oye por encima.
    private static final AudioAttributes VOICE_ATTRIBUTES = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build();

    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private TextToSpeech tts;
    private volatile boolean ttsReady = false;
    private volatile String lastUtterance = "";
    private int utteranceCount = 0;

    @Override
    public void load() {
        Context context = getContext();
        audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(VOICE_ATTRIBUTES)
                .build();
        }
        tts = new TextToSpeech(context, status -> {
            if (status != TextToSpeech.SUCCESS) return;
            tts.setLanguage(new Locale("es", "ES"));
            tts.setAudioAttributes(VOICE_ATTRIBUTES);
            tts.setOnUtteranceProgressListener(
                new UtteranceProgressListener() {
                    @Override
                    public void onStart(String utteranceId) {}

                    @Override
                    public void onDone(String utteranceId) {
                        releaseFocus(utteranceId);
                    }

                    @Override
                    public void onError(String utteranceId) {
                        releaseFocus(utteranceId);
                    }

                    @Override
                    public void onStop(String utteranceId, boolean interrupted) {
                        releaseFocus(utteranceId);
                    }
                }
            );
            ttsReady = true;
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
        abandonFocus();
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (!ttsReady || text.isEmpty()) {
            call.reject("Voz no disponible");
            return;
        }
        String id = "hw9-" + (++utteranceCount);
        lastUtterance = id;
        requestFocus();
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id);
        call.resolve();
    }

    private void requestFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioManager.requestAudioFocus(focusRequest);
        } else {
            audioManager.requestAudioFocus(null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
        }
    }

    // Si un aviso nuevo interrumpió a este, el foco sigue haciendo falta.
    private void releaseFocus(String utteranceId) {
        if (utteranceId.equals(lastUtterance)) abandonFocus();
    }

    private void abandonFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioManager.abandonAudioFocusRequest(focusRequest);
        } else {
            audioManager.abandonAudioFocus(null);
        }
    }

    @PluginMethod
    public void start(PluginCall call) {
        Context context = getContext();
        // La notificación es opcional: el servicio funciona aunque se deniegue.
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 0);
        }
        try {
            ContextCompat.startForegroundService(context, new Intent(context, WorkoutService.class));
            call.resolve();
        } catch (RuntimeException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Context context = getContext();
        context.stopService(new Intent(context, WorkoutService.class));
        call.resolve();
    }
}
