package com.elyoncat.deepsea;

import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuInflater;
import android.view.View;
import android.widget.PopupMenu;

/**
 * 只压掉「浮动的文本选择工具条」（{@link ActionMode#TYPE_FLOATING}），
 * 但**完整保留选区、选择手柄和插入光标手柄**。
 *
 * 背景（真机 2026-11-01，用户 vivo V2136A / Android 12 / WebView 91）：
 * WebView 里长按选中文本时，系统会弹一条 FloatingActionMode 工具条，这条工具条
 * 是系统窗口，配色/测量由 ROM 决定，在部分 ROM 上会渲染成整块白色面板盖住界面。
 * 之前为了压掉它，重写了 {@code WebView.startActionMode} 直接返回一个「全部 no-op」
 * 的假 ActionMode。结果白面板确实没了，但**拖动光标/拖手柄选词也跟着坏了**：
 *
 *   · 那个假 ActionMode 的 {@link ActionMode#getMenu()} 返回 null，{@link ActionMode#finish()}
 *     也什么都不做 —— Chromium 的 SelectionPopupController 拿不到「模式已结束」的回调，
 *     选择会话一直卡着，选择/光标手柄就再也不响应拖动了。
 *   · 而且它把**所有类型**的 startActionMode 都压掉了（连插入光标用的那条一起），
 *     等于把光标定位也一起堵死。
 *
 * 正确做法（参照开源项目 Readest #5427 的 SelectionMenuSuppressor，实测可用）：
 *   1) 只在 {@code TYPE_FLOATING} 时接管，其它类型原样交还系统 —— 光标/插入手柄照常；
 *   2) 返回的 NoOpActionMode 必须遵守 ActionMode 契约：给一个**真实的 Menu**、
 *      {@code finish()} 里回调 {@code onDestroyActionMode}，让 Chromium 正常收尾；
 *   3) 记住：返回 null 不行 —— Chromium 会把「启动失败」当成「选择 UI 不可用」并清掉选区。
 *
 * 复制/剪切/粘贴/全选/删除由网页侧自绘工具条补上（src/components/SelectionCopyBar.tsx）。
 */
public final class SelectionMenuSuppressor {

    private SelectionMenuSuppressor() {
    }

    /** 构造一个「什么都画、但遵守契约」的 ActionMode。 */
    public static ActionMode noOp(View anchor, ActionMode.Callback callback) {
        return new NoOpActionMode(anchor, callback);
    }

    private static final class NoOpActionMode extends ActionMode {
        private final View view;
        private final ActionMode.Callback callback;
        /** 真实但永不显示的 Menu：Chromium / DecorView 会去读它，返回 null 会 NPE 或卡死选择。 */
        private final Menu menu;
        private boolean finished;

        NoOpActionMode(View view, ActionMode.Callback callback) {
            this.view = view;
            this.callback = callback;
            this.menu = new PopupMenu(view.getContext(), view).getMenu();
            // 声明成浮动模式，让 DecorView 按浮动工具条处理（它不会真的创建窗口，因为 mode 非空）。
            setType(ActionMode.TYPE_FLOATING);
        }

        @Override public void setTitle(CharSequence title) { }
        @Override public void setTitle(int resId) { }
        @Override public void setSubtitle(CharSequence subtitle) { }
        @Override public void setSubtitle(int resId) { }
        @Override public void setCustomView(View view) { }

        // 菜单永不显示，跳过 onPrepareActionMode 往返。
        @Override public void invalidate() { }

        @Override public void finish() {
            if (finished) return;
            finished = true;
            // 关键：必须通知 Chromium 的 callback，让它跑 onDestroyActionMode，
            // 决定保留还是清除选区，并释放 DecorView 的浮动模式引用。
            if (callback != null) callback.onDestroyActionMode(this);
        }

        @Override public Menu getMenu() { return menu; }
        @Override public CharSequence getTitle() { return null; }
        @Override public CharSequence getSubtitle() { return null; }
        @Override public View getCustomView() { return null; }
        @Override public MenuInflater getMenuInflater() { return new MenuInflater(view.getContext()); }
    }
}
