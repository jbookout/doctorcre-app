// Doc is one floating round icon at the bottom right of every DoctorCRE
// surface, and one nonmodal chat window anchored to it. There is no per-tile
// Doc control and no panel that opens at the top of a page: Doc is always in
// the same place, and it always says which page it is reading.
//
// Prototype only. The replies are canned and marked as such, the dictation
// button toggles a visible listening state and nothing else: no audio is
// captured, no network call is made, no record is read or changed.

const CANNED = [
  "The LOI response on Demo Gulf Breeze Dental is due Friday 5:00 PM and the redline is overdue. I can draft the reminder for your review.",
  "Demo Coastal Surveying has not answered on the survey window since Monday 9:12 AM. Dell owns the follow-up on Thursday.",
  "Three phases hold five assignments. Demo Crestview Derm moved to Engaged at 11:20 AM.",
  "I would read the authorized evidence for that record and propose the next action. Nothing would be sent until you approve it.",
];

/**
 * Wire the floating Doc icon and its chat window.
 *
 * @param {string} reading  the page Doc is reading, shown in the chat header
 *                          ("Doc is reading: Business home")
 */
export function mountDocDock(reading) {
  const fab = document.getElementById("docFab");
  const chat = document.getElementById("docChat");
  if (!fab || !chat) return null;
  const transcript = document.getElementById("docTranscript");
  const form = document.getElementById("docForm");
  const input = document.getElementById("docInput");
  const mic = document.getElementById("docMic");
  const label = document.getElementById("docReading");
  let opener = null;
  let replies = 0;

  const setReading = (text) => { if (label) label.textContent = `Doc is reading: ${text}`; };
  setReading(reading);

  const turn = (from, text) => {
    const node = document.createElement("div");
    node.className = "doc-turn";
    node.dataset.from = from;
    const tag = document.createElement("span");
    tag.textContent = from === "you" ? "You" : "Doc · Prototype reply";
    node.append(tag, document.createTextNode(text));
    transcript?.append(node);
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  };

  const open = (context) => {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : fab;
    if (context) setReading(context);
    chat.hidden = false;
    fab.setAttribute("aria-expanded", "true");
    input?.focus();
  };
  const close = () => {
    if (chat.hidden) return;
    chat.hidden = true;
    fab.setAttribute("aria-expanded", "false");
    stopListening();
    (opener || fab).focus();
  };
  const stopListening = () => {
    if (!mic || mic.getAttribute("aria-pressed") !== "true") return;
    mic.setAttribute("aria-pressed", "false");
    mic.querySelector(".doc-mic-label").textContent = "Dictate with Quill";
  };

  fab.addEventListener("click", () => (chat.hidden ? open() : close()));
  document.getElementById("docChatClose")?.addEventListener("click", close);
  chat.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } });
  fab.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = (input?.value || "").trim();
    if (!text) return;
    turn("you", text);
    input.value = "";
    turn("doc", CANNED[replies++ % CANNED.length]);
  });

  mic?.addEventListener("click", () => {
    const listening = mic.getAttribute("aria-pressed") !== "true";
    mic.setAttribute("aria-pressed", String(listening));
    mic.querySelector(".doc-mic-label").textContent = listening ? "Listening…" : "Dictate with Quill";
    if (!listening) turn("doc", "Dictation is a prototype toggle here. No audio was captured and nothing was sent.");
  });

  return { open, close, setReading };
}
