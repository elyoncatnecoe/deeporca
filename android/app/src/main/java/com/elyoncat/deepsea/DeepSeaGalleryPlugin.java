package com.elyoncat.deepsea;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/**
 * 把照片写进系统相册（布置屏「保存到相册」按钮的实现）。
 *
 * 为什么必须自己写一个原生插件：
 * - Capacitor Filesystem v7 的 Directory 枚举里没有 Pictures，公共目录在 targetSdk 35
 *   的 scoped storage 下写不进去（要 WRITE_EXTERNAL_STORAGE 也只在 <=28 有效）；
 * - 主 WebView 没有 DownloadListener，所以 <a download> 在布置屏里点了静默无事发生；
 * - 上游那份「保存」实现依赖 window.xhs.miniTool（小红书容器），在 Capacitor 里恒不存在。
 *
 * 分版本写法与上游 RikkaHub 一致（只参考设计，没抄代码）：
 * - API 29+：MediaStore.Images 插入 Pictures/<相册名>，**不需要任何权限**；
 *   写失败用 resolver.delete(uri) 回滚，免得相册里留一张 0 字节的黑图。
 * - API 23-28：运行时申请 WRITE_EXTERNAL_STORAGE（manifest 里 maxSdkVersion=28），
 *   写公共目录后用 MediaScannerConnection 通知系统，否则图库里看不到。
 *   用户拒绝授权时 reject 一句明确的话，JS 侧据此退到系统分享面板 —— 绝不静默失败。
 */
@CapacitorPlugin(
    name = "DeepSeaGallery",
    permissions = {
        @Permission(alias = "storageWrite", strings = { "android.permission.WRITE_EXTERNAL_STORAGE" })
    }
)
public class DeepSeaGalleryPlugin extends Plugin {
    private static final String DEFAULT_ALBUM = "深鲸";

    @PluginMethod
    public void saveImage(PluginCall call) {
        byte[] bytes = decode(call);
        if (bytes == null) return; // decode 里已经 reject 过了
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveViaMediaStore(call, bytes);
            return;
        }
        // 23–28：公共目录要运行时权限。没拿到就先申请，授权结果在下面的回调里接着走。
        if (getPermissionState("storageWrite") != PermissionState.GRANTED) {
            final PluginCall pending = call;
            // 权限申请必须在主线程发起（ActivityResultLauncher 的约束），
            // 而插件方法体不一定跑在主线程上。
            getActivity().runOnUiThread(() -> requestPermissionForAlias("storageWrite", pending, "storageWriteResult"));
            return;
        }
        saveToPublicFolder(call, bytes);
    }

    /**
     * 授权回来的分支。
     * Capacitor 会把原来的 PluginCall 存起来再回调到这里，参数还在线上，所以重新取一遍即可。
     * 注意签名只有一个 PluginCall —— 框架是按 (savedCall) 反射调用的，
     * 授权状态用 getPermissionState 复查，不要去接那个 Map。
     */
    @PermissionCallback
    private void storageWriteResult(PluginCall call) {
        if (call == null) return;
        if (getPermissionState("storageWrite") != PermissionState.GRANTED) {
            // 这句要能被 JS 侧看懂：它看到失败就退到分享面板，界面上也会照实说。
            call.reject("没有存储权限，改走系统分享");
            return;
        }
        byte[] bytes = decode(call);
        if (bytes == null) return;
        saveToPublicFolder(call, bytes);
    }

    /** 解 base64；失败就地 reject 并返回 null。 */
    private byte[] decode(PluginCall call) {
        String base64 = call.getString("base64");
        if (base64 == null || base64.isEmpty()) {
            call.reject("缺少图片数据");
            return null;
        }
        try {
            return Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("图片数据不是合法的 base64", error);
            return null;
        }
    }

    private String mimeType(PluginCall call) {
        String mime = call.getString("mimeType");
        return mime == null || mime.isEmpty() ? "image/jpeg" : mime;
    }

    private String fileName(PluginCall call) {
        String name = call.getString("fileName");
        if (name == null || name.isEmpty()) {
            return "deepsea-" + System.currentTimeMillis() + ".jpg";
        }
        // 路径分隔符一律剔掉：这个名字直接进 MediaStore / 文件系统。
        return name.replace("/", "_").replace("\\", "_");
    }

    private String albumName(PluginCall call) {
        String album = call.getString("album");
        return album == null || album.isEmpty() ? DEFAULT_ALBUM : album;
    }

    /** API 29+：插入 MediaStore，免权限，写完解除 IS_PENDING。 */
    private void saveViaMediaStore(PluginCall call, byte[] bytes) {
        ContentResolver resolver = getContext().getContentResolver();
        String mime = mimeType(call);
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName(call));
        values.put(MediaStore.Images.Media.MIME_TYPE, mime);
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + albumName(call));
        values.put(MediaStore.Images.Media.IS_PENDING, 1);

        Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            call.reject("相册不接受这张图");
            return;
        }
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new IOException("openOutputStream 返回空");
            out.write(bytes);
            out.flush();
        } catch (Exception error) {
            // 回滚：留一条写坏的行比抛错更糟，用户会在相册里看到一张打不开的「照片」。
            resolver.delete(uri, null, null);
            call.reject("写入相册失败", error);
            return;
        }
        values.clear();
        values.put(MediaStore.Images.Media.IS_PENDING, 0);
        resolver.update(uri, values, null, null);

        JSObject result = new JSObject();
        result.put("uri", uri.toString());
        result.put("path", "");
        call.resolve(result);
    }

    /** API 23-28：写公共 Pictures/<相册名>，再让 MediaScanner 认账。 */
    private void saveToPublicFolder(PluginCall call, byte[] bytes) {
        File folder = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), albumName(call));
        if (!folder.exists() && !folder.mkdirs()) {
            call.reject("建不出相册目录：" + folder.getAbsolutePath());
            return;
        }
        // 这条路上没有 MediaStore 帮忙加 (1) 后缀，重名得自己顺延，否则会把上一张覆盖掉。
        File target = uniqueFile(folder, fileName(call));
        try (OutputStream out = new FileOutputStream(target)) {
            out.write(bytes);
            out.flush();
        } catch (Exception error) {
            call.reject("写入公共目录失败", error);
            return;
        }
        MediaScannerConnection.scanFile(getContext(), new String[] { target.getAbsolutePath() }, new String[] { mimeType(call) }, null);
        JSObject result = new JSObject();
        result.put("uri", Uri.fromFile(target).toString());
        result.put("path", target.getAbsolutePath());
        call.resolve(result);
    }

    /** 同名就往后插 -1 / -2 …（照片被覆盖掉是不可逆的，宁可多一个文件）。 */
    private File uniqueFile(File folder, String name) {
        File candidate = new File(folder, name);
        if (!candidate.exists()) return candidate;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            File next = new File(folder, stem + "-" + i + ext);
            if (!next.exists()) return next;
        }
        return candidate;
    }
}
