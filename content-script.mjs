const LOG_PREFIX = "[WI Notify AI]";
const BUILD_MARK = "2026-09-21-01";

console.log(`${LOG_PREFIX} Content script loaded.`, { build: BUILD_MARK });

const AI_BUTTON_CLASS = "ai-rewrite-button";
const AI_BUTTON_CONTAINER_CLASS = "ai-rewrite-button-container";
const AI_BUTTON_STYLE_ID = "wi-notify-ai-button-styles";
const AI_FEATURES_ENABLED = true;
const COMMAND_BAR_SELECTORS = [
  ".ms-CommandBar-primaryCommands",
  ".bolt-header-commandbar .ms-CommandBar",
  ".work-item-form-toolbar .ms-CommandBar",
  "[data-renderedregion='toolbar'] .ms-CommandBar",
  "[role='toolbar']",
];
const TOOLBAR_LOCAL_ROOT_SELECTORS = [
  ".html-editor",
  ".rooster-wrapper",
  ".discussion-messages-right",
  ".discussion-message-entry",
  ".wit-comment-item",
];
const RICH_TEXT_EDITOR_TARGETS = [
  {
    kind: "description",
    fieldName: "Description",
    selectors: [
      "[aria-label='Description'][role='textbox'][contenteditable='true']",
      "textarea[aria-label='Description']",
      "iframe[title='Description']",
    ],
  },
  {
    kind: "discussion",
    fieldName: "Discussion",
    selectors: [
      "[aria-label='Discussion'][role='textbox'][contenteditable='true']",
      "textarea[aria-label='Discussion']",
      "iframe[title='Discussion']",
    ],
  },
];
const TITLE_SELECTORS = [
  "[aria-label='Title']",
  "input[placeholder='Title']",
  "input[aria-labelledby*='Title']",
  "textarea[aria-label='Title']",
  "[data-field='System.Title'] input",
  "[data-field='System.Title'] textarea",
];

function isVisible(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function resolveEditorCandidate(candidate) {
  if (candidate instanceof HTMLIFrameElement) {
    return candidate.contentDocument?.body || null;
  }

  if (candidate instanceof HTMLElement && isVisible(candidate)) {
    return candidate;
  }

  return null;
}

function findRichTextEditors() {
  if (!AI_FEATURES_ENABLED) {
    return [];
  }

  const editors = [];
  const seen = new Set();

  for (const target of RICH_TEXT_EDITOR_TARGETS) {
    for (const selector of target.selectors) {
      for (const candidate of document.querySelectorAll(selector)) {
        const editor = resolveEditorCandidate(candidate);
        if (!editor || seen.has(editor)) {
          continue;
        }

        seen.add(editor);
        editors.push({
          editor,
          host: candidate instanceof HTMLIFrameElement ? candidate : editor,
          kind: target.kind,
          fieldName: target.fieldName,
        });
      }
    }
  }

  return editors;
}

function findToolbarHostForEditor(host) {
  if (!AI_FEATURES_ENABLED || !(host instanceof HTMLElement)) {
    return null;
  }

  const searchRoots = [];
  for (const selector of TOOLBAR_LOCAL_ROOT_SELECTORS) {
    const root = host.closest(selector);
    if (root instanceof HTMLElement) {
      searchRoots.push(root);
    }
  }

  const sectionRoot = host.closest(
    "section, [role='region'], .flex-column, .work-item-form-control, .work-item-control"
  ) || host.parentElement;
  if (sectionRoot instanceof HTMLElement) {
    searchRoots.push(sectionRoot);
  }

  for (const root of searchRoots) {
    for (const selector of COMMAND_BAR_SELECTORS) {
      for (const candidate of root.querySelectorAll(selector)) {
        if (!(candidate instanceof HTMLElement) || !isVisible(candidate)) {
          continue;
        }

        // Реакции у уже опубликованных комментариев — не тот тулбар.
        if (candidate.closest(".comment-toolbar")) {
          continue;
        }

        return candidate;
      }
    }
  }

  return null;
}

function resolveEditorFromButton(button, fallbackEditor) {
  const root = button.closest(
    ".html-editor, .discussion-messages-right, .discussion-message-entry, .wit-comment-item, .work-item-control"
  );
  if (!(root instanceof HTMLElement)) {
    return fallbackEditor;
  }

  const candidate = root.querySelector(
    "[role='textbox'][contenteditable='true'], textarea[aria-label='Description'], textarea[aria-label='Discussion']"
  );
  return resolveEditorCandidate(candidate) || fallbackEditor;
}

function findWorkItemTitle() {
  for (const selector of TITLE_SELECTORS) {
    const candidate = document.querySelector(selector);
    if (!candidate) {
      continue;
    }

    if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) {
      const value = candidate.value.trim();
      if (value) {
        console.log(`${LOG_PREFIX} Work item title found via field selector.`, { selector });
        return value;
      }
    }

    if (candidate instanceof HTMLElement) {
      const text = (candidate.innerText || candidate.textContent || "").trim();
      if (text) {
        console.log(`${LOG_PREFIX} Work item title found via element selector.`, { selector });
        return text;
      }
    }
  }

  const heading = document.querySelector("h1, [role='heading']");
  const headingText = (heading?.textContent || "").trim();
  if (headingText) {
    console.log(`${LOG_PREFIX} Work item title found via heading fallback.`);
    return headingText;
  }

  const titleMatch = document.title.match(/-\s*(.+?)\s*-\s*Azure DevOps/i);
  if (titleMatch?.[1]) {
    console.log(`${LOG_PREFIX} Work item title found via document.title fallback.`);
    return titleMatch[1].trim();
  }

  console.warn(`${LOG_PREFIX} Work item title not found.`);
  return "";
}

function getEditorText(editor) {
  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    return editor.value;
  }

  return editor.innerText || editor.textContent || "";
}

const HTML_MARKUP_PATTERN = /<\/?(?:p|div|br|span|strong|b|em|i|u|s|ul|ol|li|h[1-6]|a|table|thead|tbody|tr|td|th|blockquote|pre|code|hr|img|html|body)\b[^>]*>/i;

