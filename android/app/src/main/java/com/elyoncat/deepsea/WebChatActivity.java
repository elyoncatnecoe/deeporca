package com.elyoncat.deepsea;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONObject;

/**
 * A dedicated top-level WebView for chat.deepseek.com. The site refuses
 * framing (frame-ancestors 'none'), so this is a real activity, not an iframe.
 * The skin is injected as a style element; navigation is limited to DeepSeek.
 */
public class WebChatActivity extends AppCompatActivity {
    private static final int FILE_CHOOSER = 4107;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private String css = "";
    private String js = "";
    private String startUrl = "https://chat.deepseek.com/";

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#061821"));
        getWindow().setNavigationBarColor(Color.parseColor("#061821"));
        getWindow().getDecorView().setSystemUiVisibility(0);

        startUrl = getIntent().getStringExtra("url");
        if (startUrl == null || startUrl.isEmpty()) startUrl = "https://chat.deepseek.com/";
        css = getIntent().getStringExtra("css");
        if (css == null) css = "";
        js = getIntent().getStringExtra("js");
        if (js == null) js = "";

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#061821"));
        root.setFitsSystemWindows(true);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(6), dp(5), dp(8), dp(5));
        bar.setBackgroundColor(Color.parseColor("#082530"));

        TextView back = new TextView(this);
        back.setText("‹");
        back.setTextSize(30);
        back.setTextColor(Color.parseColor("#cdeef2"));
        back.setGravity(Gravity.CENTER);
        back.setPadding(dp(10), 0, dp(12), dp(2));
        back.setOnClickListener(v -> finish());
        bar.addView(back);

        TextView title = new TextView(this);
        title.setText("深鲸 · 网页版");
        title.setTextSize(15);
        title.setTextColor(Color.parseColor("#e8f7f9"));
        title.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        title.setLayoutParams(titleParams);
        bar.addView(title);

        bar.addView(barButton("刷新", () -> {
            if (webView != null) webView.reload();
        }));
        bar.addView(barButton("浏览器", () -> {
            if (webView != null) {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(webView.getUrl()));
                startActivity(intent);
            }
        }));
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)));

        // 用自定义 WebView：它现在只收敛输入法全屏编辑，文本选择工具条交还给系统
        // （主题是固定深色，工具条不会再是白底）。网页版里长按文字能正常复制/粘贴。
        webView = new DeepSeaWebView(this);
        webView.setBackgroundColor(Color.parseColor("#061821"));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString().replace("; wv", ""));

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectSkin();
                CookieManager.getInstance().flush();
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                injectSkin();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), FILE_CHOOSER);
                    return true;
                } catch (Exception error) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
                try {
                    String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
                    DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                    request.setMimeType(mimeType);
                    request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                    DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    manager.enqueue(request);
                    Toast.makeText(WebChatActivity.this, "开始下载：" + name, Toast.LENGTH_SHORT).show();
                } catch (Exception error) {
                    Toast.makeText(WebChatActivity.this, "下载失败", Toast.LENGTH_SHORT).show();
                }
            }
        });

        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
        // 登记给中继单例：主 App 的 3D 界面通过它把消息送进这个 WebView。
        WebChatRelay.attach(webView);
        webView.loadUrl(startUrl);
    }

    private TextView barButton(String text, Runnable action) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(12);
        view.setTextColor(Color.parseColor("#9cc6ce"));
        view.setPadding(dp(10), dp(7), dp(10), dp(7));
        view.setOnClickListener(v -> action.run());
        return view;
    }

    private boolean handleUrl(Uri uri) {
        String host = uri.getHost();
        if (host != null && (host.equals("deepseek.com") || host.endsWith(".deepseek.com"))) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception error) {
            Toast.makeText(this, "打不开这个链接", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void injectSkin() {
        if (webView == null) return;
        String style = "(function(){var id='deepsea-theme';var s=document.getElementById(id);"
            + "if(!s){s=document.createElement('style');s.id=id;(document.head||document.documentElement).appendChild(s);}"
            + "s.textContent=" + JSONObject.quote(css) + ";})();";
        webView.evaluateJavascript(style, null);
        if (!js.isEmpty()) {
            webView.evaluateJavascript(js, null);
        }
        // 网页账号模式的中继脚本：每次页面就绪都重挂（登录会整页重载）。
        webView.evaluateJavascript(RelayScript.SOURCE, null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER) {
            if (fileCallback != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        results = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        results = new Uri[]{data.getData()};
                    }
                }
                fileCallback.onReceiveValue(results);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            WebChatRelay.detach(webView);
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
