package com.elyoncat.deepsea;

import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.GZIPInputStream;

/**
 * 第三方 OpenAI 兼容接口的原生 HTTP 通道。
 *
 * 为什么必须搬到原生：App 的界面是 WebView，网页里发 fetch 受同源策略约束。
 * 第三方中转站 / 自建端点绝大多数不会回 Access-Control-Allow-Origin，浏览器
 * 直接拦掉响应，界面只能看到一句 `fetch failed`。原生 HttpURLConnection 没有
 * CORS 这回事，所以把请求挪到这里，WebView 只负责跟插件说话。
 *
 * 和 WebApiClient 的分工：那边服务 chat.deepseek.com 的网页账号（要带 cookie、
 * 要算 PoW）；这里只做通用的 OpenAI 兼容转发，**不读 cookie、不加 Origin**，
 * 请求头完全由调用方给，避免把网页账号的登录态误带到第三方端点上去。
 *
 * 线程：所有网络 IO 都在这条单线程池里跑，插件方法本身不能阻塞 —— 主线程一卡
 * WebView 就掉帧，而 HttpURLConnection 的 read 可能阻塞几十秒。
 */
@CapacitorPlugin(name = "DeepSeaHttp")
public class DeepSeaHttpPlugin extends Plugin {

    /** 默认超时 120 秒：推理模型的首 token 有时候确实很慢，太短会误杀。 */
    private static final int DEFAULT_TIMEOUT_MS = 120000;

    /** 用户主动停止时的错误文案。和 Electron 主进程的 `error: 'aborted'` 保持一致，
     *  JS 侧 net.ts 靠 /abort/i 认出这是「用户取消」而不是网络故障。 */
    private static final String ABORTED_MESSAGE = "aborted";

    /** 建连单独限 15 秒：DNS / TLS / 代理卡死时别把整个 timeout 都耗在 connect 上。 */
    private static final int MAX_CONNECT_TIMEOUT_MS = 15000;

    /**
     * 网络请求专用线程。
     *
     * 和 WebApiClient 一样用 newSingleThreadExecutor：网络读写会阻塞，绝不能碰
     * 主线程；单线程也保证同一时刻只有一条请求在跑，行为简单、可预期。
     * 代价是长流会一直占着它，所以 streamAbort 必须能把阻塞中的 read 打断。
     */
    private static final ExecutorService HTTP_POOL = Executors.newSingleThreadExecutor();

    /**
     * 活跃的流：streamId -> 取消状态。
     *
     * streamAbort 从这里拿到连接并 disconnect()；disconnect 会让卡在 read 上的
     * 线程立刻抛异常醒过来。ConcurrentHashMap 是因为 streamAbort 在桥线程写、
     * 工作线程在结束时删，两边不能抢出并发问题。
     */
    private static final ConcurrentHashMap<String, StreamTask> STREAMS = new ConcurrentHashMap<>();

    /** 一条流的取消状态。aborted 必须是 volatile：abort 在桥线程写，读循环在工作线程看。 */
    private static final class StreamTask {
        final String streamId;
        volatile HttpURLConnection connection;
        volatile boolean aborted;

        StreamTask(String streamId) {
            this.streamId = streamId;
        }
    }

    /** 解析好的请求参数。先在桥线程解析完再交给工作线程，避免跨线程碰 PluginCall。 */
    private static final class RequestSpec {
        String url;
        String method;
        JSObject headers;
        String body;
        int timeoutMs;
    }

    /** 非流式请求的完整结果。 */
    private static final class ResponseData {
        int status;
        Map<String, List<String>> headers;
        String text;
        /** 二进制请求专用：Base64.NO_WRAP 编码的响应字节。 */
        String base64;
        /** 二进制请求专用：响应 Content-Type（已去掉 charset 参数）。 */
        String mime;
    }

    /* ---------------- 非流式请求 ---------------- */

