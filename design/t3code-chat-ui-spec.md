# t3code 聊天界面设计规格（Composer + 消息流）复刻报告

> 来源：`F:\projects\t3code-chinese`（只读研究，未改动任何文件）
> 核心文件：`apps/web/src/index.css`（2620 行）、`apps/web/src/components/chat/*.tsx`、`apps/web/src/components/ui/button.tsx`、`apps/web/src/components/ComposerPromptEditorTiptap.tsx`
> 技术栈：Tailwind CSS v4.3.3（`--spacing: 0.25rem`，圆角/字号全部走 `@theme` 变量）、Base UI、Tiptap/ProseMirror

---

## 0. 一页总览：视觉骨架

```
┌─ 页面 bg-background (#ffffff 亮 / #151517 暗)，带 256px 噪点 grain ─────────┐
│                                                                              │
│   ┌─ .chat-content-lane  max-width: 46rem, margin-inline: auto ──────────┐   │
│   │  [用户消息]  右对齐气泡 bg-message #edf3fe，rounded-2xl，max-w 80%     │   │
│   │  [Agent 消息] 左对齐纯 markdown，无气泡无头像（sr-only heading）       │   │
│   │  [工具行]    6px 圆角行 + 24px 图标槽 + 16px 图标 + 14px 文本         │   │
│   │  [思考块]    rounded-md 边框 bg-muted/30                              │   │
│   └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌─ composer 卡片：rounded-2xl(16px) + 1px 边框 rgb(0 0 0/8%) ─────────┐   │
│   │  [附件缩略图行]  64px 方块 rounded-lg                                  │   │
│   │  [Tiptap 编辑器]  14px / leading-relaxed，max-h 208px                 │   │
│   │  [底部行]  📎  …模型 pill… …权限 pill… …溢出 pill…   ●(36px 圆发送钮) │   │
│   └──────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

三条最关键的「观感密码」：

1. **消息流是「无气泡单列居中」**：只有用户消息有气泡（右对齐、`#edf3fe` 淡蓝），Agent 消息就是**通栏 Markdown**，没有头像、没有左边距、没有卡片。作者名是 `sr-only`。
2. **Composer 是「贴底悬浮玻璃卡」**：`--card` 色 + 80% 不透明 + `backdrop-blur(12px) saturate(1.14)` + 16px 大圆角 + 极淡投影（亮色 `0 1px 2px rgb(0 0 0/5%)`，暗色**无投影**）。
3. **工具调用不是卡片，是「一行文字 + 缩进输出」**：6px 圆角的可点击行，图标 16px 放 24px 槽位里，文字 `text-secondary-label` 灰色，展开后输出缩进 28px。这是 t3code 最独特的辨识点。

---

# A. Composer / Sender

## A1. 组件文件与 JSX 结构

| 文件 | 作用 |
|---|---|
| `apps/web/src/components/chat/ComposerSurface.tsx` | 卡片的 4 层壳：`Shell` / `Host` / `Main` / `ContextStrip` |
| `apps/web/src/components/chat/ChatComposer.tsx`（3694 行，渲染体在 L3208-3694） | 表单主体 |
| `apps/web/src/components/ChatView.tsx`（L3522-3826） | 把 composer 挂成 `absolute inset-x-0 bottom-0 z-20` 浮层 |
| `apps/web/src/components/ComposerPromptEditorTiptap.tsx` | Tiptap 编辑器（L1075-1099 属性、L1800-1864 容器） |
| `apps/web/src/components/chat/ComposerPrimaryActions.tsx` | 发送/停止/恢复按钮 |
| `apps/web/src/components/chat/ComposerControl.tsx` | 底部 pill 的基类（模型/权限/溢出） |
| `apps/web/src/components/chat/ComposerFooterControls.tsx` | 权限 pill + 权限分段控件 |
| `apps/web/src/components/chat/ComposerControlsBar.tsx` | 底部控件编排 |
| `apps/web/src/components/chat/ProviderModelPicker.tsx`（L333-414） | 模型选择 pill 触发器 |
| `apps/web/src/components/chat/ComposerBanner.tsx` | 输入框上方的 banner / 附件条 |
| `apps/web/src/components/chat/ComposerAttachmentStrip.tsx` | 附件缩略图 + 📎 按钮 |

### 嵌套层级（含 `data-slot`，照抄即可）

```jsx
<form data-chat-composer-form
      className="mx-auto w-full min-w-0 max-w-(--chat-content-max-width)">

  {/* 输入框上方的附加 banner 组，向下压住 composer 17px */}
  <ComposerBanner.Dock>            {/* data-slot="composer-banner-attachment" */}
    <ComposerBanner.Column>
      <ComposerBannerStack items={shelfItems} />
      <ComposerBanner.Attachment>
        <ComposerBanner.Root data-chat-composer-top-drawer variant="info">
          <ComposerPendingUserInputPanel … />
        </ComposerBanner.Root>
      </ComposerBanner.Attachment>
    </ComposerBanner.Column>
    <ComposerStashBadge … />        {/* ml-auto 右侧肩章 */}
  </ComposerBanner.Dock>

  <div className="relative">
    <ComposerSurface.Main data-chat-composer-main-surface>        {/* rounded-2xl p-px */}
      <div data-chat-composer-surface
           data-chat-composer-mobile-collapsed="false"
           className="rounded-2xl transition-[background-color] duration-200">
        {/* ↓ 拖拽悬停：in-data-[thread-context-over]:bg-accent/45 + ring-1 ring-inset ring-primary/70 */}

        {/* 移动端折叠行（可选） */}
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <button className="min-w-0 flex-1 truncate bg-transparent p-0 text-left text-sm …" />
          <button className="flex size-8 shrink-0 items-center justify-center rounded-full
                             bg-message-action text-message-action-foreground
                             hover:bg-message-action-hover disabled:opacity-64" />
        </div>

        {/* 输入区 */}
        <div data-chat-composer-body
             className="relative px-4 pb-2 pt-3.5 sm:pt-4">
          {composerAttachmentMediaRow}     {/* mb-3 flex max-w-full gap-2 */}
          {composerAttachmentFileList}
          <div className="relative">
            <ComposerPromptEditor … />     {/* 容器 + .composer-tiptap */}
          </div>
        </div>

        <ComposerPromptLengthValidation />  {/* px-3 pb-2 text-xs text-destructive sm:px-4 */}

        {/* 底部工具行 */}
        <div data-chat-composer-footer
             className="flex min-w-0 flex-nowrap items-center overflow-visible px-2 pb-2">
          {composerAttachButton && <div className="me-2"><ComposerAttachButton/></div>}
          <div data-chat-composer-actions="right"
               className="flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-2">
            <div data-chat-composer-footer-controls
                 className="relative flex min-w-0 flex-1 items-center justify-end gap-0.5">
              {composerControls}            {/* 模型 pill / 权限 pill / 溢出 pill */}
            </div>
            <ComposerFooterPrimaryActions>  {/* 发送按钮 */}
              <ComposerSpeechButton … />
            </ComposerFooterPrimaryActions>
          </div>
        </div>

        {/* 静止态内联控件（可选） */}
        <div className="h-8">
          <div className="absolute bottom-2 inset-x-4 min-w-0">
            <div data-chat-composer-resting-controls
                 className="relative flex w-max min-w-0 max-w-full items-center gap-1
                            text-muted-foreground/70 [&_button]:text-xs!">
              {composerControls}
            </div>
          </div>
        </div>
      </div>
    </ComposerSurface.Main>

    {/* 卡片下方裸行（环境/worktree/分支），无自身表面 */}
    <div className="min-h-0"><div className="relative z-0">
      <ComposerSurface.ContextStrip>…</ComposerSurface.ContextStrip>
    </div></div>
  </div>
</form>
```

外层挂载点（`ChatView.tsx` L3522-3536）：

```jsx
<div data-chat-composer-overlay
     className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2">
  <div className="chat-composer-lane w-full">…</div>
</div>
```

`index.css` L2572-2609 的 `.chat-composer-lane`（含 `@layer components`）：

```css
.chat-composer-lane {
  padding-inline-start: calc(env(safe-area-inset-left) + 0.75rem + var(--chat-lane-inset-start, 0px));
  padding-inline-end:   calc(env(safe-area-inset-right) + 0.75rem + var(--chat-lane-inset-end, 0px));
}
[data-chat-canvas] .messages-timeline-scroll { /* 同样的左右内衬，让时间线与 composer 对齐 */ }
@media (min-width: 640px) {
  .chat-composer-lane { padding-inline: calc(env(safe-area-inset-*) + 3rem + …); }
  [data-chat-canvas] .messages-timeline-scroll { padding-inline: calc(3rem + …); }
}
```

> 即：**< 640px 时左右留 12px；≥ 640px 时左右留 48px**。

## A2. Composer 完整样式（原样抄录）

### A2.1 `index.css` 里的 composer 专属变量（L197-222，`@theme inline`）

```css
  /* The composer's elevation: a soft drop pulled in under the surface, shared
     by the composer, its context strip and attached banners. */
  --shadow-composer: 0 1px 2px rgb(0 0 0 / 5%);
  --shadow-composer-dark: 0 14px 32px -18px rgb(0 0 0 / 75%);
  /* Overlap the lower toolbar backdrop by one pixel to cover the composer seam. */
  --spacing-composer-seam: calc(var(--spacing) * 4 - 1px);
  --background-image-composer-seam-below:
    linear-gradient(
      to bottom,
      transparent 0 1rem,
      rgb(0 0 0 / 18%) 1rem,
      transparent calc(1rem + 10px)
    ),
    linear-gradient(rgb(255 255 255 / 1%), rgb(255 255 255 / 1%));
  --background-image-composer-seam-above:
    linear-gradient(var(--chat-composer-attached-tint), var(--chat-composer-attached-tint)),
    linear-gradient(
      to top,
      transparent 0 var(--chat-composer-attachment-overlap),
      rgb(0 0 0 / 18%) var(--chat-composer-attachment-overlap),
      transparent calc(var(--chat-composer-attachment-overlap) + 10px)
    );
```

`index.css` L91-152（`:root`）里与 composer 相关的：

```css
  --control-radius: 0.5rem;
  --chat-content-max-width: 46rem;         /* 736px；wide=72rem，full=100% */
  --font-size-prompt-touch: max(var(--font-size-prompt, 1rem), 16px);
  --workspace-gutter: 0.75rem;             /* ≥sm: 1.25rem */
  @variant dark {
    --glass-blur: 16px;
    --glass-saturation: 1.08;
  }
```

`index.css` L119-121：

```css
  --glass-blur: 12px;
  --glass-opacity: 80%;
  --glass-saturation: 1.14;
```

### A2.2 `ComposerSurface.tsx` —— 三层壳（原样）

```tsx
function Shell({ contextRow = false, className, ...props }) {
  return (
    <div
      data-slot="composer-shell"
      data-context-row={contextRow || undefined}
      className={cn(
        "@container/composer-surface group/composer-surface relative isolate mx-auto w-full max-w-(--chat-content-max-width)",
        "[--chat-composer-drawer-inset:1.375rem] [--chat-composer-glass-surface:var(--card)] [--chat-composer-outline:rgb(0_0_0/8%)]",
        "dark:[--chat-composer-glass-surface:var(--surface-raised)] dark:[--chat-composer-highlight:rgb(255_255_255/3%)] dark:[--chat-composer-outline:color-mix(in_srgb,var(--color-white)_5%,transparent)]",
        "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-2xl before:bg-(--chat-composer-glass-surface)/(--glass-opacity) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-glass-surface)",
        "has-data-[composer-banner-surface=attached]:before:hidden",
        "data-context-row:before:hidden",
        className,
      )}
      {...props}
    />
  );
}

const outlineClasses =
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-(--chat-composer-outline) dark:after:inset-shadow-2xs dark:after:inset-shadow-(color:--chat-composer-highlight)";

function Host({ className, ...props }) {
  return (
    <div
      data-slot="composer-host"
      className={cn(
        "relative z-10 w-full rounded-2xl shadow-composer after:z-1 dark:shadow-none",
        "group-data-context-row/composer-surface:before:pointer-events-none group-data-context-row/composer-surface:before:absolute group-data-context-row/composer-surface:before:inset-0 group-data-context-row/composer-surface:before:-z-1 group-data-context-row/composer-surface:before:rounded-2xl group-data-context-row/composer-surface:before:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-data-context-row/composer-surface:before:backdrop-blur-(--glass-blur) group-data-context-row/composer-surface:before:backdrop-saturate-(--glass-saturation)",
        outlineClasses,
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none group-has-data-[composer-banner-surface=attached]/composer-surface:before:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:hidden",
        className,
      )}
      {...props}
    />
  );
}

function Main({ className, ...props }) {
  return (
    <div
      data-chat-composer-main-surface="true"
      className={cn(
        "group relative z-10 rounded-2xl p-px",
        outlineClasses,
        "after:z-20 after:hidden group-has-data-[composer-banner-surface=attached]/composer-surface:after:block",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)/(--glass-opacity) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-blur-(--glass-blur) group-has-data-[composer-banner-surface=attached]/composer-surface:backdrop-saturate-(--glass-saturation)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-composer dark:group-has-data-[composer-banner-surface=attached]/composer-surface:shadow-none",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:group-has-data-[composer-banner-surface=attached]/composer-surface:bg-(--chat-composer-glass-surface)",
        "group-has-data-[composer-banner-surface=attached]/composer-surface:**:data-[chat-composer-mobile-collapsed=true]:min-h-[calc(1rem+1px)]",
        className,
      )}
      {...props}
    />
  );
}

/** A plain row under the card (environment, worktree, branch) with no surface of its own. */
function ContextStrip({ className, ...props }) {
  return (
    <div
      data-slot="composer-context-strip"
      className={cn(
        "group/composer-context relative flex w-full items-center gap-2 overflow-x-clip px-2 pt-2 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
```

### A2.3 等效纯 CSS（Chartelis 直接可用）

```css
/* ---- Composer 卡片 ---- */
.chat-composer {
  position: relative;
  isolation: isolate;
  margin-inline: auto;
  width: 100%;
  max-width: var(--chat-content-max-width);   /* 46rem = 736px */
  border-radius: 1rem;                        /* rounded-2xl = --radius + 8px */
  background: color-mix(in srgb, var(--surface) 80%, transparent);
  -webkit-backdrop-filter: blur(12px) saturate(1.14);
  backdrop-filter: blur(12px) saturate(1.14);
  box-shadow: 0 1px 2px rgb(0 0 0 / 5%);      /* --shadow-composer */
  border: 1px solid rgb(0 0 0 / 8%);          /* --chat-composer-outline */
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .chat-composer { background: var(--surface); }
}
.dark .chat-composer {
  background: color-mix(in srgb, var(--surface-raised, #2c2c2e) 80%, transparent);
  box-shadow: none;                            /* dark:shadow-none */
  border-color: rgb(255 255 255 / 5%);
  -webkit-backdrop-filter: blur(16px) saturate(1.08);
  backdrop-filter: blur(16px) saturate(1.08);
}
/* 暗色内侧高光线：dark:after:inset-shadow-2xs inset-shadow-(color:--chat-composer-highlight) */
.dark .chat-composer::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  box-shadow: inset 0 1px 0 0 rgb(255 255 255 / 3%);   /* 2xs ≈ 1px */
}

/* ---- 输入区 ---- */
.chat-composer__body { position: relative; padding: 0.875rem 1rem 0.5rem; }  /* pt-3.5 pb-2 px-4 */
@media (min-width: 640px) { .chat-composer__body { padding-top: 1rem; } }     /* sm:pt-4 */

/* ---- 底部工具行 ---- */
.chat-composer__footer {
  display: flex; min-width: 0; flex-wrap: nowrap; align-items: center;
  overflow: visible; padding-inline: 0.5rem; padding-block-end: 0.5rem;       /* px-2 pb-2 */
}

/* ---- 拖拽悬停 ---- */
.chat-composer.is-drag-over {
  background-color: color-mix(in srgb, var(--accent) 45%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 70%, transparent);
}

/* ---- 过渡 ---- */
.chat-composer__surface { border-radius: 1rem; transition: background-color 200ms; }
```

