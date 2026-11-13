package com.elyoncat.deepsea;

import android.content.Context;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 网页账号的 HTTP 客户端（Android 侧）。
 *
 * 与桌面端 electron/deepseek-api.ts 同一套协议，目标是同一件事：
 * 登录一次之后，网页窗关掉也能聊。
 *
 * 登录态来源：
 *   - token：第一次从网页窗的 localStorage.userToken 采集，存 SharedPreferences；
 *   - Cookie：始终从 CookieManager 实时取（WAF 挑战 cookie 会变，不能缓存）。
 * PoW 在 Java 里算（见 DeepSeekPow），所以发送路径完全不依赖 WebView。
 *
 * 多轮上下文靠网页线程：每段 App 对话映射到一个 chat_session_id，并用
 * parent_message_id 续接，所以不需要把历史重放给服务端。
 */
public final class WebApiClient {
    private static final String ORIGIN = "https://chat.deepseek.com";
    private static final String COMPLETION = "/api/v0/chat/completion";
    private static final String CONTINUE = "/api/v0/chat/continue";
    private static final String RESUME = "/api/v0/chat/resume_stream";
    private static final String CHALLENGE = "/api/v0/chat/create_pow_challenge";
    private static final String SESSION_CREATE = "/api/v0/chat_session/create";
    private static final String UPLOAD = "/api/v0/file/upload_file";
    private static final String FETCH_FILES = "/api/v0/file/fetch_files";
    private static final String APP_VERSION = "2.0.0";
    private static final String PREFS = "deepsea_web_account";
    private static final String KEY_TOKEN = "token";
    /** 续写次数上限，避免 INCOMPLETE 循环把一轮挂死。 */
    private static final int MAX_CONTINUES = 20;

    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();
    private static Context appContext;

    /**
     * 正在跑的那一条连接 + 取消标记。
     *
     * 单线程池保证同时最多只有一轮在跑，所以一个静态槽位就够。
     * 用户按「停止」时先把标记置上（读循环里能看见），再把连接断开
     * （readLine 阻塞着也能立刻醒），两边一起才断得干净。
     */
    private static volatile HttpURLConnection activeConn;
    private static volatile boolean aborted;

    private WebApiClient() {}

    /** 取消正在进行的那一轮（用户按了「停止」）。没有在跑的也无害。 */
    static void abortCurrent() {
        aborted = true;
        HttpURLConnection conn = activeConn;
        if (conn != null) {
            try {
                conn.disconnect();
            } catch (Exception ignored) {
                // 已经关掉的连接再断一次会抛，忽略即可。
            }
        }
    }

    public static void init(Context context) {
        appContext = context.getApplicationContext();
        loadThreads();
    }

    public interface Callback<T> { void done(T value, String error); }

    /* ---------------- 登录态 ---------------- */

    static boolean hasSession() {
        return token() != null;
    }

