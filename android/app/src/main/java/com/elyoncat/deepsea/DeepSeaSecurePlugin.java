package com.elyoncat.deepsea;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Stores the API key with an Android Keystore AES-GCM key. The ciphertext lives
 * in private SharedPreferences; the key material never leaves the keystore.
 */
@CapacitorPlugin(name = "DeepSeaSecure")
public class DeepSeaSecurePlugin extends Plugin {
    private static final String ALIAS = "deepsea_api_key";
    private static final String PREFS = "deepsea_secure";
    private static final String KEY = "apiKey";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) {
            return (SecretKey) store.getKey(ALIAS, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    @PluginMethod
    public void get(PluginCall call) {
        JSObject result = new JSObject();
        String stored = prefs().getString(KEY, null);
        if (stored == null) {
            result.put("value", null);
            call.resolve(result);
            return;
        }
        try {
            byte[] combined = Base64.decode(stored, Base64.NO_WRAP);
            byte[] iv = new byte[IV_BYTES];
            byte[] ciphertext = new byte[combined.length - IV_BYTES];
            System.arraycopy(combined, 0, iv, 0, IV_BYTES);
            System.arraycopy(combined, IV_BYTES, ciphertext, 0, ciphertext.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
            result.put("value", new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not decrypt the stored key", error);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String value = call.getString("value");
        if (value == null) {
            call.reject("value is required");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] combined = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, combined, 0, iv.length);
            System.arraycopy(ciphertext, 0, combined, iv.length, ciphertext.length);
            prefs().edit().putString(KEY, Base64.encodeToString(combined, Base64.NO_WRAP)).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not encrypt the key", error);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        prefs().edit().remove(KEY).apply();
        call.resolve();
    }
}
