// imeGuard —— 挡住「中文输入法选词那一下的回车」。
//
// ! 病症（Jane 2026-08-08 报）：用中文输入法打字，按回车本来是**确认候选词**，
//    结果整句话直接发出去了。
//
// ! 为什么原来那句 `!e.nativeEvent.isComposing` 不管用：两家内核的事件顺序是反的。
//
//      Chrome / Edge：keydown(isComposing=true) → compositionend
//      Safari / WKWebView：compositionend → keydown(isComposing=**false**)
//
//    Omia 跑在 WKWebView 上，走的是第二条 —— 等 keydown 到手时 composition 已经结束，
//    isComposing 早变回 false 了，那个判断形同虚设。
//
//    所以还得看「刚刚才结束选词」：compositionend 之后极短的时间内来的回车，
//    是选词那一下的余波，不是用户要提交。

/** compositionend 之后多久内的回车算「选词的余波」。
 *  50ms：Safari 里这两个事件本就在同一轮事件循环里前后脚，够用；
 *  又短到人不可能在这个间隔里真的打完字再按回车。 */
export const IME_GRACE_MS = 50;

export type EnterCheck = {
  /** 事件自带的标志（Chrome 走这条）。 */
  isComposing: boolean;
  /** 我们自己记的「正在选词」（compositionstart 到 end 之间）。 */
  composing: boolean;
  /** 距离上次 compositionend 过了多久（Safari 走这条）。没结束过就传 Infinity。 */
  sinceEndMs: number;
};

/**
 * 这个回车是不是输入法选词弄出来的（是就别提交）。
 * 三条判据任意一条成立就拦——宁可漏放一次回车，也不能把半句话发出去。
 */
export function isImeEnter({ isComposing, composing, sinceEndMs }: EnterCheck): boolean {
  return isComposing || composing || sinceEndMs < IME_GRACE_MS;
}