    private static String token() {
        if (appContext == null) return null;
        String value = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null);
        return (value == null || value.isEmpty()) ? null : value;
    }

    /**
     * 从网页窗采集 token。
     *
     * evaluateJavascript 必须在 UI 线程调：插件方法跑在别的线程，直接调会抛异常，
     * 所以先 post 回主线程再执行。
     */
    static void capture(final WebView view, final Callback<Boolean> done) {
        if (view == null) { done.done(false, "网页窗还没打开"); return; }
        view.post(() -> view.evaluateJavascript(READ_TOKEN_JS, raw -> {
            final String found = unquote(raw);
            if (found == null || found.isEmpty()) {
                done.done(false, "还没登录：页面里没有 userToken");
                return;
            }
            if (appContext != null) {
                appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_TOKEN, found).apply();
            }
            done.done(true, null);
        }));
    }

    static void forget() {
        if (appContext != null) {
            appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_TOKEN).apply();
        }
        THREADS.clear();
        saveThreads();
    }

    private static final String READ_TOKEN_JS = "(() => { try { var raw = window.localStorage.getItem('userToken');"
        + " if (!raw) return null; var o = JSON.parse(raw); return (o && o.value) ? o.value : null; } catch (e) { return null; } })()";

    /* ---------------- App 对话 到 网页线程 ---------------- */

    private static final class WebThread {
        String sid;
        Long mid;
        /** 已经拼进首轮 prompt 的人设；内容没变就不再重拼。 */
        String persona = "";
    }

    private static final Map<String, WebThread> THREADS = new ConcurrentHashMap<>();

    private static void loadThreads() {
        if (appContext == null) return;
        String raw = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("threads", null);
        if (raw == null || raw.isEmpty()) return;
        try {
            JSONObject root = new JSONObject(raw);
            Iterator<String> keys = root.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                JSONObject item = root.optJSONObject(key);
                if (item == null) continue;
                WebThread thread = new WebThread();
                thread.sid = item.optString("sid", "");
                thread.mid = item.isNull("mid") ? null : item.optLong("mid");
                thread.persona = item.optString("persona", "");
                if (!thread.sid.isEmpty()) THREADS.put(key, thread);
            }
        } catch (Exception ignored) {
            // 存档读坏了就从头开始，不影响功能。
        }
    }

    private static void saveThreads() {
        if (appContext == null) return;
        try {
            JSONObject root = new JSONObject();
            for (Map.Entry<String, WebThread> entry : THREADS.entrySet()) {
                JSONObject item = new JSONObject();
                item.put("sid", entry.getValue().sid);
                item.put("mid", entry.getValue().mid == null ? JSONObject.NULL : entry.getValue().mid);
                item.put("persona", entry.getValue().persona == null ? "" : entry.getValue().persona);
                root.put(entry.getKey(), item);
            }
            appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString("threads", root.toString()).apply();
        } catch (Exception ignored) {
            /* 存不下就只活在本进程内存里 */
        }
    }

    /** App 里删掉一段对话时，把它的网页线程映射一起清掉。 */
    static void forgetThread(String key) {
        THREADS.remove(key);
        saveThreads();
    }

    /**
     * 把所有线程「这一版人设已经拼过」的标记清掉（并落盘）。
     *
     * 助手被关掉时调用：那一刻上层推下来的是空人设，不注入是对的，但缓存必须一起清。
     * 否则用户再打开同一个助手、人设一个字都没变，去重会认为「A 已经拼过」而永远跳过，
     * 网页那边就一直用关掉之前的旧设定说话。
     *
     * 只动 persona 字段：sid / mid / 历史消息一律保留 —— 清标记不等于撤回旧消息，
     * 已经发进网页会话里的设定本来就撤不回来。
     * 与 Electron 侧 electron/deepseek-api.ts 的 clearPersonaCache() 逐条对应。
     */
    static void clearPersonaCache() {
        boolean changed = false;
        for (WebThread thread : THREADS.values()) {
            if (thread.persona == null || thread.persona.isEmpty()) continue;
            thread.persona = "";
            changed = true;
        }
        if (changed) saveThreads();
    }

    /* ---------------- 发消息 ---------------- */

    /** 一次回复：正文加思考过程。 */
    public static final class Reply {
        public String text = "";
        public String reasoning = "";
    }

    static void send(final String conversationKey, final String prompt,
                     final String systemPrompt, final boolean thinking,
                     final List<String> refFileIds,
                     final Callback<Reply> done) {
        final String currentToken = token();
        if (currentToken == null) { done.done(null, "还没登录网页账号"); return; }
        final String key = conversationKey == null || conversationKey.isEmpty() ? "default" : conversationKey;
        POOL.execute(() -> {
            aborted = false;
            try {
                done.done(doSend(key, currentToken, prompt, systemPrompt, thinking, refFileIds), null);
            } catch (Exception error) {
                String message = error.getMessage();
                done.done(null, message == null || message.isEmpty() ? "网页接口出错" : message);
            } finally {
                activeConn = null;
                aborted = false;
            }
        });
    }

    private static Reply doSend(String key, String token, String prompt, String systemPrompt, boolean thinking,
                                List<String> refFileIds)
        throws Exception {
        WebThread thread = THREADS.get(key);
        if (thread == null) {
            thread = new WebThread();
            thread.sid = createSession(token);
            THREADS.put(key, thread);
            // 立刻落盘：这一轮可能超时、失败，或者进程被杀。映射丢了下一轮就会
            // 重新建会话、重新拼人设——用户看到的就是「同一段对话又被灌了一遍设定」。
            saveThreads();
        }

        // 人设只在这一段对话的第一轮（或人设/记忆真的改过之后）拼一次：
        // 网页线程自己记得上下文，每轮重复灌既浪费上下文，网页那边看着也难看。
        //
        // 判据是「和上次拼进去的是不是同一段文字」。传进来的必须是稳定块
        // （人设 + 常驻记忆，见 src/lib/web-context.ts）——身体读数、时间、
        // 最近对话回顾、滚动摘要这些每轮都在变的东西绝不能进这个字符串，
        // 否则这里就退化成「每条消息都重拼一遍人设」。
        String persona = systemPrompt == null ? "" : systemPrompt.trim();
        boolean needPersona = !persona.isEmpty() && !persona.equals(thread.persona);
        /*
         * 空人设（助手被关掉）：这一轮不注入，但**立刻**把去重标记清掉并落盘。
         *
         * 不清的话，「开 A → 关 → 再开 A」第三步会被判成「A 已经拼过」而永久跳过，
         * 网页那边就一直用关掉之前的旧设定。只清标记：sid / mid / 历史消息都不动，
         * 已经发进网页会话里的旧设定本来就撤不回来。
         * 与 Electron 侧 electron/deepseek-api.ts 的同一段逐条对应。
         */
        if (persona.isEmpty() && !thread.persona.isEmpty()) {
            thread.persona = "";
            saveThreads();
        }
        String fullPrompt = needPersona ? (persona + "\n\n---\n\n" + prompt) : prompt;

        StringBuilder text = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();

        String endpoint = COMPLETION;
        JSONObject body = new JSONObject();
        body.put("action", JSONObject.NULL);
        body.put("chat_session_id", thread.sid);
        body.put("parent_message_id", thread.mid == null ? JSONObject.NULL : thread.mid.longValue());
        body.put("prompt", fullPrompt);
        JSONArray refs = new JSONArray();
        if (refFileIds != null) {
            for (String id : refFileIds) {
                if (id != null && !id.isEmpty()) refs.put(id);
            }
        }
        body.put("ref_file_ids", refs);
        body.put("thinking_enabled", thinking);
        body.put("search_enabled", false);
        body.put("preempt", false);

        int continues = 0;
        while (true) {
            if (aborted) throw new Exception("已停止");
            // 只有 completion 要 PoW；continue 和 resume 带了会被判 INVALID_TARGET_PATH。
            String pow = COMPLETION.equals(endpoint) ? solvePow(token, endpoint) : null;
            StreamResult result = postStream(token, endpoint, body, pow);

            // 服务端已经收下这条消息了：这时候才敢把「人设拼过了」记下来。
            // 只在整轮成功结束时记的话，中途断流/被停止就会漏记，下一轮又把设定拼一遍。
            if (needPersona) {
                thread.persona = persona;
                saveThreads();
            }

            // 续写是「接着写」，正文要累加，不能整段覆盖。
            text.append(result.text);
            reasoning.append(result.reasoning);

            if ("INCOMPLETE".equals(result.status) && result.messageId != null && continues < MAX_CONTINUES) {
                continues++;
                endpoint = CONTINUE;
                body = new JSONObject();
                body.put("chat_session_id", thread.sid);
                body.put("message_id", result.messageId.longValue());
                body.put("fallback_to_resume", true);
                continue;
            }
            if ("FINISHED".equals(result.status) && text.length() == 0 && reasoning.length() == 0
                && result.messageId != null && continues == 0) {
                continues++;
                endpoint = RESUME;
                body = new JSONObject();
                body.put("chat_session_id", thread.sid);
                body.put("message_id", result.messageId.longValue());
                continue;
            }
            if (result.messageId != null) thread.mid = result.messageId;
            saveThreads();
            break;
        }

        Reply reply = new Reply();
        reply.text = text.toString();
        reply.reasoning = reasoning.toString();
        return reply;
    }

    /* ---------------- 附件上传 ---------------- */

    /** 上传一张图片（data URL）到网页账号，返回 file_id（已等到处理成功）。 */
    static void upload(final String dataUrl, final String filename, final Callback<String> done) {
        final String currentToken = token();
        if (currentToken == null) { done.done(null, "还没登录网页账号"); return; }
        POOL.execute(() -> {
            aborted = false;
            try {
                done.done(doUpload(currentToken, dataUrl, filename), null);
            } catch (Exception error) {
                String message = error.getMessage();
                done.done(null, message == null || message.isEmpty() ? "附件上传失败" : message);
            } finally {
                activeConn = null;
                aborted = false;
            }
        });
    }

    private static String doUpload(String token, String dataUrl, String filename) throws Exception {
        int comma = dataUrl == null ? -1 : dataUrl.indexOf(',');
        if (comma < 0) throw new Exception("附件格式不对（不是 data URL）");
        String meta = dataUrl.substring(0, comma);
        if (!meta.contains(";base64")) throw new Exception("只支持 base64 编码的附件");
        byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
        if (bytes.length == 0) throw new Exception("附件是空的");

        String boundary = "----WebKitFormBoundary" + Long.toHexString(System.currentTimeMillis());
        String CRLF = "\r\n";
        String safeName = (filename == null || filename.isEmpty()) ? "image.png" : filename.replace("\"", "_");
        String header = "--" + boundary + CRLF
            + "Content-Disposition: form-data; name=\"file\"; filename=\"" + safeName + "\"" + CRLF
            + "Content-Type: application/octet-stream" + CRLF + CRLF;
        String footer = CRLF + "--" + boundary + "--" + CRLF;
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        buf.write(header.getBytes(StandardCharsets.UTF_8));
        buf.write(bytes);
        buf.write(footer.getBytes(StandardCharsets.UTF_8));

        String pow = solvePow(token, UPLOAD);
        HttpURLConnection conn = openRaw("POST", UPLOAD, token, pow);
        conn.setRequestProperty("content-type", "multipart/form-data; boundary=" + boundary);
        conn.setRequestProperty("x-file-size", String.valueOf(bytes.length));
        conn.setRequestProperty("x-model-type", "default");
        conn.setRequestProperty("x-thinking-enabled", "0");
        try (OutputStream out = conn.getOutputStream()) {
            out.write(buf.toByteArray());
        }
        int code = conn.getResponseCode();
        if (code == 401 || code == 403) throw new Exception("网页登录过期了，请重新登录一次");
        String text = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
        if (code >= 400) throw new Exception("上传返回 " + code + "：" + cut(text));
        JSONObject root = new JSONObject(text);
        JSONObject data = root.optJSONObject("data");
        int bizCode = data == null ? root.optInt("code", 0) : data.optInt("biz_code", 0);
        if (bizCode != 0) throw new Exception("上传被拒绝：" + (data == null ? "" : data.optString("biz_msg", "")));
        JSONObject bizData = data == null ? null : data.optJSONObject("biz_data");
        String fileId = bizData == null ? "" : bizData.optString("id", "");
        if (fileId.isEmpty()) throw new Exception("上传没返回 file_id");
        return pollFile(token, fileId);
    }

    private static String pollFile(String token, String fileId) throws Exception {
        for (int attempt = 0; attempt < 30; attempt++) {
            if (aborted) throw new Exception("已停止");
            HttpURLConnection conn = openRaw("GET", FETCH_FILES + "?file_ids=" + URLEncoder.encode(fileId, "UTF-8"), token, null);
            int code = conn.getResponseCode();
            if (code == 401 || code == 403) throw new Exception("网页登录过期了，请重新登录一次");
            String text = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
            if (code >= 400) throw new Exception("查询文件返回 " + code);
            JSONObject bizData = biz(text);
            JSONArray files = bizData.optJSONArray("files");
            JSONObject file = (files == null || files.length() == 0) ? null : files.optJSONObject(0);
            if (file == null) throw new Exception("文件查询结果为空");
            String status = file.optString("status", "");
            if ("SUCCESS".equals(status)) return fileId;
            if ("ERROR".equals(status) || !file.optString("error_code", "").isEmpty()) {
                throw new Exception("文件处理失败：" + file.optString("error_code", ""));
            }
            Thread.sleep(1500);
        }
        throw new Exception("文件处理超时");
    }

    /** 拿挑战，Java 侧解，拼头。 */
    private static String solvePow(String token, String targetPath) throws Exception {
        JSONObject body = new JSONObject();
        body.put("target_path", targetPath);
        JSONObject challenge = biz(postJson(token, CHALLENGE, body)).getJSONObject("challenge");
        String algorithm = challenge.optString("algorithm", "");
        if (!"DeepSeekHashV1".equals(algorithm)) throw new Exception("PoW 算法不是 DeepSeekHashV1");
        String digest = challenge.optString("challenge", "");
        String salt = challenge.optString("salt", "");
        long expireAt = challenge.optLong("expire_at", 0);
        long difficulty = challenge.optLong("difficulty", 0);
        String signature = challenge.optString("signature", "");
        String path = challenge.optString("target_path", targetPath);

        long answer = DeepSeekPow.solve(salt, expireAt, digest, difficulty);
        if (answer < 0) throw new Exception("PoW 没解出来（挑战可能已过期）");
        return DeepSeekPow.header(algorithm, digest, salt, answer, signature, path);
    }

    private static String createSession(String token) throws Exception {
        JSONObject bizData = biz(postJson(token, SESSION_CREATE, new JSONObject()));
        JSONObject session = bizData.optJSONObject("chat_session");
        String sid = session == null ? bizData.optString("id", "") : session.optString("id", "");
        if (sid.isEmpty()) throw new Exception("网页没返回会话 id");
        return sid;
    }

    /* ---------------- HTTP ---------------- */

    private static HttpURLConnection open(String path, String token, String powHeader) throws Exception {
        return openRaw("POST", path, token, powHeader);
    }

    /** 通用连接：方法 / 路径 / token / PoW 头，其余头一致。GET 不发 body。 */
    private static HttpURLConnection openRaw(String method, String path, String token, String powHeader) throws Exception {
        if (aborted) throw new Exception("已停止");
        HttpURLConnection conn = (HttpURLConnection) new URL(ORIGIN + path).openConnection();
        conn.setRequestMethod(method);
        conn.setDoOutput(!"GET".equals(method));
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(180000);
        conn.setRequestProperty("accept", "*/*");
        conn.setRequestProperty("content-type", "application/json");
        conn.setRequestProperty("authorization", "Bearer " + token);
        conn.setRequestProperty("origin", ORIGIN);
        conn.setRequestProperty("referer", ORIGIN + "/a/chat/");
        conn.setRequestProperty("x-client-platform", "web");
        conn.setRequestProperty("x-client-version", APP_VERSION);
        conn.setRequestProperty("x-client-bundle-id", "com.deepseek.chat");
        conn.setRequestProperty("x-client-locale", "zh_CN");
        conn.setRequestProperty("x-client-timezone-offset",
            String.valueOf(java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000));
        String cookie = CookieManager.getInstance().getCookie(ORIGIN);
        if (cookie != null && !cookie.isEmpty()) conn.setRequestProperty("cookie", cookie);
        if (powHeader != null) conn.setRequestProperty("x-ds-pow-response", powHeader);
        // 记下当前连接，好让「停止」能把它断开。
        activeConn = conn;
        return conn;
    }

    private static String postJson(String token, String path, JSONObject body) throws Exception {
        HttpURLConnection conn = open(path, token, null);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int code = conn.getResponseCode();
        if (code == 401 || code == 403) throw new Exception("网页登录过期了，请重新登录一次");
        String text = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
        if (code >= 400) throw new Exception("网页接口返回 " + code + "：" + cut(text));
        return text;
    }

    /* ---------------- SSE 解析 ---------------- */

    private static final class StreamResult {
        String text = "";
        String reasoning = "";
        String status;
        Long messageId;
        final java.util.Map<Integer, String> kinds = new java.util.HashMap<>();
    }

    /**
     * 一轮 SSE 解析。
     *
     * 帧的几种形状必须都认，漏一种就会把正文错归到思考里（我们就是这样出现过
     * 「只看到思维链、看不到对话」）：
     *   {"v":{"response":{...}}}                        整段快照
     *   {"p":"response/fragments","v":[...]}            数组补丁，开新 fragment
     *   {"p":"response/fragments/-1/content","v":".."}   按路径追加
     *   {"v":"..."}                                      裸字符串追加到最后那个
     * 行为与桌面端 electron/sse.ts 的 PatchReader 一致。
     */
    private static StreamResult postStream(String token, String path, JSONObject body, String pow) throws Exception {
        HttpURLConnection conn = open(path, token, pow);
        try (OutputStream out = conn.getOutputStream()) {
            out.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int code = conn.getResponseCode();
        if (code == 401 || code == 403) throw new Exception("网页登录过期了，请重新登录一次");
        if (code >= 400) throw new Exception("网页接口返回 " + code + "：" + cut(readAll(conn.getErrorStream())));

        StreamResult result = new StreamResult();
        String contentType = conn.getContentType();
        if (contentType != null && contentType.contains("application/json")) {
            // 续写或重读可能一次性把整条消息给回来。
            JSONObject bizData = biz(readAll(conn.getInputStream()));
            JSONObject response = bizData.optJSONObject("response");
            if (response != null) applyResponse(response, result, new String[]{"RESPONSE"});
            return result;
        }

        // 跨帧保持「最后那个 fragment 是什么类型」：裸字符串与 fragments/-1 的
        // 追加都靠它判断内容归正文还是思考。
        final String[] lastKind = {"RESPONSE"};
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
            StringBuilder data = new StringBuilder();
            String event = "message";
            boolean hasData = false;
            String line;
            while ((line = reader.readLine()) != null) {
                // 断开连接能让 readLine 立刻抛，但数据已经在缓冲里时不抛；
                // 所以每读一行也看一眼取消标记。
                if (aborted) throw new Exception("已停止");
                if (line.isEmpty()) {
                    if (hasData) consumeFrame(data.toString().trim(), event, result, lastKind);
                    data.setLength(0);
                    hasData = false;
                    event = "message";
                    continue;
                }
                if (line.startsWith(":")) continue;
                int colon = line.indexOf(':');
                if (colon < 0) continue;
                String field = line.substring(0, colon);
                String value = line.substring(colon + 1);
                if (value.startsWith(" ")) value = value.substring(1);
                if ("event".equals(field)) {
                    event = value.isEmpty() ? "message" : value;
                    if ("close".equals(event)) break;
                } else if ("data".equals(field)) {
                    if (hasData) data.append('\n');
                    data.append(value);
                    hasData = true;
                }
            }
            if (hasData) consumeFrame(data.toString().trim(), event, result, lastKind);
        }
        return result;
    }

    private static void consumeFrame(String payload, String event, StreamResult result, String[] lastKind) {
        if (payload.isEmpty() || "[DONE]".equals(payload)) return;
        if (!"message".equals(event) && !"ready".equals(event)) return;
        try {
            applyFrame(new JSONObject(payload), result, lastKind);
        } catch (Exception ignored) {
            // 解不动的帧跳过，不能让一帧毁掉整轮回复。
        }
    }

    /** 处理一帧。 */
    private static void applyFrame(JSONObject frame, StreamResult result, String[] lastKind) {
        if (frame == null) return;

        // BATCH：一组同形状的补丁，逐个套。
        if ("BATCH".equals(frame.optString("o", ""))) {
            JSONArray items = frame.optJSONArray("v");
            if (items != null) {
                for (int i = 0; i < items.length(); i++) {
                    JSONObject item = items.optJSONObject(i);
                    if (item != null) applyFrame(item, result, lastKind);
                }
            }
            return;
        }

        String path = frame.optString("p", null);
        if (path != null) {
            Object raw = frame.opt("v");
            if ("response/status".equals(path) && raw instanceof String) {
                result.status = (String) raw;
                return;
            }
            if ("response/message_id".equals(path) && raw instanceof Number) {
                result.messageId = ((Number) raw).longValue();
                return;
            }
            if ("response/fragments".equals(path) && raw instanceof JSONArray) {
                fragments((JSONArray) raw, result, lastKind);
                return;
            }
            if (path.endsWith("/content") && raw instanceof String) {
                appendTo(result, kindForPath(path, result, lastKind), (String) raw);
            }
            return;
        }

        Object rawValue = frame.opt("v");
        if (rawValue instanceof JSONObject) {
            JSONObject response = ((JSONObject) rawValue).optJSONObject("response");
            if (response != null) applyResponse(response, result, lastKind);
            return;
        }
        if (rawValue instanceof String) {
            appendTo(result, lastKind[0], (String) rawValue);
        }
    }

    private static void applyResponse(JSONObject response, StreamResult result, String[] lastKind) {
        if (response.has("message_id") && !response.isNull("message_id")) result.messageId = response.optLong("message_id");
        String status = response.optString("status", null);
        if (status != null) result.status = status;
        fragments(response.optJSONArray("fragments"), result, lastKind);
    }

    /**
     * 把一批 fragment 折进结果。
     *
     * 这里必须记住每个 fragment 的类型：模型先开一个 THINK 写思考，写完再开一个
     * RESPONSE 写正文，之后的裸字符串追加都落在「最后一个」上。漏了这一步，正文
     * 就会被归进思考——正是「只看到思维链」的成因。
     */
    private static void fragments(JSONArray list, StreamResult result, String[] lastKind) {
        if (list == null) return;
        for (int i = 0; i < list.length(); i++) {
            JSONObject fragment = list.optJSONObject(i);
            if (fragment == null) continue;
            String kind = fragment.optString("type", "");
            if (!kind.isEmpty()) {
                lastKind[0] = kind;
                result.kinds.put(i, kind);
                Integer idx = fragmentId(fragment);
                if (idx != null) result.kinds.put(idx, kind);
            }
            String content = fragment.optString("content", "");
            if (content.isEmpty()) continue;
            appendTo(result, kind.isEmpty() ? lastKind[0] : kind, content);
        }
    }

    /** 取 path 里 fragments/<n>/ 的 n，用它查登记的类型；查不到退回 lastKind。 */
    private static String kindForPath(String path, StreamResult result, String[] lastKind) {
        Integer index = fragmentIndexFromPath(path);
        if (index == null || index < 0) return lastKind[0];
        String kind = result.kinds.get(index);
        return kind == null ? lastKind[0] : kind;
    }

    private static Integer fragmentIndexFromPath(String path) {
        String marker = "fragments/";
        int at = path.indexOf(marker);
        if (at < 0) return null;
        String rest = path.substring(at + marker.length());
        int slash = rest.indexOf('/');
        String digits = slash < 0 ? rest : rest.substring(0, slash);
        try {
            return Integer.valueOf(digits);
        } catch (NumberFormatException error) {
            return null;
        }
    }

    private static Integer fragmentId(JSONObject fragment) {
        if (!fragment.has("id") || fragment.isNull("id")) return null;
        Object raw = fragment.opt("id");
        return raw instanceof Number ? Integer.valueOf(((Number) raw).intValue()) : null;
    }

    private static void appendTo(StreamResult result, String kind, String content) {
        if (content == null || content.isEmpty()) return;
        if (isThinkingKind(kind)) result.reasoning += content; else result.text += content;
    }

    private static boolean isThinkingKind(String kind) {
        if (kind == null) return false;
        String upper = kind.toUpperCase();
        return "THINK".equals(upper) || "THINKING".equals(upper) || "REASONING".equals(upper);
    }

    /* ---------------- 工具 ---------------- */

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            char[] buffer = new char[4096];
            int read;
            while ((read = reader.read(buffer)) > 0) builder.append(buffer, 0, read);
        }
        return builder.toString();
    }

    private static JSONObject biz(String json) throws Exception {
        JSONObject root = new JSONObject(json);
        int code = root.optInt("code", 0);
        // 22 表示一次性返回整条消息（续写流常见），不当成错误。
        if (code != 0 && code != 22) throw new Exception("网页接口拒绝：" + root.optString("msg", String.valueOf(code)));
        JSONObject data = root.optJSONObject("data");
        if (data == null) throw new Exception("网页接口返回结构变了");
        JSONObject bizData = data.optJSONObject("biz_data");
        if (bizData == null) throw new Exception("网页接口没有 biz_data");
        return bizData;
    }

    private static String cut(String value) {
        return value == null ? "" : value.substring(0, Math.min(160, value.length()));
    }

    private static String unquote(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        if (trimmed.isEmpty() || "null".equals(trimmed)) return null;
        if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length() >= 2) {
            trimmed = trimmed.substring(1, trimmed.length() - 1);
        }
        return trimmed.replace("\\\"", "\"").replace("\\\\", "\\");
    }
}