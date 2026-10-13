// The address window: one field, checked as it's typed, OK or Cancel. Everything it knows comes from window.ask.
(() => {
  const form = document.getElementById("form");
  const input = document.getElementById("value");
  const label = document.getElementById("label");
  const error = document.getElementById("error");
  const ok = document.getElementById("ok");
  const cancel = document.getElementById("cancel");
  const api = window.ask;
  let closing = false;
  let seq = 0;

  const done = (v) => {
    if (closing) return;
    closing = true;
    api.done(v);
  };
  const check = async (show) => {
    const n = ++seq;
    const msg = await api.check(input.value);
    if (n !== seq) return msg;
    ok.disabled = msg !== null;
    input.setAttribute("aria-invalid", String(msg !== null && show));
    error.textContent = show && msg ? msg : "";
    return msg;
  };

  api.init().then((c) => {
    if (!c) return done(null);
    document.title = c.title;
    label.textContent = c.label;
    input.placeholder = c.placeholder;
    input.value = c.value;
    ok.textContent = c.ok;
    input.focus();
    input.select();
    void check(false);
  });
  input.addEventListener("input", () => void check(true));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if ((await check(true)) === null) done(input.value);
  });
  cancel.addEventListener("click", () => done(null));
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done(null);
  });
})();