### A2.4 Tiptap / ProseMirror 编辑器容器

**JS 里的 class（`ComposerPromptEditorTiptap.tsx` L1076-1079）**：

```
composer-tiptap -m-1 block max-h-52 min-h-[calc(2lh+--spacing(2))] overflow-y-auto
p-1 whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed
text-foreground focus:outline-none
```

**外层容器（L1804-1809）**：

```
relative flow-root font-(family-name:--font-composer,var(--font-sans))
text-(length:--font-size-prompt,var(--text-sm))
max-sm:pointer-coarse:text-(length:--font-size-prompt-touch)
```

**Placeholder（L1853-1863）**：

```
pointer-events-none absolute inset-0 leading-relaxed text-placeholder
```

> `--font-size-prompt` 默认 **14px**（`DEFAULT_PROMPT_FONT_SIZE = 14`），与 `--text-sm` 一致；触屏强制 ≥16px（防 iOS 聚焦缩放）。
> `max-h-52` = 13rem = **208px**；`min-h` = 2 行 + 8px；`-m-1 p-1` 净边距为 0。
> `.composer-tiptap p { margin: 0 }`（L2473）。

**`index.css` L2466-2570 `.composer-tiptap` 全部规则（原样）**：

```css
/* Rich text composer (Tiptap). The stored prompt stays markdown; only the
   surface renders styled text. Markers (** * ` ~~) appear as non-editable
   widgets while the caret is on styled text. */
.composer-tiptap {
  position: relative;
}

.composer-tiptap p {
  margin: 0;
}

.composer-tiptap:focus,
.composer-tiptap .ProseMirror:focus {
  outline: none;
}

.composer-tiptap :not(pre) > code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: color-mix(in oklab, var(--muted-foreground) 12%, transparent);
  border-radius: 0.3em;
  padding: 0.05em 0.25em;
}

/* Markdown delimiters shown, as editable text, around styled text with the caret in it. */
.composer-rich-marker {
  color: var(--muted-foreground);
  opacity: 0.75;
  font-weight: 400;
  font-style: normal;
  text-decoration: none;
}

/* Delimiters of source restored by undo or redo, once the caret leaves it. */
.composer-rich-marker-hidden {
  display: none;
}

/* Selected chips (node selection from arrowing into or clicking a chip). */
.composer-tiptap .ProseMirror-selectednode {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
  border-radius: 6px;
}

.composer-tiptap .composer-chip-range-selected {
  position: relative;
}

.composer-tiptap.ProseMirror-focused .composer-chip-range-selected::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 6px;
  background: Highlight;
  opacity: 0.3;
  pointer-events: none;
}

/* Rich-text task lists render as real checkboxes. … */
.composer-tiptap ul[data-type="taskList"] {
  list-style: none;
  margin: 0;
  padding: 0;
}

.composer-tiptap ul[data-type="taskList"] ul[data-type="taskList"] {
  padding-inline-start: 1.375rem;
}

.composer-tiptap li[data-checked] {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
}

.composer-tiptap li[data-checked] > label {
  display: flex;
  align-items: center;
  flex: none;
  height: 1lh;
  cursor: pointer;
}

.composer-tiptap li[data-checked] > label input[type="checkbox"] {
  display: block;
  margin: 0;
  width: 0.95rem;
  height: 0.95rem;
  cursor: pointer;
}

.composer-tiptap li[data-checked] > div {
  flex: 1 1 auto;
  min-width: 0;
}

.composer-tiptap li[data-checked] > div > p {
  margin: 0;
}
```

**`.composer-tiptap` 与 `.chat-markdown` 共享的排版规则（L1896-2128，节选）**：

```css
.chat-markdown p, .chat-markdown ul, .chat-markdown ol, .chat-markdown blockquote,
.chat-markdown pre, .chat-markdown .chat-markdown-table-container,
.composer-tiptap ul, .composer-tiptap ol {
  margin: 0.65rem 0;
}

:is(.chat-markdown, .composer-tiptap) h1…h6 {
  margin: 1.25rem 0 0.5rem; font-weight: 600; line-height: 1.3;
  color: var(--contrast-foreground);
}
:is(.chat-markdown, .composer-tiptap) h1 { font-size: 1.25rem; }   /* 20px */
:is(.chat-markdown, .composer-tiptap) h2 { font-size: 1.125rem; }  /* 18px */
:is(.chat-markdown, .composer-tiptap) h3 { font-size: 1rem; }      /* 16px */
:is(.chat-markdown, .composer-tiptap) h4,
:is(.chat-markdown, .composer-tiptap) h5,
:is(.chat-markdown, .composer-tiptap) h6 { font-size: 0.875rem; }  /* 14px */
:is(.chat-markdown, .composer-tiptap) h6 { color: var(--contrast-muted-foreground); }

:is(.chat-markdown, .composer-tiptap) ul {
  --list-gutter: 1.25rem; padding-inline-start: 1.25rem; list-style-type: disc;
}
:is(.chat-markdown, .composer-tiptap) ol {
  --list-gutter: 1.25rem; padding-inline-start: var(--list-gutter, 1.25rem);
  list-style-type: decimal;
}
:is(.chat-markdown, .composer-tiptap) ol > li::marker { font-variant-numeric: tabular-nums; }
.composer-tiptap ol > li[data-marker]::marker { content: attr(data-marker) " "; }
.composer-tiptap ol { --list-gutter: max(1.25rem, 3ch); }
.composer-tiptap ul { padding-inline-start: max(1.25rem, 2ch); }
:is(.chat-markdown, .composer-tiptap) ul ul { list-style-type: circle; }
:is(.chat-markdown, .composer-tiptap) ul ul ul { list-style-type: square; }
.chat-markdown ol ol { list-style-type: lower-alpha; }
.chat-markdown ol ol ol { list-style-type: lower-roman; }
.chat-markdown.user-message-markdown ol { list-style-type: decimal; }
.chat-markdown li + li { margin-top: 0.25rem; }

.chat-markdown li.task-list-item { list-style-type: none; }
.chat-markdown li.task-list-item input[type="checkbox"] {
  margin-block: 0 0.15em;
  margin-inline: calc(-1 * var(--list-gutter, 1.25rem)) 0.35em;
  vertical-align: middle;
}

.chat-markdown img { display: inline-block; }
.chat-markdown a { text-decoration: none; }
.chat-markdown a:not(.chat-markdown-file-link, :has([data-slot="context-chip-label"])) {
  color: var(--info-foreground);
}
/* hover/focus 时用 4px×2px 点阵下划线 */
.chat-markdown a:not(…):hover, .chat-markdown a:not(…):focus-visible {
  background-image: radial-gradient(circle, currentcolor 0.75px, transparent 1px);
  background-position: left bottom; background-repeat: repeat-x; background-size: 4px 2px;
}

:is(.chat-markdown, .composer-tiptap) blockquote {
  border-inline-start: 2px solid color-mix(in srgb, currentcolor 35%, transparent);
  padding-inline-start: 0.8rem; color: inherit;
}
.composer-tiptap blockquote { margin: 0.65rem 0; }

:is(.chat-markdown, .composer-tiptap) hr { @variant dark { border-color: var(--contrast-muted-foreground); } }
.composer-tiptap hr { margin: 0.65rem 0; }

/* Block spacing separates blocks, not the draft from the composer edge. */
.composer-tiptap > :first-child { margin-top: 0; }
.composer-tiptap > :last-child { margin-bottom: 0; }
.composer-tiptap :is(h1,h2,h3,h4,h5,h6):first-child { margin-top: 0; }
```

## A3. 发送按钮（`ComposerPrimaryActions.tsx` L258-304）

```tsx
const sendButton = (
  <button
    type={showResume ? "button" : "submit"}
    className={cn(
      "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none",
      stageBackdropVariant
        ? "bg-transparent text-white enabled:shadow-black/24 enabled:hover:brightness-110 disabled:opacity-64"
        : "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover disabled:bg-foreground/12 disabled:text-muted-foreground",
    )}
    disabled={ isSendBusy || isSendDisabled || isEnvironmentUnavailable || (!hasSendableContent && !showResume) }
    aria-label={submitStatus ?? submitLabel}
  >
    {isSendBusy ? <Spinner size="sm" aria-hidden="true" />
     : showResume ? <PlayIcon className="size-4 fill-current" aria-hidden="true" />
     : isEditingQueuedMessage ? <CheckIcon className="size-4" aria-hidden="true" />
     : isRunning && isQueuing ? <ListPlusIcon className="size-4" aria-hidden="true" />
     : isRunning ? <CornerUpRightIcon className="size-4" aria-hidden="true" />
     : (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
              stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" />
      </svg>
     )}
  </button>
);
```

**状态矩阵**

| 状态 | 尺寸 | 背景 | 文字 | 阴影 | 图标 |
|---|---|---|---|---|---|
| 可发送 | `h-9 w-9`（sm: `h-8 w-8`，36/32px） | `--message-action` `#0f1115` / `#f9fafb` | `--message-action-foreground` 反色 | `shadow-message-action/24` + `inset 0 1px rgb(255 255 255/16%)` | 14×14 上箭头（stroke 1.8） |
| hover | 同上 | `--message-action-hover` `#43454a` / `#ebeef2` | — | — | `scale(1.05)` |
| active | 同上 | 同上 | — | 无阴影，`inset 0 1px rgb(0 0 0/8%)` | — |
| **不可发送** | 同上 | `--foreground/12` | `--muted-foreground` | **无** | 同上 |
| 发送中 busy | 同上 | 同「可发送」 | — | — | `Spinner size="sm"` |
| 运行中可插入 | 同上 | 同「可发送」 | — | — | `CornerUpRightIcon size-4` |
| 运行中排队 | 同上 | 同「可发送」 | — | — | `ListPlusIcon size-4` |
| 恢复线程 | 同上 | 同「可发送」 | — | — | `PlayIcon size-4 fill-current` |
| 编辑队列消息 | 同上 | 同「可发送」 | — | — | `CheckIcon size-4` |

**停止按钮（L130-155）**

```tsx
<button
  type="button"
  className={cn(
    "flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive active:inset-shadow-control-pressed active:shadow-none [&_svg]:pointer-events-none",
    insidePendingAction ? "size-8 sm:size-7" : "size-8 sm:h-8 sm:w-8",
  )}
  disabled={!canOperateThread}
  aria-label="Stop generation"
>
  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
    <rect x="2" y="2" width="8" height="8" rx="1.5" />
  </svg>
</button>
```

**文字型主操作 pill（`messageActionPillClassName`，L79-80，用于审批答题等场景）**

```
inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap
rounded-full bg-message-action font-medium text-base text-message-action-foreground
shadow-xs shadow-message-action/24 outline-none hover:bg-message-action-hover
focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring
focus-visible:ring-offset-1 focus-visible:ring-offset-background
disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:text-sm
/* + h-8 sm:h-7，px-4（compact 时 px-3） */
```

**「发送前压缩」小钮（L326-341）**

```
flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-(--control-radius) px-2
font-medium text-base text-foreground/80 tabular-nums outline-none hover:bg-accent
hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring
disabled:pointer-events-none disabled:opacity-64 sm:text-sm
aria-pressed:bg-accent/60 aria-pressed:text-foreground [&_svg]:size-4 [&_svg]:text-muted-foreground
```

## A4. 底部工具行（模型选择 / 审批模式 / 沙箱 / 溢出）

### `ComposerControl.tsx` —— 所有 pill 的基类（原样）

```tsx
function composerControlClassName(size: ComposerControlSize, className?: string) {
  return cn(
    "relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-(--control-radius) border border-transparent text-base outline-none hover:bg-accent data-pressed:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-disabled:pointer-events-none data-disabled:opacity-64 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&:active:not([aria-haspopup])]:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:-mx-0.5 [&_svg[data-composer-control-icon]]:mx-0",
    "[&_:is([data-composer-control-label],[data-chat-provider-model-picker-label])]:[text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:[&_:is([data-composer-control-label],[data-chat-provider-model-picker-label])]:py-1.5",
    size === "xs"
      ? "h-7 gap-1 has-[[data-composer-label]]:gap-1.5 px-1.75 font-normal text-foreground/70 text-sm hover:text-foreground dark:text-muted-foreground sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5 [&_svg]:mx-0 [&_svg[data-composer-control-chevron]]:ms-0 [&_svg[data-composer-control-chevron]]:-me-1"
      : "h-7 gap-1.5 px-2 font-medium text-foreground/80 [&_svg:not([class*='text-'])]:text-muted-foreground hover:text-foreground sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
    "aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-pressed:hover:bg-accent/80",
    className,
  );
}
```

| 尺寸 | 高 | 内衬 | 字号 | 字色 | 图标 |
|---|---|---|---|---|---|
| `sm`（默认） | 28px | `px-2`（8px） | 14px（sm 起） | `--foreground/80`，hover `--foreground` | 18px，sm 起 16px |
| `xs`（折叠/紧凑） | 28px，sm 起 24px | `px-1.75`（7px） | 14px，sm 起 12px | `--foreground/70`，hover `--foreground`（暗色 `--muted-foreground`） | 16px，sm 起 14px |

公共：`rounded-(--control-radius)` = 8px、`border: 1px solid transparent`、hover/按压 `background: var(--accent)`、`aria-pressed:bg-accent`、按下 `scale(0.97)`、focus ring `2px var(--ring) inset + offset 1px`。

### 模型选择 pill（`ProviderModelPicker.tsx` L333-364）

```tsx
<ComposerControl
  size={size}
  data-chat-provider-model-picker="true"
  data-composer-shortcut={props.triggerShortcuts}
  className={cn(
    "min-w-0 shrink justify-between whitespace-nowrap",
    props.compact ? "max-w-42 shrink-0" : !props.isComposerOwned && "max-w-48 sm:max-w-56",
    props.triggerClassName,
  )}
/>
```

`ComposerControlsBar.tsx` L40/L212-216 追加：

```
const MODEL_TRIGGER_STATES = "data-popup-open:bg-accent data-popup-open:text-foreground";
triggerClassName={cn("group/model-trigger", MODEL_TRIGGER_STATES,
                     composerControlsCollapsed ? "min-w-13 shrink text-xs!" : "min-w-13")}
```

