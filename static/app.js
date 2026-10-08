// 대화 기록은 브라우저 메모리에만 둔다. 새로고침하면 사라진다.
const MAX_TURNS = 40;
const history = [];

const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("input");
const send = document.getElementById("send");
const suggestions = document.getElementById("suggestions");

function render(md) {
  return DOMPurify.sanitize(marked.parse(md));
}

function addBubble(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "user") bubble.textContent = text;
  else bubble.innerHTML = render(text);
  wrap.appendChild(bubble);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

async function ask(question) {
  suggestions?.remove();
  history.push({ role: "user", content: question });
  addBubble("user", question);
  const bubble = addBubble("assistant", "");
  bubble.classList.add("pending");
  setBusy(true);

  let answer = "";
  let failed = false;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history.slice(-MAX_TURNS) }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const event = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? "{}");
        if (event === "delta") {
          answer += data.text;
        } else if (event === "refusal" || event === "error") {
          // 거절·오류 시 이미 받은 부분 답변은 버린다.
          answer = data.text;
          failed = true;
        }
        bubble.classList.remove("pending");
        bubble.innerHTML = render(answer);
        log.scrollTop = log.scrollHeight;
      }
    }
  } catch (err) {
    console.error(err);
    answer = "서버와 통신하지 못했어요. 잠시 후 다시 시도해 주세요.";
    failed = true;
    bubble.classList.remove("pending");
    bubble.innerHTML = render(answer);
  }

  if (failed || !answer) {
    // 실패한 질문은 기록에서 빼서 다음 요청이 user→user 로 이어지지 않게 한다.
    history.pop();
    bubble.classList.add("error");
  } else {
    history.push({ role: "assistant", content: answer });
  }
  setBusy(false);
  input.focus();
}

function setBusy(busy) {
  send.disabled = busy;
  input.disabled = busy;
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  input.style.height = "";
  ask(q);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
});

suggestions?.addEventListener("click", (e) => {
  if (e.target instanceof HTMLButtonElement) ask(e.target.textContent);
});

document.getElementById("reset").addEventListener("click", () => location.reload());
