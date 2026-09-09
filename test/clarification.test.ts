import assert from "node:assert/strict";
import test from "node:test";
import { hasMultipleQuestionSentences } from "../src/core/clarification.js";

test("question syntax guard distinguishes multiple sentences from explanation or emphasis", () => {
  for (const text of ["Which date? Also, which style?", "几号出发？另外选哪种风格？", "日期？风格?"]) {
    assert.equal(hasMultipleQuestionSentences(text), true, text);
  }
  for (const text of ["何时出发？？", "使用哪个后端？这会影响接口设计。", "保暖实用、兼顾拍照，还是轻装少带？", "请输入日期范围"]) {
    assert.equal(hasMultipleQuestionSentences(text), false, text);
  }
});
