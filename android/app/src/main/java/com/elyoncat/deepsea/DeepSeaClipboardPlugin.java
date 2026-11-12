package com.elyoncat.deepsea;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 剪贴板读写（给 App 内自绘的文本选择工具条用）。
 *
 * 为什么需要它：系统那条文本选择工具条在某些 ROM 上会渲染成整块白屏盖住界面
 * （见 DeepSeaWebView 的注释），所以我们在主界面把它压掉，改由网页侧自绘工具条
 * 提供「复制 / 剪切 / 粘贴 / 全选」。
 * 其中「粘贴」在网页里做不到：document.execCommand('paste') 被浏览器禁用，
 * navigator.clipboard.readText() 在 Android WebView 里也不可靠。
 * 于是走原生 ClipboardManager 读一次，把文本交给网页插进输入框。
 */
@CapacitorPlugin(name = "DeepSeaClipboard")
public class DeepSeaClipboardPlugin extends Plugin {

    private ClipboardManager manager() {
        return (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
    }

    @PluginMethod
    public void read(PluginCall call) {
        String text = "";
        try {
            ClipboardManager clipboard = manager();
            if (clipboard != null && clipboard.hasPrimaryClip()) {
                ClipData clip = clipboard.getPrimaryClip();
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence value = clip.getItemAt(0).coerceToText(getContext());
                    if (value != null) text = value.toString();
                }
            }
        } catch (Exception error) {
            call.reject("Could not read the clipboard", error);
            return;
        }
        JSObject result = new JSObject();
        result.put("text", text);
        call.resolve(result);
    }

    @PluginMethod
    public void write(PluginCall call) {
        String text = call.getString("text");
        if (text == null) {
            call.reject("text is required");
            return;
        }
        try {
            ClipboardManager clipboard = manager();
            if (clipboard == null) {
                call.reject("No clipboard service");
                return;
            }
            clipboard.setPrimaryClip(ClipData.newPlainText("deepsea", text));
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not write the clipboard", error);
        }
    }
}
