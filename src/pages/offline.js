// Why Studio didn't open, and a way back to it. main.ts passes ?url=&code= along.
(() => {
  const q = new URLSearchParams(location.search);
  const url = q.get("url") || "";
  const code = Number(q.get("code") || 0);
  const why = document.getElementById("why");
  const title = document.getElementById("title");
  if (code === 404) {
    title.textContent = "This Studio isn't there";
    why.textContent = "The address answered, but there's no Studio at it yet. If it was just published, give it a minute.";
  } else if (code === 401 || code === 403) {
    title.textContent = "This Studio is private";
    why.textContent = "It only opens for people signed in to where it's hosted.";
  } else if (code >= 500) {
    title.textContent = "Studio is having a moment";
    why.textContent = "Its server didn't answer properly. Try again in a minute.";
  }
  const retry = document.getElementById("retry");
  if (/^https?:\/\//i.test(url)) retry.href = url;
  else retry.hidden = true;
  const other = document.getElementById("other");
  if (window.whosliveApp) {
    other.hidden = false;
    other.addEventListener("click", () => window.whosliveApp.chooseStudio());
  }
})();