function unwrapHtmlCodeFence(value) {
  const match = value.match(/^```(?:html|xml)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1] : value;
}

function htmlToPlainText(value) {
  const source = unwrapHtmlCodeFence(String(value ?? "").replace(/\r\n/g, "\n").trim());
  if (!HTML_MARKUP_PATTERN.test(source)) {
    return source;
  }

  const doc = new DOMParser().parseFromString(source, "text/html");
  const parts = [];

  const appendBreak = () => {
    if (parts.length === 0 || parts[parts.length - 1].endsWith("\n")) {
      return;
    }
    parts.push("\n");
  };

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent ?? "";
      if (!raw.trim()) {
        if (!raw.includes("\n") && raw.includes(" ")) {
          parts.push(" ");
        }
        return;
      }

      const text = raw.replace(/[ \t\f\v]+/g, " ").replace(/\n+/g, " ");
      if (text) {
        parts.push(text);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const tag = node.tagName.toLowerCase();
    if (tag === "script" || tag === "style") {
      return;
    }
    if (tag === "br" || tag === "hr") {
      parts.push("\n");
      return;
    }

    const isBlock = /^(?:p|div|h[1-6]|li|tr|blockquote|pre|ul|ol|table|section|article)$/.test(tag);
    if (isBlock) {
      appendBreak();
    }
    if (tag === "li") {
      parts.push("- ");
    } else if (tag === "td" || tag === "th") {
      if (parts.length > 0 && !/[\n ]$/.test(parts[parts.length - 1])) {
        parts.push(" ");
      }
    }

    for (const child of node.childNodes) {
      walk(child);
    }

    if (isBlock) {
      appendBreak();
    }
  };

  walk(doc.body);

  return parts.join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function plainTextToEditorHtml(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  if (lines.length === 0) {
    return "<div><br></div>";
  }

  return lines
    .map((line) => (line ? `<div>${escapeHtml(line)}</div>` : "<div><br></div>"))
    .join("");
}

function setPlainTextContent(editor, text) {
  const doc = editor.ownerDocument;
  const normalized = String(text).replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  editor.innerHTML = "";

  if (lines.length === 0) {
    editor.appendChild(doc.createElement("br"));
    return;
  }

  for (const line of lines) {
    const block = doc.createElement("div");
    if (line) {
      block.textContent = line;
    } else {
      block.appendChild(doc.createElement("br"));
    }
    editor.appendChild(block);
  }
}

function notifyFieldChanged(editor, text) {
  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: text,
  }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));
}

function insertPlainText(editor, text) {
  const doc = editor.ownerDocument;
  if (typeof doc.execCommand !== "function") {
    return false;
  }

  try {
    const selection = doc.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return doc.execCommand("insertHTML", false, plainTextToEditorHtml(text));
  } catch (error) {
    console.warn(`${LOG_PREFIX} execCommand insertHTML failed, falling back to manual update.`, error);
    return false;
  }
}

function updateDescriptionEditor(editor, text) {
  const plainText = htmlToPlainText(text);
  console.log(`${LOG_PREFIX} Updating description editor`, {
    tagName: editor.tagName,
    contentEditable: editor.contentEditable,
    textLength: plainText.length,
  });

  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    editor.focus();
    editor.value = plainText;
    notifyFieldChanged(editor, plainText);
    console.log(`${LOG_PREFIX} Description updated via value assignment.`);
    return;
  }

  editor.focus();

  if (insertPlainText(editor, plainText)) {
    notifyFieldChanged(editor, plainText);
    console.log(`${LOG_PREFIX} Description updated with plain text.`);
    return;
  }

  setPlainTextContent(editor, plainText);
  notifyFieldChanged(editor, plainText);
  console.log(`${LOG_PREFIX} Description updated via plain text DOM update.`);
}

function requestAiRewrite({ text, title, kind }, timeoutMs = 100000) {
  return new Promise((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      console.error(`${LOG_PREFIX} rewriteDescription timed out after ${timeoutMs}ms.`);
      reject(new Error(`Timed out waiting for AI rewrite response after ${timeoutMs}ms.`));
    }, timeoutMs);

    chrome.runtime.sendMessage(
      {
        action: "rewriteDescription",
        text,
        title,
        kind,
      },
      (response) => {
        window.clearTimeout(timerId);
        const lastError = chrome.runtime.lastError;

        if (lastError) {
          console.error(`${LOG_PREFIX} chrome.runtime.sendMessage failed.`, lastError);
          reject(new Error(lastError.message));
          return;
        }

        resolve(response);
      }
    );
  });
}

function ensureAiButtonStyles() {
  if (document.getElementById(AI_BUTTON_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = AI_BUTTON_STYLE_ID;
  style.textContent = `
    .${AI_BUTTON_CONTAINER_CLASS} {
      display: inline-flex;
      flex: 0 0 auto;
      align-self: stretch;
    }

    .${AI_BUTTON_CLASS} {
      display: inline-flex;
      align-items: center;
      align-self: stretch;
      justify-content: center;
      width: 34px;
      min-width: 34px;
      height: 32px;
      min-height: 32px;
      padding: 0;
      border-radius: 0;
    }

    .${AI_BUTTON_CLASS} .wi-ai-icon {
      display: inline-flex;
      width: 18px;
      height: 18px;
      flex: 0 0 18px;
      align-items: center;
      justify-content: center;
      margin: 0;
    }

    .${AI_BUTTON_CLASS} .wi-ai-icon svg {
      display: block;
      width: 18px;
      height: 18px;
      overflow: visible;
    }

    .${AI_BUTTON_CLASS} .wi-ai-icon-core {
      transform-origin: 9px 9px;
    }

    .${AI_BUTTON_CLASS}[data-state="pending"] .wi-ai-icon-core {
      animation: wi-ai-icon-spin 1s linear infinite;
    }

    .${AI_BUTTON_CLASS}[data-state="pending"] .wi-ai-icon {
      filter: drop-shadow(0 0 7px rgba(104, 76, 255, 0.45));
    }

    @keyframes wi-ai-icon-spin {
      from {
        transform: rotate(0deg);
      }

      to {
        transform: rotate(360deg);
      }
    }
  `;
  document.head.appendChild(style);
}

function renderAiButtonContent(isPending = false) {
  return `
    <span class="bolt-button-icon wi-ai-icon" aria-hidden="true">
      <svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="wiNotifyAiGradient" x1="3" y1="2" x2="15" y2="15" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#9B5CFF"></stop>
            <stop offset="0.42" stop-color="#6E45FF"></stop>
            <stop offset="1" stop-color="#2E6BFF"></stop>
          </linearGradient>
        </defs>
        <g class="wi-ai-icon-core">
          <path d="M9 2.15C9.76 4.63 10.82 5.88 12.12 6.88C13.12 7.64 14.37 8.23 16.85 9C14.37 9.77 13.12 10.36 12.12 11.12C10.82 12.12 9.76 13.37 9 15.85C8.24 13.37 7.18 12.12 5.88 11.12C4.88 10.36 3.63 9.77 1.15 9C3.63 8.23 4.88 7.64 5.88 6.88C7.18 5.88 8.24 4.63 9 2.15Z" fill="url(#wiNotifyAiGradient)"></path>
          <path d="M9 4.35C9.48 5.74 10.17 6.5 10.97 7.12C11.63 7.63 12.43 8.02 13.96 8.53C12.43 9.04 11.63 9.43 10.97 9.94C10.17 10.56 9.48 11.32 9 12.71C8.52 11.32 7.83 10.56 7.03 9.94C6.37 9.43 5.57 9.04 4.04 8.53C5.57 8.02 6.37 7.63 7.03 7.12C7.83 6.5 8.52 5.74 9 4.35Z" fill="white" fill-opacity="0.18"></path>
        </g>
      </svg>
    </span>
  `;
}

function createAiButton(field) {
  ensureAiButtonStyles();
  const isDiscussion = field.kind === "discussion";
  const button = document.createElement("button");
  button.className = `${AI_BUTTON_CLASS} bolt-button bolt-button-secondary bolt-icon-button`;
  button.dataset.wiNotifyAiBuild = BUILD_MARK;
  button.dataset.wiNotifyAiKind = field.kind;
  button.dataset.state = "idle";
  button.type = "button";
  button.innerHTML = renderAiButtonContent(false);
  button.title = isDiscussion
    ? `Rewrite comment with AI (${BUILD_MARK})`
    : `Rewrite description with AI (${BUILD_MARK})`;

  button.addEventListener("click", async () => {
    console.log(`${LOG_PREFIX} AI Rewrite button clicked.`, { kind: field.kind });
    const editor = resolveEditorFromButton(button, field.editor);
    if (!editor) {
      console.error(`${LOG_PREFIX} Click aborted: ${field.fieldName} editor not found.`);
      alert(isDiscussion
        ? "Could not find the comment editor."
        : "Could not find the description editor.");
      return;
    }

    const originalText = getEditorText(editor);
    const workItemTitle = findWorkItemTitle();
    console.log(`${LOG_PREFIX} Original ${field.fieldName} text collected.`, {
      kind: field.kind,
      titleLength: workItemTitle.length,
      textLength: originalText.length,
      preview: originalText.slice(0, 200),
    });
    if (!originalText.trim()) {
      console.warn(`${LOG_PREFIX} Click aborted: ${field.fieldName} is empty.`);
      alert(isDiscussion
        ? "Comment field is empty. Please enter some text to rewrite."
        : "Description field is empty. Please enter some text to rewrite.");
      return;
    }

    button.disabled = true;
    button.dataset.state = "pending";
    button.innerHTML = renderAiButtonContent(true);

    try {
      console.log(`${LOG_PREFIX} Sending rewriteDescription message to background.`, {
        kind: field.kind,
        titleLength: workItemTitle.length,
        textLength: originalText.length,
      });
      const response = await requestAiRewrite({
        text: originalText,
        title: workItemTitle,
        kind: field.kind,
      });
      console.log(`${LOG_PREFIX} Received response from background.`, response);

      if (response?.ok && typeof response.rewrittenText === "string") {
        updateDescriptionEditor(editor, response.rewrittenText);
      } else if (response && response.error) {
        console.error(`${LOG_PREFIX} Background returned AI error.`, response.error);
        alert(`AI Rewrite Error: ${response.error}`);
      } else {
        console.error(`${LOG_PREFIX} Background returned unexpected response.`, response);
        alert("AI Rewrite failed: No response or unexpected response from background script.");
      }
    } catch (error) {
      console.error(`${LOG_PREFIX} Error during AI rewrite.`, error);
      alert(`An error occurred during AI rewrite: ${error.message}`);
    } finally {
      button.disabled = false;
      button.dataset.state = "idle";
      button.innerHTML = renderAiButtonContent(false);
      console.log(`${LOG_PREFIX} AI Rewrite button restored to idle state.`);
    }
  });

  return button;
}

function pingAiBackground(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      console.error(`${LOG_PREFIX} ai-ping timed out after ${timeoutMs}ms.`);
      reject(new Error(`Timed out waiting for ai-ping response after ${timeoutMs}ms.`));
    }, timeoutMs);

    chrome.runtime.sendMessage(
      {
        action: "ai-ping",
      },
      (response) => {
        window.clearTimeout(timerId);
        const lastError = chrome.runtime.lastError;

        if (lastError) {
          console.error(`${LOG_PREFIX} ai-ping failed.`, lastError);
          reject(new Error(lastError.message));
          return;
        }

        resolve(response);
      }
    );
  });
}

function addAiButtonToDescriptionToolbar() {
  if (!AI_FEATURES_ENABLED) {
    document.querySelectorAll(`.${AI_BUTTON_CONTAINER_CLASS}`).forEach((node) => node.remove());
    return false;
  }

  let mounted = false;

  for (const field of findRichTextEditors()) {
    const toolbarHost = findToolbarHostForEditor(field.host);
    if (!toolbarHost) {
      continue;
    }

    if (toolbarHost.querySelector(`.${AI_BUTTON_CLASS}`)) {
      mounted = true;
      continue;
    }

    const buttonContainer = document.createElement("div");
    buttonContainer.className = AI_BUTTON_CONTAINER_CLASS;
    buttonContainer.dataset.wiNotifyAiKind = field.kind;
    buttonContainer.appendChild(createAiButton(field));
    toolbarHost.insertBefore(buttonContainer, toolbarHost.firstChild);
    console.log(`${LOG_PREFIX} AI button mounted in ${field.fieldName} toolbar.`);
    mounted = true;
  }

  return mounted;
}

// ---------------------------------------------------------------------------
// Создание задачи на ревью из задачи на дизайн
// ---------------------------------------------------------------------------

const REVIEW_BUTTON_CLASS = "wi-create-review-button";
const REVIEW_BUTTON_CONTAINER_CLASS = "wi-create-review-container";
const REVIEW_OVERFLOW_ITEM_CLASS = "wi-create-review-overflow-item";
const REVIEW_TOAST_CLASS = "wi-review-toast";
const ADO_CONFIG_STORAGE_KEY = "adoConfig";
const AI_CONFIG_STORAGE_KEY = "aiConfig";
const CREATE_REVIEW_TASK_MESSAGE_TYPE = "create-review-task";
const CREATE_REVIEW_TASK_TIMEOUT_MS = 65000;
const CUSTOM_OVERFLOW_ITEM_CLASS = "wi-custom-review-overflow-item";
const CREATE_CUSTOM_WI_MESSAGE_TYPE = "create-custom-wi";
const REVIEW_TOOLBAR_SELECTORS = [
  // Классический TFS / Azure DevOps Server
  ".work-item-form-main-header .work-item-form-toolbar-container",
  ".work-item-form-headerContent .work-item-form-toolbar-container",
  ".work-item-form-toolbar-container",
  // Новый Bolt UI (dev.azure.com) — только внутри формы WI
  ".work-item-form-header .bolt-header-commandbar .ms-CommandBar-primaryCommands",
  ".work-item-form-header .ms-CommandBar-primaryCommands",
];
/** Максимум ждём окончания Save, потом всё равно показываем кнопку. */
const REVIEW_SAVE_WATCH_TIMEOUT_MS = 10000;

let reviewConfigCache = null;
let aiConfigCache = null;
/** true — Save в процессе: кнопку скрываем, монтируем только после окончания загрузки. */
let reviewPausedForSave = false;
let reviewSaveWatchStartedAt = 0;

function parseReviewDesignTypes(value) {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parsePositiveWorkItemId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,9}$/.test(text)) {
    return null;
  }

  const id = Number(text);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function getWorkItemFormRoot() {
  const form = document.querySelector(
    ".work-item-form, .witform-layout-resizable, [class*='work-item-form']",
  );
  return form instanceof HTMLElement ? form : null;
}

/**
 * Id из URL полной формы (`/_workitems/edit/{id}`) или query/hash.
 * На странице Queries в панели справа URL остаётся `/_queries/query/{guid}/` — тогда null.
 */
function getSourceWorkItemIdFromLocation() {
  const editMatch = location.href.match(/_workitems\/(?:edit|view)\/(\d+)/i);
  if (editMatch) {
    return Number(editMatch[1]);
  }

  try {
    const url = new URL(location.href);
    for (const key of ["id", "workitem", "witd"]) {
      const fromQuery = url.searchParams.get(key);
      const parsed = parsePositiveWorkItemId(fromQuery);
      if (parsed !== null) {
        return parsed;
      }
    }

    const hash = url.hash || "";
    const fromHash = hash.match(/(?:^|[?&#])(?:id|workitem|witd)=(\d{1,9})\b/i);
    if (fromHash) {
      return Number(fromHash[1]);
    }
  } catch (_error) {
    // ignore
  }

  return null;
}

/**
 * Id из DOM формы WI — нужен для панели списка (Queries / Backlogs), где URL без номера.
 * Ищем только внутри формы, не в гриде результатов.
 */
function getSourceWorkItemIdFromDom() {
  const form = getWorkItemFormRoot();
  if (!form) {
    return null;
  }

  const idNodeSelectors = [
    ".work-item-form-id",
    ".work-item-form-header .work-item-form-id",
    ".work-item-form-main-header .work-item-form-id",
    ".work-item-form-headerContent .work-item-form-id",
    "[data-testid='work-item-id']",
  ];

  for (const selector of idNodeSelectors) {
    const node = form.querySelector(selector);
    const parsed = parsePositiveWorkItemId(node?.textContent);
    if (parsed !== null) {
      return parsed;
    }
  }

  for (const link of form.querySelectorAll('a[href*="_workitems/"]')) {
    const href = link.getAttribute("href") || "";
    const match = href.match(/_workitems\/(?:edit|view)\/(\d{1,9})/i);
    if (match) {
      return Number(match[1]);
    }
  }

  const header = form.querySelector(
    ".work-item-form-main-header, .work-item-form-header, .work-item-form-headerContent",
  );
  if (header instanceof HTMLElement) {
    for (const el of header.querySelectorAll("span, div, label, a, em, strong")) {
      if (!(el instanceof HTMLElement)) {
        continue;
      }

      // Чистый номер в шапке формы — обычно id WI рядом с типом/заголовком.
      if (el.children.length > 0) {
        continue;
      }

      if (el.closest(".work-item-form-toolbar-container, .menu-bar, .ms-CommandBar, .bolt-header-commandbar")) {
        continue;
      }

      const parsed = parsePositiveWorkItemId(el.textContent);
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  return null;
}

/**
 * Запасной вариант для Queries/Backlogs: id из выделенной строки результатов.
 */
function getSourceWorkItemIdFromSelectedRow() {
  const selectedRow = document.querySelector(
    [
      ".grid-row-selected",
      ".grid-row.grid-row-current",
      ".bolt-table-row[aria-selected='true']",
      "tr[aria-selected='true']",
      ".work-item-list-row.selected",
    ].join(", "),
  );

  if (!(selectedRow instanceof HTMLElement)) {
    return null;
  }

  for (const attr of ["data-itemid", "data-item-id", "data-id", "data-row-id"]) {
    const parsed = parsePositiveWorkItemId(selectedRow.getAttribute(attr));
    if (parsed !== null) {
      return parsed;
    }
  }

  const idMatch = String(selectedRow.id || "").match(/(\d{4,9})/);
  if (idMatch) {
    return Number(idMatch[1]);
  }

  // Первая ячейка грида Queries обычно — ID.
  const firstCell = selectedRow.querySelector(
    ".grid-cell, .bolt-table-cell, td, [role='gridcell']",
  );
  return parsePositiveWorkItemId(firstCell?.textContent);
}

function getSourceWorkItemId() {
  const fromLocation = getSourceWorkItemIdFromLocation();
  if (fromLocation !== null) {
    return fromLocation;
  }

  const fromDom = getSourceWorkItemIdFromDom();
  if (fromDom !== null) {
    return fromDom;
  }

  // Строка грида — только когда тулбар формы уже на месте.
  // Иначе на Queries id находится слишком рано и кнопка может сесть не в ту форму.
  if (findClassicMenuBar() || findReviewToolbarHost()) {
    return getSourceWorkItemIdFromSelectedRow();
  }

  return null;
}

function getSourceWorkItemType() {
  const form = getWorkItemFormRoot();
  const root = form ?? document;
  const selectors = [
    ".work-item-form-header .work-item-type-icon",
    ".work-item-form-main-header .work-item-type-icon",
    ".work-item-type-icon",
    "[class*='work-item-type-name']",
    "[class*='workitem-type-name']",
  ];

  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (!element) {
      continue;
    }

    // Вне формы иконка типа часто есть в гриде Queries — её не считаем.
    if (form && !form.contains(element)) {
      continue;
    }

    const value = (
      element.getAttribute("aria-label")
      || element.getAttribute("title")
      || element.textContent
      || ""
    ).trim();

    if (value) {
      return value;
    }
  }

  return "";
}

function isWorkItemFormPresent() {
  return Boolean(getWorkItemFormRoot());
}

/**
 * Видимость кнопки Design Review Task.
 * `unknown` — переходное состояние DOM (Save / SPA-перерисовка): id или тип
 * временно не читаются. В этом случае уже смонтированную кнопку не трогаем,
 * чтобы не было мельтешения тулбара.
 * @returns {"show"|"hide"|"unknown"}
 */
function getReviewButtonVisibility() {
  if (!isWorkItemFormPresent()) {
    return "hide";
  }

  // Тоггл в настройках: выключен — кнопку не показываем.
  if (reviewConfigCache?.reviewEnabled === false) {
    return "hide";
  }

  // Без номера сохранённой задачи сценарий недоступен (в т.ч. на форме создания).
  // Во время Save шапка формы может кратко перерисоваться без id — не снимаем кнопку.
  if (getSourceWorkItemId() === null) {
    if (/_workitems\/create\b/i.test(location.href)) {
      return "hide";
    }
    return "unknown";
  }

  // FR-002 / Q-003: ограничение по типу исходной задачи, если задано в настройках.
  const allowedTypes = parseReviewDesignTypes(reviewConfigCache?.reviewDesignTypes);
  if (!allowedTypes.length) {
    return "show";
  }

  const type = getSourceWorkItemType();
  if (!type) {
    return "unknown";
  }

  return allowedTypes.some((allowed) => allowed.toLowerCase() === type.toLowerCase())
    ? "show"
    : "hide";
}

function shouldShowReviewButton() {
  return getReviewButtonVisibility() === "show";
}

function findReviewToolbarHost() {
  const form = getWorkItemFormRoot();
  if (!form) {
    return null;
  }

  for (const selector of REVIEW_TOOLBAR_SELECTORS) {
    for (const candidate of form.querySelectorAll(selector)) {
      if (candidate instanceof HTMLElement && isVisible(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function ensureReviewToast() {
  let toast = document.querySelector(`.${REVIEW_TOAST_CLASS}`);
  if (toast) {
    return toast;
  }

  toast = document.createElement("div");
  toast.className = REVIEW_TOAST_CLASS;
  toast.setAttribute("role", "status");
  document.body.appendChild(toast);
  return toast;
}

let reviewToastTimerId = null;

function showReviewToast(message, kind = "info") {
  const toast = ensureReviewToast();
  toast.dataset.kind = kind;
  toast.textContent = "";

  const text = document.createElement("div");
  text.className = "wi-review-toast__text";
  text.textContent = message;
  toast.appendChild(text);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "wi-review-toast__close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Закрыть");
  close.addEventListener("click", () => {
    toast.remove();
  });
  toast.appendChild(close);

  toast.classList.add("wi-review-toast--visible");

  if (reviewToastTimerId !== null) {
    window.clearTimeout(reviewToastTimerId);
    reviewToastTimerId = null;
  }

  // Успех скрываем автоматически; предупреждения и ошибки — вручную.
  if (kind === "success" || kind === "info") {
    reviewToastTimerId = window.setTimeout(() => {
      toast.remove();
      reviewToastTimerId = null;
    }, 6000);
  }
}

function requestCreateReviewTask(sourceId, pixsoUrl = "", timeoutMs = CREATE_REVIEW_TASK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      reject(new Error(`Превышено время ожидания создания задачи на ревью (${timeoutMs} мс).`));
    }, timeoutMs);

    chrome.runtime.sendMessage(
      {
        type: CREATE_REVIEW_TASK_MESSAGE_TYPE,
        sourceId,
        pixsoUrl: pixsoUrl || undefined,
      },
      (response) => {
        window.clearTimeout(timerId);
        const lastError = chrome.runtime.lastError;

        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }

        resolve(response);
      },
    );
  });
}

/**
 * Достаёт из текста буфера первую ссылку, содержащую pixso.net.
 * @param {string} text
 * @returns {string}
 */
function extractPixsoUrlFromText(text) {
  const raw = String(text ?? "").trim();
  if (!raw || !/pixso\.net/i.test(raw)) {
    return "";
  }

  const match = raw.match(/https?:\/\/[^\s<>"'()\]]+/i);
  if (!match) {
    return "";
  }

  let candidate = match[0].replace(/[.,;:!?]+$/g, "");
  try {
    const url = new URL(candidate);
    if (!url.hostname.toLowerCase().includes("pixso.net")) {
      return "";
    }
    return url.href;
  } catch (_error) {
    return "";
  }
}

/** Читает буфер обмена (по клику пользователя) и возвращает pixso-ссылку, если есть. */
async function readPixsoUrlFromClipboard() {
  try {
    if (!navigator.clipboard?.readText) {
      return "";
    }
    const text = await navigator.clipboard.readText();
    return extractPixsoUrlFromText(text);
  } catch (error) {
    console.warn(`${LOG_PREFIX} Clipboard read skipped.`, error);
    return "";
  }
}

async function handleCreateReviewClick(control) {
  if (control.dataset.state === "pending") {
    return;
  }

  // FR-003: без номера исходной задачи сценарий не запускается.
  const sourceId = getSourceWorkItemId();
  if (sourceId === null) {
    showReviewToast(
      "Задача ещё не сохранена или не имеет номера. Сохраните задачу и повторите.",
      "error",
    );
    return;
  }

  // Сразу по клику (user gesture) читаем буфер: если там pixso.net — подставим в «Макеты».
  const pixsoUrl = await readPixsoUrlFromClipboard();

  // FR-016: блокируем повторный запуск и показываем состояние.
  const label = control.querySelector(".wi-create-review-label");
  const originalText = label?.textContent ?? getReviewMenuItemLabel();
  control.dataset.state = "pending";
  if (control instanceof HTMLButtonElement) {
    control.disabled = true;
  } else {
    control.classList.add("disabled");
    control.setAttribute("aria-disabled", "true");
  }
  if (label) {
    label.textContent = getReviewPendingLabel();
  }

  try {
    const response = await requestCreateReviewTask(sourceId, pixsoUrl);

    if (response?.ok) {
      // FR-015: запасной вариант, если фоновая вкладка не открылась.
      if (!response.tabOpened && response.url) {
        window.open(response.url, "_blank", "noopener");
      }

      const warnings = Array.isArray(response.warnings) ? response.warnings : [];
      if (warnings.length > 0) {
        showReviewToast(
          `Задача на ревью #${response.id} создана и открыта, но не все связи добавлены: ${warnings.join(" ")}`,
          "warning",
        );
      } else {
        showReviewToast(
          `Задача на ревью #${response.id} создана и открыта. Связи (исходная — Related, родительская — child) добавлены.`,
          "success",
        );
      }
    } else {
      showReviewToast(
        `Не удалось создать задачу на ревью: ${response?.error ?? "неизвестная ошибка"}`,
        "error",
      );
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Create review task failed.`, error);
    showReviewToast(`Ошибка при создании задачи на ревью: ${error.message}`, "error");
  } finally {
    control.dataset.state = "idle";
    if (control instanceof HTMLButtonElement) {
      control.disabled = false;
    } else {
      control.classList.remove("disabled");
      control.setAttribute("aria-disabled", "false");
    }
    if (label) {
      label.textContent = originalText;
    }
  }
}

/** Подключает шрифт иконок ADO для глифа типа Review. */
function ensureReviewIconFont() {
  if (document.getElementById("wi-review-icon-font")) {
    return;
  }

  try {
    const style = document.createElement("style");
    style.id = "wi-review-icon-font";
    const fontUrl = chrome.runtime.getURL("icons/AzDevMDL2.woff");
    style.textContent = `
      @font-face {
        font-family: "WINotifyReviewIcons";
        src: url("${fontUrl}") format("woff");
        font-weight: normal;
        font-style: normal;
        font-display: block;
      }
    `;
    document.documentElement.appendChild(style);
  } catch (_error) {
    // На странице уже может быть Bowtie/AzDevMDL2 — тогда сработает fallback в CSS.
  }
}

function createReviewIconAndLabel() {
  const icon = document.createElement("span");
  icon.className = "menu-item-icon wi-create-review-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "\ueac4"; // глиф типа Review (AzDevMDL2 / Bowtie)

  const label = document.createElement("span");
  label.className = "text wi-create-review-label";
  label.textContent = getReviewMenuItemLabel();

  return { icon, label };
}

/**
 * Локаль UI TFS/ADO: по lang страницы и подписям тулбара (Save/Сохранить).
 * @returns {boolean}
 */
function isTfsUiRussian() {
  const lang = String(
    document.documentElement.lang
    || document.body?.getAttribute("lang")
    || "",
  ).toLowerCase();

  if (lang.startsWith("ru")) {
    return true;
  }
  if (lang.startsWith("en")) {
    return false;
  }

  const menuBar = findClassicMenuBar();
  const sample = String(menuBar?.textContent || document.body?.innerText || "")
    .slice(0, 4000)
    .toLowerCase();

  if (sample.includes("сохранить") || sample.includes("отслеж") || sample.includes("удалить")) {
    return true;
  }
  if (/\bsave\b/.test(sample) || /\bfollow\b/.test(sample) || /\bdelete\b/.test(sample)) {
    return false;
  }

  return String(navigator.language || "").toLowerCase().startsWith("ru");
}

function getReviewMenuItemLabel() {
  return isTfsUiRussian()
    ? "Создать задачу на дизайн-ревью"
    : "New design review task";
}

function getReviewMenuItemTitle() {
  return isTfsUiRussian()
    ? "Создать связанную задачу типа Review из этой задачи на дизайн"
    : "Create a linked Review work item from this design task";
}

function getReviewPendingLabel() {
  return isTfsUiRussian() ? "Создаём…" : "Creating…";
}

/**
 * Пункт в выпадающем меню «...» тулбара WI.
 * @returns {HTMLLIElement}
 */
function createReviewOverflowMenuItem() {
  ensureReviewIconFont();

  const item = document.createElement("li");
  item.className = `menu-item ${REVIEW_OVERFLOW_ITEM_CLASS}`;
  item.dataset.state = "idle";
  item.setAttribute("role", "menuitem");
  item.tabIndex = -1;
  item.title = getReviewMenuItemTitle();
  item.setAttribute("aria-disabled", "false");

  const { icon, label } = createReviewIconAndLabel();
  item.append(icon, label);
  item.addEventListener("mouseenter", () => {
    item.classList.add("hover");
  });
  item.addEventListener("mouseleave", () => {
    item.classList.remove("hover");
  });
  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void handleCreateReviewClick(item);
  });
  return item;
}

/**
 * Ищет открытый popup меню «...» формы work item.
 * @returns {HTMLElement|null}
 */
function findWorkItemOverflowMenuList() {
  const selectors = [
    ".menu-popup ul.menu",
    ".menu-popup .menu",
    ".sub-menu ul.menu",
    ".ms-ContextualMenu-list",
    "[role='menu']",
  ];

  const candidates = [];
  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      if (node instanceof HTMLElement) {
        candidates.push(node);
      }
    }
  }

  for (const menu of candidates) {
    if (!isVisible(menu)) {
      continue;
    }

    const text = (menu.textContent || "").toLowerCase();
    const looksLikeOverflow = (
      text.includes("удалить")
      || text.includes("delete")
      || text.includes("шаблон")
      || text.includes("template")
      || text.includes("создать копию")
      || text.includes("copy of the work item")
      || text.includes("visualize")
      || text.includes("excel")
      || text.includes("связанный")
      || text.includes("linked work item")
      || text.includes("сочетания клавиш")
      || text.includes("keyboard shortcuts")
    );

    if (!looksLikeOverflow) {
      continue;
    }

    // Берём ul со строками, если нашли обёртку.
    if (menu.matches("ul, [role='menu'], .ms-ContextualMenu-list")) {
      return menu;
    }
    const inner = menu.querySelector("ul.menu, ul[role='menu'], .ms-ContextualMenu-list");
    if (inner instanceof HTMLElement) {
      return inner;
    }
    return menu;
  }

  return null;
}

/**
 * Добавляет пункт в меню «...» сразу при открытии (без debounce).
 * @returns {boolean}
 */
function addReviewOverflowMenuItem() {
  // Старую кнопку в тулбаре больше не показываем.
  document.querySelectorAll(`.${REVIEW_BUTTON_CONTAINER_CLASS}`).forEach((node) => node.remove());

  const existing = document.querySelectorAll(`.${REVIEW_OVERFLOW_ITEM_CLASS}`);
  const visibility = getReviewButtonVisibility();

  if (visibility === "hide") {
    existing.forEach((node) => node.remove());
    return false;
  }

  const menu = findWorkItemOverflowMenuList();
  if (!menu) {
    return false;
  }

  // Переходный DOM: не создаём новый пункт, но оставляем уже вставленный.
  if (visibility !== "show") {
    for (const node of existing) {
      if (menu.contains(node)) {
        return true;
      }
    }
    return false;
  }

  const expectedLabel = getReviewMenuItemLabel();
  for (const node of existing) {
    if (menu.contains(node)) {
      const label = node.querySelector(".wi-create-review-label");
      if (label && label.textContent !== expectedLabel && node.dataset.state !== "pending") {
        label.textContent = expectedLabel;
        node.title = getReviewMenuItemTitle();
      }
      return true;
    }
  }

  existing.forEach((node) => node.remove());
  const item = createReviewOverflowMenuItem();
  menu.insertBefore(item, menu.firstChild);
  return true;
}

// ---------------------------------------------------------------------------
// Свои кнопки ревью в меню «...» (сразу под Design Review Task)
// ---------------------------------------------------------------------------

function requestCreateCustomWi(buttonId, sourceId, timeoutMs = CREATE_REVIEW_TASK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      reject(new Error(`Превышено время ожидания создания задачи (${timeoutMs} мс).`));
    }, timeoutMs);
    chrome.runtime.sendMessage(
      { type: CREATE_CUSTOM_WI_MESSAGE_TYPE, buttonId, sourceId },
      (response) => {
        window.clearTimeout(timerId);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      },
    );
  });
}

async function handleCustomButtonClick(control, buttonId) {
  if (control.dataset.state === "pending") {
    return;
  }
  const sourceId = getSourceWorkItemId();
  if (sourceId === null) {
    showReviewToast(
      isTfsUiRussian()
        ? "Задача ещё не сохранена или не имеет номера. Сохраните задачу и повторите."
        : "The work item has no id yet. Save it and try again.",
      "error",
    );
    return;
  }

  const label = control.querySelector(".wi-custom-review-label");
  const originalText = label?.textContent ?? "";
  control.dataset.state = "pending";
  control.setAttribute("aria-disabled", "true");
  if (label) {
    label.textContent = getReviewPendingLabel();
  }

  try {
    const response = await requestCreateCustomWi(buttonId, sourceId);
    if (response?.ok) {
      if (!response.tabOpened && response.url) {
        window.open(response.url, "_blank", "noopener");
      }
      const warnings = Array.isArray(response.warnings) ? response.warnings : [];
      if (warnings.length > 0) {
        showReviewToast(`Задача #${response.id} создана, но не все связи добавлены: ${warnings.join(" ")}`, "warning");
      } else {
        showReviewToast(`Задача #${response.id} создана и открыта.`, "success");
      }
    } else {
      showReviewToast(`Не удалось создать задачу: ${response?.error ?? "неизвестная ошибка"}`, "error");
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Create custom work item failed.`, error);
    showReviewToast(`Ошибка при создании задачи: ${error.message}`, "error");
  } finally {
    control.dataset.state = "idle";
    control.setAttribute("aria-disabled", "false");
    if (label) {
      label.textContent = originalText;
    }
  }
}

/** Иконка (по типу Wi) + подпись для пункта кастомной кнопки. */
function createCustomIconAndLabel(cfg) {
  const icon = document.createElement("span");
  icon.className = "menu-item-icon wi-create-review-icon wi-custom-review-icon";
  icon.setAttribute("aria-hidden", "true");
  const iconUrl = cfg?.wiTypeIcon?.url;
  if (iconUrl) {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = "";
    img.width = 16;
    img.height = 16;
    icon.appendChild(img);
  } else {
    icon.textContent = "";
  }

  const label = document.createElement("span");
  label.className = "text wi-create-review-label wi-custom-review-label";
  label.textContent = cfg?.name || "Custom";
  return { icon, label };
}

/**
 * Пункт кастомной кнопки в выпадающем меню «...».
 * @param {object} cfg
 * @returns {HTMLLIElement}
 */
function createCustomOverflowMenuItem(cfg) {
  ensureReviewIconFont();

  const item = document.createElement("li");
  item.className = `menu-item wi-create-review-overflow-item ${CUSTOM_OVERFLOW_ITEM_CLASS}`;
  item.dataset.state = "idle";
  item.dataset.buttonId = cfg.id;
  item.setAttribute("role", "menuitem");
  item.tabIndex = -1;
  item.title = cfg.name || "";
  item.setAttribute("aria-disabled", "false");

  const { icon, label } = createCustomIconAndLabel(cfg);
  item.append(icon, label);
  item.addEventListener("mouseenter", () => item.classList.add("hover"));
  item.addEventListener("mouseleave", () => item.classList.remove("hover"));
  item.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void handleCustomButtonClick(item, cfg.id);
  });
  return item;
}

/**
 * Кастомные пункты стоят правильно: те же id и порядок, и идут сразу после
 * пункта Design Review Task (или в начале меню, если пункта ревью нет).
 */
function customOverflowItemsCorrect(menu, buttons) {
  const existing = Array.from(menu.querySelectorAll(`.${CUSTOM_OVERFLOW_ITEM_CLASS}`));
  if (existing.length !== buttons.length) {
    return false;
  }
  const ids = existing.map((n) => n.dataset.buttonId);
  if (!buttons.every((b, i) => ids[i] === b.id)) {
    return false;
  }
  const reviewItem = menu.querySelector(`.${REVIEW_OVERFLOW_ITEM_CLASS}`);
  for (let i = 0; i < existing.length; i += 1) {
    const expectedPrev = i === 0 ? reviewItem : existing[i - 1];
    if (expectedPrev) {
      if (expectedPrev.nextElementSibling !== existing[i]) {
        return false;
      }
    } else if (existing[i] !== menu.firstElementChild) {
      return false;
    }
  }
  return true;
}

/**
 * Вставляет кастомные пункты в меню «...» сразу под Design Review Task.
 * @returns {boolean}
 */
/**
 * Кнопка видна для текущей задачи: список типов пуст (для всех) или тип исходной
 * задачи входит в список. Если тип определить не удалось — показываем (fail-open).
 */
function customButtonVisibleForSource(cfg, sourceType) {
  const types = Array.isArray(cfg?.showForTypes) ? cfg.showForTypes.filter(Boolean) : [];
  if (!types.length || !sourceType) {
    return true;
  }
  return types.some((t) => String(t).toLowerCase() === sourceType.toLowerCase());
}

function addCustomOverflowMenuItems() {
  const allButtons = Array.isArray(reviewConfigCache?.customReviewButtons)
    ? reviewConfigCache.customReviewButtons
    : [];

  const menu = findWorkItemOverflowMenuList();
  if (!menu) {
    return false;
  }

  const sourceType = getSourceWorkItemType();
  const buttons = allButtons.filter((cfg) => customButtonVisibleForSource(cfg, sourceType));

  if (!buttons.length || getSourceWorkItemId() === null) {
    menu.querySelectorAll(`.${CUSTOM_OVERFLOW_ITEM_CLASS}`).forEach((n) => n.remove());
    return false;
  }

  if (customOverflowItemsCorrect(menu, buttons)) {
    return true;
  }

  menu.querySelectorAll(`.${CUSTOM_OVERFLOW_ITEM_CLASS}`).forEach((n) => n.remove());

  const reviewItem = menu.querySelector(`.${REVIEW_OVERFLOW_ITEM_CLASS}`);
  let anchor = reviewItem || null;
  for (const cfg of buttons) {
    const item = createCustomOverflowMenuItem(cfg);
    if (anchor) {
      anchor.after(item);
    } else {
      menu.insertBefore(item, menu.firstChild);
    }
    anchor = item;
  }
  return true;
}

function findClassicMenuBar() {
  const form = getWorkItemFormRoot();
  if (!form) {
    return null;
  }

  const selectors = [
    ".work-item-form-toolbar-container .menu-bar",
    ".workitem-tool-bar .menu-bar",
    ".toolbar.workitem-tool-bar .menu-bar",
  ];

  for (const selector of selectors) {
    for (const candidate of form.querySelectorAll(selector)) {
      if (candidate instanceof HTMLElement && isVisible(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

/**
 * @param {Element} el
 * @returns {string}
 */
function getToolbarControlHaystack(el) {
  return [
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    el.getAttribute("command"),
    el.getAttribute("data-command-key"),
    el.getAttribute("command-key"),
    el.textContent,
  ]
    .map((part) => String(part ?? "").trim().toLowerCase())
    .join(" ");
}

/**
 * @param {string} haystack
 * @returns {boolean}
 */
function isFollowHaystack(haystack) {
  return (
    /\bfollow\b/.test(haystack)
    || /\bunfollow\b/.test(haystack)
    || haystack.includes("следить")
    || haystack.includes("отслеж")
    || haystack.includes("отписаться")
  );
}

/**
 * @param {string} haystack
 * @returns {boolean}
 */
function isSaveHaystack(haystack) {
  return (
    /\bsave\b/.test(haystack)
    || haystack.includes("сохранить")
    || haystack.includes("сохран")
  );
}

/**
 * @param {string} haystack
 * @returns {boolean}
 */
function isRefreshHaystack(haystack) {
  return (
    /\brefresh\b/.test(haystack)
    || haystack.includes("обновить")
    || haystack.includes("refresh work item")
  );
}

/**
 * @param {string} haystack
 * @returns {boolean}
 */
function isNotificationSettingsHaystack(haystack) {
  return (
    haystack.includes("notification settings")
    || haystack.includes("настройки уведомлений")
  );
}

/**
 * @param {HTMLElement} menuBar
 * @returns {HTMLElement|null}
 */
function findSaveMenuItem(menuBar) {
  const byCommand = menuBar.querySelector(
    'li.menu-item[command="save-work-item"], li.menu-item.save-only, li.menu-item.drop-down-save',
  );
  if (byCommand instanceof HTMLElement) {
    return byCommand;
  }

  for (const item of menuBar.querySelectorAll("li.menu-item")) {
    if (!(item instanceof HTMLElement) || item.classList.contains(REVIEW_BUTTON_CONTAINER_CLASS)) {
      continue;
    }
    if (isSaveHaystack(getToolbarControlHaystack(item))) {
      return item;
    }
  }

  return null;
}

/**
 * @param {HTMLElement} menuBar
 * @returns {HTMLElement|null}
 */
function findFollowMenuItem(menuBar) {
  for (const item of menuBar.querySelectorAll("li.menu-item")) {
    if (!(item instanceof HTMLElement) || item.classList.contains(REVIEW_BUTTON_CONTAINER_CLASS)) {
      continue;
    }
    if (isFollowHaystack(getToolbarControlHaystack(item))) {
      return item;
    }
  }

  return null;
}

/**
 * Ищет Notification Settings в menu-bar или в ближайшем контейнере тулбара.
 * @param {HTMLElement} menuBar
 * @returns {HTMLElement|null}
 */
function findNotificationSettingsMenuItem(menuBar) {
  const scopes = [
    menuBar,
    menuBar.closest(
      ".work-item-form-toolbar-container, .workitem-tool-bar, .toolbar.workitem-tool-bar, .toolbar",
    ),
  ];

  for (const scope of scopes) {
    if (!(scope instanceof HTMLElement)) {
      continue;
    }

    for (const el of scope.querySelectorAll(
      "li.menu-item, button, a[role='button'], [role='menuitem'], [title], [aria-label]",
    )) {
      if (!(el instanceof HTMLElement) || el.closest(`.${REVIEW_BUTTON_CONTAINER_CLASS}`)) {
        continue;
      }

      if (!isNotificationSettingsHaystack(getToolbarControlHaystack(el))) {
        continue;
      }

      const menuItem = el.closest("li.menu-item");
      return menuItem instanceof HTMLElement ? menuItem : el;
    }
  }

  return null;
}

/**
 * Якорь для подписей (NS / Follow / Save). Для float:right лучше опираться на Refresh.
 * @param {HTMLElement} menuBar
 * @returns {HTMLElement|null}
 */
function findClassicReviewPlacementAnchor(menuBar) {
  return (
    findNotificationSettingsMenuItem(menuBar)
    || findFollowMenuItem(menuBar)
    || findSaveMenuItem(menuBar)
  );
}

/**
 * @param {HTMLElement} menuBar
 * @returns {HTMLElement|null}
 */
function findRefreshMenuItem(menuBar) {
  for (const item of menuBar.querySelectorAll("li.menu-item")) {
    if (!(item instanceof HTMLElement) || item.classList.contains(REVIEW_BUTTON_CONTAINER_CLASS)) {
      continue;
    }
    if (isRefreshHaystack(getToolbarControlHaystack(item))) {
      return item;
    }
  }
  return null;
}

/**
 * В классическом TFS toolbar часто float:right — DOM-порядок обратен визуальному.
 * @param {HTMLElement} menuBar
 * @returns {boolean}
 */
function isMenuBarFloatRight(menuBar) {
  const styleCandidates = [
    menuBar,
    menuBar.parentElement,
    menuBar.closest(".toolbar"),
    menuBar.closest(".workitem-tool-bar"),
    menuBar.closest(".work-item-form-toolbar-container"),
  ];

  for (const el of styleCandidates) {
    if (el instanceof HTMLElement && getComputedStyle(el).float === "right") {
      return true;
    }
  }

  // Эвристика: первый li визуально правее последнего.
  const items = [...menuBar.querySelectorAll(":scope > li.menu-item")].filter(
    (li) => li instanceof HTMLElement
      && !li.classList.contains(REVIEW_BUTTON_CONTAINER_CLASS)
      && isVisible(li),
  );
  if (items.length >= 2) {
    const firstRect = items[0].getBoundingClientRect();
    const lastRect = items[items.length - 1].getBoundingClientRect();
    if (firstRect.left > lastRect.left + 4) {
      return true;
    }
  }

  return false;
}

/**
 * Вставить кнопку визуально справа от gear / слева от Refresh.
 * При float:right это `refresh.after(item)` в DOM.
 * @param {HTMLElement} menuBar
 * @param {HTMLElement} item
 */
function placeReviewMenuItem(menuBar, item) {
  const floatRight = isMenuBarFloatRight(menuBar);
  const refresh = findRefreshMenuItem(menuBar);
  const anchor = findClassicReviewPlacementAnchor(menuBar);

  if (floatRight) {
    // DOM: … Refresh, Review, Gear… → визуально: … Gear, Review, Refresh …
    if (refresh) {
      if (item.previousElementSibling !== refresh || item.parentElement !== refresh.parentElement) {
        refresh.after(item);
      }
      return;
    }
    if (anchor) {
      if (item.nextElementSibling !== anchor || item.parentElement !== anchor.parentElement) {
        anchor.before(item);
      }
      return;
    }
    menuBar.appendChild(item);
    return;
  }

  // Обычный LTR: сразу после Notification Settings / Follow / Save, иначе перед Refresh.
  if (anchor) {
    if (item.previousElementSibling !== anchor || item.parentElement !== anchor.parentElement) {
      anchor.after(item);
    }
    return;
  }
  if (refresh) {
    if (item.nextElementSibling !== refresh || item.parentElement !== refresh.parentElement) {
      refresh.before(item);
    }
    return;
  }
  menuBar.appendChild(item);
}

/**
 * Кнопка стоит в нужном слоте относительно Refresh/якоря (с учётом float:right).
 * @param {HTMLElement} node
 * @param {HTMLElement} menuBar
 * @returns {boolean}
 */
function isReviewMenuItemCorrectlyPlaced(node, menuBar) {
  if (!menuBar.contains(node)) {
    return false;
  }

  const floatRight = isMenuBarFloatRight(menuBar);
  const refresh = findRefreshMenuItem(menuBar);
  const anchor = findClassicReviewPlacementAnchor(menuBar);

  if (floatRight) {
    if (refresh) {
      return node.previousElementSibling === refresh;
    }
    if (anchor) {
      return node.nextElementSibling === anchor;
    }
    return node === menuBar.lastElementChild;
  }

  if (anchor) {
    return node.previousElementSibling === anchor;
  }
  if (refresh) {
    return node.nextElementSibling === refresh;
  }
  return node === menuBar.lastElementChild;
}

/**
 * @param {HTMLElement} node
 * @returns {boolean}
 */
function isReviewButtonInToolbar(node) {
  if (!(node instanceof HTMLElement) || !node.isConnected) {
    return false;
  }

  const menuBar = findClassicMenuBar();
  if (menuBar && menuBar.contains(node)) {
    return isReviewMenuItemCorrectlyPlaced(node, menuBar);
  }

  const host = findReviewToolbarHost();
  return Boolean(host && host.contains(node));
}

/**
 * @param {HTMLElement} host
 * @param {(haystack: string) => boolean} match
 * @returns {HTMLElement|null}
 */
function findToolbarControlByHaystack(host, match) {
  const candidates = host.querySelectorAll(
    "button, a[role='button'], input[type='button'], .toolbar-item, [command-key], [data-command-key], li.menu-item",
  );

  for (const el of candidates) {
    if (!(el instanceof HTMLElement) || el.closest(`.${REVIEW_BUTTON_CONTAINER_CLASS}`)) {
      continue;
    }

    if (match(getToolbarControlHaystack(el))) {
      return el;
    }
  }

  return null;
}

/**
 * @param {HTMLElement} host
 * @returns {HTMLElement|null}
 */
function findBoltReviewPlacementControl(host) {
  return (
    findToolbarControlByHaystack(host, isNotificationSettingsHaystack)
    || findToolbarControlByHaystack(host, isFollowHaystack)
    || findToolbarControlByHaystack(host, isSaveHaystack)
  );
}

/**
 * @param {HTMLElement} host
 * @param {HTMLElement} container
 * @param {HTMLElement|null} control
 */
function insertAfterToolbarControl(host, container, control) {
  if (!control) {
    host.appendChild(container);
    return;
  }

  let anchor = control;
  while (anchor.parentElement && anchor.parentElement !== host) {
    anchor = anchor.parentElement;
  }

  if (anchor.parentElement === host) {
    anchor.after(container);
  } else {
    control.after(container);
  }
}

/**
 * @param {Iterable<Element>} nodes
 * @returns {HTMLElement|null}
 */
function takePrimaryReviewNode(nodes) {
  let primary = null;
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) {
      continue;
    }
    if (!primary) {
      primary = node;
      continue;
    }
    node.remove();
  }
  return primary;
}

function removeReviewButtons() {
  document.querySelectorAll(`.${REVIEW_BUTTON_CONTAINER_CLASS}`).forEach((node) => node.remove());
  document.querySelectorAll(`.${REVIEW_OVERFLOW_ITEM_CLASS}`).forEach((node) => node.remove());
}

function isWorkItemFormBusy() {
  const form = getWorkItemFormRoot();
  if (!form) {
    return false;
  }

  return Boolean(
    form.querySelector(
      [
        '[aria-busy="true"]',
        ".work-item-form-loading",
        ".status-progress",
        ".progress-text",
        ".loading-indicator",
        ".is-loading",
        ".busy-overlay",
        ".status-indicator.progress",
      ].join(", "),
    ),
  );
}

function isSaveControlStillSavingOrDirty() {
  const menuBar = findClassicMenuBar();
  const host = menuBar || findReviewToolbarHost();
  if (!host) {
    return true;
  }

  const save = menuBar
    ? findSaveMenuItem(menuBar)
    : findToolbarControlByHaystack(host, isSaveHaystack);

  if (!save) {
    return true;
  }

  const haystack = getToolbarControlHaystack(save);
  if (haystack.includes("saving") || haystack.includes("сохраня")) {
    return true;
  }

  const disabled = (
    save.classList.contains("disabled")
    || save.getAttribute("aria-disabled") === "true"
    || save.hasAttribute("disabled")
  );

  // Save disabled ≈ сохранение завершено и грязных правок нет.
  return !disabled;
}

/**
 * Можно ли снова показать кнопку после Save.
 * Ждём: нет busy-индикаторов и Save снова в idle (disabled).
 */
function canShowReviewButtonAfterSave() {
  if (!reviewPausedForSave) {
    return true;
  }

  if (Date.now() - reviewSaveWatchStartedAt >= REVIEW_SAVE_WATCH_TIMEOUT_MS) {
    return true;
  }

  if (isWorkItemFormBusy()) {
    return false;
  }

  if (isSaveControlStillSavingOrDirty()) {
    return false;
  }

  const menuBar = findClassicMenuBar();
  if (menuBar) {
    return Boolean(findClassicReviewPlacementAnchor(menuBar));
  }

  return Boolean(findReviewToolbarHost());
}

function removeToolbarReviewButtonLeftovers() {
  document.querySelectorAll(`.${REVIEW_BUTTON_CONTAINER_CLASS}`).forEach((node) => node.remove());
}

function isOverflowMenuToggleTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }

  const control = target.closest(
    "li.menu-item, button, a[role='button'], [role='menuitem'], [role='button']",
  );
  if (!(control instanceof HTMLElement)) {
    return false;
  }

  if (control.closest(`.${REVIEW_OVERFLOW_ITEM_CLASS}, .${REVIEW_BUTTON_CONTAINER_CLASS}`)) {
    return false;
  }

  if (
    control.querySelector(
      ".bowtie-ellipsis, .bowtie-icon.bowtie-ellipsis, [class*='ellipsis'], .ms-Icon--More",
    )
  ) {
    return true;
  }

  const haystack = getToolbarControlHaystack(control);
  if (
    haystack.includes("more actions")
    || haystack.includes("more options")
    || haystack.includes("дополнитель")
    || haystack.includes("другие действия")
  ) {
    return true;
  }

  const text = String(control.textContent || "").replace(/\s+/g, "").trim();
  return text === "..." || text === "…" || text === "⋯" || text === "•••";
}

/**
 * Сразу вставляем пункт, как только DOM меню появился (без 400ms debounce).
 */
function mountReviewOverflowNow() {
  if (isMutatingUi) {
    return;
  }

  isMutatingUi = true;
  try {
    removeToolbarReviewButtonLeftovers();
    addReviewOverflowMenuItem();
    addCustomOverflowMenuItems();
  } finally {
    queueMicrotask(() => {
      isMutatingUi = false;
    });
  }
}

document.addEventListener(
  "click",
  (event) => {
    if (!isOverflowMenuToggleTarget(event.target)) {
      return;
    }
    // Меню рисуется после клика — несколько быстрых попыток без заметной задержки.
    queueMicrotask(() => mountReviewOverflowNow());
    requestAnimationFrame(() => {
      mountReviewOverflowNow();
      requestAnimationFrame(() => mountReviewOverflowNow());
    });
  },
  true,
);

function loadReviewConfigCache() {
  try {
    chrome.storage.local.get(ADO_CONFIG_STORAGE_KEY, (result) => {
      if (chrome.runtime.lastError) {
        return;
      }

      reviewConfigCache = result?.[ADO_CONFIG_STORAGE_KEY] ?? null;
      scheduleUiMount();
      mountReviewOverflowNow();
    });
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to load review config.`, error);
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[ADO_CONFIG_STORAGE_KEY]) {
    reviewConfigCache = changes[ADO_CONFIG_STORAGE_KEY].newValue ?? null;
    scheduleUiMount();
    mountReviewOverflowNow();
  }
});

