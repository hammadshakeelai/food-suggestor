const storageKey = "pink-plate-chats-v1";
const chatList = document.querySelector("#chatList");
const messagesEl = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const promptInput = document.querySelector("#promptInput");
const suggestButton = document.querySelector("#suggestButton");
const newChatButton = document.querySelector("#newChatButton");
const activeTitle = document.querySelector("#activeTitle");
const statusPill = document.querySelector("#statusPill");
const menuButton = document.querySelector("#menuButton");
const sidebar = document.querySelector(".sidebar");
const sidebarBackdrop = document.querySelector("#sidebarBackdrop");
const scrollButton = document.querySelector("#scrollToLatest");

const SCROLL_THRESHOLD = 96;

let chats = loadChats();
let activeChatId = chats[0]?.id || createChat().id;
let isLoading = false;
// Whether the view should follow new content. True while the user is parked
// near the bottom; flipped off the moment they scroll up to read history.
let stickToBottom = true;
// Force a single scroll-to-bottom on the next render (new message, chat switch).
let forceScrollNext = true;
// Anchor the latest prompt to the top of the view on the next render, so the
// prompt, recipe, and image are all visible together when an answer arrives.
let anchorLatestExchange = false;

render();

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isLoading) return;
  await suggestFood();
});

newChatButton.addEventListener("click", () => {
  const chat = createChat();
  activeChatId = chat.id;
  forceScrollNext = true;
  setSidebar(false);
  saveAndRender();
  promptInput.focus();
});

// Mobile drawer: keep the sidebar, its backdrop, and the menu button's ARIA
// state in sync through one entry point.
function setSidebar(open) {
  sidebar.classList.toggle("is-open", open);
  if (sidebarBackdrop) sidebarBackdrop.classList.toggle("is-visible", open);
  menuButton.setAttribute("aria-expanded", open ? "true" : "false");
}

menuButton.addEventListener("click", () => {
  setSidebar(!sidebar.classList.contains("is-open"));
});

if (sidebarBackdrop) {
  sidebarBackdrop.addEventListener("click", () => setSidebar(false));
}

// Escape closes the drawer for keyboard users.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && sidebar.classList.contains("is-open")) {
    setSidebar(false);
  }
});

