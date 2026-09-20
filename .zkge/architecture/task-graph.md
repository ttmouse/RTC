# task-graph.md —— 任务图谱（阶段⑧ 可执行规约 · 任务图谱）
# 项目：RTC 实时语音转文字 ｜ 人工重写，非生成器初稿
#
# 与 intent.yaml 的 task_graph 段一一对应；每个状态/迁移都指向一条能力问题或 claim。
# 与 ontology.yaml 的 roundtrip：状态迁移 ↔ events 声明 ↔ constraints oracle。

# ── 主流程编排图（mermaid flowchart TD）──────────────────────────────────────
```mermaid
flowchart TD
    A[用户说话] --> B{界面状态}
    B -->|就绪| C[采集音频]
    B -->|不可用 / 降级| Z1[如实报出原因与出路<br/>MUST_NOT 显示就绪]

    C --> D[识别引擎]
    D -->|本机 8932| E1[SenseVoice]
    D -->|云端| E2[百炼 API]

    E1 --> F[得到文本]
    E2 --> F

    F --> G{静音/噪声判定}
    G -->|丢弃| G1[不计入记录<br/>SegmentDiscarded]
    G -->|保留| H[落盘 events/YYYY-MM-DD.jsonl]

    H -->|成功| I[SegmentPersisted<br/>列表显示该条]
    H -->|失败| I1[SegmentPersistFailed<br/>MUST_NOT 表现为成功]

    I --> J{该条是否在粘贴/发送名单内}
    J -->|在| K[投递到目标应用<br/>DELIVERED_TO + 行末徽标]
    J -->|不在| K1[不投递、不提示<br/>静默]

    I --> L[按天文件反推会议场次]
    L --> M[白板：正文 / 分析]
    M -->|用户写| M1[编辑模式自动保存]
    M -->|外部 AI 写| M2[rtc board write-document]
    M1 -.->|磁盘被外部改动| M3[冲突：人类裁决]
    M2 -.->|整篇替换| M4[不得静默覆盖用户内容]

    I --> N[外部 AI 读取<br/>rtc transcript / REST]
    N --> O[会议分析 / 指令生成]

    style Z1 fill:#ffe0e0
    style G1 fill:#f0f0f0
    style I1 fill:#ffe0e0
    style M3 fill:#fff0c0
    style M4 fill:#ffe0e0
```

# ── 子流程状态机 ─────────────────────────────────────────────────────────────
## 状态机一：录音与识别（主链路）
```mermaid
stateDiagram-v2
    [*] --> IDLE_READY
    IDLE_READY --> IDLE_UNAVAILABLE: 服务不可达
    IDLE_READY --> IDLE_ENGINE_DEGRADED: 端口可达但模型未加载
    IDLE_UNAVAILABLE --> IDLE_READY: 服务恢复
    IDLE_ENGINE_DEGRADED --> IDLE_READY: 模型加载成功

    IDLE_READY --> RECORDING: 点击麦克风 / 空格 / 热键
    IDLE_UNAVAILABLE --> RECORDING: MUST_NOT 进入
    IDLE_ENGINE_DEGRADED --> RECORDING: MUST_NOT 静默进入

    RECORDING --> RECORDING_LOSING: 识别链路断开
    RECORDING_LOSING --> RECORDING: 链路自愈
    RECORDING --> RECORDING_NO_SIGNAL: 输入电平持续低于阈值
    RECORDING_NO_SIGNAL --> RECORDING: 输入恢复有信号

    RECORDING --> STOPPING: 点击停止 / 空格
    STOPPING --> IDLE_READY: 尾部内容落盘成功
    STOPPING --> PERSIST_FAILED: 落盘失败
    PERSIST_FAILED --> IDLE_READY: 用户处理后写入恢复
```

## 状态机二：睡眠唤醒恢复
```mermaid
stateDiagram-v2
    IDLE_READY --> SLEEPING: 系统睡眠
    RECORDING --> SLEEPING: 系统睡眠
    SLEEPING --> WAKING: 系统唤醒
    WAKING --> IDLE_READY: 音频上下文 resume 成功且输入有信号
    WAKING --> IDLE_UNAVAILABLE: 自愈失败（MUST 给出可执行恢复动作）
```

## 状态机三：录音中落盘失败
```mermaid
stateDiagram-v2
    RECORDING --> PERSIST_ATTEMPT: 识别结果产生
    PERSIST_ATTEMPT --> RECORDING: 写入成功
    PERSIST_ATTEMPT --> PERSIST_FAILED: 写入失败（磁盘满/目录不可写/权限变化）
    PERSIST_FAILED --> RECORDING: 恢复
```

## 状态机四：会议白板
```mermaid
stateDiagram-v2
    [*] --> BOARD_EMPTY
    BOARD_EMPTY --> BOARD_READONLY: 有正文或分析
    BOARD_READONLY --> BOARD_EDITING: 点击「编辑」
    BOARD_EDITING --> BOARD_READONLY: 自动保存成功
    BOARD_EDITING --> BOARD_CONFLICT: 保存前检测到磁盘被外部改动
    BOARD_CONFLICT --> BOARD_EDITING: 用户选择保留哪一版（人类闸门）
    BOARD_READONLY --> BOARD_READONLY: 外部写入（MUST 让用户知情）
```

## 状态机五：数据清除
```mermaid
stateDiagram-v2
    IDLE_READY --> CLEARING: 点击「清除历史」（二次确认，人类闸门）
    CLEARING --> IDLE_READY: 清除完成（所有界面同步，无死入口）
    IDLE_READY --> CLEARING_ALL: 点击「清除所有数据」（二次确认，人类闸门）
    CLEARING_ALL --> [*]: 回到首次启动态
```

