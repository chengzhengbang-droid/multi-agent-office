import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewAnchors } from "../src/web/review-anchors.js";

test("审核卡片挂到最新一轮审核运行上，而不是被审核的那条交付上", () => {
  const anchors = buildReviewAnchors([
    { id: "run-task", hasReview: true },
    { id: "run-review-1", taskRunId: "run-task", hasReview: false },
    { id: "run-rework", hasReview: false },
    { id: "run-review-2", taskRunId: "run-task", hasReview: false },
  ]);
  assert.equal(anchors.get("run-task"), "run-review-2");
});

test("审核还没开跑时，卡片留在交付本身，等待状态不会凭空消失", () => {
  const anchors = buildReviewAnchors([{ id: "run-task", hasReview: true }]);
  assert.equal(anchors.get("run-task"), "run-task");
});

test("没有审核状态的运行不产生锚点", () => {
  const anchors = buildReviewAnchors([
    { id: "run-task", hasReview: false },
    { id: "run-review", taskRunId: "run-task", hasReview: false },
  ]);
  assert.equal(anchors.size, 0);
});

test("两份交付各自的审核互不串台", () => {
  const anchors = buildReviewAnchors([
    { id: "task-a", hasReview: true },
    { id: "task-b", hasReview: true },
    { id: "review-b", taskRunId: "task-b", hasReview: false },
    { id: "review-a", taskRunId: "task-a", hasReview: false },
  ]);
  assert.equal(anchors.get("task-a"), "review-a");
  assert.equal(anchors.get("task-b"), "review-b");
});
