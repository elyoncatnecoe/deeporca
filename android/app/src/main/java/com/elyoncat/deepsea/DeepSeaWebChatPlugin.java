package com.elyoncat.deepsea;

import android.content.Intent;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 网页账号模式的桥。
 *
 * 两条路：
 *   - webApi*：纯 HTTP（登录一次后，网页窗关掉也能聊）；
 *   - launch / send / state / setContext：DOM 遥控（需要网页窗开着），作后备。
 *
 * 渲染层优先走 webApi*，拿不到登录态才退回 DOM 遥控。
 */
@CapacitorPlugin(name = "DeepSeaWebChat")
public class DeepSeaWebChatPlugin extends Plugin {

    /* ---------------- 网页窗（登录与 DOM 遥控都要用） ---------------- */

    @PluginMethod
    public void launch(PluginCall call) {
        String url = call.getString("url", "https://chat.deepseek.com/");
        String css = call.getString("css", "");
        String js = call.getString("js", "");
        Intent intent = new Intent(getContext(), WebChatActivity.class);
        intent.putExtra("url", url);
        intent.putExtra("css", css);
        intent.putExtra("js", js);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /** 网页窗是否已经开着。 */
    @PluginMethod
    public void isOpen(PluginCall call) {
        JSObject result = new JSObject();
        result.put("open", WebChatRelay.available());
        call.resolve(result);
    }

    /* ---------------- 纯 HTTP 模式 ---------------- */

    /** 本机有没有可用的网页登录态。 */
    @PluginMethod
    public void webApiHasSession(PluginCall call) {
        JSObject result = new JSObject();
        result.put("hasSession", WebApiClient.hasSession());
        call.resolve(result);
    }

    /** 从网页窗采集 token（用户登录完成后调一次）。 */
    @PluginMethod
    public void webApiCapture(PluginCall call) {
        WebApiClient.capture(WebChatRelay.current(), (ok, error) -> {
            JSObject result = new JSObject();
            result.put("ok", Boolean.TRUE.equals(ok));
            if (error != null) result.put("error", error);
            call.resolve(result);
        });
    }

    /** 忘掉登录态。 */
    @PluginMethod
    public void webApiForget(PluginCall call) {
        WebApiClient.forget();
        call.resolve();
    }

    /** 发一条消息（纯 HTTP，不依赖网页窗开着）。 */
    @PluginMethod
    public void webApiSend(PluginCall call) {
        String conversationKey = call.getString("conversationKey", "default");
        String prompt = call.getString("prompt", "");
        String systemPrompt = call.getString("systemPrompt", "");
        boolean thinking = Boolean.TRUE.equals(call.getBoolean("thinking", false));
        java.util.List<String> refFileIds = new java.util.ArrayList<>();
        JSArray refs = call.getArray("refFileIds");
        if (refs != null) {
            for (int i = 0; i < refs.length(); i++) {
                String id = refs.optString(i, "");
                if (id != null && !id.isEmpty()) refFileIds.add(id);
            }
        }
        WebApiClient.send(conversationKey, prompt, systemPrompt, thinking, refFileIds, (reply, error) -> {
            JSObject result = new JSObject();
            if (error != null) {
                result.put("ok", false);
                result.put("error", error);
            } else {
                result.put("ok", true);
                result.put("text", reply == null || reply.text == null ? "" : reply.text);
                result.put("reasoning", reply == null || reply.reasoning == null ? "" : reply.reasoning);
            }
            call.resolve(result);
        });
    }

    /** 上传一个附件（data URL）到网页账号，返回 file_id。 */
    @PluginMethod
    public void webApiUpload(PluginCall call) {
        String dataUrl = call.getString("dataUrl", "");
        String filename = call.getString("filename", "image.png");
        if (dataUrl == null || dataUrl.isEmpty()) {
            JSObject result = new JSObject();
            result.put("ok", false);
            result.put("error", "附件为空");
            call.resolve(result);
            return;
        }
        WebApiClient.upload(dataUrl, filename, (fileId, error) -> {
            JSObject result = new JSObject();
            if (error != null) {
                result.put("ok", false);
                result.put("error", error);
            } else {
                result.put("ok", true);
                result.put("fileId", fileId == null ? "" : fileId);
            }
            call.resolve(result);
        });
    }

    /**
     * 取消正在跑的那一轮发送（用户按了「停止」）。
     *
     * 渲染层也会同时松手，但只松手不掐连接的话，Java 这边会一直读到
     * 180 秒读超时；单线程池还会把下一条消息一起堵在后面。
     */
    @PluginMethod
    public void webApiAbort(PluginCall call) {
        WebApiClient.abortCurrent();
        call.resolve();
    }

    /* ---------------- DOM 遥控（后备） ---------------- */

    @PluginMethod
    public void send(PluginCall call) {
        String text = call.getString("text", "");
        WebChatRelay.send(text, (ok, error) -> {
            JSObject result = new JSObject();
            result.put("ok", Boolean.TRUE.equals(ok));
            if (!Boolean.TRUE.equals(ok) && error != null) result.put("error", error);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void state(PluginCall call) {
        WebChatRelay.state(state -> {
            if (state == null) { call.resolve(); return; }
            JSObject result = new JSObject();
            result.put("busy", state.busy);
            result.put("text", state.text);
            result.put("done", state.done);
            if (state.error != null) result.put("error", state.error);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void setContext(PluginCall call) {
        String text = call.getString("text", "");
        WebChatRelay.setContext(text);
        /*
         * 空人设 = 助手被关掉了：把 HTTP 链路那份「已经拼过」的标记一起清掉。
         *
         * 不清的话，用户重新打开同一个助手、人设一个字都没变，WebApiClient 的去重
         * 会认为 A 已经拼过而永远跳过。只清标记，网页线程 / 会话 id / 历史都不动。
         */
        if (text.isEmpty()) WebApiClient.clearPersonaCache();
        call.resolve();
    }
}