promptInput.addEventListener("input", () => {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 148)}px`;
});

// Enter sends; Shift+Enter inserts a newline.
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!isLoading) composer.requestSubmit();
  }
});

// Track the user's intent: if they scroll up, stop auto-following.
messagesEl.addEventListener("scroll", () => {
  stickToBottom = isNearBottom();
  updateScrollButton();
});

if (scrollButton) {
  scrollButton.addEventListener("click", () => {
    stickToBottom = true;
    scrollToBottom();
    updateScrollButton();
  });
}

async function suggestFood() {
  const chat = getActiveChat();
  const typed = promptInput.value.trim();
  const userText = typed || "Suggest a delicious food recipe for me.";

  chat.messages.push({
    id: crypto.randomUUID(),
    role: "user",
    content: userText,
    createdAt: new Date().toISOString()
  });

  promptInput.value = "";
  promptInput.style.height = "auto";
  forceScrollNext = true;
  setLoading(true);
  saveAndRender();

  try {
    const response = await fetch("/api/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: chat.messages.map(({ role, content }) => ({ role, content }))
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not create a recipe.");

    const updatedChat = getActiveChat();
    updatedChat.messages.push({
      id: crypto.randomUUID(),
      ...data.assistant
    });
    updatedChat.title = data.title || updatedChat.title;
    updatedChat.updatedAt = new Date().toISOString();
    chats = [updatedChat, ...chats.filter((item) => item.id !== updatedChat.id)];
    activeChatId = updatedChat.id;
    anchorLatestExchange = true;
    saveAndRender();
  } catch (error) {
    const failedChat = getActiveChat();
    failedChat.messages.push({
      id: crypto.randomUUID(),
      role: "assistant",
      content: friendlyError(error),
      error: true,
      createdAt: new Date().toISOString()
    });
    forceScrollNext = true;
    saveAndRender();
  } finally {
    setLoading(false);
    promptInput.focus();
  }
}

function friendlyError(error) {
  if (error instanceof TypeError) {
    return "Couldn't reach the kitchen. Check your connection and that the server is running, then try again.";
  }
  return error.message || "Something went wrong. Please try again.";
}

function render() {
  const activeChat = getActiveChat();
  activeTitle.textContent = activeChat.title;
  renderChatList();
  renderMessages(activeChat);
}

function renderChatList() {
  chatList.innerHTML = "";

  chats.forEach((chat) => {
    const tab = document.createElement("div");
    tab.className = `chat-tab${chat.id === activeChatId ? " is-active" : ""}`;

    const open = document.createElement("button");
    open.className = "chat-tab-open";
    open.type = "button";
    open.innerHTML = `
      <span class="chat-tab-title"></span>
      <span class="chat-tab-date">${formatDate(chat.updatedAt)}</span>
    `;
    open.querySelector(".chat-tab-title").textContent = chat.title;
    open.addEventListener("click", () => {
      if (activeChatId !== chat.id) {
        activeChatId = chat.id;
        forceScrollNext = true;
        stickToBottom = true;
      }
      setSidebar(false);
      saveAndRender();
    });

    const remove = document.createElement("button");
    remove.className = "chat-tab-delete";
    remove.type = "button";
    remove.title = "Delete chat";
    remove.setAttribute("aria-label", `Delete ${chat.title}`);
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteChat(chat.id);
    });

    tab.append(open, remove);
    chatList.append(tab);
  });
}

function renderMessages(chat) {
  const prevScrollTop = messagesEl.scrollTop;
  const shouldStick = forceScrollNext || stickToBottom;
  forceScrollNext = false;

  messagesEl.innerHTML = "";

  if (!chat.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="empty-visual" aria-hidden="true">
        <span class="plate"></span>
        <span class="sauce"></span>
        <span class="leaf leaf-one"></span>
        <span class="leaf leaf-two"></span>
      </div>
      <h3>Hungry?</h3>
      <p>Sweet, savory, spicy, cozy - today's plate can go anywhere.</p>
    `;
    messagesEl.append(empty);
    updateScrollButton();
    return;
  }

  chat.messages.forEach((message) => {
    const article = document.createElement("article");
    article.className = `message ${message.role}${message.error ? " is-error" : ""}`;

    if (message.role === "assistant" && message.recipe) {
      article.append(renderRecipeMessage(message));
    } else {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = message.content;
      article.append(bubble);
    }

    messagesEl.append(article);
  });

  if (isLoading) {
    const article = document.createElement("article");
    article.className = "message assistant";
    article.innerHTML = `
      <div class="bubble loading-bubble" role="status" aria-label="Cooking up a recipe">
        <span></span>
        <span></span>
        <span></span>
      </div>
    `;
    messagesEl.append(article);
  }

  if (anchorLatestExchange && anchorLatestPromptToTop()) {
    anchorLatestExchange = false;
    stickToBottom = isNearBottom();
    updateScrollButton();
    return;
  }
  anchorLatestExchange = false;

  if (shouldStick) {
    scrollToBottom();
    stickToBottom = true;
  } else {
    messagesEl.scrollTop = prevScrollTop;
  }
  updateScrollButton();
}

// Scroll so the most recent user prompt sits at the top of the view; returns
// false if there is no prompt to anchor to.
function anchorLatestPromptToTop() {
  const prompts = messagesEl.querySelectorAll(".message.user");
  const last = prompts[prompts.length - 1];
  if (!last) return false;
  const elTop = last.getBoundingClientRect().top;
  const contTop = messagesEl.getBoundingClientRect().top;
  messagesEl.scrollTop += elTop - contTop - 8;
  return true;
}

