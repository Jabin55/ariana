/* 브라우저 주소가 제목에 나오는 기본 대화상자 대신 사이트 안에 안내창을 표시한다. */
let appDialogQueue = Promise.resolve();

function showAppDialog(message, kind, initialValue = "") {
  const next = appDialogQueue.then(() => new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const backdrop = document.createElement("div");
    backdrop.className = "app-dialog-backdrop";
    const panel = document.createElement("section");
    panel.className = "app-dialog-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "app-dialog-title");
    panel.setAttribute("aria-describedby", "app-dialog-message");
    const title = document.createElement("h2");
    title.id = "app-dialog-title";
    title.textContent = "외솔온닷의 메세지";
    const body = document.createElement("p");
    body.id = "app-dialog-message";
    body.className = "app-dialog-message";
    body.textContent = String(message ?? "");
    const input = kind === "prompt" ? document.createElement("input") : null;
    if (input) {
      input.type = "text";
      input.value = String(initialValue ?? "");
      input.setAttribute("aria-label", "입력 내용");
    }
    const actions = document.createElement("div");
    actions.className = "app-dialog-actions";
    const cancel = kind === "alert" ? null : document.createElement("button");
    const okay = document.createElement("button");
    okay.type = "button";
    okay.className = "primary";
    okay.textContent = "확인";
    if (cancel) {
      cancel.type = "button";
      cancel.textContent = "취소";
      actions.append(cancel);
    }
    actions.append(okay);
    panel.append(title, body);
    if (input) panel.append(input);
    panel.append(actions);
    backdrop.append(panel);
    const finish = (accepted) => {
      backdrop.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(kind === "prompt" ? (accepted ? input.value : null) : kind === "confirm" ? accepted : undefined);
    };
    cancel?.addEventListener("click", () => finish(false));
    okay.addEventListener("click", () => finish(true));
    backdrop.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); finish(false); }
      else if (event.key === "Enter" && event.target === input) { event.preventDefault(); finish(true); }
      else if (event.key === "Tab") {
        const focusable = [input, cancel, okay].filter(Boolean);
        const edge = event.shiftKey ? focusable[0] : focusable[focusable.length - 1];
        if (document.activeElement === edge) {
          event.preventDefault();
          (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
        }
      }
    });
    document.body.append(backdrop);
    (input || okay).focus();
    if (input) input.select();
  }));
  appDialogQueue = next.then(() => {}, () => {});
  return next;
}

function appAlert(message) { return showAppDialog(message, "alert"); }
function appConfirm(message) { return showAppDialog(message, "confirm"); }
function appPrompt(message, initialValue = "") { return showAppDialog(message, "prompt", initialValue); }
