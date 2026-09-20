# challenges/public —— 空

阶段④（开发）产出候选制品之后，CHALLENGER 才针对制品产出挑战。
初始化（S2_COMMITTED）时没有制品，**写任何挑战都是在编造攻击面**，因此本目录留空。

进入 S3_BUILT 后按 skills 模板建 `<challenge_id>.yaml`：
- 公开挑战（BUILDER 可见）：正常路径
- 隐藏挑战（仅存 digest，BUILDER 不可读）：反例 / 边界 / 组合 / 故障 / 属性

隔离铁律：产出挑战的上下文 MUST_NOT 与产出实现的上下文是同一个。