内容结构：`[provider 图标 size-4 圆角叠放 -space-x-1]` + `[模型名]` + `[effort 后缀]`。
图标槽底色：`bg-(--chat-composer-glass-surface, var(--background))` + `ring-2 ring-(--chat-composer-glass-surface, var(--background))`。
effort 后缀（`ComposerModelEffort.tsx` L145-174）：

```tsx
<span className={cn(
  "flex shrink-0 items-center gap-1.5 text-muted-foreground group-hover/model-trigger:text-foreground group-data-pressed/model-trigger:text-foreground group-data-popup-open/model-trigger:text-foreground",
  size === "sm" && "-ms-0.5")}>
  {word ? <span data-composer-control-label className="max-w-24 truncate">{word}</span>
        : glyph ? <EffortGlyph count={glyph.count} filled={glyph.filled} size={size} /> : null}
  {fast ? <FastBolt ultra={display.speedLabel === "Ultrafast"} /> : null}
  {display.ultracode ? <WorkflowIcon data-composer-control-icon className="size-3" /> : null}
  {contextWindow ? <span data-composer-control-label data-composer-secondary-trait
                          className="max-w-24 truncate text-xs">{contextWindow}</span> : null}
</span>
```

### 权限 / 审批模式 pill（`ComposerFooterControls.tsx` L56-83）

```tsx
<ComposerControl
  ref={permissionsChipRef}
  data-composer-shortcut="composer.mode"
  size={size}
  className="ps-1.5"                       /* 与模型 pill 的尾部 pe-1 对齐 */
  aria-label={`Permissions: ${runtimeModeOption.label}`}
>
  <ComposerControlIcon icon={RuntimeModeIcon} size={size} />
  <span data-composer-control-label
        className={accessDisplay === "icon" ? "sr-only" : undefined}>
    {runtimeModeOption.label}
  </span>
</ComposerControl>
```

权限菜单里的**分段单选**（L118-162）：

```tsx
<div data-composer-permissions className="grid w-72 gap-1.5 px-2 py-1.5">
  <div className="font-medium text-muted-foreground text-xs">Permissions</div>
  <MenuPrimitive.RadioGroup className="flex rounded-lg bg-input/40 p-0.5">
    {/* 每段： */}
    <MenuPrimitive.RadioItem
      className="flex h-6 flex-1 cursor-pointer items-center justify-center text-muted-foreground outline-none first:rounded-l-md last:rounded-r-md data-disabled:cursor-not-allowed data-disabled:opacity-40 data-checked:bg-input/72 data-checked:text-foreground data-highlighted:text-foreground not-data-checked:data-highlighted:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <OptionIcon className="size-3.5" />
    </MenuPrimitive.RadioItem>
  </MenuPrimitive.RadioGroup>
  <span className={shownMode === props.runtimeMode ? "text-foreground text-sm" : "text-muted-foreground text-sm"}>
    {shown.label}
  </span>
  <span className="min-h-8 text-muted-foreground text-xs leading-4">
    {shown.disabledReason ?? shown.description}
  </span>
</div>
```

### 溢出菜单 pill / 布局细节

- `ComposerControlsBar.tsx` L278-281：被隐藏的 block 用 `absolute invisible pointer-events-none`；纯图标态把 `[data-composer-control-label]` 设为 `absolute invisible w-max max-w-none`。
- `ChatComposer.tsx` L3676-3683：静止态控件容器 `relative flex w-max min-w-0 max-w-full items-center gap-1 text-muted-foreground/70 [&_button]:text-xs!`，不可见时加 `invisible`。
- 底部控件容器 `data-chat-composer-footer-controls`：`relative flex min-w-0 flex-1 items-center justify-end gap-0.5`。
- 主操作与控件间距：`data-chat-composer-actions="right"` → `flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-2`。

### 📎 附件按钮（`ComposerAttachmentStrip.tsx` L728-745）

```tsx
<Button type="button" variant="ghost" size="icon-sm"
        onPointerDown={(e) => e.preventDefault()}
        aria-label="Attach files">
  <PaperclipIcon className="translate-y-px" />   {/* 视觉居中补偿 */}
</Button>
```
外层包了 `<div className="me-2">`（右外距 8px）。

## A5. 输入框上方的上下文条 / 附件区 / banner

### 附件缩略图行（`ComposerAttachmentStrip.tsx` L179-218）

```tsx
<div className={cn(
  "mb-3 flex max-w-full gap-2",
  /* 需要横滑时（快照/多图）： */
  "snap-x snap-proximity overflow-x-auto overscroll-x-contain pb-1 scrollbar-thumb-foreground/18 scrollbar-track-transparent [scrollbar-width:thin] [&::-webkit-scrollbar]:h-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-3 [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-foreground/18 [&::-webkit-scrollbar-thumb]:bg-clip-content [&::-webkit-scrollbar-thumb:hover]:bg-foreground/28 [&::-webkit-scrollbar-track]:mx-1 [&::-webkit-scrollbar-track]:bg-transparent",
  /* 否则： */ "flex-wrap")}
>
  <SnapShotAttachmentFrame
    className={cn(
      "group/attachment shrink-0 snap-start bg-background",
      source?.kind === "snap-shot" ? SNAP_SHOT_ATTACHMENT_FRAME_CLASS_NAME
                                   : "relative h-16 w-16 overflow-hidden rounded-lg border border-border/80",
    )} … />
</div>
```

> 缩略图 **64×64px**、`rounded-lg`（8px）、`border-border/80`。到达动画：
> `origin-center transition-[opacity,scale] duration-300 ease-drawer starting:scale-95 starting:opacity-0 motion-reduce:transition-none`。

### `ComposerBanner`（附加在 composer 上方的条）

```tsx
const surfaceColors = cn(
  "[--chat-composer-attached-surface:var(--chat-composer-glass-surface,var(--card))]",
  "dark:[--chat-composer-attached-surface:var(--chat-composer-glass-surface,var(--surface-raised))]",
  "[html[data-theme-id]_&]:[--chat-composer-attached-surface:var(--app-theme-surface-raised)]",
);

const neutralOutline = cn(
  "[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--contrast-foreground)_8%,transparent))]",
  "dark:[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--color-white)_5%,transparent))]",
  …
);

const variantColors = {
  default: neutralOutline,
  error:   "[--chat-composer-attached-outline:color-mix(in_srgb,var(--error)_32%,transparent)] [--chat-composer-attached-tint:color-mix(in_srgb,var(--error)_8%,transparent)]",
  info:    neutralOutline,
  success: neutralOutline,
  warning: "[--chat-composer-attached-outline:color-mix(in_srgb,var(--warning)_28%,transparent)] [--chat-composer-attached-tint:color-mix(in_srgb,var(--warning)_8%,transparent)]",
};

function Surface({ variant = "default", detached = false, className, ...props }) {
  return (
    <div
      data-composer-banner-surface={detached ? "detached" : "attached"}
      data-variant={variant}
      className={cn(
        surfaceColors,
        "relative isolate border-0 bg-transparent shadow-none [--chat-composer-attached-tint:transparent]",
        variantColors[variant],
        detached
          ? "[--chat-composer-attachment-overlap:0px] before:rounded-2xl"
          : "[--chat-composer-attachment-overlap:calc(1rem+1px)] before:rounded-t-2xl before:mask-t-from-transparent before:mask-t-from-4 before:mask-t-to-black before:mask-t-to-4",
        "before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:border before:border-(--chat-composer-attached-outline)",
        "before:bg-(--chat-composer-attached-surface)/(--glass-opacity) before:bg-linear-to-b before:from-(--chat-composer-attached-tint) before:to-(--chat-composer-attached-tint) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation)",
        "before:shadow-composer dark:before:shadow-composer-dark",
        !detached && "dark:supports-[(backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px))]:before:bg-composer-seam-above",
        "not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-attached-surface)",
        className,
      )}
      {...props}
    />
  );
}

function Attachment({ className, ...props }) {
  return (
    <div data-slot="composer-banner-attachment"
      className={cn(
        "mx-auto -mb-[calc(1rem+1px)] w-[calc(100%-2*var(--chat-composer-drawer-inset))]",
        … /* 相连时去掉上圆角与上边框 */
      )} {...props} />
  );
}

function Root({ className, density = "default", variant = "default", width = "fill", ...props }) {
  return (
    <Surface className={cn(
      "min-w-0 px-1 py-(--composer-banner-padding-block) after:block after:h-(--chat-composer-attachment-overlap) text-xs/4 [--composer-banner-corner-top:var(--radius-xl)] [--composer-banner-icon-column:--spacing(7)] [--composer-banner-padding-block:--spacing(1)] sm:[--composer-banner-icon-column:--spacing(6)]",
      density === "comfortable" && "[--composer-banner-padding-block:--spacing(1.25)]",
      density === "spacious" && "px-3 [--composer-banner-padding-block:--spacing(3)]",
      width === "content" ? "w-fit max-w-full flex-none" : "@container",
      …)} data-slot="composer-banner" data-composer-banner-width={width} variant={variant} {...props} />
  );
}

function Row({ className, render, layout = "inline", ...props }) {
  /* className: */
  "group/banner-row grid min-h-(--composer-banner-icon-column) w-full min-w-0 grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)_auto] items-center gap-x-1 text-start",
  "not-has-[>[data-slot=composer-banner-actions]]:grid-cols-[var(--composer-banner-icon-column)_minmax(0,1fr)]",
  "[&:is(button)]:cursor-pointer [&:is(button)]:rounded-xl [&:is(button)]:hover:bg-foreground/5 [&:is(button)]:focus-visible:outline-2 [&:is(button)]:focus-visible:-outline-offset-2 [&:is(button)]:focus-visible:outline-ring",
  layout === "wrap-actions" && "flex flex-wrap *:data-[slot=composer-banner-content]:max-w-[calc(100%-var(--composer-banner-icon-column)-var(--spacing))] *:data-[slot=composer-banner-content]:grow",
  layout === "approval" && "items-start gap-x-2 gap-y-3",
}

function Icon({ className, ...props }) {   /* data-slot="composer-banner-icon" */
  "col-start-1 row-start-1 flex w-(--composer-banner-icon-column) min-w-0 flex-none items-center justify-center text-muted-foreground [&>svg]:size-3",
  "group-data-[composer-banner-layout=approval]/banner-row:pt-0.5 group-data-[composer-banner-layout=approval]/banner-row:text-warning group-data-[composer-banner-layout=approval]/banner-row:[&>svg]:size-4",
}
function Content({ className, ...props }) { /* data-slot="composer-banner-content" */
  "col-start-2 row-start-1 flex min-w-0 items-center gap-1 *:data-[slot=composer-banner-separator]:mx-0", …
}
function Separator() { /* data-slot="composer-banner-separator" */
  "mx-1 inline-block flex-none text-muted-foreground/40"  /* 内容：· */
}
function Actions({ className, ...props }) { /* data-slot="composer-banner-actions" */
  "col-start-3 row-start-1 flex flex-wrap items-center justify-end gap-1", …
}
function Children({ className, render, ...props }) {
  "grid gap-px [&_[data-composer-banner-row]]:min-h-5",
}
function Scroll({ className, children, ...props }) {  /* ScrollArea */
  "h-auto max-h-[min(24rem,40dvh)]"
}
function Count({ className, ...props }) {
  "inline-flex min-w-(--composer-banner-icon-column,1em) flex-none justify-center font-medium text-muted-foreground tabular-nums",
}
function Body({ className, ...props }) { "min-w-0 ps-8 sm:ps-7"; }
function Dot({ className, ...props }) { "size-1.5 flex-none rounded-full bg-current"; }
function ToggleIcon({ expanded }) {
  <Button render={<span aria-hidden />} size="icon-xs" variant="ghost" tabIndex={-1} className="pointer-events-none">
    <ChevronDownIcon className={cn("size-3.5", !expanded && "rotate-180")} />
  </Button>
}
function Dismiss({ className, children, ...props }) {
  <Button size="icon-xs" variant="ghost" className={className}>{children ?? <XIcon className="size-3.5" />}</Button>
}
```

**关键几何**：`--chat-composer-drawer-inset: 1.375rem`（22px）→ 附加 banner 比 composer **左右各窄 22px**，并向下压住 **17px**（`calc(1rem+1px)`），只圆上边两角（`rounded-t-2xl`），顶部 4px 内做透明→黑的 mask 渐变实现「咬合」效果。

### 卡片下方的 `ContextStrip`（环境/worktree/分支）

```
group/composer-context relative flex w-full items-center gap-2 overflow-x-clip px-2 pt-2 text-muted-foreground
```

> 有 context row 时，卡片自身不画玻璃（`data-context-row:before:hidden`），改由这一行承载，视觉上「行贴在卡上」。

---

# B. 对话流（消息渲染）

## B1. 用户消息（`TimelineUserMessageRow.tsx`）

**容器（L830-834）**

```tsx
<div className="group @container flex flex-col items-end gap-1"
     data-user-message-attribution={folded ? "agent" : undefined}>
```

**气泡（L864-876）**

```tsx
<div className={cn(
  "relative min-w-0 max-w-[80%] rounded-2xl text-message-foreground",
  (mediaAboveText || row.groupedWithPrevious) && "rounded-tr-md",   /* 6px，与上一条/媒体收口 */
  row.groupedWithNext && "rounded-br-md",                            /* 6px */
  BUBBLE_CHIP_CLASS_NAME,   /* "[&_[data-slot=context-chip]]:[--context-chip-ink:var(--context-chip-message,var(--context-chip-accent))]" */
  userMessage.attribution === "guest"
    ? guestBubbleClassName(false)
    : !mediaOnly && !fileCardsOnly && !audioOnly && "bg-message",
  !folded && !mediaOnly && !fileCardsOnly && !audioOnly && "p-3",
  folded && expanded && "w-full",
)}>
```

| 属性 | 值 |
|---|---|
| 对齐 | `flex flex-col items-end` → 整组右对齐 |
| 气泡宽 | `max-width: 80%` |
| 圆角 | `rounded-2xl` = 16px；与上一条相邻时右上角 `rounded-tr-md` = 6px；与下一条相邻时右下角 6px |
| 背景 | `--message-surface`：`#edf3fe`（亮）/ `#2c2c2e`（暗） |
| 文字 | `--message-foreground`：`#0f1115` / `#f9fafb` |
| 内边距 | `p-3` = 12px |
| 头像 | **无**。`<MessageAuthorHeading>` 渲染 `<h3 class="sr-only select-none">You</h3>` |
| 署名行 | `me-1 text-2xs text-muted-foreground/70`（11px，仅 guest / t3code 归属时） |
| 底部行 | `mt-1.5 flex items-center justify-end gap-2` |
| Markdown 类 | `text-foreground user-message-markdown` + `lineBreaks` |

**媒体 + 文字组合（L857-862、L906-907）**：图片/视频在气泡**上方**单独成块（`flex max-w-[80%] justify-end`），最大 `w-80`（320px），`rounded-2xl`，相连的角收成 `rounded-tr-md` / `rounded-br-md`。

**文件卡片（L136-139）**

