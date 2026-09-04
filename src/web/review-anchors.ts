/**
 * 审核结论卡片挂在哪条消息下面。
 *
 * 事件投影把 review 状态挂在**发起交付的那个 run** 上（见 App.tsx 的
 * applyReviewEvent）：被审核的是那份交付，状态属于它，这一点不变。
 * 但时间线上那条消息通常在很上面——任务的第一条 Agent 回复——而审核
 * 往往要谈好几轮。照着投影渲染的结果是：审核越往后走，结论离读者的
 * 视线越远，最后全部堆在第一条消息底下。
 *
 * 所以显示位置和归属分开算：卡片改挂到这条审核链**最新的那次审核运行**
 * 上，也就是审核者自己那条消息下面。还没有审核运行时（review.requested
 * 刚落库）退回交付本身，这样"等待审核"不会凭空消失。
 */
export interface ReviewAnchorInput {
  id: string;
  /** 审核运行指回被它审核的那次交付；交付本身没有这个字段。 */
  taskRunId?: string;
  /** 该 run 上有没有审核状态，即它是不是一份被审核的交付。 */
  hasReview: boolean;
}

/**
 * 按时间顺序传入同一个 thread 的 Agent 运行，返回「交付 run id → 卡片该挂在哪个 run id 上」。
 * 只有带审核状态的交付会出现在结果里。
 */
export function buildReviewAnchors(runs: readonly ReviewAnchorInput[]): Map<string, string> {
  const latestReviewRun = new Map<string, string>();
  for (const run of runs) {
    // 后面的覆盖前面的：同一份交付审了三轮就挂在第三轮那条消息下面。
    if (run.taskRunId) latestReviewRun.set(run.taskRunId, run.id);
  }
  const anchors = new Map<string, string>();
  for (const run of runs) {
    if (!run.hasReview) continue;
    anchors.set(run.id, latestReviewRun.get(run.id) ?? run.id);
  }
  return anchors;
}
