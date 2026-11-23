// The pad turns its page when it goes to another subject. Each meeting is a page of the pad in the
// order it was held, then a run that filed none yet, then New recording, the blank page after them.
// Forward, a copy of the sheet as it was flips up over the binding (pad.css, .page-turn), off the
// new page, which is drawn and live under it. Back, the earlier page comes down over the binding
// onto a still copy of the one left (.page-turn.back over .page-under).

// pad.css: the binding at the top of .content.
const BINDING = 30;

// What the pad's page is about: New recording, a meeting, or a run that filed none yet.
export function pageOf(view, meeting, run) {
  if (view !== "meeting") return "record";
  return meeting ? `meeting:${meeting.path}` : run ? `run:${run.id}` : "meeting";
}

export const turnsPage = (from, to) => Boolean(from) && from !== to;

// Where a page is in the pad: a meeting by its summary's path, which starts with when it was held.
const placeOf = (page) => (page.startsWith("meeting:") ? page.slice("meeting:".length) : page === "record" ? "￿2" : "￿1");

// Whether going from page `from` to page `to` goes back in the pad.
export const turnsBack = (from, to) => placeOf(to) < placeOf(from);

// Turns the page of `sheet` (.content) before it is drawn anew; resolves nothing. Returns what to
// call once the new page is drawn: going back, that is when the earlier page comes down.
export function turnPage(sheet, back = false) {
  if (!sheet.closest(".arrived") || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return () => {};
  const box = sheet.getBoundingClientRect();
  const pad = sheet.parentElement.getBoundingClientRect();
  const scroll = sheet.scrollTop;
  const hinge = Math.max(box.top, pad.top, box.top + BINDING - scroll) - box.top;
  const foot = Math.min(box.bottom, pad.bottom) - box.top;
  const place = (el) => {
    el.inert = true;
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = `left: ${box.left}px; top: ${box.top}px; width: ${box.width}px; --tall: ${box.height}px; ` +
      `--hinge: ${hinge}px; --bend: ${hinge + (foot - hinge) * 0.45}px; --foot: ${foot}px;${box.bottom > pad.bottom + 1 ? " --ear: 0px;" : ""}`;
    document.body.append(el);
    return el;
  };
  // The leaf that turns, cut at the binding and bent once, both faces a copy of `page`.
  const leaf = (page, back) => {
    const turn = document.createElement("div");
    turn.className = back ? "page-turn back" : "page-turn";
    turn.innerHTML = '<div class="turn-leaf"><div class="turn-face"></div><div class="turn-leaf"><div class="turn-face"></div></div></div>';
    for (const face of turn.querySelectorAll(".turn-face")) face.append(page.cloneNode(true));
    place(turn);
    for (const copy of turn.querySelectorAll(".turn-face > .content")) copy.scrollTop = page.scrollTop;
    return turn;
  };
  const ends = (turn, done) => {
    turn.addEventListener("animationend", (event) => event.target === turn.firstChild && done());
    setTimeout(done, 1500);
  };
  if (!back) {
    const turn = leaf(sheet, false);
    ends(turn, () => turn.remove());
    return () => {};
  }
  // The page left stays still while the earlier one comes down onto it.
  const under = place(document.createElement("div"));
  under.className = "page-under";
  under.append(sheet.cloneNode(true));
  under.firstChild.scrollTop = scroll;
  return () => {
    const turn = leaf(sheet, true);
    ends(turn, () => {
      turn.remove();
      under.remove();
    });
  };
}