```tsx
<div className="flex w-64 max-w-full items-center gap-1 rounded-2xl bg-message py-2 ps-2 pe-1 text-message-foreground">
  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background/60">…</span>
  <span className="min-w-0 flex-1">
    <span className="block truncate text-sm font-medium group-hover/file:underline">{label}</span>
    <span className="block text-xs text-muted-foreground tabular-nums">{EXT} · {size}</span>
  </span>
</div>
```

**音频条**：`<InlineAudioPreview variant={audioOnly ? "bubble" : "chip"} />`，外层 `flex max-w-full flex-col gap-1` + `mb-2`。

**长消息折叠（L1118-1165）**

```tsx
const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK =
  `linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)`;

<div className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
     data-user-message-body="true" data-user-message-collapsed data-user-message-collapsible data-user-message-fade
     style={isCollapsed ? { WebkitMaskImage: MASK, maskImage: MASK } : undefined}>
  <UserMessageBody … />
</div>
{showCollapseControl && (
  <div className="mt-1.5 flex items-center justify-end gap-2" data-user-message-footer="true">
    <Button size="xs" variant="ghost-muted" className="-ml-1"
            aria-expanded={expanded}>{expanded ? "Show less" : "Show full message"}</Button>
  </div>
)}
```

**时间戳（`TimelineRowParts.tsx` L26-34）** —— 悬停才出现，浮在气泡**左侧**

```tsx
<span className={cn(
  "pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-muted-foreground text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100",
  alwaysVisible && "pointer-events-auto static opacity-100", className)} />
```
外层（L1029）：`absolute end-full top-1/2 me-2 hidden w-max max-w-[calc(20cqw-0.5rem)] -translate-y-1/2 @min-[37rem]:flex`

**guest 气泡（`guestMessageStyle.tsx`）**

```ts
export function guestBubbleClassName(pending: boolean): string {
  return pending ? "border border-dashed border-guest/50 bg-transparent" : "bg-guest-surface";
}
// 名字行：<p className="me-1 text-2xs text-guest-foreground">{name}<span className="sr-only"> (guest)</span></p>
// --guest-surface: color-mix(in srgb, var(--color-fuchsia-500) 14%, var(--message-surface));
// --color-fuchsia-500: oklch(66.7% 0.295 322.15)
```

**自动化长消息折叠头（L297-334）**

```tsx
<div className="group flex flex-col items-end gap-1" data-user-message-attribution="automation">
  <div className="min-w-0 max-w-[80%] rounded-2xl bg-message text-message-foreground">…</div>
  <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
    <button className="rounded-sm text-xs text-muted-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">…</button>
  </div>
</div>
```

## B2. Agent 消息 + `.chat-markdown` 排版

**容器（`TimelineAssistantRows.tsx` L38-83）**

```tsx
<div className="relative min-w-0 px-1 py-0.5">
  <MessageAuthorHeading>T3 Code</MessageAuthorHeading>     {/* sr-only */}
  <div data-thread-find-text="true">
    <AssistantCitationSource …>
      <ChatMarkdown text={messageText} cwd={ctx.markdownCwd} threadRef={…}
                    isStreaming={Boolean(row.message.streaming)}
                    lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
                    skills={ctx.skills} headingLevelOffset={MESSAGE_HEADING_LEVEL} … />
    </AssistantCitationSource>
  </div>
  {ctx.onOpenTurnDiff ? <AssistantChangedFilesSection … /> : null}
  {row.showAssistantMeta ? <AssistantMessageMeta className="mt-1.5" … /> : null}
</div>
```

**Markdown 根类（`ChatMarkdown.tsx` L1794-1800）**

```
chat-markdown w-full min-w-0 [overflow-wrap:anywhere] [word-break:break-word]
text-sm leading-relaxed text-foreground/[calc(90%+var(--appearance-contrast-boost)/10)]
```

> 即 **14px / 行高 1.625**，字色 `--foreground` 的 90%（对比度增强可调）。首子元素 `margin-top: 0`、末子元素 `margin-bottom: 0`。

**`.chat-markdown` 完整 CSS（`index.css` L1894-2327，原样）**

```css
/* Chat markdown rendering */

.chat-markdown > :first-child { margin-top: 0; }
.chat-markdown > :last-child  { margin-bottom: 0; }

.chat-markdown p,
.chat-markdown ul,
.chat-markdown ol,
.chat-markdown blockquote,
.chat-markdown pre,
.chat-markdown .chat-markdown-table-container,
.composer-tiptap ul,
.composer-tiptap ol {
  margin: 0.65rem 0;
}

.chat-markdown-math-display .katex-display { margin: 0; }

:is(.chat-markdown, .composer-tiptap) h1, h2, h3, h4, h5, h6 {
  margin: 1.25rem 0 0.5rem; font-weight: 600; line-height: 1.3;
  color: var(--contrast-foreground);
}
:is(.chat-markdown, .composer-tiptap) h1 { font-size: 1.25rem; }
:is(.chat-markdown, .composer-tiptap) h2 { font-size: 1.125rem; }
:is(.chat-markdown, .composer-tiptap) h3 { font-size: 1rem; }
:is(.chat-markdown, .composer-tiptap) h4,
:is(.chat-markdown, .composer-tiptap) h5,
:is(.chat-markdown, .composer-tiptap) h6 { font-size: 0.875rem; }
:is(.chat-markdown, .composer-tiptap) h6 { color: var(--contrast-muted-foreground); }

:is(.chat-markdown, .composer-tiptap) ul {
  --list-gutter: 1.25rem; padding-inline-start: 1.25rem; list-style-type: disc;
}
:is(.chat-markdown, .composer-tiptap) ol {
  --list-gutter: 1.25rem; padding-inline-start: var(--list-gutter, 1.25rem);
  list-style-type: decimal;
}
:is(.chat-markdown, .composer-tiptap) ol > li::marker { font-variant-numeric: tabular-nums; }
:is(.chat-markdown, .composer-tiptap) ul ul { list-style-type: circle; }
:is(.chat-markdown, .composer-tiptap) ul ul ul { list-style-type: square; }
.chat-markdown ol ol { list-style-type: lower-alpha; }
.chat-markdown ol ol ol { list-style-type: lower-roman; }
.chat-markdown.user-message-markdown ol { list-style-type: decimal; }
.chat-markdown li + li { margin-top: 0.25rem; }

.chat-markdown li.task-list-item { list-style-type: none; }
.chat-markdown li.task-list-item input[type="checkbox"] {
  margin-block: 0 0.15em;
  margin-inline: calc(-1 * var(--list-gutter, 1.25rem)) 0.35em;
  vertical-align: middle;
}

.chat-markdown img { display: inline-block; }
.chat-markdown a { text-decoration: none; }
.chat-markdown a:not(.chat-markdown-file-link, :has([data-slot="context-chip-label"])) {
  color: var(--info-foreground);
}
.chat-markdown a:not(.chat-markdown-file-link, :has([data-slot="context-chip-label"]), [data-markdown-image-link]):hover,
.chat-markdown a:not(.chat-markdown-file-link, :has([data-slot="context-chip-label"]), [data-markdown-image-link]):focus-visible {
  background-image: radial-gradient(circle, currentcolor 0.75px, transparent 1px);
  background-position: left bottom;
  background-repeat: repeat-x;
  background-size: 4px 2px;
}

:is(.chat-markdown, .composer-tiptap) blockquote {
  border-inline-start: 2px solid color-mix(in srgb, currentcolor 35%, transparent);
  padding-inline-start: 0.8rem;
  color: inherit;
}

:is(.chat-markdown, .composer-tiptap) hr {
  @variant dark { border-color: var(--contrast-muted-foreground); }
}

.chat-markdown section[data-footnotes] {
  margin-top: 1.25rem;
  border-top: 1px solid var(--contrast-border);
  padding-top: 0.75rem;
  color: var(--contrast-muted-foreground);
  font-size: 0.75rem;
}
.chat-markdown section[data-footnotes] ol { margin: 0; }
.chat-markdown section[data-footnotes] li + li { margin-top: 0.35rem; }

.chat-markdown a[data-footnote-ref],
.chat-markdown a[data-footnote-backref] {
  display: inline-flex; min-width: 1rem; align-items: center; justify-content: center;
  border-radius: 0.25rem; text-decoration: none; font-size: 0.6875rem; font-weight: 600;
}

/* ---- 行内代码 ---- */
.chat-markdown :not(pre) > code {
  border: 1px solid transparent;
  border-radius: 0.25rem;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  background: color-mix(in srgb, var(--contrast-foreground) 10%, transparent);
  padding: 0.1em 0.35em;
  color: var(--contrast-foreground);
  font-size: 0.85em;
}

.chat-markdown strong { font-weight: 700; }

/* ---- 裸代码块（无 header） ---- */
.chat-markdown pre {
  max-width: 100%;
  overflow-x: auto;
  border: 1px solid var(--contrast-border);
  border-radius: 0.5rem;
  background: var(--muted);
  padding: 0.8rem 0.9rem;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--contrast-border) 78%, transparent) transparent;
}
.chat-markdown pre code { border: none; background: transparent; padding: 0; }
.chat-markdown pre::-webkit-scrollbar { height: var(--app-scrollbar-width); }
.chat-markdown pre::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--contrast-border) 78%, transparent);
}

:is(.chat-markdown, .composer-tiptap) .chat-markdown-codeblock-header {
  color: color-mix(in srgb, var(--contrast-foreground) 72%, transparent);
}
:is(.chat-markdown, .composer-tiptap) .chat-markdown-codeblock pre {
  margin: 0; border: none; border-radius: 0; background: transparent;
}
:is(.chat-markdown, .composer-tiptap) .chat-markdown-codeblock[data-wrap="true"] pre {
  white-space: pre-wrap; overflow-wrap: anywhere;
}
:is(.chat-markdown, .composer-tiptap) .chat-markdown-shiki :is(.shiki, .diffs) {
  background: transparent !important;
}
/* Plain-text fences override the highlighter's inline foreground colors. */
:is(.chat-markdown, .composer-tiptap)
  .chat-markdown-codeblock:is([data-language="text" i], [data-language="txt" i],
                              [data-language="plain" i], [data-language="plaintext" i]) {
  &, & :is(pre, pre *) { color: inherit !important; }
}

/* ---- 流式淡入 ---- */
@media (prefers-reduced-motion: no-preference) {
  .chat-markdown[data-streaming] > *,
  .chat-markdown[data-streaming] .chat-markdown-shiki,
  .chat-markdown[data-streaming] .chat-markdown-mermaid {
    transition: opacity 600ms ease-out;
    @starting-style { opacity: 0; }
  }
}

/* ---- 表格 ---- */
.chat-markdown table {
  width: 100%; border-collapse: collapse; overflow-wrap: normal; word-break: normal;
  font-size: 0.875rem;   /* 比正文小一档，15px 下一档 */
}
.chat-markdown th, .chat-markdown td {
  padding: 0.45rem 0.75rem; text-wrap: pretty; text-align: start; vertical-align: top;
}
.chat-markdown :is(th, td):first-child { padding-inline-start: 0; }
.chat-markdown :is(th, td):last-child  { padding-inline-end: 0; }
.chat-markdown thead th {
  border-bottom: 1px solid color-mix(in srgb, var(--contrast-border) 60%, transparent);
  padding-block: 0.55rem; font-weight: 600;
}
.chat-markdown tbody td {
  border-bottom: 1px solid color-mix(in srgb, var(--contrast-border) 60%, transparent);
}
.chat-markdown :is(th, td) { max-width: 24rem; overflow-wrap: break-word; }
.chat-markdown :is(th, td):has([data-markdown-math]) { max-width: none; }
.chat-markdown .chat-markdown-table-container
  [data-slot="scroll-area-scrollbar"][data-orientation="horizontal"] {
  opacity: 1;
  --app-scrollbar-thumb: color-mix(in srgb, var(--muted-foreground) 60%, transparent);
  --app-scrollbar-thumb-hover: color-mix(in srgb, var(--muted-foreground) 80%, transparent);
}
```

**主题化时代码块改色（L1548-1565）**

```css
html[data-theme-id] :is(.chat-markdown, .composer-tiptap) .chat-markdown-codeblock {
  background-color: var(--code-background);
  border-color: var(--contrast-border);
  color: var(--code-foreground);
}
html[data-theme-id] .chat-markdown pre {
  background-color: var(--code-background);
  color: var(--code-foreground);
}
html[data-theme-id] :is(.chat-markdown, .composer-tiptap) .chat-markdown-codeblock pre {
  background-color: transparent;
}
html[data-theme-id] :is(.chat-markdown, .composer-tiptap) .chat-markdown-codeblock-header {
  color: color-mix(in srgb, var(--code-foreground) 72%, transparent);
}
```

**代码字号（L1823-1827）**

```css
.chat-markdown .chat-markdown-shiki :is(.shiki, .diffs),
.chat-markdown .chat-markdown-codeblock pre,
:is(.chat-markdown, .composer-tiptap) pre code {
  font-size: var(--font-size-code, inherit);
}
/* --font-size-code 默认 13px（DEFAULT_CODE_FONT_SIZE）*/
```

**图片（`ChatMarkdownMedia.tsx` L24-34）**

```
max-w-[min(100%,30rem)] max-h-[30rem] h-auto w-auto object-contain
frame: rounded-lg border border-border/40
```

**`<details>` 折叠（`MarkdownDetails.tsx`）**

```tsx
<div className="my-2 border-y border-border/60">
  <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left text-sm font-medium text-foreground data-panel-open:[&_svg]:rotate-90">
    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform" />
    <span>{summary}</span>
  </CollapsibleTrigger>
  <CollapsiblePanel hiddenUntilFound={searching}>
    <div className="pb-3 ps-6 text-foreground/[calc(90%+var(--appearance-contrast-boost)/10)]">{content}</div>
  </CollapsiblePanel>
</div>
```

**告警块（`ChatMarkdown.tsx` L1012-1018）**：`className={cn("my-1 border-s-2 ps-3", alert.borderClassName)}` + `flex items-center gap-1.5 font-medium` + `size-3.5` 图标。

**工件模板卡（`ChatMarkdown.tsx` L290-304）**：`my-[0.65rem] flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5 text-foreground shadow-xs`；图标槽 `size-9 rounded-lg border border-border/70 bg-background text-muted-foreground shadow-xs`，图标 `size-5`。

## B3. 代码块（`.chat-markdown-codeblock`）

**`MarkdownCodeBlock.tsx` L42-91（Frame）**

```tsx
<Wrapper dir="ltr"
  className="chat-markdown-codeblock my-[0.65rem] text-start overflow-hidden rounded-lg border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
  data-language={language} data-wrap={wrapped ? "true" : "false"}>
  <div {...headerProps}
       className={cn("chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none", headerProps?.className)}>
    {title ?? (
      <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs">
        <MarkdownCodeBlockTitleContent fenceTitle={fenceTitle} language={language} theme={theme} />
      </span>
    )}
    {actions}
  </div>
  {children}
</Wrapper>
```

