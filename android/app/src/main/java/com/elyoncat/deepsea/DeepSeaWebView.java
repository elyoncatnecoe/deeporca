package com.elyoncat.deepsea;

import android.content.Context;
import android.util.AttributeSet;
import android.view.ActionMode;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

import com.getcapacitor.CapacitorWebView;

/**
 * 自定义 WebView。
 *
 * 一、文本选择工具条
 *
 * WebView 里长按选中文本时，系统会弹一条 FloatingActionMode 工具条，它是系统窗口，
 * 配色/测量由 ROM 决定 —— 实测（2026-11-01，用户 vivo V2136A / Android 12 / WebView 91）
 * 在本机会渲染成整块白色面板盖住界面。所以主界面压掉它，复制/剪切/粘贴/全选/删除
 * 由网页侧自绘工具条补上（src/components/SelectionCopyBar.tsx）。
 *
 * 关键教训：只压 {@link ActionMode#TYPE_FLOATING}（浮动选择工具条），
 * **绝不能把插入光标那条一起压**，否则光标无法拖动、手柄无法选词。
 * 压的方式也必须遵守 ActionMode 契约（真实 Menu + finish 回调），见
 * {@link SelectionMenuSuppressor}。
 *
 * 两条接缝都接上，互为兜底：
 *   · 本类重写 {@link #startActionMode}（Chromium 的每条展示路径最终都走这里）；
 *   · {@code MainActivity.onWindowStartingActionMode} 再兜一层。
 *
 * 网页版窗口（WebChatActivity 里 {@code new DeepSeaWebView(this)}）不压，保留系统工具条，
 * 否则没法复制网页内容。
 *
 * 二、输入法全屏编辑
 *
 * 百度输入法等在输入框被键盘盖住时会把界面接管成一块白色全屏编辑区，加
 * IME_FLAG_NO_EXTRACT_UI 一并避免（对正常输入没有副作用）。
 */
public class DeepSeaWebView extends CapacitorWebView {

    /** true = 压掉浮动选择工具条（主界面 XML 实例）；false = 保留（网页版窗口）。 */
    private final boolean suppressSelectionToolbar;

    /** 主界面走 XML 布局，这里压掉浮动选择工具条。 */
    public DeepSeaWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        this.suppressSelectionToolbar = true;
    }

    /** 代码里直接 new 的场景（WebChatActivity 的网页版窗口），保留系统工具条。 */
    public DeepSeaWebView(Context context) {
        super(context, null);
        this.suppressSelectionToolbar = false;
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        if (suppressSelectionToolbar && type == ActionMode.TYPE_FLOATING && callback != null) {
            return SelectionMenuSuppressor.noOp(this, callback);
        }
        return super.startActionMode(callback, type);
    }

    @Override
    @SuppressWarnings("deprecation")
    public ActionMode startActionMode(ActionMode.Callback callback) {
        // 老签名没有 type 参数：只在主界面兜底压掉；网页版窗口交还系统。
        if (suppressSelectionToolbar && callback != null) {
            return SelectionMenuSuppressor.noOp(this, callback);
        }
        return super.startActionMode(callback);
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