    @PluginMethod
    public void request(PluginCall call) {
        final RequestSpec spec;
        try {
            spec = readSpec(call);
        } catch (Exception error) {
            reject(call, message(error));
            return;
        }
        HTTP_POOL.execute(() -> {
            try {
                ResponseData response = execute(spec);
                JSObject result = new JSObject();
                result.put("status", response.status);
                result.put("headers", headerObject(response.headers));
                result.put("text", response.text);
                resolve(call, result);
            } catch (Exception error) {
                reject(call, message(error));
            }
        });
    }

    /* ---------------- 非流式二进制请求 ---------------- */

    /**
     * TTS 音频 / 生图外链的二进制下载。
     *
     * 返回 base64 而不是把字节塞进 JS 数组：Capacitor 的 JSObject 对 byte[] 支持
     * 不稳定，base64 字符串跨桥最稳；渲染层拼回 data URL 给 <audio>/<img>。
     */
    @PluginMethod
    public void requestBinary(PluginCall call) {
        final RequestSpec spec;
        try {
            spec = readSpec(call);
        } catch (Exception error) {
            reject(call, message(error));
            return;
        }
        HTTP_POOL.execute(() -> {
            try {
                ResponseData response = executeBinary(spec);
                JSObject result = new JSObject();
                result.put("status", response.status);
                result.put("headers", headerObject(response.headers));
                result.put("base64", response.base64);
                result.put("mime", response.mime);
                if (response.text != null) result.put("text", response.text);
                resolve(call, result);
            } catch (Exception error) {
                reject(call, message(error));
            }
        });
    }

    /* ---------------- 流式请求 ---------------- */

    @PluginMethod
    public void streamStart(PluginCall call) {
        final RequestSpec spec;
        try {
            spec = readSpec(call);
        } catch (Exception error) {
            reject(call, message(error));
            return;
        }
        String requested = call.getString("streamId");
        final String streamId = (requested == null || requested.isEmpty())
            ? UUID.randomUUID().toString()
            : requested;
        final StreamTask task = new StreamTask(streamId);
        // 同一个 id 还在跑就先断掉旧的，避免两条流抢同一个事件通道。
        StreamTask previous = STREAMS.put(streamId, task);
        if (previous != null) abortTask(previous);

        // 先把 streamId 交回 JS，再开始跑：JS 侧可能要靠这个 id 去过滤事件。
        // resolve 必须在主线程，而且 execute 必须排在 resolve 之后 —— 否则工作线程
        // 可能抢在返回值之前把第一批 httpChunk 发出去，JS 还没挂好监听就丢了。
        runOnMain(() -> {
            JSObject result = new JSObject();
            result.put("streamId", streamId);
            call.resolve(result);
            HTTP_POOL.execute(() -> runStream(task, spec));
        });
    }

    @PluginMethod
    public void streamAbort(PluginCall call) {
        String streamId = call.getString("streamId");
        if (streamId == null || streamId.isEmpty()) {
            reject(call, "streamId 不能为空");
            return;
        }
        StreamTask task = STREAMS.get(streamId);
        if (task != null) abortTask(task);
        resolve(call, null);
    }

    /** 掐断一条流：先置标记再断连接，两边一起才断得干净。 */
    private static void abortTask(StreamTask task) {
        task.aborted = true;
        HttpURLConnection connection = task.connection;
        if (connection != null) {
            try {
                connection.disconnect();
            } catch (Exception ignored) {
                // 已经关掉的连接再断一次会抛，忽略即可。
            }
        }
    }

    /* ---------------- 请求执行 ---------------- */