| 部分 | 样式 |
|---|---|
| 外框 | `rounded-lg`（8px）、`border-border/70`、`bg-secondary`（`#f5f6f7` 亮 / `#353638` 暗）、暗色 `bg-input/32` 且无边框、`overflow-hidden`、`leading-snug`（1.375）、上下外距 0.65rem |
| header | `flex items-center justify-between gap-2`，`pt-1.5 pr-1.5 pb-0 pl-3`（6/6/0/12px），`select-none`，字色 `--contrast-foreground` 72% |
| header 标题 | `inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs`（**11px** 等宽），文件图标 `size-3.5` |
| pre | `margin:0; border:none; border-radius:0; background:transparent` |
| 代码字号 | `var(--font-size-code, inherit)` = **13px** |
| 换行开关 | `data-wrap="true"` → `white-space: pre-wrap; overflow-wrap: anywhere` |
| shiki | `.chat-markdown-shiki :is(.shiki,.diffs) { background: transparent !important }` |

**动作按钮（L181-260）**：`<Button variant="ghost-muted" size="icon-xs">`（`size-7 sm:size-6`），图标 `size-3`（Copy / Check / WrapText / Play），tooltip `side="top"`。复制成功 1200ms 后图标回弹。

**复制按钮**

```tsx
<TooltipTrigger render={<Button type="button" variant="ghost-muted" size="icon-xs" onClick={handleCopy} aria-label={copyLabel} />}>
  {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
</TooltipTrigger>
```

**语法高亮**：Shiki（`codeToHtml` / 增量 `createIncrementalHighlightedDocument`），LRU 缓存 500 条 / 50MB，主题名 `resolveDiffThemeName(resolvedTheme)`；纯文本语言（text/txt/plain/plaintext）强制 `color: inherit !important`。

**Mermaid**：`MarkdownMermaidCodeBlock.tsx`，外层 `<div className="my-[0.65rem] border border-transparent">`，动作行 `flex items-center justify-end gap-0.5 pt-1.5 pr-1.5 select-none`。

## B4. 工具调用 / 命令执行卡片

t3code 的工具行**不是卡片**，而是「WorkLog 行」：6px 圆角的可点击行 + 24px 图标槽 + 缩进输出。

### `WorkLog.tsx`（原样）

```tsx
export function WorkLogBlock({ layout = "standalone", continues = false, children }) {
  return (
    <div className={continues || layout === "group-header" ? "pb-0"
                    : layout === "group-content" ? "pb-1" : "pb-2"}>
      {children}
    </div>
  );
}

export function WorkLogList({ children }) {
  return <GroupedRows value><div className="flex min-w-0 flex-col">{children}</div></GroupedRows>;
}

function WorkLogLine({ icon, label, trailing, wrapLabel }) {
  return (
    <div className={cn(
      "flex min-h-6 min-w-0 gap-1.5 text-sm leading-relaxed select-none [&_*]:select-none",
      wrapLabel ? "items-start" : "items-center")}>
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {icon ? (
          <span className="relative w-6 shrink-0 leading-0">
            <span className="inline-block size-6 overflow-hidden align-[calc(0.5cap_-_0.75rem)]">
              <span className="flex size-full items-center justify-center">{icon}</span>
            </span>
          </span>
        ) : null}
        <div className={cn("min-w-0 flex-1 text-secondary-label", !wrapLabel && "truncate [&_*]:whitespace-nowrap")}>
          {label}
        </div>
      </div>
      {trailing}
    </div>
  );
}

const interactionClassName =
  "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

function useRowClassName(interactive: boolean) {
  const grouped = use(GroupedRows);
  return cn(
    "group/timeline-row relative w-full min-w-0 rounded-md px-0.5 text-left transition-colors",
    grouped ? "py-0" : "py-0.5",
    interactive && interactionClassName,
  );
}
```

### `WorkLogDetails`（展开输出）

```tsx
<div className={cn("cursor-auto",
  kind === "text"   ? "ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text"
  : kind === "panel" ? "mt-0.5 mb-1.5 pb-2"
  : "mt-1")} …>
```

### `TimelineWorkEntryRow.tsx`（单条工具行）

**图标与标题配色（L389-407）**

```tsx
const iconWrapperClass = cn(
  "flex size-4 items-center justify-center",
  showWarningIndicator ? "text-warning"
  : showDestructiveRowStyle ? "text-destructive"
  : showFailedIndicator ? failedToolIconClassName        /* "text-tool-error-icon/40" */
  : workEntry.tone === "tool" ? "text-icon-muted"
  : iconConfig.className,
);
const headingClass = showWarningIndicator ? "font-medium text-warning"
  : showDestructiveRowStyle ? "font-medium text-destructive"
  : workLogEntryIsToolLike(workEntry) ? "text-secondary-label"
  : "text-foreground/80";
```

**行结构（L431-544）**

```tsx
<WorkLogRow data-v2-item-type={workEntry.projectedItem?.item.type}
            data-v2-item-visibility={workEntry.projectedItem?.visibility}
            {...rowToggleProps}                    /* role=button, aria-expanded, onClick, onKeyDown */
  icon={<span className={iconWrapperClass} role={showFailedIndicator ? "img" : undefined}
               aria-label={showFailedIndicator ? "Tool call failed" : undefined}>
          <ToolActivityIconView icon={entryToolIcon} fallbackName={entryIconName}
                                className="block size-4 shrink-0 stroke-2" muted />
        </span>}
  label={
    <div className="min-w-0 flex-1 overflow-hidden">
      <p className="flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed">
        <span className={cn(answerPreview ? "min-w-0" : "min-w-0 flex-1", "truncate", headingClass)}>
          {isReasoning && !expanded ? <ChatMarkdown inline … />
           : threadLabel ? <ThreadReadLabel label={threadLabel} … linked />
           : previewText}
        </span>
        {answerPreview ? <span className={cn("min-w-0 truncate", … ? "text-foreground" : "text-muted-foreground")}>{answerPreview}</span> : null}
      </p>
    </div>
  }
  trailing={<>
    {createdThread ? <button className="shrink-0 rounded-sm text-sm text-primary hover:underline …">Open chat</button> : null}
    {notifiedSubagentThreadId ? <InlineButton aria-label="Open subagent thread">Open subagent</InlineButton> : null}
    {showFailedIndicator && !showDestructiveRowStyle && !toolIconAcceptsTint(entryToolIcon)
      ? <XIcon aria-hidden className={cn("size-3 shrink-0", failedToolIconClassName)} /> : null}
    <TimelineRowTimestamp createdAt={workEntry.createdAt} timestampFormat={timestampFormat} />
    <span className={cn("flex size-4 shrink-0 items-center justify-center", !canExpandProjectedItem && "invisible")} aria-hidden>
      <ChevronRightIcon className={cn("size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200", expanded && "rotate-90")} />
    </span>
  </>}
>
  {expanded && viewedImage ? <WorkLogDetails kind="media">…</WorkLogDetails> : null}
  {expanded && workEntry.questionAnswer ? <QuestionAnswerHistory answer={…} /> : null}
  {expanded && isReasoning ? <ReasoningTraceContent entries={[workEntry]} /> : null}
  {expanded && !isReasoning && !workEntry.questionAnswer && canExpandProjectedItem && (…) ? (
    <WorkLogDetails kind="panel">
      {workEntry.projectedItem && plainOutput === undefined
        ? <V2ItemInspector projectedItem={…} environmentId={…} cwd={…} workspaceRoot={…}
                           onOpenToolDiff={…} onImageExpand={…} source={ctx.turnItemSource} />
        : (<>
            {expandedBody ? <pre className={toolCallExpandedBodyClassName}>{expandedBody}</pre> : null}
            {plainOutputFetches && workEntry.projectedItem ? <FetchedToolOutput … /> : null}
          </>)}
    </WorkLogDetails>
  ) : null}
</WorkLogRow>
```

**两个等宽类（L115-116、`V2ItemInspector.tsx` L65-66）**

```
toolCallExpandedBodyClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono
   text-secondary-label text-(length:--font-size-code,var(--text-2xs)) leading-relaxed select-text"

monoClassName =
  "font-mono text-(length:--font-size-code,var(--text-2xs)) leading-relaxed
   whitespace-pre-wrap break-words select-text"
```

### `V2ItemInspector.tsx`（展开后的详细内容）

```tsx
<div className="space-y-2 text-xs" data-v2-item-inspector={item.type}>
  {/* reasoning */}
  <div className="rounded-md border border-border/45 bg-muted/15 p-2 italic text-muted-foreground">
    <ChatMarkdown text={item.text} … lineBreaks />
  </div>

  {/* command_execution → ToolCallBody */}
  <div className={cn("space-y-1.5", monoClassName)}>
    <ToolOutputImages … />
    {call.command ? <ShellCommandBlock command={call.command} /> : null}
    {call.args ? <div className="text-foreground/85">
      {call.args.map(([key, value]) => (
        <div key={key}><span className="text-muted-foreground">{key} </span>{…}</div>
      ))}
    </div> : null}
    {call.argsText ? <StructuredValue value={call.argsText} highlightJson /> : null}
    {props.outputSlot ?? <ToolOutput … />}
    {props.exitCode !== undefined && props.exitCode !== 0
      ? <div className="text-destructive">exit {props.exitCode}</div> : null}
  </div>

  {/* file_change */}
  <div className="flex flex-wrap items-center gap-2">
    <span className="font-mono text-muted-foreground">{formatWorkspaceRelativePath(item.fileName, props.workspaceRoot)}</span>
    <span><span className="text-diff-addition">+{n}</span> <span className="text-diff-deletion">-{n}</span></span>
    <Button size="xs" variant="outline">Open diff</Button>
  </div>

  {/* StructuredValue */}
  <pre className={cn("max-h-80 overflow-auto text-muted-foreground", monoClassName)}>…</pre>
</div>
```

**命令输出面板（`CommandOutputPanel.tsx` L56-79）**

```tsx
<div className="max-h-80 overflow-auto text-muted-foreground">
  {data?.output.truncated ? <div className="italic">Earlier output not shown</div> : null}
  {spans.map(…)}   {/* 终端 ANSI 着色 */}
</div>
```
空态：`<div className="text-muted-foreground italic">Loading output…</div>` / `No output.` / 错误 `text-destructive`。

**ShellCommandBlock（`ShellCommandBlock.tsx` L50-63）**

```tsx
<div className="text-foreground/85">
  <RenderErrorBoundary fallback={plain} resetKeys={[code]}>
    <Suspense fallback={plain}>
      <HighlightedCommand code={code} theme={resolvedTheme} />
    </Suspense>
  </RenderErrorBoundary>
</div>
/* 每个词：<span className="inline-block max-w-full [overflow-wrap:anywhere]"> */
```

### 工具组折叠头 / 实时行

**`WorkGroupToggleTimelineRow` → `WorkGroupHeader`（`TimelineWorkGroupRows.tsx` L608-637）**

```tsx
<WorkLogButton aria-label={props.failed ? `${props.label}, tool call failed` : props.label}
               aria-expanded={props.expanded} onClick={props.onToggle}
  icon={<ToolActivityIconView icon={props.toolIcon} fallbackName={props.iconName}
                              className="size-4 shrink-0 stroke-2 text-icon-muted" muted />}
  label={<span className="block truncate">{props.label}</span>}
  trailing={<TimelineRowTimestamp createdAt={props.createdAt} timestampFormat={props.timestampFormat} />}
/>
```

**`LiveWorkEntryTimelineRow`（L512-584）**：外层 button `group/live-work flex w-full max-w-full cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70`；有思考行时 `flex-col items-start`，否则 `min-h-6 items-center`。

**`LiveActivityRow`（L406-424）**

```tsx
<div className="relative min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed">
  <LiveActivityContent … active={animated && !shimmer} />
  {showShimmer ? <ActivityShimmerOverlay><LiveActivityContent … highlighted /></ActivityShimmerOverlay> : null}
</div>
```

**状态 → 颜色映射（`V2LifecycleRow.tsx` L173-182）**

```ts
const SUBAGENT_STATUS_VISUAL = {
  pending:    { dotClass: "bg-info",                    label: "Queued" },
  running:    { dotClass: "bg-info",                    label: "Running" },
  waiting:    { dotClass: "bg-info",                    label: "Waiting" },
  idle:       { dotClass: "bg-muted-foreground/50",     label: "Idle · resumable" },
  completed:  { dotClass: "bg-success",                 label: "Completed" },
  failed:     { dotClass: "bg-destructive",             label: "Failed" },
  cancelled:  { dotClass: "bg-muted-foreground/60",     label: "Stopped" },
  interrupted:{ dotClass: "bg-muted-foreground/60",     label: "Stopped" },
};
```

**状态点（`V2LifecycleRow.tsx` L255-261）**

```tsx
<span className={cn("absolute size-2 rounded-full ring-2 ring-background",
                    showBadge ? "-left-px -top-px" : "-right-px -bottom-px",
                    subagentStatusVisual(status).dotClass)} />
```

**Subagent 头像（L233-263）**

```tsx
<span className={cn("relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted ring-2 ring-background", className)}>
  <ProviderInstanceIcon … iconClassName="size-3.5" />
</span>
```

**Subagent 组折叠（`TimelineV2EventRow.tsx` L91-161）**

```tsx
<WorkLogBlock continues={row.continuesWorkLog}>
  <Collapsible open={expanded} onOpenChange={toggleExpanded} data-subagent-group>
    <CollapsibleTrigger className={cn(
      "flex w-full min-w-0 items-center gap-2.5 py-2 pr-3.25 text-left transition-opacity hover:opacity-100",
      expanded || summary.active ? "text-foreground opacity-100" : "text-muted-foreground opacity-55")}>
      <span className="flex shrink-0 items-center -space-x-1.5">…avatars…</span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold">{label}</span>
        <span className={cn("block truncate text-3xs text-muted-foreground",
                            summary.active ? "text-info" : summary.failed && "text-destructive")}>{statusSummary}</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums"><SubagentElapsed … /></span>
      <ChevronDownIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} />
    </CollapsibleTrigger>
    <CollapsiblePanel animate={false}>
      {expanded ? <div className="mt-1 mb-1 rounded-lg border border-border/60 bg-card/30 p-1">…</div> : null}
    </CollapsiblePanel>
  </Collapsible>
</WorkLogBlock>
```

**Subagent 链接行（L504-529）**

```
group/subagent flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left
+ cursor-pointer transition-colors hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70
标题 text-xs font-medium text-foreground；detail text-2xs（failed → text-destructive，否则 text-muted-foreground）
```

## B5. 思考过程（reasoning）折叠

**`AssistantReasoningBlock.tsx`（原样）**

```tsx
<Collapsible open={open} onOpenChange={handleOpenChange}
  className="assistant-reasoning-block mb-2 rounded-md border border-border/50 bg-muted/30"
  data-reasoning-streaming={streaming ? "true" : "false"}
  data-reasoning-open={open ? "true" : "false"}>
  <CollapsibleTrigger
    className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted/50 data-panel-open:[&_svg:first-child]:rotate-90"
    data-scroll-anchor-ignore>
    <ChevronRightIcon className="size-3.5 shrink-0 transition-transform" aria-hidden />
    <BotIcon className="size-3.5 shrink-0" aria-hidden />
    <span>{t(streaming ? "chat.reasoning.thinking" : "chat.reasoning.completed")}</span>
    {streaming ? <span className="animate-pulse text-muted-foreground/70">...</span> : null}
  </CollapsibleTrigger>
  <CollapsiblePanel>
    <div className="ms-2.5 border-s-2 border-border/50 pb-2.5 pe-2.5 ps-2.5 text-sm text-muted-foreground/90"
         data-reasoning-content="">
      <ChatMarkdown text={text} cwd={markdownCwd} threadRef={threadRef} isStreaming={streaming} skills={skills} />
    </div>
  </CollapsiblePanel>
</Collapsible>
```