let uiMountTimerId = null;
let isMutatingUi = false;

/** Debounce только для AI-кнопки в Description/Discussion; пункт меню «...» монтируется сразу. */
const UI_MOUNT_DEBOUNCE_MS = 400;

function scheduleUiMount() {
  if (uiMountTimerId !== null) {
    window.clearTimeout(uiMountTimerId);
  }

  uiMountTimerId = window.setTimeout(() => {
    uiMountTimerId = null;
    if (isMutatingUi) {
      scheduleUiMount();
      return;
    }

    isMutatingUi = true;
    try {
      if (AI_FEATURES_ENABLED) {
        addAiButtonToDescriptionToolbar();
      }
      removeToolbarReviewButtonLeftovers();
      addReviewOverflowMenuItem();
      addCustomOverflowMenuItems();
    } finally {
      queueMicrotask(() => {
        isMutatingUi = false;
      });
    }
  }, UI_MOUNT_DEBOUNCE_MS);
}

const observer = new MutationObserver(() => {
  if (isMutatingUi) {
    return;
  }
  // Меню «...» — сразу, без ожидания debounce.
  mountReviewOverflowNow();
  if (AI_FEATURES_ENABLED) {
    scheduleUiMount();
  }
});

observer.observe(document.body, { childList: true, subtree: true });

if (AI_FEATURES_ENABLED) {
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (
      /^(Description|Discussion)$/i.test(target.getAttribute("aria-label") || "")
      || target.closest(".html-editor, .discussion-message-entry, .work-item-discussion-control")
    ) {
      scheduleUiMount();
    }
  });
}

loadReviewConfigCache();
mountReviewOverflowNow();
scheduleUiMount();

if (AI_FEATURES_ENABLED) {
  void pingAiBackground()
    .then((response) => {
      console.log(`${LOG_PREFIX} ai-ping response received.`, response);
    })
    .catch((error) => {
      console.error(`${LOG_PREFIX} ai-ping failed on content-script startup.`, error);
    });
}
