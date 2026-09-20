# roundtrip-report.md —— 图谱 Roundtrip 验证报告（阶段⑨ 适配回溯 · 实施后回填）
# 模板来源：renheng B2B 订单履约验证项目 docs/05-roundtrip-report.html（已实战验证 15/15）
#
# 用途：里程碑验收时，用 code-review-graph 把代码读回成图，回答 ontology.yaml 的
# 每个能力问题。这份报告是「人读的两样东西」中的第二样（验收总表的证据主体）。
# 纪律：
#   1. 设计期先填「预期图锚点」，实施后回填「实际图锚点」——两份对照，不允许实施后补预期
#   2. 「答不出」的就是设计裂缝：修正 ontology/状态图/claims，不修代码掩盖
#   3. 设计偏差必须记录「先改文档再改代码」的次序（roundtrip 纪律）
#   4. 每个结论必须有测试背书（score-card.yaml 的 case id）——图锚点 + 测试双证

# ── 抽取结果（工具/参数/规模）──────────────────────────────────────────────
extraction:
  tool: "code-review-graph"
  command: "code-review-graph build --repo ."
  params: { files: <N>, nodes: <N>, edges: <N>, postprocess: "full", commit: <sha> }
  note: "流程检测启用；社区聚类方式（igraph 或文件级降级）"

# ── CQ 回答表（能力问题 × 预期/实际锚点 × 测试背书 × 结论）───────────────────
# 每个能力问题一行。这是适配总表的核心，必须逐条填，不允许合并。
cq_answers:
  # - cq: CQ-04
  #   question: "订单 O 当前处于什么状态？允许哪些状态迁移？哪些禁止？"
  #   expected_anchor: "domain/fsm.go transitionTable（设计时）"
  #   actual_anchor: "internal/domain/fsm.go:18 表驱动 FSM（实施后）"
  #   test_backing: [L0-01]
  #   conclusion: "✅ 由代码图回答"
  # - cq: <CQ-XX>
  #   question: "<能力问题原文>"
  #   expected_anchor: "<设计时的预期图锚点>"
  #   actual_anchor: "<实施后的实际图锚点 file:line>"
  #   test_backing: [<test ids>]
  #   conclusion: "✅ 由代码图回答 / ❌ 答不出（设计裂缝）"

# ── 设计偏差记录（实施中发现，先改文档再改代码）────────────────────────────
# 每项偏差必须绑定：变更内容、为什么、是否绑定 CQ。
design_deviations:
  # - change: "schema caveat 语法校准：expiry_ok(expires_at timestamp) { expires_at > time.now() }"
  #   reason: "授权系统 v1.39 语法实测（冒号参数移除、now 注入）"
  #   binds_cq: true
  # - change: "FSM 增边：SHIP_ASSIGNING → SHIPPED（实发完成直连）"
  #   reason: "实发信号在分配闸门直接执行（发货+库存扣减单事务）"
  #   binds_cq: true   # CQ-04/08
  # - change: "<变更>"
  #   reason: "<为什么>"
  #   binds_cq: <true/false>

# ── 结论 ─────────────────────────────────────────────────────────────────────
conclusion: |
  <N>/<M> 个能力问题全部由代码图回答。代码与设计的一致性见偏差记录
  （roundtrip 纪律：先改文档再改代码均已同步）。