    private RequestSpec readSpec(PluginCall call) throws Exception {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) throw new Exception("url 不能为空");
        RequestSpec spec = new RequestSpec();
        spec.url = url.trim();
        String method = call.getString("method", "GET");
        spec.method = (method == null || method.trim().isEmpty())
            ? "GET"
            : method.trim().toUpperCase(Locale.ROOT);
        spec.headers = call.getObject("headers");
        spec.body = call.getString("body");
        spec.timeoutMs = readTimeout(call);
        return spec;
    }

    /** timeoutMs 是 JS 的 number，桥接过来可能是 Integer / Long / Double，统一按数字读。 */
    private static int readTimeout(PluginCall call) {
        Object raw = call.getData().opt("timeoutMs");
        if (!(raw instanceof Number)) return DEFAULT_TIMEOUT_MS;
        long value = ((Number) raw).longValue();
        if (value <= 0) return DEFAULT_TIMEOUT_MS;
        return (int) Math.min(value, Integer.MAX_VALUE);
    }

    private static ResponseData execute(RequestSpec spec) throws Exception {
        HttpURLConnection connection = open(spec);
        try {
            writeBody(connection, spec);
            ResponseData result = new ResponseData();
            result.status = connection.getResponseCode();
            result.headers = connection.getHeaderFields();
            InputStream input = responseStream(connection, result.status);
            result.text = readText(input, connection.getHeaderField("Content-Encoding"));
            return result;
        } finally {
            try {
                connection.disconnect();
            } catch (Exception ignored) {
                // 收尾失败无所谓，连接已经不用了。
            }
        }
    }

    /** 和 execute 同一套连接逻辑，只是把响应读成字节并 base64 编码。 */
    private static ResponseData executeBinary(RequestSpec spec) throws Exception {
        HttpURLConnection connection = open(spec);
        try {
            writeBody(connection, spec);
            ResponseData result = new ResponseData();
            result.status = connection.getResponseCode();
            result.headers = connection.getHeaderFields();
            String contentType = connection.getContentType();
            result.mime = contentType == null ? "" : contentType.split(";")[0].trim().toLowerCase(Locale.ROOT);
            InputStream input = responseStream(connection, result.status);
            byte[] bytes = readBytes(input, connection.getHeaderField("Content-Encoding"));
            result.base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
            // 错误响应/JSON 响应才需要文本；音频字节不要按 UTF-8 解，避免无意义开销。
            if (result.mime.contains("json") || result.mime.startsWith("text/")) {
                result.text = new String(bytes, StandardCharsets.UTF_8);
            }
            return result;
        } finally {
            try {
                connection.disconnect();
            } catch (Exception ignored) {
                // 已断开
            }
        }
    }

    /** 建连接并原样铺请求头。 */
    private static HttpURLConnection open(RequestSpec spec) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(spec.url).openConnection();
        connection.setRequestMethod(spec.method);
        connection.setConnectTimeout(Math.min(MAX_CONNECT_TIMEOUT_MS, spec.timeoutMs));
        connection.setReadTimeout(spec.timeoutMs);
        connection.setUseCaches(false);
        connection.setDoInput(true);
        // 请求头原样透传：Authorization / Content-Type / Accept 一个都不能丢。
        // 但绝不额外塞 Origin / Cookie —— 原生请求没有同源概念，也不该带网页登录态。
        JSObject headers = spec.headers;
        if (headers != null) {
            Iterator<String> names = headers.keys();
            while (names.hasNext()) {
                String name = names.next();
                Object raw = headers.opt(name);
                if (raw == null || raw == JSONObject.NULL) continue;
                connection.setRequestProperty(name, String.valueOf(raw));
            }
        }
        // POST/PUT 即使 body 为空也置上 doOutput，和网页 fetch 的语义保持一致；
        // 有 body 的方法（DELETE/PATCH 等）同样需要它才能 getOutputStream()。
        boolean methodWritesBody = "POST".equals(spec.method) || "PUT".equals(spec.method);
        if (spec.body != null || methodWritesBody) connection.setDoOutput(true);
        return connection;
    }

    /** body 一律按 UTF-8 写；没有 body 就什么都不写。 */
    private static void writeBody(HttpURLConnection connection, RequestSpec spec) throws Exception {
        if (spec.body == null) return;
        try (OutputStream output = connection.getOutputStream()) {
            output.write(spec.body.getBytes(StandardCharsets.UTF_8));
            output.flush();
        }
    }

    /**
     * 挑正确的响应流。
     *
     * 4xx/5xx 的正文在 getErrorStream() 里，不读它的话错误 JSON 就丢了，
     * JS 侧只能拿到一个冷冰冰的状态码，没法告诉用户到底哪里填错了。
     */
    private static InputStream responseStream(HttpURLConnection connection, int status) throws Exception {
        if (status >= 400) return connection.getErrorStream();
        try {
            return connection.getInputStream();
        } catch (Exception error) {
            // 个别 3xx / 非标准响应也会走到这里，能拿到 error stream 就先用它。
            InputStream fallback = connection.getErrorStream();
            if (fallback != null) return fallback;
            throw error;
        }
    }

    /* ---------------- 流式读取 ---------------- */

    private void runStream(StreamTask task, RequestSpec spec) {
        HttpURLConnection connection = null;
        try {
            if (task.aborted) { emitError(task, ABORTED_MESSAGE); return; }
            connection = open(spec);
            task.connection = connection;
            // open 期间可能已经被 abort 了：连接刚建好也要立刻收掉，
            // 否则下面的 getResponseCode() 还能卡很久。
            if (task.aborted) { emitError(task, ABORTED_MESSAGE); return; }
            writeBody(connection, spec);
            if (task.aborted) { emitError(task, ABORTED_MESSAGE); return; }

            int status = connection.getResponseCode();
            Map<String, List<String>> headers = connection.getHeaderFields();
            // 先单独发一条 httpStatus，再开始发正文：SSE 消费方必须在把 chunk
            // 喂进解析器之前就知道这一路是 200 的流还是 400 的 JSON 错误。
            // 非 2xx 也照发，正文照样从 error stream 里读出来发完。
            JSObject statusEvent = new JSObject();
            statusEvent.put("streamId", task.streamId);
            statusEvent.put("status", status);
            statusEvent.put("headers", headerObject(headers));
            notifyListeners("httpStatus", statusEvent);

            InputStream input = maybeGzip(
                responseStream(connection, status),
                connection.getHeaderField("Content-Encoding")
            );
            if (input != null) {
                // 用 InputStreamReader + char[] 按「字符」读，不用字节数组自己拼。
                // InputStreamReader 内部会处理跨缓冲区的多字节序列，中文/emoji 不会
                // 被切成半个字符 —— 契约要求的就是这个。
                try (InputStreamReader reader = new InputStreamReader(input, StandardCharsets.UTF_8)) {
                    char[] buffer = new char[4096];
                    int read;
                    while ((read = reader.read(buffer)) != -1) {
                        // disconnect() 不保证立刻打断已经被缓冲的数据，每读一块
                        // 再看一眼取消标记，用户按「停止」才能真的马上停下来。
                        if (task.aborted) { emitError(task, ABORTED_MESSAGE); return; }
                        JSObject chunk = new JSObject();
                        chunk.put("streamId", task.streamId);
                        chunk.put("chunk", new String(buffer, 0, read));
                        // notifyListeners 内部会把结果 post 回 WebView 线程
                        // （MessageHandler.sendResponseMessage -> webView.post），
                        // 所以工作线程直接发事件是安全的。
                        notifyListeners("httpChunk", chunk);
                    }
                }
            }
            if (task.aborted) { emitError(task, ABORTED_MESSAGE); return; }
            // 不管 2xx 还是 4xx/5xx，正文都先发完，最后一定得把状态码/响应头交给 JS。
            // 少了这个 httpEnd，上层 Promise 会一直挂着等不到终点。
            JSObject end = new JSObject();
            end.put("streamId", task.streamId);
            end.put("status", status);
            end.put("headers", headerObject(headers));
            notifyListeners("httpEnd", end);
        } catch (Exception error) {
            // 主动 abort 时 disconnect() 也会让 read 抛异常：这不是网络故障，
            // 但 JS 侧要收到一个「终点」才会 settle。和 Electron 主进程保持一致，
            // 统一发 message="aborted" 的 httpError，让上层按「用户取消」收尾。
            emitError(task, task.aborted ? ABORTED_MESSAGE : message(error));
        } finally {
            if (connection != null) {
                try {
                    connection.disconnect();
                } catch (Exception ignored) {
                    // 收尾失败无所谓。
                }
            }
            task.connection = null;
            // 两参 remove：如果同 id 已经起了新流，别把新的那条误删掉。
            STREAMS.remove(task.streamId, task);
        }
    }

    /** 发一条终止型错误事件。abort 与真正的网络异常都走这里，保证每条流一定有终点。 */
    private void emitError(StreamTask task, String text) {
        JSObject failure = new JSObject();
        failure.put("streamId", task.streamId);
        failure.put("message", text);
        notifyListeners("httpError", failure);
    }

    /* ---------------- 工具 ---------------- */

    private static String readText(InputStream raw, String contentEncoding) throws Exception {
        if (raw == null) return "";
        InputStream input = maybeGzip(raw, contentEncoding);
        StringBuilder text = new StringBuilder();
        try (InputStreamReader reader = new InputStreamReader(input, StandardCharsets.UTF_8)) {
            char[] buffer = new char[4096];
            int read;
            while ((read = reader.read(buffer)) != -1) {
                text.append(buffer, 0, read);
            }
        }
        return text.toString();
    }

    /** 二进制读取：gzip 解压后按字节收，最后交给 Base64 编码。 */
    private static byte[] readBytes(InputStream raw, String contentEncoding) throws Exception {
        if (raw == null) return new byte[0];
        InputStream input = maybeGzip(raw, contentEncoding);
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        } finally {
            try {
                input.close();
            } catch (Exception ignored) {
                // 关闭失败不影响已读到的字节
            }
        }
    }

    /**
     * 服务器说 gzip 就自己解。
     *
     * Android 只有在它自己加 Accept-Encoding 时才会自动解压；调用方显式传了
     * gzip 的情况下必须手解，否则拿到的是一堆乱码。
     */
    private static InputStream maybeGzip(InputStream input, String contentEncoding) throws Exception {
        if (input == null) return null;
        if (contentEncoding != null && contentEncoding.toLowerCase(Locale.ROOT).contains("gzip")) {
            return new GZIPInputStream(input);
        }
        return input;
    }

    /** Map<String,List<String>> -> Record<string,string>（同名多值用逗号合并）。 */
    private static JSObject headerObject(Map<String, List<String>> fields) {
        JSObject headers = new JSObject();
        if (fields == null) return headers;
        for (Map.Entry<String, List<String>> entry : fields.entrySet()) {
            String name = entry.getKey();
            // getHeaderFields() 的第一项 key 是 null（HTTP 状态行），不是响应头。
            if (name == null) continue;
            List<String> values = entry.getValue();
            if (values == null || values.isEmpty()) continue;
            StringBuilder joined = new StringBuilder();
            for (int i = 0; i < values.size(); i++) {
                if (i > 0) joined.append(", ");
                String value = values.get(i);
                joined.append(value == null ? "" : value);
            }
            // 统一转小写：浏览器 fetch 的 Headers 和 Electron 的响应头都是小写键，
            // 上层就是按 response.headers['content-length'] 这种写法读的。
            headers.put(name.toLowerCase(Locale.ROOT), joined.toString());
        }
        return headers;
    }

    /** Capacitor 要求 resolve/reject 在主线程调。 */
    private void resolve(final PluginCall call, final JSObject data) {
        runOnMain(() -> {
            if (data == null) call.resolve();
            else call.resolve(data);
        });
    }

    private void reject(final PluginCall call, final String text) {
        runOnMain(() -> call.reject(text));
    }

    private void runOnMain(Runnable action) {
        try {
            if (getActivity() != null) {
                getActivity().runOnUiThread(action);
                return;
            }
        } catch (Exception ignored) {
            // Activity 已经销毁：退到主线程 Handler，别把异常留在线程池里。
        }
        new Handler(Looper.getMainLooper()).post(action);
    }

    private static String message(Exception error) {
        if (error == null) return "网络请求失败";
        String text = error.getMessage();
        if (text == null || text.trim().isEmpty()) return error.getClass().getSimpleName();
        return text;
    }

    @Override
    protected void handleOnDestroy() {
        // 页面退出时把还挂着的连接全掐掉，别让工作线程抱着 socket 继续读。
        for (StreamTask task : STREAMS.values()) abortTask(task);
        STREAMS.clear();
        super.handleOnDestroy();
    }
}