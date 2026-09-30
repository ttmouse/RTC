# ADR-004: 会议白板的纪要草稿改用用户配置的 AI，且仅手动触发

- Status: accepted
- Date: 2026-09-30
- Owner: RTC maintainer
- Scope: 会议白板（server.js 白板接口 + meeting-board 前端）

## 背景

白板的「本地 AI 处理」是调用本机 Ollama 里写死的 `minicpm5-meeting` 模型，自动给每场会
生成一版「忠实整理」（只修识别错误/标点/口头禅，prompt 明确禁止总结）。这有三层问题：

1. **违反原则 1 的精神**——总结应该交给「用户自己配的 AI，不是我们指定的那一家」，
   而写死的 minicpm5-meeting 恰恰是「我们指定的那一家」，还要求用户专门安装这个模型。
2. **自动触发不可控**——转写一新增就重新整理，用户感知不到调用量，也感知不到本机
   Ollama 正在持续占用资源。
3. **定位天花板低**——因为小模型会编造，prompt 只敢让它做最小修改，产出不是人能直接用的
   纪要；守门规则「字符保留率 ≥45%」也把「总结」这条路堵死了。

用户拍板（2026-09-30）：产出定位升级为**会议纪要草稿**（分主题、结论、待办，可读性优先），
且**只在用户点按钮时才生成**——AI 消耗完全由用户的点击控制。

## 决定

- 退役本地 Ollama 链路：删除写死的模型常量、Ollama 专用端点拼装与旧保真校验。
- 「生成纪要草稿」改调 `settings.ai`（用户在设置 → AI 接入里配的服务商），OpenAI 兼容
  非流式调用，复用 `chatEndpoint` + `providerHeaders`（与 analyze / infer-definition 同一套）。
- **仅手动触发**：2 秒轮询、初始化、切场次都不再调 AI；每次点击真实重跑，无指纹缓存。
- 守门换成三条底线：非空、不是拒答套话、不比逐字稿还长（草稿是压缩不是扩写）。
- 正文所有权边界原样保留：只在正文为空或等于上一版草稿时写 `document`；
  用户手改过或 agent 写过就不覆盖，前端给「用草稿替换正文」显式采纳入口。
- 未配置 AI 时零副作用地返回指路提示（`{ok:false, status:'unconfigured'}`）。
- 外部 agent 通道 `rtc board`（scripts/meeting-board.mjs）不动，两者互补。

## 考虑过的替代方案

- 保留本地 Ollama 模型做降级——绑死一个模型、要用户装模型，正是本次要移除的东西；
  用户真想本地跑，可以在设置里把服务商配成 Ollama，走同一条链路。
- 保留自动触发（限频）——仍然会在用户不知情时消耗 API 额度，违背「仅手动」的决定；
  手动按钮 + 结果靠轮询送达已经覆盖「会中想要一版」的场景。
- 不内置，只靠 `rtc board` 外部 agent——白板开箱没有任何 AI 内容，会中即时性差；
  且外部 agent 是异步旁路，覆盖不了「点一下就有一版」。

## 后果

- 好处：去掉 Ollama 硬编码依赖与装机负担；产出从「修错字」升级为「能直接看、直接改的
  纪要草稿」；AI 消耗由用户每次点击控制；更符合原则 1。
- 代价：断网或未配置 AI 时没有草稿（白板仍可正常打开、手动编辑，空档如实指路）；
  逐字稿内容会发往用户配置的云端服务商——这是配置行为本身，用户可见可控。
- 兼容：`preliminary` 数据字段形状不变，旧数据直接兼容；
  `preliminary.model` 语义变为「用户配置的模型名」，只落盘不进界面（UX-10）。
- 后续：analyze / infer-definition 两个遗留端点的内联配置读取可顺手换成
  `boardAiSettings()`，作为独立小改动，不混入本次。

## 验证与链接

- 规则：`../product-rules/core-product-principles.md`（原则 1 例外清单已更新）、
  `../product-rules/ui-interaction-spec.md` 第 8 节、`../product-rules/ux-issue-log.md` UX-10 后记
- 方向：`../product-direction/meeting-board-external-ai-first.md`（已按本决定改写）
- 实现：`server.js`（`boardAiSettings` / `plausibleMeetingDraft` / `runPreliminary整理` /
  `POST /api/meeting-board/preliminary`）、`meeting-board/src/main.js`、
  `meeting-board/src/lib/preliminaryPanel.js`
- 测试：`meeting-board/tests/preliminary.test.mjs`、`preliminary-panel.test.mjs`、
  `ai-content-write.test.mjs`、`transcript.test.mjs`；巡检 `scripts/check-ux.mjs`
