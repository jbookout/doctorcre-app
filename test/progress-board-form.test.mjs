import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

import { mountBoard } from "../js/progress-board.js";

const PAGE = await readFile(new URL("../progress-board.html", import.meta.url), "utf8");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function board(answers = []) {
  const dom = new JSDOM(PAGE, { url: "https://app.doctorcre.com/progress-board?board=project-one" });
  const { window } = dom;
  const writes = [];
  const client = {
    readProgressBoard: async () => ({
      snapshot: { board_id: "project-one", version: 1, snapshot_json: { title: "Test board", tasks: {} } },
      questions: [{ question_id: "color", revision: 2, prompt: "Choose a color",
        choices: ["Blue", "Green"], allow_free_text: true, status: null }],
    }),
    answerBoardQuestion: async args => {
      writes.push(structuredClone(args));
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { ok: true };
    },
  };
  mountBoard({ window, document: window.document, client, storage: null, search: "?board=project-one",
    setInterval: () => 0 }).start();
  await tick();
  const doc = window.document;
  const form = doc.querySelector("#board-questions form.answer-form");
  assert.ok(form, "question form rendered");
  const radios = [...form.querySelectorAll('input[type="radio"]')];
  const textarea = form.querySelector("textarea");
  const preview = form.querySelector(".answer-preview");
  const select = index => {
    radios[index].checked = true;
    radios[index].dispatchEvent(new window.Event("change"));
  };
  const type = value => { textarea.value = value; textarea.dispatchEvent(new window.Event("input")); };
  const current = () => doc.querySelector("#board-questions form.answer-form");
  return {
    form, radios, textarea, preview, writes, select, type,
    submit: async () => {
      form.dispatchEvent(new window.Event("submit", { cancelable: true }));
      for (let i = 0; i < 5; i += 1) await tick();
    },
    current,
  };
}

for (const [name, actions, expected] of [
  ["choice only", [["select", 0]], "Blue"],
  ["text only", [["type", "Custom"]], "Custom"],
  ["text then choice", [["type", "Custom"], ["select", 1]], "Green"],
  ["choice then text", [["select", 0], ["type", "Custom"]], "Custom"],
  ["text then choice then text", [["type", "First"], ["select", 1], ["type", "Last"]], "Last"],
  ["choice then text then choice", [["select", 0], ["type", "Custom"], ["select", 1]], "Green"],
]) {
  test(`answer form sends its visible value after ${name}`, async () => {
    const view = await board();
    for (const [action, value] of actions) view[action](value);
    assert.equal(view.preview.textContent, `Will send: ${expected}`);
    assert.equal(view.radios.filter(radio => radio.checked).length + Number(Boolean(view.textarea.value.trim())), 1,
      "only one answer mode is filled");
    await view.submit();
    assert.equal(view.writes.length, 1);
    assert.equal(view.writes[0].answer_text, expected);
    assert.equal(view.writes[0].base_version, 2);
  });
}

test("typing whitespace after a choice clears it and previews no answer", async () => {
  const view = await board();
  view.select(0);
  view.type("   ");
  assert.equal(view.radios.some(radio => radio.checked), false);
  assert.equal(view.preview.textContent, "Will send: —");
  await view.submit();
  assert.equal(view.writes.length, 0);
});

test("an unconfirmed send locks the shown answer until the identical retry", async () => {
  const view = await board([new Error("HTTP 503")]);
  view.type("Custom");
  await view.submit();
  assert.equal(view.preview.textContent, "Will send: Custom");
  assert.equal(view.textarea.disabled, true);
  assert.ok(view.radios.every(radio => radio.disabled));
  await view.submit();
  assert.equal(view.writes.length, 2);
  assert.deepEqual(view.writes[1], view.writes[0]);
});