| 属性 | 值 |
|---|---|
| 外框 | `rounded-md`（6px）、`border-border/50`、`bg-muted/30`、`mb-2` |
| 触发器 | `px-2.5 py-1.5`（10/6px）、`text-xs font-medium`、`text-muted-foreground`、hover `bg-muted/50`、图标 `size-3.5` |
| 面板 | `ms-2.5 border-s-2 border-border/50 pb-2.5 pe-2.5 ps-2.5 text-sm text-muted-foreground/90` |
| 默认展开 | 流式中默认开；结束后自动关 |
| 流式指示 | 文字后跟 `animate-pulse` 的 `...` |

**行内 reasoning（工具行内的思考，`TimelineWorkEntryRow.tsx` L120-131 + `ReasoningTraceContent`）**

```tsx
<WorkLogDetails followLive={entries.some(isStreaming)}>
  {entries.map((entry) => (
    <ChatMarkdown key={entry.id} className="text-foreground" … />
  ))}
</WorkLogDetails>
```

**思考实时行（`TimelineWorkGroupRows.tsx` L361-387）**

```tsx
export function ThinkingTimelineRow({ row }) {
  …
  const activity = <LiveActivityRow label={liveAnswerPreview ?? "Thinking"} iconName="brain"
                                    active={live} shimmer={live} />;
  const { groupId } = row;
  if (groupId === undefined) return activity;
  return (
    <button type="button"
      className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-expanded={row.expanded === true}
      onClick={() => ctx.onToggleWorkGroup(groupId, row.id)}>
      {activity}
    </button>
  );
}
```

## B6. 消息间距 / 时间线布局

**是否居中单列**：是。`.chat-content-lane` 居中，`max-width: var(--chat-content-max-width)`。

**`index.css` L953-962（`@layer components`）**

```css
.chat-content-lane {
  margin-inline: auto;
  width: 100%;
  min-width: 0;
  max-width: var(--chat-content-max-width);
}
.messages-timeline-row-frame { padding-inline: 0; }
```

**宽度档位（L2319-2327）**

```css
:root { --chat-content-max-width: 46rem; }              /* 736px 默认 */
:root[data-chat-width="wide"] { --chat-content-max-width: 72rem; }   /* 1152px */
:root[data-chat-width="full"] { --chat-content-max-width: 100%; }
```

**行间距（`MessagesTimeline.tsx` L1448-1472）**

| 行类型 | 底部内衬 |
|---|---|
| 默认 | `pb-4`（16px） |
| assistant 消息（无 meta） | `pb-2`（8px） |
| user 消息 `groupedWithNext` | `pb-1`（4px） |
| `event` / `worktree-setup` / `html-render` / `mcp-app` / `viewed-images` / `attempt-fold` | `pb-2` |
| `turn-fold` / `working` | `pb-1.5`（6px） |
| `WorkLogBlock` standalone / group-content / group-header | `pb-2` / `pb-1` / `pb-0` |

**列表头尾**：`<div className="h-3 sm:h-4" />`（12/16px）。

**滚动容器（L1355-1358）**

```
messages-timeline-scroll scrollbar-gutter-both h-full min-h-0 overflow-x-hidden
overscroll-y-contain [overflow-anchor:none] [topFadeEnabled && "topbar-scroll-fade"]
```

**空态（L1288-1294）**：`flex h-full items-center justify-center` + `<p className="text-sm text-muted-foreground">Send a message to start the conversation.</p>`

**历史控制（L1391-1409）**

```tsx
<div className="messages-timeline-row-frame">
  <div className="chat-content-lane flex flex-col gap-1.5 pb-2">
    <button className="flex w-full cursor-pointer items-center gap-3 py-1.5 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default">
      <span aria-hidden className="h-px flex-1 bg-border/70" />
      <span className="shrink-0">…</span>
      <span aria-hidden className="h-px flex-1 bg-border/70" />
    </button>
    <p role="status" className="text-center text-muted-foreground text-xs">…</p>
  </div>
</div>
```

**加载骨架（L1638-1644）**

```tsx
<div role="status" aria-label="Loading work history" className="space-y-2 px-1 pb-1 pt-3">
  <div className="flex items-center gap-2" aria-hidden>
    <Skeleton className="size-3 shrink-0" />
    <Skeleton className={index === 0 ? "h-2.5 w-2/5" : index === 1 ? "h-2.5 w-3/5" : "h-2.5 w-1/3"} />
  </div>
</div>
```

**系统分割线（`TimelineSystemDivider.tsx`）**

```tsx
<div className={cn("flex min-w-0 items-center gap-2 py-2 text-2xs text-muted-foreground",
                  props.tone === "danger" && "text-destructive")}>
  <span aria-hidden className="h-px flex-1 bg-border/70" />
  <button className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70">
    {Icon && <Icon className="size-3 shrink-0" />}
    <span className="font-medium">{props.label}</span>
    <span className="inline-flex min-w-0 items-center opacity-70 max-w-80 truncate">· {props.detail}</span>
  </button>
  <span aria-hidden className="h-px flex-1 bg-border/70" />
</div>
```

**回滚到底部按钮（`TimelineOverlays.tsx` L31-53）**

```tsx
<div className="chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center py-1.5"
     style={{ bottom: props.bottom }}>
  <Button data-scroll-to-end="true" onPointerDown={(e) => e.preventDefault()}
          onClick={props.onScrollToEnd} className="pointer-events-auto" size="xs" variant="glass">
    <ChevronDownIcon className="size-3.5" />
    Scroll to end
    {props.summary && <span className="text-muted-foreground"><span aria-hidden>· </span>{props.summary}</span>}
  </Button>
</div>
```
`variant="glass"` = `surface-glass rounded-full border-border/60 text-foreground shadow-sm`。

**文件拖放浮层（L5-20）**

```tsx
<div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]">
  <div role="status" className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg">
    <PaperclipIcon className="size-4 text-primary" /> Drop files to attach
  </div>
</div>
```

## B7. 「正在输入 / 工作中」指示器

**核心是两层叠加的 shimmer（`TimelineRowParts.tsx` L44-54 + `index.css` L605-661）**

```tsx
export function ActivityShimmerOverlay({ children }) {
  return (
    <span aria-hidden className="live-activity-focus pointer-events-none absolute inset-y-0 select-none">
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-foreground">{children}</span>
      </span>
    </span>
  );
}
```

```css
@keyframes live-tool-shine {
  from { background-position: -4.5rem 0, 0 0; }
  to   { background-position: calc(100% + 4.5rem) 0, 0 0; }
}

@utility live-tool-shine {
  @media (prefers-reduced-motion: no-preference) and (forced-colors: none) {
    color: transparent;
    background-image:
      linear-gradient(to right, transparent, var(--contrast-foreground), transparent),
      linear-gradient(var(--contrast-secondary-label), var(--contrast-secondary-label));
    background-size: 4.5rem 100%, 100% 100%;
    background-repeat: no-repeat;
    background-clip: text;
    animation: live-tool-shine 2.2s steps(30) infinite;
    animation-play-state: var(--visible-animation-state, paused);
  }
}

@keyframes live-activity-focus        { from { transform: translateX(0); } to { transform: translateX(100%); } }
@keyframes live-activity-focus-counter{ from { transform: translateX(0); } to { transform: translateX(-100%); } }

@utility live-activity-focus {
  --live-activity-focus-width: 4.5rem;
  right: auto;
  left: calc(-1 * var(--live-activity-focus-width));
  width: calc(100% + var(--live-activity-focus-width) + var(--live-activity-focus-width));
  -webkit-mask-image: linear-gradient(to right,
    transparent 0, rgb(0 0 0 / 12%) 0.675rem, rgb(0 0 0 / 55%) 1.575rem,
    black 2.25rem, rgb(0 0 0 / 55%) 2.925rem, rgb(0 0 0 / 12%) 3.825rem,
    transparent var(--live-activity-focus-width), transparent 100%);
  mask-image: /* 同上 */;
  mask-repeat: no-repeat;
  animation: live-activity-focus 2.2s steps(30) infinite;
  animation-play-state: var(--visible-animation-state, paused);
  will-change: var(--visible-animation-will-change, auto);
  @media (prefers-reduced-motion: reduce), (forced-colors: active) {
    animation: none; opacity: 0; will-change: auto;
  }
}

@utility live-activity-focus-counter {
  width: 100%;
  animation: live-activity-focus-counter 2.2s steps(30) infinite;
  animation-play-state: var(--visible-animation-state, paused);
  will-change: var(--visible-animation-will-change, auto);
  @media (prefers-reduced-motion: reduce), (forced-colors: active) { animation: none; will-change: auto; }
}

@utility live-activity-focus-aligned {
  width: calc(100% - var(--live-activity-focus-width) - var(--live-activity-focus-width));
  margin-left: var(--live-activity-focus-width);
}
```

> 效果：底层是 `--contrast-secondary-label` 灰色的普通文字；上层一份 `--contrast-foreground` 高亮文字被一个 4.5rem 宽的「柔边透镜」mask 从左到右扫过（`steps(30)`、2.2s、循环）。这就是「文字在思考」的观感。`--visible-animation-state` 由 IntersectionObserver 控制，滚出视口自动 `paused`。

**其它指示器**

| 场景 | 类 |
|---|---|
| 状态脉冲（通用） | `animate-status-pulse` = `status-pulse 2s infinite`，`0-40% opacity:1`、`50-90% opacity:.5`，`steps(6)` |
| 状态 ping | `animate-status-ping` = `status-ping 2s infinite`，`0% opacity:.9 scale:.75` → `40-100% opacity:0 scale:2`，`steps(8)` |
| 骨架 | `animate-skeleton` = `skeleton 2.4s infinite`，`0-42% opacity:1` / `50-92% opacity:.55`，`steps(4)` |
| 旋转 | `visible-animate-spin` = `animation: var(--animate-spin); animation-play-state: var(--visible-animation-state, paused)` |
| 录制点 | `size-1.5 shrink-0 rounded-full bg-primary` |
| 思考省略号 | `animate-pulse text-muted-foreground/70` |

**压缩中（`TimelineWorkGroupRows.tsx` L346-359）**

```tsx
<span className="inline-flex items-center gap-1.5">
  <Minimize2Icon aria-hidden className="size-3" />
  {createdAt ? <span>Compacting for <WorkingTimer createdAt={createdAt} /></span> : "Compacting…"}
</span>
```

**后台 setup（L312-343）**

```tsx
<Button variant="ghost-muted" size="micro" className="ml-auto min-w-0 shrink-0">
  <Spinner className="size-3 shrink-0" />
  <span className="truncate">Background setup</span>
</Button>
```

## B8. 审批请求卡片

**`TimelinePendingApprovalRow.tsx`（原样）**

```tsx
const APPROVAL_PRESENTATION = {
  command:        { icon: "terminal",   label: "Command approval",       detailLabel: "Command" },
  "file-change":  { icon: "square-pen", label: "File change approval",   detailLabel: "File change" },
  "file-read":    { icon: "eye",        label: "File read approval",     detailLabel: "File to read" },
  permission:     { icon: "wrench",     label: "App permission approval",detailLabel: "Permission request" },
  "mcp-elicitation":{ icon: "hammer",   label: "App access approval",    detailLabel: "App access request" },
};

<WorkLogRow role="group" aria-label={presentation.label}
            data-v2-item-type="approval_request" wrapLabel
  icon={<ToolActivityIconView icon={undefined} fallbackName={presentation.icon}
                              className="block size-4 shrink-0 stroke-2 text-icon-muted" muted />}
  label={
    <code aria-label={presentation.detailLabel}
      className="block max-h-40 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-foreground select-text! wrap-anywhere [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      data-approval-detail="complete" tabIndex={0}>
      {approval.detail || presentation.label}
    </code>
  }
>
  <div className="ms-7.5 flex min-w-0 flex-col gap-1 pb-1 text-xs">
    {approval.appName ? <span className="text-muted-foreground wrap-anywhere">{approval.appName}</span> : null}
    {approval.reason  ? <span className="text-muted-foreground select-text wrap-anywhere">{approval.reason}</span> : null}
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {canRespond ? (<>
        <span className="inline-flex items-center gap-1 text-warning">
          <ShieldIcon aria-hidden className="size-3 shrink-0" /> Waiting for approval
        </span>
        <span aria-hidden className="text-muted-foreground">·</span>
        <ComposerPendingApprovalActions presentation="inline" requestId={approval.requestId}
          disabled={!canOperateThread}
          isResponding={respondingRequestIds.includes(approval.requestId)}
          canRespond={canRespond} options={approval.options}
          onRespondToApproval={onRespondToApproval} />
      </>) : (
        <span className="text-warning">Provider process is gone. Interrupt or restart the run to respond.</span>
      )}
      {approval.fullAccessOverride ? (
        <Popover>
          <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
            {FULL_ACCESS_OVERRIDE_QUESTION}
          </PopoverTrigger>
          <PopoverPopup aria-description={…} tooltipStyle side="top"
                        className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal">
            {fullAccessOverrideExplanation(approval.fullAccessOverride)}
          </PopoverPopup>
        </Popover>
      ) : null}
    </div>
  </div>
</WorkLogRow>
```

**审批动作按钮（`ComposerPendingApprovalActions.tsx` L49-96）**

```tsx
const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel",           label: "Cancel" },
  { decision: "decline",          label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept",           label: "Approve" },
];
const primaryOptions = options.filter(o => o.decision === "decline" || o.decision === "accept");
const moreOptions    = options.filter(o => o.decision !== "decline" && o.decision !== "accept");

/* inline（时间线里） */
<InlineButton {...buttonProps} tone={option.decision === "accept" ? "default" : "muted"}>
  {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
  <span className={presentation === "inline" ? "whitespace-normal" : "max-w-40 truncate"}>{option.label}</span>
</InlineButton>

/* composer 里（presentation="composer"） */
<Button {...buttonProps} size="xs" variant={option.decision === "accept" ? "default" : "outline"}>…</Button>

/* 溢出 */
<MenuTrigger render={<InlineButton tone="muted" aria-label="More approval options" />}>More</MenuTrigger>
/* 或 <Button size="icon-xs" variant="outline"><EllipsisIcon /></Button> */
/* 警告态菜单项：<TriangleAlertIcon className="size-3 text-warning" /> */
```

**composer 顶部的审批/提问面板**：走 `ComposerBanner`（见 A5），`layout="approval"` 时图标列 `text-warning`、图标 `size-4`、`items-start gap-x-2 gap-y-3`；≤560px 时内容跨到第 4 列、动作换到第二行。

---

# C. Design Tokens

## C1. 主题色（`index.css` L1114-1256，默认 DSH 调色板）