# ── 编排规则四要素（人工逐条回答）────────────────────────────────────────────
orchestration_rules:
  - rule: parallel_fan_out
    question: "哪些可以并行扇出，哪些必须串行？"
    answer: >
      可并行：识别（8932）、模型管理（8933）、代理（8931）三者互不阻塞；
      对外展示的统计聚合、白板分析、外部 AI 读取可以并行。
      必须串行：音频采集 → 识别 → 落盘 → 投递（粘贴/发送）——后一步的事实来源是前一步，
      特别是「只有落盘成功的记录才允许投递」与「列表显示 ⟹ 已落盘」两条约束；
      白板冲突检测必须在保存之前完成，不得先写后比。
      跨实例（开发态 + 已安装应用同时运行）没有互斥机制，两条链路实际并行写同一份记录文件——
      这是 C-037 的根因，属于已知未解决缺口，不得当成串行来处理。

  - rule: independent_verifier
    question: "授权/校验是否独立成 Activity 并在每个业务副作用前重复验证？"
    answer: >
      没有独立的校验 Activity。当前实现里，可用性判定（端口可达 / 模型已加载）与副作用
      （开始录音、写入配置、安装更新）在同一个流程内，判定结果不二次复核。
      具体后果：端口可达即报「就绪」（状态诚实约束不成立）；外部 AI 与界面并发写 config 没有
      复核（配置写入不互相覆盖约束不成立）；更新安装前不检查录音是否在进行（录音不因更新中断约束不成立）。
      本项在 claims 中的对应：CLAIM.CONFIG.*、CLAIM.UPDATE.*、CLAIM.ASR.*。
      → 这是本项目 38 条 R3 声明里多条共同指向的结构性缺口。

  - rule: stop_rule
    question: "每个等待节点/超时的停止规则是什么？"
    answer: >
      等待类节点：识别服务连接（超时后进入 IDLE_UNAVAILABLE，不得静默重试到无限）、
      落盘写入（失败即进入 PERSIST_FAILED，不得吞掉异常继续显示成功）、
      唤醒恢复判定（超时即判为自愈失败，进入 IDLE_UNAVAILABLE 并给出可执行动作）。
      停止录音后等待尾部内容落盘：必须有超时，超时按落盘失败处理并告知用户。
      机器侧的停止规则见技能 A12：命中 OPEN_COUNTEREXAMPLE / FLAKY_RESULT 一律停止，不得重跑到绿。
      未定义停止规则的已知节点：白板冲突——用户不做选择时的行为没有定义（C-036 同类问题）。

  - rule: human_gate
    question: "哪些节点是人工闸门？AI/自动化是否可能绕过？"
    answer: >
      人工闸门三条（与 intent.yaml 中 human_gate: true 的三条迁移一致）：
      白板冲突裁决（BOARD_EDITING ↔ BOARD_CONFLICT）、清除历史/清除所有数据（IDLE_READY → CLEARING）。
      可能被绕过的路径（这是本项要盯的核心）：
      ① 白板：外部 AI 走 rtc board write-document 整篇替换，不经过编辑模式，不触发冲突检测——
         用户的手写内容会被静默覆盖，人类闸门形同不存在（C-019/C-020）。
      ② 清除：外部 AI 可以绕过界面的二次确认直接删记录文件（C-034/C-035 同类）。
      ③ 更新：「恢复默认」不经确认即生效，且确认框出现后取消不能中止（C-035/C-036）。
      ④ 应用更新：安装后自动重启，录音中的内容不落盘（C-033/S-225）。
      → 四条绕过路径都已有对应 claim 冻结，未修复前该闸门不得宣称有效。

# ── 任务图 ↔ 世界图 roundtrip（阶段⑨ 验证闭环）──────────────────────────────
roundtrip_checklist:
  - "每个状态机的合法/禁止迁移都有能力问题覆盖"
  - "每个事件在 events 中有声明，且状态迁移与事件同事务"
  - "每个守恒约束有 claims/ 中的 oracle"
  - "人工闸门无自动旁路"

roundtrip_detail:
  - item: 合法/禁止迁移有覆盖
    status: 部分
    note: >
      RECORDING_LOSING / RECORDING_NO_SIGNAL / PERSIST_FAILED / BOARD_CONFLICT /
      IDLE_ENGINE_DEGRADED 五个异常态都有对应 claim 冻结（CLAIM.AUDIO.*、CLAIM.ASR.*、CLAIM.REC.*、CLAIM.BOARD.*）。
      未覆盖：IDLE_ENGINE_DEGRADED → RECORDING 这条「MUST_NOT 静默进入」的禁止迁移，
      只有能力问题、没有冻结成 claim（在清单第三部分，R2）。
  - item: 事件声明与迁移同事务
    status: 否
    note: >
      ontology 中声明的 22 类事件（SegmentPersisted / SegmentPersistFailed / AudioFlowStalled /
      SystemWoke / WakeRecoveryResult / BoardConflictDetected / HistoryCleared 等）在实现里
      大多不存在为独立事件，只是分散的日志或状态变量。当前记录文件里只有 type=segment 一种行。
      → 这是 claim 兑现前必须先补的实现缺口，否则多条 oracle 无法机器检查。
  - item: 守恒约束有 oracle
    status: 是（仅对 R3 冻结项）
    note: 18 条 constraints 中，对应 R3 冻结 claim 的已配有 oracle 与 counterexample；R2 项仍在清单未冻结。
  - item: 人工闸门无自动旁路
    status: 否
    note: 见 orchestration_rules.human_gate 列出的四条绕过路径，全部成立且均已冻结为 claim。