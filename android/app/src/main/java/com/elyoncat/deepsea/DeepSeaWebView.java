package com.elyoncat.deepsea;

import android.content.Context;
import android.util.AttributeSet;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuInflater;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

import com.getcapacitor.CapacitorWebView;

/**
 * 自定义 WebView。
 *
 * 一、文本选择工具条：主界面压掉，网页版窗口保留
 *
 * WebView 里长按选中文本时，系统会弹一条 FloatingActionMode 工具条（复制/剪切/粘贴/
 * 全选/分享/网页搜索/翻译）。这条工具条是**系统窗口**，配色与布局由系统/ROM 决定，
 * 网页 CSS 管不到，Activity 主题也管不全 —— 实测（2026-11-01，用户真机）：
 *   · 主题已固定为深色（MainActivity 里 setTheme(AppTheme_NoActionBar)）；
 *   · styles.xml 里 colorBackgroundFloating 也钉成了 #0b1b24；
 *   · 结果这条工具条仍然渲染成**一整块白色面板**盖住整个界面，只有「粘贴」按钮可见。
 * 属于该 ROM 上 FloatingActionMode 窗口测量/绘制坏掉，改主题救不回来。
 *
 * 所以主界面（capacitor_bridge_layout_main.xml 里的实例）继续把它压掉：重写
 * startActionMode 返回一个空 ActionMode，保留选区与选择手柄、只是不弹系统工具条。
 * 复制/剪切/粘贴/全选由网页侧自绘工具条补上（src/components/SelectionCopyBar.tsx），
 * 粘贴走原生剪贴板插件（DeepSeaClipboardPlugin）。
 *
 * 网页版窗口（WebChatActivity 里 new 出来的实例）**不压**：那里没有自绘工具条，
 * 压掉就等于没法复制网页内容。它沿用系统工具条。
 *
 * 二、输入法全屏编辑
 *
 * 百度输入法等在输入框被键盘盖住时会把界面接管成一块白色全屏编辑区，加
 * IME_FLAG_NO_EXTRACT_UI 一并避免（对正常输入没有副作用）。
 */
public class DeepSeaWebView extends CapacitorWebView {

    /** true = 压掉系统文本选择工具条（主界面）；false = 保留（网页版窗口）。 */
    private final boolean suppressSelectionToolbar;

    /** 主界面走 XML 布局，这里压掉系统工具条。 */
    public DeepSeaWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        this.suppressSelectionToolbar = true;
    }

    /** 代码里直接 new 的场景（WebChatActivity 的网页版窗口），保留系统工具条。 */
    public DeepSeaWebView(Context context) {
        super(context, null);
        this.suppressSelectionToolbar = false;
    }

    /** 空 ActionMode：所有方法都是 no-op，只为让系统认为「ActionMode 已启动」。 */
    private ActionMode dummyActionMode() {
        return new ActionMode() {
            @Override public void setTitle(CharSequence title) {}
            @Override public void setTitle(int resId) {}
            @Override public void setSubtitle(CharSequence subtitle) {}
            @Override public void setSubtitle(int resId) {}
            @Override public void setCustomView(View view) {}
            @Override public void invalidate() {}
            @Override public void finish() {}
            @Override public Menu getMenu() { return null; }
            @Override public CharSequence getTitle() { return null; }
            @Override public CharSequence getSubtitle() { return null; }
            @Override public View getCustomView() { return null; }
            @Override public MenuInflater getMenuInflater() { return null; }
        };
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        if (!suppressSelectionToolbar) return super.startActionMode(callback, type);
        return dummyActionMode();
    }

    @Override
    @SuppressWarnings("deprecation")
    public ActionMode startActionMode(ActionMode.Callback callback) {
        if (!suppressSelectionToolbar) return super.startActionMode(callback);
        return dummyActionMode();
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        InputConnection connection = super.onCreateInputConnection(outAttrs);
        if (outAttrs != null) {
            outAttrs.imeOptions |= EditorInfo.IME_FLAG_NO_EXTRACT_UI;
        }
        return connection;
    }
}
