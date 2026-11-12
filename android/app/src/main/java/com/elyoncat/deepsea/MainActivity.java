package com.elyoncat.deepsea;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

/**
 * 应用主界面。
 *
 * 除了注册插件，这里还做一件容易被忽略的事：**把系统栏的真实高度告诉网页**。
 *
 * 为什么必须自己算：targetSdk 35（Android 15）起系统强制 edge-to-edge，
 * 网页内容会画到状态栏和导航栏底下；而 CSS 的 env(safe-area-inset-*) 在
 * Android WebView 里并不可靠（多数版本恒为 0）。结果就是首页顶部的标题被
 * 状态栏压住一截。
 *
 * 所以这里用 WindowInsetsCompat 拿到真实 insets，写进 CSS 变量
 * --safe-top / --safe-bottom / --safe-left / --safe-right，
 * 网页侧的样式本来就在用这四个变量（见 styles.css），布局不用改。
 *
 * ⚠️ 单位：WindowInsetsCompat 给的是**物理像素**，而 CSS 变量是 **CSS px**。
 * 两者差一个 devicePixelRatio（3x 屏上差 3 倍），所以注入 JS 时必须换算；
 * 换算完还要钳一个上限，防止任何异常值把网页的固定全屏容器压塌。
 *
 * ⚠️ 软键盘：--safe-* 只放系统栏（systemBars），**不能把 IME 混进 --safe-bottom**。
 * 键盘弹起时 IME 高度在 3x 屏上约 900–1100 物理 px，一旦写进 padding-bottom，
 * 设置页（.screen/.screen-panel）的 padding 会超过视口高度，height:100% 塌成 0，
 * 整页只剩半透明深色底 → 用户看到「巨大的黑屏」。键盘高度单独走 --ime-inset，
 * 只给网页侧做输入框滚动让位用（见 styles.css 的 .screen-body 的 scroll-padding）。
 */