function renderRecipeMessage(message) {
  const recipe = message.recipe;
  const wrap = document.createElement("div");
  wrap.className = "recipe-message";

  // Only reserve the hero image area when there is actually an image to show,
  // so a recipe without one reads as a clean card rather than an empty box.
  const imageBlock = message.imageUrl
    ? `<div class="recipe-image"><img src="${escapeAttribute(message.imageUrl)}" alt="${escapeAttribute(recipe.title)}" loading="lazy" /></div>`
    : "";

  const metaPills = [recipe.time, recipe.servings]
    .filter(Boolean)
    .map((value) => `<span class="meta-pill">${escapeHtml(value)}</span>`)
    .join("");

  wrap.innerHTML = `
    ${imageBlock}
    <div class="recipe-body">
      <div class="recipe-heading">
        <h3>${escapeHtml(recipe.title)}</h3>
        ${metaPills ? `<div class="recipe-meta">${metaPills}</div>` : ""}
      </div>
      <p class="intro">${escapeHtml(recipe.short_intro)}</p>
      <div class="recipe-grid">
        <section>
          <h4>Ingredients</h4>
          <ul>${recipe.ingredients.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
        </section>
        <section>
          <h4>Steps</h4>
          <ol>${recipe.steps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>
        </section>
      </div>
      ${recipe.tips?.length ? `<div class="tips"><h4>Tips</h4><p>${escapeHtml(recipe.tips.join(" "))}</p></div>` : ""}
    </div>
  `;

  const img = wrap.querySelector(".recipe-image img");
  if (img) {
    // Lazy images change height as they load; keep the view pinned if the
    // user is following along, and swap in a tidy placeholder if the URL breaks.
    img.addEventListener("load", () => {
      if (stickToBottom) scrollToBottom();
    });
    img.addEventListener("error", () => {
      const holder = img.parentElement;
      if (holder) holder.innerHTML = `<div class="image-fallback"><span aria-hidden="true">🍽️</span>Image unavailable</div>`;
    });
  }

  return wrap;
}

function deleteChat(id) {
  chats = chats.filter((chat) => chat.id !== id);
  if (!chats.length) {
    const fresh = createChat();
    activeChatId = fresh.id;
  } else if (activeChatId === id) {
    activeChatId = chats[0].id;
  }
  forceScrollNext = true;
  stickToBottom = true;
  saveChats();
  render();
}

function createChat() {
  const chat = {
    id: crypto.randomUUID(),
    title: "Fresh recipe",
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  chats = [chat, ...chats];
  saveChats();
  return chat;
}

function getActiveChat() {
  let chat = chats.find((item) => item.id === activeChatId);
  if (!chat) {
    chat = createChat();
    activeChatId = chat.id;
  }
  return chat;
}

function setLoading(value) {
  isLoading = value;
  suggestButton.disabled = value;
  promptInput.disabled = value;
  statusPill.textContent = value ? "Cooking" : "Ready";
  document.body.classList.toggle("is-loading", value);
  render();
}

function saveAndRender() {
  const chat = getActiveChat();
  chat.updatedAt = new Date().toISOString();
  saveChats();
  render();
}

function saveChats() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(chats.slice(0, 30)));
  } catch {
    // Storage can be full or blocked (private mode); keep running in-memory.
  }
}

function loadChats() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (Array.isArray(saved) && saved.length) {
      return saved.filter((chat) => chat && typeof chat.id === "string" && Array.isArray(chat.messages));
    }
  } catch {
    localStorage.removeItem(storageKey);
  }
  return [];
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= SCROLL_THRESHOLD;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateScrollButton() {
  if (!scrollButton) return;
  const hasMessages = getActiveChat().messages.length > 0;
  const show = hasMessages && !isNearBottom();
  scrollButton.classList.toggle("is-visible", show);
  scrollButton.setAttribute("aria-hidden", show ? "false" : "true");
}

function formatDate(date) {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric"
  }).format(value);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
