# RTC 语音指令生成指南

这份文档面向外部 AI Agent。文档路径通常是 `~/Projects/RTC/docs/voice-command-agent-guide.md`。用户要求新增或调整 RTC 语音指令时，先阅读本文，再修改 `commands.json`。

## 1. RTC 目前支持什么

RTC 的语音指令是“说法 → 已有能力”的映射，不是脚本语言。当前支持三类：

### 1.1 打开应用（`aliases`）

用户说出“打开 + 说法”后，RTC 激活目标应用。

```json
{
  "aliases": {
    "微信": "WeChat",
    "聊天软件": "WeChat"
  }
}
```

- 左侧是用户可能说出的短语。
- 右侧必须是系统应用列表中的应用标识，也就是 `.app` 包名，例如 `WeChat`、`Lark`、`Google Chrome`、`Terminal`。
- 不能把中文显示名直接当成右侧值；例如“飞书”通常应配置为 `Lark`。
- 同一个应用需要多个说法时，分别写成多个键；界面会把它们合并显示。
- 这类指令实际触发时，用户说的是“打开微信”，配置中的键只写“微信”。

### 1.2 按键或程序功能（`actions`）

用户说完整短语后，RTC 执行一次按键，或调用程序已经内置的功能。

```json
{
  "actions": {
    "发送": "Enter",
    "打开搜索": "Meta+KeyK",
    "总结会议": "meeting_summary"
  }
}
```

按键值使用浏览器 `KeyboardEvent.code` 表达式：

- 单键：`Enter`、`Escape`、`Tab`、`Space`、`ArrowDown`
- 组合键：`Meta+Shift+KeyK`、`Ctrl+Alt+Delete`
- 修饰键名称只能使用 `Meta`、`Ctrl`、`Alt`、`Shift`。
- `Meta` 代表 macOS 的 Command。左右修饰键无法区分。

目前已内置的程序功能码：

- `meeting_summary`：总结最近一次会议并生成 Markdown 会议纪要。

不要为了满足用户需求臆造新的功能码。用户如果要求“搜索网页”“发送邮件”“打开某个没有安装的应用”等超出上述能力的事情，应明确说明限制；能用按键或快捷短语近似实现时，再提出替代方案。

### 1.3 快捷短语（`snippets`）

用户说完整短语后，RTC 把预设文本粘贴到当前光标位置，并按当前设置决定是否自动回车。

```json
{
  "snippets": {
    "我的邮箱": "hello@example.com",
    "提交说明": "请检查刚才的修改，并告诉我是否存在遗漏。"
  }
}
```

- 左侧是用户要说的完整短语。
- 右侧是要粘贴的原文，可以包含中文、换行和标点。
- 这类指令不会调用 AI，也不会根据上下文动态生成内容；它只粘贴配置里的固定文本。
- 如果需求需要动态内容，应改用 `meeting_summary` 或建议用户使用外部 AI Agent，而不是把动态逻辑写进 `commands.json`。

## 2. 文件格式

`commands.json` 是普通 JSON 文件，默认位于：

```text
~/Library/Application Support/com.rtc.transcriber/commands.json
```

完整结构如下：

```json
{
  "version": 1,
  "aliases": {},
  "actions": {},
  "snippets": {}
}
```

修改时必须：

1. 先读取当前文件，不能用空模板覆盖现有配置；
2. 保留 `version` 和未涉及的条目；
3. 只在对应分区新增、修改或删除用户明确提到的条目；
4. 保持合法 JSON，键和值都必须是字符串；
5. 修改后重新读取并校验 JSON；
6. 不修改程序代码，不新增 `commands.json` 未支持的字段或动作码。

如果 RTC 正在运行，修改文件后重新打开语音指令页或重启 RTC，让内存中的指令表重新加载。

## 3. 推荐工作流程

1. 阅读本文，判断用户需求属于 `aliases`、`actions` 还是 `snippets`；
2. 读取当前 `commands.json`，检查是否已有相同或相近说法；
3. 对“打开应用”确认目标应用的系统标识，不要凭中文名猜测；
4. 对“按键”把用户描述转换成 `KeyboardEvent.code` 表达式；
5. 对“功能”只使用已内置的功能码；
6. 生成最小修改，保留其它配置；
7. 校验并写回文件；
8. 用简短清单告诉用户新增、修改或拒绝了哪些指令，以及需要重新加载 RTC 的提示。

如果不能访问文件或无法确认应用标识，不要假装已经完成，先向用户说明阻塞点。

## 4. 也可以使用 CLI

在已安装 `rtc` 命令的环境中，可以先查看配置：

```bash
rtc commands get
rtc commands list
```

CLI 支持管理打开应用指令：

```bash
rtc commands set "聊天软件=WeChat"
rtc commands remove "聊天软件"
```

CLI 也支持管理按键/功能指令：

```bash
rtc commands actions set "发送=Enter" "打开搜索=Meta+KeyK"
rtc commands actions remove "打开搜索"
```

快捷短语目前应直接按本文格式修改 `commands.json`，并保留文件中的其它分区和条目。
