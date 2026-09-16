// 轻量中英双语。STRINGS[key] = [中文, English]。
// 组件里用 useT() 拿 t（跟随 LangContext 自动重渲）；App 自身用 makeT(lang)。
import { createContext, useContext } from "react";

export type Lang = "zh" | "en";

export const STRINGS = {
  // 右下角小耳朵（交给 AI）
  agentEarTip: ["交给 AI", "Ask AI"],
  agentOnline: ["AI 已接入", "AI connected"],
  agentOffline: ["还没有 AI 接进来", "No AI connected"],
  agentConnectHint: [
    "把下面这句发给你的 agent（哪家都行），它就接进来了：",
    "Send the line below to your agent (any of them), and it will connect:",
  ],
  // 发给 agent 的接入指令。**一句话通吃任何 agent**——connect.sh 自己认调用者、
  // 扫机器上装了什么、全都注册 MCP；内置模板之外的 agent 由它自己用 --exec 自报
  // （各家 headless 的写法差太远，它自己那条最准，我们猜不了）。
  // 收这句的是 agent 不是 shell，所以写成自然语言并附找不到时的兜底
  //（用户可能把 Omia 装在别处）。
  // Windows 版那句（PowerShell）。两句分开而不是拼一起——用户只会复制一句，
  // 给他看另一个平台的命令只会添乱。由 isWindows 决定显示哪句。
  agentConnectCmdWin: [
    '帮我接上 Omia：powershell -ExecutionPolicy Bypass -File "C:\\Program Files\\Xiaoer Omia\\omia-cli\\connect.ps1"'
      + "（🔴 资源在安装根目录下、不在 resources 里；装到别的盘就在安装目录找 omia-cli\\connect.ps1。"
      + "你不是 Claude Code / Codex / Hermes 的话，末尾加 -Exec '<你的一次性命令> $t' 自报）",
    'Connect Omia for me: powershell -ExecutionPolicy Bypass -File "C:\\Program Files\\Xiaoer Omia\\omia-cli\\connect.ps1"'
      + " (resources sit in the install root, not under resources; if that path is wrong, find"
      + " omia-cli\\connect.ps1 in your Omia folder."
      + " If you are not Claude Code / Codex / Hermes, append -Exec '<your one-shot command> $t')",
  ],
  agentConnectCmd: [
    '帮我接上 Omia：bash "/Applications/Xiaoer Omia.app/Contents/Resources/omia-cli/connect.sh"'
      + "（路径不存在就用 mdfind 找 bundle id com.jane.xiaoeromon。"
      + "你不是 Claude Code / Codex / Hermes 的话，末尾加 --exec '<你的一次性命令> \"$(cat)\"' 自报）",
    'Connect Omia for me: bash "/Applications/Xiaoer Omia.app/Contents/Resources/omia-cli/connect.sh"'
      + " (if that path is missing, mdfind bundle id com.jane.xiaoeromon."
      + " If you are not Claude Code / Codex / Hermes, append --exec '<your one-shot command> \"$(cat)\"')",
  ],
  agentReconnectHint: [
    "AI 掉线了。把下面这句发给 agent 就能重新接上：",
    "The AI disconnected. Send the line below to your agent to reconnect:",
  ],
  agentAsk: ["想让 AI 做什么？", "What should the AI do?"],
  agentAskAboutFile: ["关于这个文件，想做什么？", "What about this file?"],
  agentWithSelection: ["带上划词：", "With selection: "],
  // 干活时的「在动」信号——沉默几十秒和死掉在人眼里一样
  agentBusyWaiting: ["已送出，等 AI 接活…", "Sent — waiting for the AI to pick it up…"],
  agentBusyThinking: ["AI 正在思考…", "AI is thinking…"],
  agentBusyTool: ["AI 正在操作工具…", "AI is using tools…"],
  agentBusyResponding: ["AI 正在整理回答…", "AI is preparing a reply…"],
  agentBusyWorking: ["AI 正在干活…", "AI is working…"],
  agentBusyQuiet: ["还在跑，但有一阵没动静了", "Still running, but quiet for a while"],
  agentBusyLost: ["接活的进程没了，可能崩了", "The worker process is gone — it may have crashed"],
  copy: ["复制", "Copy"],
  copied: ["已复制", "Copied"],
  // 侧栏
  recent: ["最近", "Recent"],
  noFilesYet: ["还没打开过文件", "No files opened yet"],
  removeFromRecent: ["从最近移除", "Remove from recent"],
  clearRecent: ["关闭未置顶的最近文件", "Close unpinned recent files"],
  searchFiles: ["搜索文件", "Search files"],
  noMatch: ["没有匹配的文件", "No matching files"],
  renameHint: ["双击重命名", "Double-click to rename"],
  renameEmpty: ["文件名不能为空", "Name cannot be empty"],
  renameBadChar: ["文件名不能含 / \\ :", "Name cannot contain / \\ :"],
  renameExists: ["已存在同名文件", "A file with that name already exists"],
  renameFailed: ["改名失败", "Rename failed"],
  newFolder: ["＋ 新建文件夹", "＋ New folder"],
  newFolderName: ["新文件夹", "New Folder"],
  moveToFolder: ["移入「{name}」", "Move to “{name}”"],
  removeFromFolder: ["移出文件夹", "Remove from folder"],
  renameFolderMenu: ["重命名", "Rename"],
  deleteFolderMenu: ["删除文件夹（文件回到最近）", "Delete folder (files return to Recent)"],
  // 链接文件夹的排序（右键菜单，2026-08-04 Jane 提；措辞照她给的资源管理器截图）
  sortBy: ["排序方式", "Sort by"],
  sortNameAsc: ["文件名（A-Z）", "Name (A-Z)"],
  sortNameDesc: ["文件名（Z-A）", "Name (Z-A)"],
  sortMtimeDesc: ["编辑时间（从新到旧）", "Date modified (newest first)"],
  sortMtimeAsc: ["编辑时间（从旧到新）", "Date modified (oldest first)"],
  sortCtimeDesc: ["创建时间（从新到旧）", "Date created (newest first)"],
  sortCtimeAsc: ["创建时间（从旧到新）", "Date created (oldest first)"],
  // 侧栏「文件管理器」改造（2026-08-03）：找（格式/标签）→ 常用（置顶）→ 浏览（文件夹/最近）
  // 加密文件（2026-08-03）：底层库原本直接把英文异常甩给用户，违 R11 且没告诉人该怎么办
  pdfLocked: ["这个 PDF 有密码", "This PDF is password-protected"],
  pdfLockedHint: ["输入密码后即可查看", "Enter the password to view it"],
  pdfPasswordPlaceholder: ["密码", "Password"],
  pdfPasswordWrong: ["密码不对，再试一次", "Wrong password — try again"],
  pdfPasswordCancelled: ["需要密码才能打开这个 PDF", "This PDF needs a password to open"],
  unlock: ["解锁", "Unlock"],
  archiveEncrypted: ["这个压缩包有密码，Omia 暂时打不开", "This archive is password-protected — Omia can't open it yet"],
  // 查看区右键菜单（2026-08-03）：WKWebView 原生菜单的「存储图像」点了没反应，换成自己的
  ctxSaveCopy: ["保存一份…", "Save a copy…"],
  // R11 补漏（2026-08-04，Windows 英文 locale 上露馅）：以下几处原本硬编码中文，
  // 英文模式下混在英文界面里。mac 因为默认中文一直没暴露。
  untitledDoc: ["未命名.md", "Untitled.md"],
  untitledBase: ["未命名", "Untitled"],
  fltAllFiles: ["所有文件", "All Files"],
  fltDocMedia: ["文档/媒体", "Documents & Media"],
  fltTextCode: ["文本/代码/数据", "Text, Code & Data"],
  // 原生菜单（在 Rust 里建，由前端把当前语言送过去重建 → menu_labels）
  menuFile: ["文件", "File"],
  menuView: ["视图", "View"],
  menuEdit: ["编辑", "Edit"],
  menuWindow: ["窗口", "Window"],
  menuHelp: ["帮助", "Help"],
  menuNew: ["新建", "New"],
  menuOpen: ["打开…", "Open…"],
  menuSave: ["保存", "Save"],
  menuSaveAs: ["另存为…", "Save As…"],
  menuCloseFile: ["关闭文件", "Close File"],
  menuCheckUpdate: ["检查更新", "Check for Updates"],
  menuToggleEdit: ["预览 / 编辑", "Preview / Edit"],
  menuToggleSource: ["HTML 源码", "HTML Source"],
  ctxReveal: ["在访达中显示", "Reveal in Finder"],
  // Windows 没有「访达」——同一个动作在 Win 上必须说资源管理器（2026-08-04 真机截图实锤）。
  ctxRevealWin: ["在资源管理器中显示", "Show in File Explorer"],
  ctxCopyPath: ["拷贝文件路径", "Copy file path"],
  sectionSearch: ["搜索结果", "Search results"],
  chipFormat: ["格式: {name}", "Format: {name}"],
  chipTag: ["标签: {name}", "Tag: {name}"],
  sectionFormats: ["格式筛选", "By format"],
  sectionTags: ["标签筛选", "By tag"],
  sectionPinned: ["置顶", "Pinned"],
  sectionFiles: ["文件", "Files"],
  filterAll: ["全部", "All"],
  filterFiles: ["筛选文件…", "Filter files…"],
  pinItem: ["置顶", "Pin"],
  unpinItem: ["取消置顶", "Unpin"],
  tagItem: ["打标签…", "Tag…"],
  tagItemN: ["给 {n} 个文件打标签…", "Tag {n} files…"],
  addTag: ["加标签", "Add tag"],
  newTagPlaceholder: ["输入标签名，回车确认", "Type a tag name, press Enter"],
  tagSuggested: ["建议", "Suggested"],
  tagRecent: ["最近用过", "Recently used"],
  removeTag: ["移除标签", "Remove tag"],
  renameTagMenu: ["重命名标签", "Rename tag"],
  deleteTagMenu: ["删除标签（从所有文件上摘掉）", "Delete tag (remove from all files)"],
  noTaggedFiles: ["这个标签下还没有文件", "No files with this tag yet"],
  filterNoMatch: ["没有符合条件的文件", "No files match"],
  moreTags: ["+{n}", "+{n}"],
  linkedTruncated: ["仅显示前 {n} 个", "Showing first {n}"],
  // 20 个格式的显示名（格式筛选那列用）
  fmtMarkdown: ["Markdown", "Markdown"],
  fmtHtml: ["HTML", "HTML"],
  fmtPdf: ["PDF", "PDF"],
  fmtDocx: ["Word", "Word"],
  fmtPptx: ["幻灯片", "Slides"],
  fmtSheet: ["表格", "Spreadsheet"],
  fmtImage: ["图片", "Image"],
  fmtHeic: ["HEIC", "HEIC"],
  fmtPsd: ["PSD", "PSD"],
  fmtCdr: ["CDR", "CDR"],
  fmtRaw: ["RAW", "RAW"],
  fmtVideo: ["视频", "Video"],
  fmtAudio: ["音频", "Audio"],
  fmtEpub: ["电子书", "E-book"],
  fmtArchive: ["压缩包", "Archive"],
  fmtXmind: ["脑图", "Mind map"],
  fmtModel3d: ["3D 模型", "3D model"],
  fmtReact: ["TSX/JSX", "TSX/JSX"],
  fmtText: ["文本/代码", "Text/Code"],
  fmtUnknown: ["其它", "Other"],
  collapseSidebar: ["收起侧栏", "Collapse sidebar"],
  expandSidebar: ["展开侧栏", "Expand sidebar"],
  collapse: ["收起", "Collapse"],
  more: ["看更多", "More"],
  newFile: ["新建文件 (⌘N)", "New file (⌘N)"],
  // 缩放
  zoomIn: ["放大 (⌘+)", "Zoom in (⌘+)"],
  zoomInShort: ["放大", "Zoom in"],
  zoomOut: ["缩小 (⌘−)", "Zoom out (⌘−)"],
  zoomOutShort: ["缩小", "Zoom out"],
  resetZoom: ["点击恢复 100%", "Click to reset to 100%"],
  // 编辑/保存
  preview: ["预览", "Preview"],
  edit: ["编辑", "Edit"],
  officeEditHint: ["就地编辑；保存覆盖原文件，另存为创建副本", "Edit in place; Save overwrites the original, Save As creates a copy"],
  source: ["源码", "Source"],
  exitSource: ["退出源码", "Exit source"],
  reactSourceHint: ["切换网页预览 / 源码编辑（tsx·jsx）", "Toggle web preview / source (tsx·jsx)"],
  reactCompiling: ["正在编译预览…", "Compiling preview…"],
  reactCompileFail: ["这个组件暂时无法预览成网页（可切「源码」查看/编辑）", "Can't render this component to a web page (switch to Source to view/edit)"],
  sourceHint: ["直接改 HTML 源码（复杂/动效页面最稳）", "Edit raw HTML source (most reliable for complex pages)"],
  save: ["保存", "Save"],
  saveStateClean: ["无改动", "No changes"],
  saveStateModified: ["编辑器内存已改", "Changes in editor"],
  saveStateDraftProtected: ["本地草稿已保护", "Local draft protected"],
  saveStateDraftPending: ["本机恢复草稿保护中…", "Protecting recovery draft…"],
  saveStateDraftFailed: ["本机恢复草稿保护失败", "Recovery draft protection failed"],
  saveStateSaving: ["正在保存原文件…", "Saving original file…"],
  saveStateSaved: ["原文件已保存", "Original file saved"],
  saveStateFailed: ["保存失败", "Save failed"],
  saveRetry: ["重试", "Retry"],
  saveRetryAria: ["重试保存", "Retry save"],
  draftRetry: ["重试", "Retry"],
  draftRetryAria: ["重试草稿保护", "Retry draft protection"],
  saveExternalConflict: [
    "这个文件已被其他程序修改。Omia 没有覆盖它；本地草稿仍受保护，请选择如何处理。",
    "Another app changed this file. Omia did not overwrite it; your local draft remains protected. Choose how to proceed.",
  ],
  saveExternalKept: ["已保留本地草稿，源文件自动保存已暂停。", "Local draft kept; source auto-save is paused."],
  saveExternalKeep: ["保留本地", "Keep local"],
  saveExternalReload: ["载入磁盘", "Load disk"],
  saveExternalCopy: ["保存副本", "Save copy"],
  // 分块保真保存（2026-09-09）：改到含高级语法的块时，保存前提示一次
  rewriteConfirmTitle: ["你改动的段落里有可视化编辑器无法原样保留的语法", "The blocks you edited contain syntax the visual editor cannot keep verbatim"],
  rewriteConfirmBody: ["保存后这些会按可视化结果改写；没改过的段落逐字保留原文。", "They will be saved as the visual editor shows them; untouched blocks stay byte-for-byte."],
  rewriteConfirmSave: ["照样保存", "Save anyway"],
  rewriteConfirmCancel: ["取消", "Cancel"],
  rewriteAutosavePaused: ["改动碰到了高级语法，自动保存已暂停，请手动保存确认。", "Your edit touches advanced syntax; auto-save is paused until you save manually."],
  riskFrontMatter: ["Front Matter", "Front Matter"],
  riskFootnotes: ["脚注", "footnotes"],
  riskRawHtml: ["HTML 混排（如 <mark>）", "embedded HTML (e.g. <mark>)"],
  riskToc: ["目录标记 [TOC]", "TOC markers"],
  riskFenceMetadata: ["代码块标题 / 行号 / 高亮行", "code-block title / line numbers / highlighted lines"],
  riskDirectives: ["扩展指令 :::", "extended directives :::"],
  saveExternalOverwrite: ["覆盖磁盘", "Overwrite"],
  fileDraftRecovered: [
    "已恢复这份文件的本地草稿；原文件没有改变。",
    "Recovered this file's local draft; the original file is unchanged.",
  ],
  fileDraftRecoveredWithExternalChange: [
    "已恢复本地草稿，但磁盘文件也已变化；原文件没有被覆盖，保存时仍会再次确认冲突。",
    "Recovered the local draft, but the disk file also changed. The original was not overwritten; Save will confirm the conflict again.",
  ],
  fileDraftKeep: ["继续使用本地草稿", "Keep local draft"],
  fileDraftDiscard: ["放弃草稿，载入磁盘", "Discard draft and load disk"],
  advancedExportLossTitle: ["这个格式会降级部分高级能力", "This format downgrades some advanced features"],
  advancedExportLossEditability: ["导出后不能在其它工具中继续按 Omia 高级模型编辑", "Other tools cannot continue editing the Omia advanced model"],
  advancedExportLossInline: ["下划线、文字色和背景色会变成普通文字", "Underline, text color, and highlight become plain text"],
  advancedExportLossTable: ["高级表格列宽、合并和单元格样式会按阅读顺序展开", "Advanced table geometry and cell styling are linearized in reading order"],
  advancedExportLossLayout: ["分栏会按从左到右、从上到下展开", "Columns are linearized left-to-right and top-to-bottom"],
  advancedExportContinue: ["继续导出", "Continue export"],
  advancedExportCancel: ["取消", "Cancel"],
  saveUnsafeText: [
    "未保存：{n} 处文字无法安全定位。原文件和当前编辑内容都未重置，请缩小编辑范围后重试。",
    "Not saved: {n} text change(s) could not be located safely. The original file and current edits were kept; narrow the edit and retry.",
  ],
  savePartialText: [
    "保存未完整完成：{n} 处改动没找到安全回写位置，可重试。",
    "Save was incomplete: {n} change(s) had no safe write-back location. You can retry.",
  ],
  saveContentUnavailable: ["读不到编辑内容（请保持编辑态后重试）", "Couldn't read the edited content. Stay in edit mode and retry."],
  saveSheetDataMissing: ["读不到表格数据，可重试", "Couldn't read the spreadsheet data. You can retry."],
  saveWordBaselineFailed: ["文件已写入，但 Word 编辑基线未能确认", "The file was written, but the Word edit baseline could not be confirmed."],
  savePowerPointBaselineFailed: ["文件已写入，但 PowerPoint 编辑基线未能确认", "The file was written, but the PowerPoint edit baseline could not be confirmed."],
  saveExcelBaselineFailed: ["文件已写入，但 Excel 编辑基线未能确认", "The file was written, but the Excel edit baseline could not be confirmed."],
  saveAs: ["另存为", "Save As"],
  saveAsHint: ["另存为 / 转换成其它格式", "Save As / convert to another format"],
  saveAsTitle: ["另存为 / 转换", "Save As / Convert"],
  exporting: ["导出中…", "Exporting…"],
  open: ["打开", "Open"],
  close: ["关闭", "Close"],
  closeHint: ["关闭当前，回到首页", "Close current, back to home"],
  // 设置
  settings: ["设置", "Settings"],
  settingsHint: ["设置", "Settings"],
  mdDefaultAction: ["默认打开 Markdown…", "Default Markdown app…"],
  mdDefaultTitle: ["用 Omia 默认打开 Markdown？", "Open Markdown with Omia by default?"],
  mdDefaultHint: ["确认后，双击 .md 文件即可用 Omia 打开。点击下方按钮，在系统页面中找到 .md，选择 Xiaoer Omia 并确认。", "After confirmation, double-clicking .md files opens them in Omia. Use the button below, find .md on the system page, then choose Xiaoer Omia and confirm."],
  mdDefaultPending: ["系统设置已打开；完成确认后返回这里。", "System settings opened. Return here after confirming."],
  mdDefaultError: ["系统设置未能打开，请重试。", "Could not open system settings. Please try again."],
  mdDefaultLater: ["稍后", "Later"],
  mdDefaultConfirm: ["去系统确认", "Confirm in system settings"],
  language: ["语言", "Language"],
  // 外观（亮/暗），与语言同一排、同款两段式开关（Jane 2026-08-15）
  appearance: ["外观", "Appearance"],
  themeLight: ["亮", "Light"],
  themeDark: ["暗", "Dark"],
  themeLightTip: ["亮色", "Light"],
  themeDarkTip: ["暗色", "Dark"],
  // 更新（右下角浮条 + 左上角菜单「检查更新」）
  updReadyPre: ["有新版 ", "Update "],
  updReadyPost: [" 已就绪", " is ready"],
  updRestart: ["重启更新", "Restart to update"],
  updInstalling: ["更新中…", "Updating…"],
  updInstallFail: ["更新安装失败", "Update couldn't be installed"],
  // 顶栏「⋯」编辑菜单（只在没有原生菜单栏的平台出现，即 Windows）
  editMenu: ["编辑", "Edit"],
  edUndo: ["撤销", "Undo"],
  edRedo: ["重做", "Redo"],
  edCut: ["剪切", "Cut"],
  edCopy: ["复制", "Copy"],
  edPaste: ["粘贴", "Paste"],
  edSelectAll: ["全选", "Select All"],
  // 自绘标题栏的窗口控制（Windows 专用）
  winMinimize: ["最小化", "Minimize"],
  winMaximize: ["最大化", "Maximize"],
  winRestore: ["还原", "Restore"],
  winClose: ["关闭", "Close"],
  updCheckNow: ["检查", "Check"],
  updChecking: ["正在检查更新…", "Checking for updates…"],
  updLatest: ["已是最新版 🌿", "You're on the latest 🌿"],
  updCheckFail: ["检查失败（可能连不上更新服务器），可去官网下载最新版", "Couldn't reach the update server — grab the latest from the website"],
  updGoSite: ["去官网下载", "Open website"],
  // 首页/开场
  welcomeTo: ["Welcome to", "Welcome to"],
  pleaseEnter: ["开始输入…", "Start typing…"],
  splashSub: ["AI 时代的万能阅览器", "The Universal Reader for the AI Age"],
  signature: ["By 小耳", "By Xiaoer"],
  // 常见 viewer 状态
  loadFailed: ["加载失败", "Failed to load"],
  epubFailed: ["EPUB 打开失败", "Failed to open EPUB"],
  htmlReadFailed: ["HTML 读取失败", "Failed to read HTML"],
  // 压缩包
  archiveFailed: ["压缩包打开失败", "Failed to open archive"],
  archiveFiles: ["个文件", "files"],
  archiveSelectHint: ["从左侧选一个文件预览", "Pick a file on the left to preview"],
  archiveBinaryHint: ["二进制文件，暂不预览", "Binary file — preview not available"],
  pptxVideoPlay: ["播放视频", "Play video"],
  pptxVideoFailed: ["视频无法播放：编码不支持或媒体已损坏", "Cannot play video: unsupported codec or damaged media"],
  nativeImageLoading: ["正在打开图片…", "Opening image…"],
  nativeImageTooLarge: ["这张图片超过预览上限（文件 256 MiB 或 6400 万像素）。", "This image exceeds the preview limit (256 MiB file or 64 million pixels)."],
  nativeHeicCodecMissing: ["此电脑缺少可用的 HEIC 解码扩展。请在 Microsoft Store 安装或更新「HEIF 图像扩展」及「HEVC 视频扩展」后重试。", "No usable HEIC codec was found. Install or update HEIF Image Extensions and HEVC Video Extensions from Microsoft Store, then try again."],
  nativeImageFailedHint: ["文件可能损坏，或使用了系统解码器暂不支持的编码。", "The file may be damaged or use an encoding the system decoder cannot read."],
  nativeImagePrevious: ["上一页图片", "Previous image page"],
  nativeImageNext: ["下一页图片", "Next image page"],
  nativeImagePage: ["第 {page} / {pages} 页", "Page {page} / {pages}"],
  imageFailed: ["这张图片打不开", "Couldn't open this image"],
  imageDisplayMode: ["图片显示方式", "Image display mode"],
  imageFit: ["适应窗口", "Fit"],
  imagePhysicalPixels: ["原始像素", "Original pixels"],
  imageSourceSize: ["源尺寸 {width} × {height}", "Source {width} × {height}"],
  imagePaintScale: ["当前 {percent}%", "Current {percent}%"],
  imageUpscaledHint: ["已放大，细节受源图限制", "Upscaled; detail is limited by the source"],
  imagePrecisionDetails: [
    "源尺寸 {width} × {height}；绘制 {paintedWidth} × {paintedHeight} CSS 像素；DPR {dpr}；有效密度 {density}",
    "Source {width} × {height}; painted {paintedWidth} × {paintedHeight} CSS pixels; DPR {dpr}; effective density {density}",
  ],
  readingCopyNoTextLayer: ["这个文档没有可选择的文字层；Omia 不会把图片伪装成文字。", "This document has no selectable text layer; Omia will not pretend an image is text."],
  readingCopySomePagesNoTextLayer: ["部分页面没有可选择的文字层；这些图片页不会被伪装成文字。", "Some pages have no selectable text layer; those image pages will not be presented as text."],
  // TIFF 和 HEIC 同一个成因：交给系统浏览器内核解码，mac 的 WebKit 支持、Windows 的 Chromium 不支持。
  // 2026-08-04 Windows 真机撞出来的（原来连兜底都没有，直接露出破图图标 + 完整路径）。
  tiffWinFailed: ["Windows 上打不开 TIFF", "TIFF isn't supported on Windows"],
  tiffWinHint: [
    "这是 Windows 系统浏览器内核不支持这个格式（mac 版可以打开）。可以先把图转成 PNG 或 JPG 再看。",
    "The browser engine Windows provides doesn't decode TIFF (the macOS version can open it). Convert the image to PNG or JPG first.",
  ],
  heicFailed: ["这张 HEIC 暂时无法显示", "Couldn't display this HEIC image"],
  // Windows 专用文案（2026-08-04 实测定论）：HEIC 在 Windows 上打不开是**引擎层面**的，
  // 不是这一张图的问题——Omia 把图交给系统的浏览器内核显示，Windows 那个内核（Chromium）
  // 不带 HEIC 解码器。同机实测：资源管理器能出缩略图（系统有解码能力），但 Edge 打开同一个
  // 文件是空白 → 内核的 <img> 不走系统编解码。所以别让用户白折腾装扩展，直接给出路。
  heicWinFailed: [
    "Windows 上打不开 HEIC",
    "HEIC isn't supported on Windows",
  ],
  heicWinHint: [
    "这是 Windows 系统浏览器内核不支持这个格式，装解码扩展也没用。可以在 iPhone 上把「相机 → 格式」改成「兼容性最优」，或先把照片转成 JPG。",
    "The browser engine Windows provides doesn't decode HEIC — installing a codec extension won't help. On your iPhone, set Camera → Formats to “Most Compatible”, or convert the photo to JPG first.",
  ],
  psdFailed: ["这个 PSD 暂时无法显示（可能未存合成预览图）", "Couldn't display this PSD (it may have no composite preview)"],
  cdrFailed: ["这个 CDR 暂时无法预览", "Couldn't preview this CDR"],
  cdrTooOld: ["这是较老版本的 CorelDRAW 文件（X3 及更早，无内嵌预览图），请让对方导出 PDF 或 AI 再打开", "Old CorelDRAW file (X3 or earlier, no embedded preview) — ask for a PDF or AI export instead"],
  rawFailed: ["这个 RAW 没有可显示的内嵌预览图（少数老机型/无损预览的 RAW 会这样）", "This RAW has no displayable embedded preview (rare on some older cameras)"],
  xmindFailed: ["XMind 打开失败", "Failed to open XMind"],
  fmtCad: ["CAD 图纸", "CAD drawing"],
  fmtSkp: ["SketchUp 模型", "SketchUp model"],
  skpCanvas: ["SketchUp 三维模型画布", "SketchUp 3D model canvas"],
  skpLoading: ["读取 SketchUp 模型…", "Reading SketchUp model…"],
  skpSizeLimit: ["暂支持 64 MB 以内的模型", "Preview supports models up to 64 MB"],
  skpComplexityLimit: ["模型过于复杂，暂时无法预览", "This model is too complex to preview"],
  skpInvalid: ["文件损坏或包含暂不支持的模型数据", "The file is damaged or contains unsupported model data"],
  skpEmpty: ["没有可显示的模型表面", "No displayable model surfaces"],
  skpReadFailed: ["无法读取文件，请确认文件仍在原位置", "Cannot read the file; check its location"],
  skpTimeout: ["模型处理超时，已停止加载", "Model processing timed out and was stopped"],
  skpWebglFailed: ["无法创建三维画布", "Could not create the 3D canvas"],
  skpFit: ["显示全模型", "Fit model"],
  skpPreviewNote: ["只读预览 · 拖动旋转，滚轮缩放，右键拖动平移", "Read-only preview · Drag to orbit, scroll to zoom, right-drag to pan"],
  cadCanvas: ["CAD 图纸画布", "CAD drawing canvas"],
  cadLoading: ["读取 CAD 图纸…", "Reading CAD drawing…"],
  cadPreparing: ["绘制图形与文字…", "Preparing geometry and text…"],
  cadFailed: ["CAD 图纸打开失败", "Could not open CAD drawing"],
  cadSizeLimit: ["暂支持 64 MB 以内的图纸", "Preview supports drawings up to 64 MB"],
  cadInvalidFile: ["文件损坏或包含暂不支持的数据", "The file is damaged or contains unsupported data"],
  cadReadFailed: ["无法读取文件，请确认文件仍在原位置", "Cannot read the file; check its location"],
  cadTimeout: ["图纸处理超时，已停止加载", "Drawing processing timed out and was stopped"],
  cadWebglFailed: ["无法创建图形画布", "Could not create the graphics canvas"],
  cadEmpty: ["没有可显示的二维图形", "No displayable 2D geometry"],
  cadFit: ["显示全图", "Fit drawing"],
  cadLayers: ["图层", "Layers"],
  cadMissingChars: ["部分文字缺少字体，显示可能不完整", "Some text may be incomplete due to missing glyphs"],
  cadPreviewNote: ["二维只读预览 · 特殊对象、外部参照和线型可能与 CAD 软件不同", "Read-only 2D preview · Custom objects, references and line styles may differ from CAD software"],
  model3dFailed: ["3D 模型打开失败", "Failed to open 3D model"],
  model3dLoading: ["加载 3D 模型…", "Loading 3D model…"],
  // Save As 目标标签
  t_md: ["Markdown", "Markdown"],
  t_html: ["HTML", "HTML"],
  t_word: ["Word", "Word"],
  t_txt: ["纯文本", "Plain text"],
  t_pdfShot: ["PDF（截图式）", "PDF (snapshot)"],
  t_pdf: ["PDF", "PDF"],
  t_mdForDoc: ["Markdown（文字为主合适）", "Markdown (text-first)"],
  t_xlsxCopy: ["Excel(.xlsx) 另存一份", "Excel (.xlsx) copy"],
  t_csv: ["CSV", "CSV"],
  t_json: ["JSON", "JSON"],
  t_jsonCopy: ["JSON 另存一份", "JSON copy"],
  t_excel: ["Excel", "Excel"],
  t_yaml: ["YAML", "YAML"],
  t_htmlTable: ["HTML 表格", "HTML table"],
  t_pptxCopy: ["PPT(.pptx) 另存一份", "PowerPoint (.pptx) copy"],
  t_docxCopy: ["Word(.docx) 另存一份", "Word (.docx) copy"],
  t_pngEachZip: ["每页 PNG.zip", "Per-page PNG.zip"],
  t_mdExtract: ["Markdown（提取文字）", "Markdown (extracted text)"],
  t_png: ["PNG", "PNG"],
  t_jpg: ["JPEG", "JPEG"],
  // 邀请码激活
  // 试用提示（轻提示，非浮层）
  trialWelcome: ["👂 一个月免费试用", "👂 One month free"],
  trialOver: ["请在设置中输入邀请码继续使用", "Enter an invite code in Settings to continue"],
  // 设置面板里的激活行（一直存在，不受试用期影响）
  settingsNeedsCode: ["设置 · 试用已结束，输入邀请码继续使用", "Settings · Trial ended — enter an invite code to continue"],
  setActivated: ["已激活", "Activated"],
  setEnterCode: ["输入邀请码", "Enter code"],
  setBuy: ["购买", "Buy"],

  // 第三方开源许可（合规必需：MIT/BSD/ISC/Apache-2.0 均要求随分发附版权声明与许可全文）
  // 版本号（Jane 2026-08-17 提）：界面上原先**没有任何地方**能看到自己装的是哪一版，
  // 顾客报障只能说「我是最新版」——而那通常只是「更新横幅没弹」，说明不了什么。
  // 排查 Windows「在资源管理器中显示」那个 bug 时，就因为搞不清对方跑的是哪版绕了很多圈。
  setVersion: ["版本", "Version"],
  setLegal: ["法律信息", "Legal"],
  ossOpen: ["第三方开源许可", "Open source licenses"],
  // 使用情况统计开关（Jane 2026-08-27 B3）：永不接触文件名/路径/内容。
  // 🔴 2026-08-28 采集范围扩了（打开方式 / 使用时长 / 是否编辑 / 是否转格式 / 失败分类），
  //    **三处文案必须同步改**：这里 / 首次告知 telemetryNotice / 官网隐私政策第 11 条。
  //    少改一处 = 收集的比公示的多，这是红线不是文案问题。见 lib/telemetry.ts 顶部注释。
  telemetryTitle: ["使用情况统计", "Usage Statistics"],
  telemetryOn: ["开", "On"],
  telemetryOff: ["关", "Off"],
  telemetrySubtitle: [
    "只记录你怎么用 Omia：打开次数、文件类型、怎么打开的、用了多久，不记录文件名和内容",
    "Records how you use Omia — opens, file types, how you opened them, session length — never names or contents",
  ],
  telemetryPrivacyLink: ["隐私政策", "Privacy Policy"],
  telemetryNotice: [
    "Omia 会统计使用情况帮助改进，不会读取你的文件。设置里可随时关闭。",
    "Omia collects usage statistics to help us improve — it never reads your files. You can turn this off anytime in Settings.",
  ],
  ossTitle: ["第三方开源许可", "Third-Party Open Source Notices"],
  ossIntro: [
    "Omia 建立在下列开源项目之上。感谢这些项目的作者与维护者。",
    "Omia is built on the open source projects listed below. Our thanks to their authors and maintainers.",
  ],
  ossLoading: ["正在载入…", "Loading…"],
  ossFailed: ["许可文本载入失败", "Failed to load the license text"],
  ossCopy: ["复制全文", "Copy all"],
  ossCopied: ["已复制", "Copied"],
  ossClose: ["关闭", "Close"],
  ossSearch: ["搜索组件名…", "Search components…"],
  ossCount: ["个开源组件", "open source components"],

  actTitle: ["试用愉快 👂 输入邀请码即可长期使用", "Enjoying it? 👂 Enter an invite code to keep using"],
  actHowToFree: ["关注公众号「小耳」免费领码", "Follow Xiaoer to get a free code"],
  // 🔴 价格双轨：中文＝国内 Z-Pay 扫码 ¥58 / 英文＝海外 Waffo 刷卡 $19.90。
  //    2026-09-03 前英文写的是 $9.9，那是从没上线过的旧口径；Waffo 上真实产品是 $19.90，
  //    接海外付款时若不改，就是「页面写 $9.9、实际扣 $19.90」。
  actBuyTitle: ["购买永久版 ¥58", "Buy lifetime — $19.90"],
  actBuySoon: ["购买即将开放", "Coming soon"],
  actPayAli: ["支付宝", "Alipay"],
  actPayCard: ["信用卡付款", "Pay with card"],
  actScanToPay: ["支付宝扫码付 ¥58，付完自动解锁", "Scan to pay ¥58 — unlocks automatically"],
  actCheckoutOpened: ["已在浏览器打开收银台，付完自动解锁", "Checkout opened in your browser — unlocks automatically"],
  actReopenCheckout: ["重新打开收银台", "Reopen checkout"],
  actWaitingPay: ["等待付款…", "Waiting for payment…"],
  actPayFail: ["下单失败，稍后再试", "Couldn't start payment, try again"],
  actChangePay: ["换一种", "Switch"],
  actPasteHint: ["有邀请码？粘这里激活 ↓", "Have an invite code? Paste below ↓"],
  actHowToPay: ["¥58 直接购买", "Buy for $19.90"],
  actEnterCode: ["使用邀请码", "Use invite code"],
  actBuy: ["支持购买 ¥58", "Buy $19.90"],
  actCodePlaceholder: ["OMON-XXXX-XXXX", "OMON-XXXX-XXXX"],
  actActivate: ["激活", "Activate"],
  actLater: ["稍后", "Later"],
  actOk: ["已激活，感谢支持 🌿", "Activated — thank you 🌿"],
  actBadFormat: ["邀请码格式不对", "Invalid code format"],
  actBadSig: ["邀请码无效", "Invalid code"],
  actExpired: ["邀请码已过期", "Code expired"],
  activated: ["已激活", "Activated"],
  // viewer 打开中 / 失败 / 提示状态
  openingWord: ["正在打开 Word…", "Opening Word…"],
  openWordFailed: ["打开 Word 失败：", "Failed to open Word: "],
  oldDocNote: ["老 .doc（97-2003 二进制）格式 · 已提取正文文本（纯前端渲染不了它的版式）。要保留版式请用 Word/WPS 转存为 .docx 再打开。", "Legacy .doc (97–2003 binary) format · text extracted (its layout can't be rendered in-browser). To keep the layout, re-save it as .docx in Word/WPS and open that."],
  openingSheet: ["正在打开表格…", "Opening spreadsheet…"],
  openSheetFailed: ["打开表格失败：", "Failed to open spreadsheet: "],
  officeSourceChanged: ["源文件已变化，请重新打开后再保存。", "The source changed. Reopen it before saving."],
  sheetPreviousRows: ["上一组行", "Previous rows"],
  sheetNextRows: ["下一组行", "Next rows"],
  sheetRowRange: ["选择行范围", "Select row range"],
  sheetRowsRange: ["第 {start}–{end} 行 / 共 {total} 行", "Rows {start}–{end} / {total}"],
  sheetTruncated: ["表格较大，仅显示前 1000 行 × 100 列", "Large sheet — showing the first 1000 rows × 100 columns"],
  embeddedImagesN: ["内嵌图片（{n} 张）", "Embedded images ({n})"],
  openingPptx: ["正在打开 PPTX…", "Opening PPTX…"],
  openPptxFailed: ["打开 PPTX 失败：", "Failed to open PPTX: "],
  pptxImagesNote: ["设计型 PPT · 版式无法纯前端还原，以下是文件内嵌的图片（{n} 张）", "Design-heavy deck · its layout can't be reproduced in-browser; below are the images embedded in the file ({n})"],
  pptxComplexNote: ["这个 PPT 用了复杂图形/矢量设计，纯前端既渲染不出版式、也没有可提取的内嵌图片。建议用 Keynote / PowerPoint 打开。", "This deck uses complex graphics / vector design — its layout can't be rendered in-browser and it has no extractable embedded images. Open it in Keynote / PowerPoint instead."],
  openPdfFailed: ["PDF 加载失败：", "Failed to load PDF: "],
  // HTML 源码编辑器
  htmlSourceHint: ["源码编辑 · 改完按 Save 写回原文件", "Source editing · press Save to write back to the file"],
  findPlaceholder: ["查找文字… Enter 跳下一处", "Find text… Enter for next"],
  findBtn: ["查找", "Find"],
  // HTML 富文本工具条 + 图片菜单 + 翻页
  rtBold: ["加粗", "Bold"],
  rtItalic: ["斜体", "Italic"],
  rtUnderline: ["下划线", "Underline"],
  rtStrike: ["删除线", "Strikethrough"],
  rtH1: ["标题", "Heading"],
  rtH2: ["小标题", "Subheading"],
  rtP: ["正文", "Body"],
  rtFontSmaller: ["字号变小", "Smaller text"],
  rtFontLarger: ["字号变大", "Larger text"],
  rtUl: ["无序列表", "Bulleted list"],
  rtOl: ["有序列表", "Numbered list"],
  rtColor: ["文字颜色", "Text color"],
  rtBrushGot: ["已取格式·选中目标再点刷上", "Format copied · select the target, then click to apply"],
  rtBrushIdle: ["格式刷·先选样板取格式", "Format painter · select a sample first"],
  rtClearFmt: ["清除格式", "Clear formatting"],
  rtImgResizeHint: ["点击选中后可拖右下角缩放", "Click to select, then drag the corner to resize"],
  imgReplace: ["替换", "Replace"],
  imgFit: ["适应", "Fit"],
  imgReset: ["原图", "Original"],
  imgFilterName: ["图片", "Images"],
  slidePrevEdit: ["上一页(保持编辑)", "Previous (keep editing)"],
  slideNextEdit: ["下一页(保持编辑)", "Next (keep editing)"],
  slidePageEdit: ["翻页改下一张", "Turn the page to edit the next"],
  // XmindView 节点折叠
  collapseNode: ["折叠", "Collapse"],
  expandNode: ["展开", "Expand"],
  // 链接文件夹（拖入的真实文件夹）
  linkedEmpty: ["这个文件夹里还没有能打开的文件", "No openable files in this folder yet"],
  unlinkFolder: ["移除（不删磁盘上的文件）", "Remove (keeps files on disk)"],
} satisfies Record<string, [string, string]>;

export type StrKey = keyof typeof STRINGS;

export function makeT(lang: Lang) {
  const i = lang === "en" ? 1 : 0;
  return (k: StrKey): string => STRINGS[k]?.[i] ?? STRINGS[k]?.[0] ?? (k as string);
}

export const LangContext = createContext<Lang>("zh");
export function useLang(): Lang { return useContext(LangContext); }
export function useT() { return makeT(useContext(LangContext)); }

export function detectLang(): Lang {
  try {
    const s = localStorage.getItem("omon.lang");
    if (s === "zh" || s === "en") return s;
  } catch { /* ignore */ }
  return (typeof navigator !== "undefined" && (navigator.language || "").toLowerCase().startsWith("zh")) ? "zh" : "en";
}