public class MainActivity extends BridgeActivity {
    /** 最近一次算出的 insets（物理像素），WebView 晚就绪时补投一次。 */
    private int insetTop = 0;
    private int insetBottom = 0;
    private int insetLeft = 0;
    private int insetRight = 0;
    /** 软键盘高度（物理像素），只用于 --ime-inset，不参与 --safe-bottom。 */
    private int imeBottom = 0;
    private boolean hasInsets = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前：把 Activity 主题钉死为深色。
        //
        // 背景：Manifest 给这个 Activity 挂的是 AppTheme.NoActionBarLaunch（启动屏主题），
        // 它继承 Theme.SplashScreen，而后者在资源表里是 Base.Theme.SplashScreen.DayNight，
        // 会跟随系统浅色模式。Capacitor 的 SplashScreen 插件是在 super.onCreate 之后才
        // 调 installSplashScreen() 的，postSplashScreenTheme 未必来得及生效，结果 Activity
        // 一直停在浅色启动主题上 —— 系统文本选择工具条、自动填充、确认对话框等全部取浅色
        // 资源，用户看到的就是整块白屏。这里显式 setTheme 兜底，保证后续系统 UI 都是深色。
        setTheme(R.style.AppTheme_NoActionBar);
        registerPlugin(DeepSeaSecurePlugin.class);
        registerPlugin(DeepSeaWebChatPlugin.class);
        registerPlugin(DeepSeaClipboardPlugin.class);
        // 第三方 OpenAI 兼容接口的 HTTP 请求走原生，绕开 WebView 的 CORS 限制
        // （很多中转站/自建端点不回 Access-Control-Allow-Origin，网页里只能看到 fetch failed）。
        registerPlugin(DeepSeaHttpPlugin.class);
        // 存图到系统相册：Filesystem 的 Directory 枚举里没有 Pictures，scoped storage
        // 下公共目录也写不进去，只能自己上 MediaStore（见 DeepSeaGalleryPlugin）。
        registerPlugin(DeepSeaGalleryPlugin.class);
        super.onCreate(savedInstanceState);
        // 网页账号的 HTTP 客户端需要应用上下文来存取登录态。
        WebApiClient.init(getApplicationContext());
        applySystemBarInsets();
        // 系统「自动填充」浮层在 WebView 上会渲染成一大片白屏（用户已遇到），
        // 本 App 的输入都是本地配置/代码，不需要密码管理器接管，直接关掉。
        disableWebViewAutofill();
        View content = findViewById(android.R.id.content);
        if (content != null) content.postDelayed(this::disableWebViewAutofill, 800);
    }

    /**
     * 关掉 WebView 及其子元素的系统自动填充。
     *
     * 为什么必须关：长按输入框时 Android 会自动弹出「自动填充」浮层，这个浮层由系统
     * 绘制、跟随 Activity 主题，在部分机型/主题组合下会变成整块白色面板盖住界面。
     * 我们没有账号密码表单，自动填充没有实际价值，关掉最稳。
     */
    private void disableWebViewAutofill() {
        final WebView target = webView();
        if (target == null) return;
        try {
            target.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
            target.getSettings().setSaveFormData(false);
        } catch (Exception ignored) {
            // 老设备上个别方法可能不可用，忽略即可，不影响主流程。
        }
    }

    /** 读一次真实 insets 并注入 CSS 变量；系统栏变化时再更新。 */
    private void applySystemBarInsets() {
        View root = findViewById(android.R.id.content);
        if (root == null) {
            WebView fallback = webView();
            if (fallback == null) return;
            root = fallback;
        }
        final View target = root;

        ViewCompat.setOnApplyWindowInsetsListener(target, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            // 系统栏与键盘分开存：--safe-bottom 只跟系统栏走，键盘高度单独给 --ime-inset。
            // （以前这里用 max(bars.bottom, ime.bottom)，键盘一弹起底部 padding 就爆掉。）
            insetTop = bars.top;
            insetBottom = bars.bottom;
            insetLeft = bars.left;
            insetRight = bars.right;
            imeBottom = ime.bottom;
            hasInsets = true;
            pushInsets();
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(target);

        // WebView 可能比 Activity 晚就绪：轮询几次，一旦拿到就补投。
        target.postDelayed(this::pushInsets, 300);
        target.postDelayed(this::pushInsets, 1200);
    }

    private WebView webView() {
        try {
            return getBridge() != null ? getBridge().getWebView() : null;
        } catch (Exception error) {
            return null;
        }
    }

    /**
     * 把当前 insets 写进 CSS 变量。
     *
     * 注入的 JS 里做三件事：
     * 1) 物理 px → CSS px：除以 window.devicePixelRatio（WebView 里它就是设备的
     *    device scale factor，等价于 density；dpr 拿不到/为 0 时退回 1）；
     * 2) 钳上限：top 120 / bottom 72 / left、right 48（CSS px），任何异常 insets
     *    都不会把网页的固定全屏容器撑爆；
     * 3) --ime-inset 单独给键盘高度（上限 600 CSS px），只供滚动让位。
     */
    private void pushInsets() {
        if (!hasInsets) return;
        final WebView webView = webView();
        if (webView == null) return;
        final String js = "(function(){"
            + "var dpr=window.devicePixelRatio||1;"
            + "if(!(dpr>0)||!isFinite(dpr)) dpr=1;"
            + "var px=function(v,max){v=Math.round(v/dpr);if(!(v>0)) v=0;if(v>max) v=max;return v+'px';};"
            + "var s=document.documentElement.style;"
            + "s.setProperty('--safe-top',px(" + insetTop + ",120));"
            + "s.setProperty('--safe-bottom',px(" + insetBottom + ",72));"
            + "s.setProperty('--safe-left',px(" + insetLeft + ",48));"
            + "s.setProperty('--safe-right',px(" + insetRight + ",48));"
            + "s.setProperty('--ime-inset',px(" + imeBottom + ",600));"
            + "})();";
        webView.post(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Exception ignored) {
                // 页面还没加载完就算了，上面的 postDelayed 会再试。
            }
        });
    }
}