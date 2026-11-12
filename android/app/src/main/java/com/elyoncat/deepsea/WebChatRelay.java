package com.elyoncat.deepsea;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import org.json.JSONObject;

/**
 * 网页账号模式的 Android 侧中继。
 *
 * 桌面端是「主进程 executeJavaScript 遥控隐藏 BrowserWindow」；Android 这边
 * 网页是一个独立 Activity 里的 WebView，跨 Activity 拿不到引用，所以用一个
 * 静态单例把它挂出来：WebChatActivity 在创建/销毁时登记与注销，
 * DeepSeaWebChatPlugin 通过这里调 send / state。
 *
 * 生命周期上的取舍：Activity 被销毁（用户按返回）后引用置空，此时 send 会
 * 明确返回 no-window，而不是静默失败。登录态本身在 CookieManager 里，
 * 下次打开网页窗仍然是登录的。
 */
public final class WebChatRelay {
    private static WebView webView;
    private static final Handler main = new Handler(Looper.getMainLooper());

    private WebChatRelay() {}

    /** WebChatActivity 在 onCreate 里登记。 */
    public static void attach(WebView view) {
        webView = view;
    }

    /** WebChatActivity 在 onDestroy 里注销。 */
    public static void detach(WebView view) {
        if (webView == view) webView = null;
    }

        /** 当前登记的 WebView（采集 token 用）。 */
    public static WebView current() {
        return webView;
    }

    public static boolean available() {
        return webView != null;
    }

    /** 把一段话交给页面里的中继脚本发送；回调在主线程。 */
    public static void send(String text, final Callback callback) {
        final WebView view = webView;
        if (view == null) {
            callback.done(false, "no-window");
            return;
        }
        String script = "(function(){var r=window.__deepseaRelay;"
            + "if(!r) return 'no-relay';"
            + "if(typeof r.send!=='function') return 'no-send';"
            + "return r.send(" + JSONObject.quote(text) + ")===true?'ok':'failed';})();";
        main.post(() -> view.evaluateJavascript(script, value -> {
            String raw = value == null ? "" : value.replace("\"", "");
            if ("ok".equals(raw)) callback.done(true, null);
            else if ("no-relay".equals(raw) || "no-send".equals(raw)) callback.done(false, "网页还没准备好，稍等一下再发");
            else callback.done(false, "没找到对话框，先在这个窗口里打开一段对话");
        }));
    }

    /** 读当前回复进度；网页窗不在就回调 null。 */
    public static void state(final StateCallback callback) {
        final WebView view = webView;
        if (view == null) {
            callback.done(null);
            return;
        }
        String script = "(function(){var r=window.__deepseaRelay;"
            + "if(!r||typeof r.getState!=='function') return null;"
            + "return JSON.stringify(r.getState());})();";
        main.post(() -> view.evaluateJavascript(script, value -> {
            if (value == null || "null".equals(value)) {
                callback.done(null);
                return;
            }
            // evaluateJavascript 返回的是 JSON 字符串字面量，先脱一层引号再解析。
            String json = value;
            if (json.startsWith("\"") && json.endsWith("\"")) {
                json = json.substring(1, json.length() - 1).replace("\\\"", "\"").replace("\\\\", "\\");
            }
            try {
                org.json.JSONObject obj = new org.json.JSONObject(json);
                State state = new State();
                state.busy = obj.optBoolean("busy", false);
                state.text = obj.optString("text", "");
                state.done = obj.optBoolean("done", false);
                state.error = obj.has("error") ? obj.optString("error", "") : null;
                callback.done(state);
            } catch (Exception error) {
                callback.done(null);
            }
        }));
    }

    /** 写入人设/记忆前缀。 */
    public static void setContext(String text) {
        final WebView view = webView;
        if (view == null) return;
        String script = "(function(){var r=window.__deepseaRelay;"
            + "if(r&&typeof r.setContext==='function') r.setContext(" + JSONObject.quote(text) + ");})();";
        main.post(() -> view.evaluateJavascript(script, null));
    }

    public interface Callback {
        void done(boolean ok, String error);
    }

    public interface StateCallback {
        void done(State state);
    }

    public static final class State {
        public boolean busy;
        public String text = "";
        public boolean done;
        public String error;
    }
}