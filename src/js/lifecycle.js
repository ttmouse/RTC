/**
 * 系统生命周期：只做一件事——认出「机器刚刚睡过一觉又回来了」。
 *
 * 为什么要专门认它：合上盖子再打开之后，麦克风句柄、WebAudio 会话、ASR 的 TCP 连接
 * 都可能已经死了，而且死得悄无声息——界面照样写「就绪」，点录音也能进「识别中」，
 * 但一个采样都不会离开这台机器。用户录完一场才发现什么都没存。
 * 浏览器不给 lid 事件，WebKit 也没有可监听的系统唤醒回调，所以只能这样认：
 * 我们自己的定时器上一秒还在，下一秒隔了几十秒才回来 —— 中间就是睡过去了。
 *
 * 这是**启发式**，不是精确信号：窗口被完全遮挡、系统省电时定时器也会被节流，
 * 于是「假唤醒」是可能的。所以唤醒动作必须便宜且幂等（重探一次服务、按需重建音频），
 * 错了不该有任何副作用；绝不在这里做删数据、写历史这类不可逆的事。
 */

/** 定时器一次跳变超过这个长度，就当成中间发生过系统睡眠 */
export const WAKE_GAP_MS = 5000;

/** 这一次跳变算不算「睡过了」 */
export function isWakeGap(gapMs) {
  return Number.isFinite(gapMs) && gapMs > WAKE_GAP_MS;
}

/**
 * 开始盯着「睡醒」这件事。onWake 只在跳变超阈值时调一次（不带任何参数判断）。
 * 返回一个停止函数，方便测试与将来的热重载。
 */
export function watchWake(onWake, { intervalMs = 1000, now = () => Date.now() } = {}) {
  let last = now();
  const timer = setInterval(() => {
    const t = now();
    const gap = t - last;
    last = t;
    if (isWakeGap(gap)) {
      try { onWake(gap); } catch (e) { console.error('[wake] 处理失败:', e); }
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