| Token | 亮色 | 暗色 |
|---|---|---|
| `--background` | `#ffffff` | `#151517` |
| `--app-chrome-background` | `#ffffff` | `#151517` |
| `--foreground` | `#0f1115` | `#f9fafb` |
| `--card` | `#ffffff` | `#232324` |
| `--card-foreground` | `#0f1115` | `#f9fafb` |
| `--popover` | `#ffffff` | `#2c2c2e` |
| `--popover-foreground` | `#0f1115` | `#f9fafb` |
| `--surface-raised` | `#ffffff` | `#2c2c2e` |
| `--primary` | `#0f1115` | `#f9fafb` |
| `--primary-foreground` | `#ffffff` | `#0f1115` |
| `--secondary` | `#f5f6f7` | `#353638` |
| `--secondary-foreground` | `#0f1115` | `#f9fafb` |
| `--muted` | `#f9fafb` | `#1b1b1c` |
| `--muted-foreground` | `#61666b` | `#cfd3d6` |
| `--placeholder` | `#81858c` | `#adb2b8` |
| `--secondary-label` | `#81858c` | `#adb2b8` |
| `--icon-muted` | `#61666b` | `#cfd3d6` |
| `--accent` | `#f1f3f5` | `#353638` |
| `--accent-foreground` | `#0f1115` | `#f9fafb` |
| **`--message-surface`** | **`#edf3fe`** | **`#2c2c2e`** |
| `--message-foreground` | `#0f1115` | `#f9fafb` |
| **`--message-action`** | **`#0f1115`** | **`#f9fafb`** |
| `--message-action-foreground` | `#ffffff` | `#0f1115` |
| `--message-action-hover` | `#43454a` | `#ebeef2` |
| `--border` | `rgba(0,0,0,0.1)` | `rgba(255,255,255,0.06)` |
| `--input` | `rgba(0,0,0,0.1)` | `rgba(255,255,255,0.12)` |
| `--ring` | `#4176e6` | `#7aaaff` |
| `--info` | `#4176e6` | — |
| `--info-foreground` | `#4168b2` | `#7aaaff` |
| `--error` | `#ef4444` | `#ef4444` |
| `--error-foreground` | `#ec1313` | `#f25a5a` |
| `--tool-error-icon` | `var(--error-foreground)` | `var(--error-foreground)` |
| `--error-surface` | `#fef2f2` | `#570c0c` |
| `--destructive` | `var(--error)` | `var(--error)` |
| `--destructive-foreground` | `var(--error-foreground)` | `var(--error-foreground)` |
| `--warning` | `#f59e0b` | `#f59e0b` |
| `--warning-foreground` | `#dd8629` | `#f7ad31` |
| `--warning-surface` | `#fef5e7` | `#27241f` |
| `--update` | `#4176e6` | `#7aaaff` |
| `--update-foreground` | `#4176e6` | `#7aaaff` |
| `--update-surface` | `#edf3fe` | `#283142` |
| `--success` | `#22c55e` | `#22c55e` |
| `--success-foreground` | `#15803d` | `#4ed17e` |
| `--guest` | `var(--color-fuchsia-500)` = `oklch(66.7% 0.295 322.15)` | 同 |
| `--guest-foreground` | `var(--color-fuchsia-600)` = `oklch(59.1% 0.293 322.896)` | `var(--color-fuchsia-300)` = `oklch(83.3% 0.145 321.434)` |
| `--guest-surface` | `color-mix(in srgb, var(--guest) 14%, var(--message-surface))` | 同 |
| `--sidebar` | `#f9fafb` | `#1b1b1c` |
| `--sidebar-foreground` | `#0f1115` | `#f9fafb` |
| `--sidebar-muted-foreground` | `#61666b` | `#cfd3d6` |
| `--sidebar-control-surface` | `#f5f6f7` | `#353638` |
| `--sidebar-row-hover` | `#f1f3f5` | `#2c2c2e` |
| `--sidebar-row-active` | `#ebeef2` | `#43454a` |
| `--sidebar-row-selected` | `#ebeef2` | `#43454a` |
| `--sidebar-border` | `rgba(0,0,0,0.04)` | `rgba(255,255,255,0.06)` |
| `--code-background` | `#f9fafb` | `#1b1b1c` |
| `--code-foreground` | `#0f1115` | `#f9fafb` |
| `--terminal-background` | `#ffffff` | `#151517` |
| `--terminal-foreground` | `#0f1115` | `#f9fafb` |
| `--terminal-cursor` | `#4176e6` | `#7aaaff` |
| `--terminal-selection-background` | `#d3e2ff` | `#43454a` |
| `--app-scrollbar-thumb` | `#e5e5e5` | `#3c3c3d` |
| `--app-scrollbar-thumb-hover` | `#d4d4d4` | `#545557` |
| `--toolbar-background` / `-foreground` | `#ffffff` / `#0f1115` | `#151517` / `#f9fafb` |
| `--toolbar-border` | `rgba(0,0,0,0.04)` | `rgba(255,255,255,0.06)` |
| `--toolbar-control` / `-foreground` / `-hover` | `#ffffff` / `#0f1115` / `#f1f3f5` | `#2c2c2e` / `#f9fafb` / `#353638` |

**对比度派生层（L1626-1738，全部 `color-mix` 计算， Chartelis 可直接写死）**

```css
:root, [data-app-sidebar] {
  --appearance-contrast-base: 100%;
  --appearance-contrast-boost: 0%;
  --appearance-contrast-border-boost: 0%;
  --appearance-contrast-target: black;   /* dark: white */
  --contrast-foreground:        color-mix(in oklab, color-mix(in oklab, var(--foreground) 100%, var(--background)), var(--appearance-contrast-target) 0%);
  --contrast-muted-foreground:  /* 同上，源 --muted-foreground */
  --contrast-placeholder:       /* 源 --placeholder */
  --contrast-secondary-label:   /* 源 --secondary-label */
  --contrast-icon-muted:        /* 源 --icon-muted */
  --contrast-border:  color-mix(in srgb, color-mix(in srgb, var(--border) 100%, transparent), var(--foreground) 0%);
  --contrast-input:   /* 同上，源 --input */
  --contrast-message-foreground: /* 源 --message-foreground，混入 --message-surface */
  --contrast-card-foreground / --contrast-popover-foreground / --contrast-accent-foreground /
  --contrast-secondary-foreground / --contrast-sidebar-foreground /
  --contrast-sidebar-muted-foreground / --contrast-sidebar-border / --contrast-toolbar-* : /* 同构 */
}
```

> base/boost 都是 100%/0% 时，`--contrast-*` 就等于原始 token。Chartelis 直接用原 token 即可。

## C2. 几何 / 圆角 / 间距

| Token | 值 | 备注 |
|---|---|---|
| `--spacing` | `0.25rem` (4px) | Tailwind v4 默认 |
| `--radius` | `0.5rem` (8px) | 基准 |
| `--radius-sm` | `calc(var(--radius) - 4px)` = **4px** | |
| `--radius-md` | `calc(var(--radius) - 2px)` = **6px** | |
| `--radius-lg` | `var(--radius)` = **8px** | `rounded-lg` |
| `--radius-xl` | `calc(var(--radius) + 4px)` = **12px** | `rounded-xl` |
| `--radius-2xl` | `calc(var(--radius) + 8px)` = **16px** | `rounded-2xl` ← **composer / 用户气泡** |
| `--radius-3xl` | `calc(var(--radius) + 12px)` = **20px** | |
| `--control-radius` | `0.5rem` (8px) | 所有 pill / 按钮 |
| `--chat-content-max-width` | `46rem` (736px) | wide `72rem`，full `100%` |
| `--workspace-gutter` | `0.75rem` (12px)，`@variant sm` → `1.25rem` (20px) | 实际 composer lane 用 12px / 48px |
| `--chat-composer-drawer-inset` | `1.375rem` (22px) | 附加 banner 左右内缩 |
| `--chat-composer-attachment-overlap` | `calc(1rem + 1px)` (17px) | banner 咬合深度 |
| `--composer-banner-icon-column` | `--spacing(7)` = 28px，sm 起 `--spacing(6)` = 24px | |
| `--composer-banner-padding-block` | `--spacing(1)` = 4px；comfortable `--spacing(1.25)` = 5px；spacious `--spacing(3)` = 12px | |
| `--composer-banner-corner-top` | `var(--radius-xl)` = 12px | |
| `--app-scrollbar-width` | `6px` | |
| `--spacing-composer-seam` | `calc(var(--spacing) * 4 - 1px)` = 15px | |
| `--list-gutter` | `1.25rem` (20px) | markdown 列表缩进 |
| `--glass-blur` / `--glass-opacity` / `--glass-saturation` | `12px` / `80%` / `1.14`（暗 `16px` / `1.08`） | composer 玻璃 |

## C3. 字号 / 行高 / 字体

| Token | 值 |
|---|---|
| `--font-sans` | `-apple-system, BlinkMacSystemFont, "Inter Variable", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif` |
| `--font-mono` | `ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace` |
| `--font-composer` | 默认 `var(--font-sans)`（可在设置里单独指定） |
| root font-size | **16px**（`DEFAULT_INTERFACE_FONT_SIZE`） |
| `--font-size-prompt` | **14px**（`DEFAULT_PROMPT_FONT_SIZE`；`--text-sm` 兜底） |
| `--font-size-prompt-touch` | `max(var(--font-size-prompt,1rem), 16px)` |
| `--font-size-code` | **13px**（`DEFAULT_CODE_FONT_SIZE`） |
| `--text-2xs` | `0.6875rem` = **11px**，`line-height: calc(1/0.6875)` ≈ 1.4545 |
| `--text-3xs` | `0.625rem` = **10px**，`line-height: calc(0.875/0.625)` = 1.4 |
| `--text-4xs` / `--text-5xs` | `0.5rem` (8px) / `0.4375rem` (7px)，`line-height: 1` |
| markdown 正文 | `text-sm` = **14px**，`leading-relaxed` = **1.625** |
| 表格 | `0.875rem` = 14px |
| 代码字号 | 13px；header 标题 `text-2xs` = 11px |
| `leading-snug` | 1.375（代码块外框） |
| markdown h1/h2/h3/h4-6 | 20 / 18 / 16 / 14px，`line-height: 1.3`，`font-weight: 600` |
| markdown 段/列表/引用/pre 间距 | `0.65rem` 上下 |
| markdown 标题间距 | `1.25rem 0 0.5rem` |
| `li + li` | `margin-top: 0.25rem` |
| 行内代码 | `0.85em`，`padding: 0.1em 0.35em`，`border-radius: 0.25rem` |
| composer 行内代码 | `0.92em`，`padding: 0.05em 0.25em`，`border-radius: 0.3em` |

## C4. 阴影 / 动画 / 缓动

| Token | 值 | 用途 |
|---|---|---|
| `--shadow-composer` | `0 1px 2px rgb(0 0 0 / 5%)` | composer 亮色投影 |
| `--shadow-composer-dark` | `0 14px 32px -18px rgb(0 0 0 / 75%)` | 附加 banner 暗色投影（**composer 本身暗色无投影**） |
| `--inset-shadow-control-highlight` | `0 1px rgb(255 255 255 / 16%)` | 实心按钮顶部亮线 |
| `--inset-shadow-control-pressed` | `0 1px rgb(0 0 0 / 8%)` | 按下暗线 |
| `--chat-composer-highlight` | 暗色 `rgb(255 255 255 / 3%)` | composer 暗色内侧高亮 |
| `--chat-composer-outline` | 亮 `rgb(0 0 0 / 8%)`；暗 `color-mix(in srgb, white 5%, transparent)` | composer 1px 边 |
| `--ease-drawer` | `cubic-bezier(0.32, 0.72, 0, 1)` | 抽屉 / pill / 附件入场 |
| `--animate-skeleton` | `skeleton 2.4s infinite` | |
| `--animate-status-pulse` | `status-pulse 2s infinite` | |
| `--animate-status-ping` | `status-ping 2s infinite` | |
| `--animate-stash-pulse-row` / `-alt` | `stash-pulse-row(-alt) 1400ms` | |
| `--animate-stash-pulse-count` | `stash-pulse-count 1400ms step-start` | |
| `live-tool-shine` | `2.2s steps(30) infinite` | 工具行思考光泽 |
| `live-activity-focus` | `2.2s steps(30) infinite` | 高亮透镜扫过 |
| 流式淡入 | `opacity 600ms ease-out` + `@starting-style { opacity: 0 }` | |
| `--surface-grain` | 256px SVG `feTurbulence` 噪点，`opacity 0.035`（t3-chat 主题 128px / 0.02745） | body 背景 |

---

# D. 可复用建议

## D1. 可以直接抄 CSS 的部分（换个 class 前缀即可）

| # | 内容 | 工作量 |
|---|---|---|
| 1 | **Composer 卡片**（A2.3）：16px 圆角 + 1px 8% 边 + 玻璃底 + 微投影 | ~30 行 |
| 2 | **`.chat-markdown` 全部排版规则**（B2 那一大块）：标题/列表/引用/链接/表格/行内代码/`pre` | ~180 行，纯 CSS，零依赖 |
| 3 | **代码块 `.chat-markdown-codeblock`**（B3）：外框 + header + 透明 pre | ~25 行 |
| 4 | **用户消息气泡**（B1）：`rounded-2xl bg-message max-w-[80%] p-3` + 角收口逻辑 | ~15 行 |
| 5 | **WorkLog 工具行**（B4）：6px 圆角行 + 24px 图标槽 + 28px 缩进输出 | ~40 行 |
| 6 | **思考折叠块**（B5） | ~15 行 |
| 7 | ** shimmer 双轨动画**（B7）：`live-tool-shine` + `live-activity-focus` 三件套 | ~50 行 |
| 8 | **系统分割线 / 回滚按钮 / 加载骨架**（B6） | ~25 行 |
| 9 | **ComposerControl pill 基类**（A4）：8px 圆角 + hover accent + scale(0.97) + focus ring | ~20 行 |
| 10 | **发送 / 停止按钮**（A3） | ~30 行 |
| 11 | **`ui/button.tsx` 的 cva 变体表**（A 附录）：14 个 size × 12 个 variant，一张表抄完 | ~65 行 |

**小计：约 500 行纯 CSS/TS，无业务依赖，可 100% 照搬。**

## D2. 依赖 t3code 组件体系、需要简化的部分

