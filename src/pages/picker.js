// The chooser: screens or windows, one picked, Share or Cancel. Everything it knows comes from window.picker.
(() => {
  const grid = document.getElementById("grid");
  const empty = document.getElementById("empty");
  const share = document.getElementById("share");
  const cancel = document.getElementById("cancel");
  const audioRow = document.getElementById("audio-row");
  const audio = document.getElementById("audio");
  const tabs = [...document.querySelectorAll("nav button")];
  /** Per tab: null while it's still being looked up. */
  const items = { screen: null, window: null };
  let kind = "screen";
  let picked = null;
  let closing = false;

  const done = (choice) => {
    if (closing) return;
    closing = true;
    window.picker.done(choice);
  };
  const go = () => picked && done({ id: picked, audio: !audioRow.hidden && audio.checked });
  const pick = (id) => {
    picked = id;
    share.disabled = !id;
    for (const c of grid.children) c.setAttribute("aria-selected", String(c.dataset.id === picked));
  };

  function render() {
    grid.textContent = "";
    const shown = items[kind];
    if (!shown) {
      empty.textContent = kind === "screen" ? "Looking for screens…" : "Looking for windows…";
      empty.hidden = false;
      return;
    }
    empty.textContent = kind === "screen" ? "No screens to share." : "No windows to share. Open the app you want to show, then try again.";
    empty.hidden = shown.length > 0;
    for (const it of shown) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "card";
      card.setAttribute("role", "option");
      card.setAttribute("aria-selected", String(it.id === picked));
      card.dataset.id = it.id;
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      if (it.thumb) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = it.thumb;
        thumb.append(img);
      }
      const label = document.createElement("div");
      label.className = "label";
      if (it.icon) {
        const ic = document.createElement("img");
        ic.alt = "";
        ic.src = it.icon;
        label.append(ic);
      }
      const name = document.createElement("span");
      name.textContent = it.name;
      name.title = it.name;
      label.append(name);
      card.append(thumb, label);
      card.addEventListener("click", () => pick(it.id));
      card.addEventListener("dblclick", () => {
        pick(it.id);
        go();
      });
      grid.append(card);
    }
  }

  for (const t of tabs)
    t.addEventListener("click", () => {
      kind = t.dataset.kind;
      for (const x of tabs) x.setAttribute("aria-selected", String(x === t));
      if (!(items[kind] ?? []).some((i) => i.id === picked)) pick(null);
      render();
    });
  share.addEventListener("click", go);
  cancel.addEventListener("click", () => done(null));
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done(null);
    else if (e.key === "Enter" && picked) go();
  });

  const load = (k) =>
    window.picker.list(k).then(
      (d) => {
        items[k] = d?.items ?? [];
        if (d?.audio) audioRow.hidden = false;
        // One screen: it's already the obvious choice.
        if (k === "screen" && items.screen.length === 1 && !picked && kind === "screen") picked = items.screen[0].id;
        share.disabled = !picked;
        if (k === kind) {
          render();
          grid.focus();
        }
      },
      () => {
        items[k] = [];
        if (k === kind) render();
      },
    );
  render();
  void load("screen");
  void load("window");
})();