| 部分 | 依赖 | 简化建议 |
|---|---|---|
| `ComposerSurface` 三层壳（Shell/Host/Main） | `@container/composer-surface`、`group-data-context-row`、`has-data-[composer-banner-surface=attached]`、`not-supports-[...]` | **直接塌成一层 div**（见 A2.3）。`group-has-data-*` 那套「有 banner 时卡片不画玻璃」的逻辑，用 React 条件类名 `hasBanner ? "..." : "..."` 代替 |
| 附加 banner 的「咬合」 | `--background-image-composer-seam-above`、`mask-t-from-*`、`before:-z-1`、17px 负 margin | 用一个简单的「banner 容器 `margin-bottom: -17px; padding-bottom: 17px` + 只圆上两角」近似；`rgb(0 0 0/18%)` 接缝阴影可改为 banner 自身 `box-shadow: 0 -1px 0 …` |
| `--contrast-*` 对比度层 | `color-mix` + 三个 `--appearance-contrast-*` | **全部删掉**，直接用 `--text` / `--muted` / `--line` |
| Tiptap / ProseMirror 富文本 | `@tiptap/*`、`buildDocJson`、chip NodeView、`composer-rich-marker` | 如果 Chartelis 用 `<textarea>`：只需 `.composer-tiptap` 的 `max-h-52 min-h-[calc(2lh+8px)] overflow-y-auto leading-relaxed p-1 -m-1` + placeholder 绝对定位覆盖。**富文本标记（`composer-rich-marker`）整块可弃** |
| `ComposerBanner` 全套 17 个 slot | Base UI `useRender`/`mergeProps`、`ScrollArea`、容器查询 `@max-[560px]` | 只保留 `Root` + `Row` + `Icon` + `Content` + `Actions` + `Dismiss` 六个，grid 三列模板照抄 |
| 模型 / 权限 pill 的下拉 | Base UI `Select`/`Menu`、`useComposerMenuState`、快捷键作用域 | pill 外观照抄（`ComposerControl`），下拉用你自己的组件 |
| `LegendList` 虚拟化 + `maintainScrollAtEnd` | `@legendapp/list`、锚定逻辑 | 普通列表 + `scrollIntoView` 即可 |
| `ProviderInstanceIcon` 品牌图标 + 叠放 | provider 注册表、ACP registry | 用你自己的图标；叠放 `-space-x-1` + `ring-2 ring-[card色]` 照抄 |
| Shiki 增量高亮 + LRU | `shiki`、`hast-util-to-html`、`@pierre/diffs` | 用 `shiki.codeToHtml()` 一次性高亮即可，外层 div 加 `chat-markdown-shiki` 类让 CSS 生效 |
| `--app-theme-*` 主题系统 | `themePalette.ts` 运行时生成 | 不需要；Chartelis 用固定 token |

## D3. 最小复刻集：30 行拿到 80% 观感

如果只抄 30 行，抄这 8 条（按收益排序）：

```css
/* 1. 布局：单列居中 736px（4 行） */
.chat-lane { margin-inline: auto; width: 100%; min-width: 0; max-width: 46rem; }

/* 2. 用户气泡：右对齐 + 淡蓝底 + 16px 圆角 + 80% 宽 + 12px 内衬（5 行） */
.msg-user { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.msg-user > .bubble {
  max-width: 80%; border-radius: 16px; padding: 12px;
  background: var(--message-surface); color: var(--message-foreground);
}

/* 3. Composer 卡片：16px 圆角 + 1px 淡边 + 玻璃底 + 微投影（6 行） */
.composer {
  position: relative; isolation: isolate; margin-inline: auto; width: 100%; max-width: 46rem;
  border-radius: 16px; border: 1px solid var(--line);
  background: color-mix(in srgb, var(--surface) 80%, transparent);
  backdrop-filter: blur(12px) saturate(1.14);
  box-shadow: 0 1px 2px rgb(0 0 0 / 5%);
}
.dark .composer { box-shadow: none; }

/* 4. 输入区：14px/1.625，最大 208px，自滚（3 行） */
.composer__input {
  max-height: 208px; min-height: calc(2lh + 8px); overflow-y: auto;
  padding: 14px 16px 8px; font-size: 14px; line-height: 1.625;
}
.composer__input:focus { outline: none; }

/* 5. 底部工具行：图标按钮 + 右对齐发送钮（4 行） */
.composer__footer { display: flex; align-items: center; gap: 8px; padding: 0 8px 8px; }
.composer__footer .spacer { flex: 1; }

/* 6. 发送钮：32px 圆、近黑底、hover 放大、禁用变灰（4 行） */
.btn-send {
  width: 32px; height: 32px; border-radius: 9999px; display: flex;
  align-items: center; justify-content: center; cursor: pointer;
  background: var(--message-action); color: var(--message-action-foreground);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--message-action) 24%, transparent);
  transition: transform 150ms;
}
.btn-send:hover:not(:disabled) { transform: scale(1.05); }
.btn-send:disabled { background: color-mix(in srgb, var(--text) 12%, transparent); color: var(--muted); box-shadow: none; }

/* 7. Markdown 正文骨架：14px/1.625 + 段距（3 行） */
.prose { font-size: 14px; line-height: 1.625; overflow-wrap: anywhere; }
.prose > *:first-child { margin-top: 0; }
.prose p, .prose ul, .prose ol, .prose pre, .prose blockquote { margin: 0.65rem 0; }

/* 8. 工具行：6px 圆角 + 24px 图标槽 + 28px 缩进（4 行） */
.tool-row { display: flex; align-items: center; gap: 6px; min-height: 24px; border-radius: 6px; padding: 2px 2px; font-size: 14px; line-height: 1.625; cursor: pointer; color: var(--muted); }
.tool-row .icon { width: 24px; flex: none; display: flex; align-items: center; justify-content: center; }
.tool-detail { margin-inline-start: 28px; max-height: 384px; overflow: auto; }
```

> 再补一个**「思考光泽」**（8 行）就能拿到 t3code 最独特的辨识度：
> ```css
> @keyframes tool-shine { from { background-position: -4.5rem 0, 0 0; } to { background-position: calc(100% + 4.5rem) 0, 0 0; } }
> .tool-row .label.active {
>   color: transparent;
>   background-image: linear-gradient(to right, transparent, var(--text), transparent),
>                     linear-gradient(var(--muted), var(--muted));
>   background-size: 4.5rem 100%, 100% 100%;
>   background-repeat: no-repeat; background-clip: text;
>   animation: tool-shine 2.2s steps(30) infinite;
> }
> ```

**优先级提示**：若时间有限，先做 1/2/3/6/7（布局 + 气泡 + 卡片 + 发送钮 + 正文），这 5 条已经能让人认出「这是 t3code 风格」。

## D4. Chartelis 主题变量 → t3code 配色映射

Chartelis 现有变量：`--paper`、`--surface`、`--sidebar`、`--text`、`--muted`、`--line`、`--hover`、`--accent`、`--selected`、`--accent-soft`。

| Chartelis | t3code 对应 | 亮色值 | 暗色值 | 说明 |
|---|---|---|---|---|
| `--paper` | `--background` | `#ffffff` | `#151517` | 页面/时间线底色 |
| `--surface` | `--card` | `#ffffff` | `#232324` | composer 卡片玻璃基色 |
| `--surface-raised`（新增） | `--surface-raised` | `#ffffff` | `#2c2c2e` | 暗色 composer 实际用这个（比 `--card` 亮一档） |
| `--sidebar` | `--sidebar` | `#f9fafb` | `#1b1b1c` | |
| `--text` | `--foreground` | `#0f1115` | `#f9fafb` | |
| `--muted` | `--muted-foreground` | `#61666b` | `#cfd3d6` | ⚠️ t3code 另有一个 `--muted`（`#f9fafb`/`#1b1b1c`）是**背景**而非文字，Chartelis 的 `--muted` 语义更接近 t3code 的 `--muted-foreground` |
| `--muted-strong`（新增） | `--placeholder` / `--secondary-label` | `#81858c` | `#adb2b8` | 工具行标题、placeholder |
| `--line` | `--border` | `rgba(0,0,0,0.1)` | `rgba(255,255,255,0.06)` | |
| `--hover` | `--accent` | `#f1f3f5` | `#353638` | pill hover / pressed |
| `--selected` | `--sidebar-row-selected` | `#ebeef2` | `#43454a` | |
| `--accent` | `--ring` / `--info` | `#4176e6` | `#7aaaff` | 焦点环、链接 |
| `--accent-soft` | `--update-surface` | `#edf3fe` | `#283142` | |
| **`--message-surface`（新增）** | `--message-surface` | **`#edf3fe`** | **`#2c2c2e`** | **用户气泡底色，t3code 观感的灵魂** |
| **`--message-action`（新增）** | `--message-action` | **`#0f1115`** | **`#f9fafb`** | 发送钮底色（亮色近黑、暗色近白） |
| `--message-action-hover`（新增） | 同名 | `#43454a` | `#ebeef2` | 发送钮 hover |
| `--destructive`（新增） | `--error` / `--error-foreground` | `#ef4444` / `#ec1313` | `#ef4444` / `#f25a5a` | 停止钮、失败态 |
| `--warning`（新增） | `--warning-foreground` | `#dd8629` | `#f7ad31` | 「等待审批」 |
| `--success`（新增） | `--success-foreground` | `#15803d` | `#4ed17e` | 完成态 |
| `--code-bg`（新增） | `--code-background` | `#f9fafb` | `#1b1b1c` | 代码块（主题化时） |

**建议的最小 token 补充集**（在 Chartelis 现有变量之外只需加这 4 个就能复刻气泡 + 发送钮）：

```css
:root {
  --message-surface: #edf3fe;      /* 用户气泡 */
  --message-action:  #0f1115;      /* 发送钮 */
  --message-action-hover: #43454a;
  --surface-raised:  #ffffff;      /* 暗色 composer 玻璃基色 */
}
.dark {
  --message-surface: #2c2c2e;
  --message-action:  #f9fafb;
  --message-action-hover: #ebeef2;
  --surface-raised:  #2c2c2e;
}
```

**语义注意**：
- t3code 亮色下 composer 卡片是 `--card` = **纯白**，页面也是纯白 → 卡片只靠 1px 淡边 + 微投影区分；**暗色下**卡片是 `#2c2c2e` 而页面 `#151517` → 明确浮起。Chartelis 若 `--paper` 非纯白，可考虑 composer 用 `--paper` 的提亮档。
- `--hover` 映射到 `--accent`（`#f1f3f5`）而不是 `--sidebar-row-hover`，因为 pill 的 hover 用的是 `--accent`。
- 用户气泡的淡蓝 `#edf3fe` 与 `--accent-soft`（`--update-surface`）在亮色下**恰好同值**，暗色不同（`#2c2c2e` vs `#283142`）——所以不要复用同一个变量。

---

## 附：`ui/button.tsx` cva 变体全表（直接抄）

**base**

```
[--control-icon-color:currentColor] [&_svg]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer
items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border
font-medium text-base outline-none transition-[box-shadow,scale]
[&:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:will-change-[scale]
[&:active:not([aria-haspopup])]:scale-[0.97]
before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)]
pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11
focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background
disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64
sm:text-sm [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)]
[&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4
[&_svg]:pointer-events-none [&_svg]:shrink-0
```

**size**

| 名称 | 类 |
|---|---|
| `compact` | `h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-xs before:rounded-[calc(var(--radius-md)-1px)] [&_svg]:size-3.5` |
| `default` | `h-9 px-[calc(--spacing(3)-1px)] sm:h-8` |
| `icon` | `size-9 sm:size-8` |
| `icon-lg` | `size-10 sm:size-9` |
| `icon-micro` | `size-5 rounded-sm p-0 before:rounded-[calc(var(--radius-sm)-1px)] [&_svg]:size-3` |
| `icon-tiny` | `size-4 p-0 [&_svg]:size-3` |
| `icon-sm` | `size-8 sm:size-7` |
| `icon-sm-pill` | `size-8 rounded-full before:rounded-full sm:size-7` |
| `icon-xl` | `size-11 sm:size-10 [&_svg]:size-5 sm:size-4.5` |
| `icon-xs` | `size-7 sm:size-6 [&_svg]:size-4 sm:size-3.5` |
| `lg` | `h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9` |
| `micro` | `h-5 gap-1 rounded-sm px-[calc(--spacing(1.5)-1px)] text-[11px] before:rounded-[calc(var(--radius-sm)-1px)] [&_svg]:size-3` |
| `multiline` | `min-h-9 px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] whitespace-normal sm:min-h-8` |
| `sm` | `h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7` |
| `sm-pill` | `h-8 gap-1.5 rounded-full px-2.5 sm:h-7` |
| `sm-multiline` | `min-h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] py-[calc(--spacing(1)-1px)] whitespace-normal sm:min-h-7` |
| `xl` | `h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg]:size-5 sm:size-4.5` |
| `xs` | `h-7 gap-1 px-[calc(--spacing(2)-1px)] text-sm sm:h-6 sm:text-xs [&_svg]:size-4 sm:size-3.5` |

**variant**

| 名称 | 类 |
|---|---|
| `default` | `not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] border-primary bg-primary text-primary-foreground shadow-primary/24 shadow-xs [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-primary/90` |
| `destructive` | 同上，`destructive` 色 + `text-white` |
| `destructive-outline` | `border-input bg-popover not-dark:bg-clip-padding text-destructive-foreground shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-input/32 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:border-destructive/32 [:hover,[data-pressed]]:bg-destructive/4` |
| `ghost` | `[--control-icon-color:var(--contrast-muted-foreground)] border-transparent text-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent` |
| `ghost-muted` | `[--control-icon-color:currentColor] border-transparent text-muted-foreground data-pressed:bg-accent [:hover,[data-pressed]]:bg-accent [:hover,[data-pressed]]:text-foreground` |
| `ghost-destructive` | 同上，hover 文字 `text-destructive` |
| `glass` | `surface-glass [--control-icon-color:var(--contrast-muted-foreground)] rounded-full border-border/60 text-foreground shadow-sm before:rounded-full [:hover,[data-pressed]]:border-border` |
| `link` | `border-transparent underline-offset-4 [:hover,[data-pressed]]:underline` |
| `media-close` | `[--control-icon-color:currentColor] border-transparent bg-black/65 text-white shadow-sm ring-1 ring-white/20 [:hover]:bg-black/80 focus-visible:ring-white` |
| `media-navigation` | `absolute top-1/2 z-20 -translate-y-1/2 border-transparent text-white/90 [:hover]:bg-white/10 [:hover]:text-white` |
| `outline` | `[--control-icon-color:var(--contrast-muted-foreground)] border-input bg-popover not-dark:bg-clip-padding text-foreground shadow-xs/5 not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-input/32 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none [:hover,[data-pressed]]:bg-accent/50 dark:[:hover,[data-pressed]]:bg-input/64` |
| `overlay` | `border-transparent bg-black/70 text-white/65 [:hover]:bg-black/90` |
| `secondary` | `border-transparent bg-secondary text-secondary-foreground [:active]:bg-secondary/80 [:hover]:bg-secondary/90` |
| `warning-outline` | `border-warning/32 bg-warning-surface text-warning-foreground shadow-xs/5 [:disabled,:active,[data-pressed]]:shadow-none [:hover]:border-warning/40 [:hover]:bg-warning/16 dark:[:hover]:bg-warning/24` |

**`surface-glass` 工具类（`index.css` L365-373）**

```css
@utility surface-glass {
  background: color-mix(in srgb, var(--background) var(--glass-opacity), transparent);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
  @supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
    background: var(--background) !important;
  }
}
```

**`Kbd`（`ui/kbd.tsx` L15-21）**

```
pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1
rounded px-1 font-medium font-sans text-muted-foreground text-xs [&_svg]:size-3
outline 变体追加：border border-b-2 border-foreground/15 px-1.5
默认变体：bg-foreground/[0.07]
```
