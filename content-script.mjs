const LOG_PREFIX = "[WI Notify AI]";
const BUILD_MARK = "2026-05-19-01";

console.log(`${LOG_PREFIX} Content script loaded.`, { build: BUILD_MARK });

const AI_BUTTON_CLASS = "ai-rewrite-button";
const AI_BUTTON_CONTAINER_CLASS = "ai-rewrite-button-container";
const AI_BUTTON_STYLE_ID = "wi-notify-ai-button-styles";
/** AI-кнопка в Description временно скрыта — код сохранён, доработаем позже. */
const AI_FEATURES_ENABLED = false;
const COMMAND_BAR_SELECTORS = [
  ".ms-CommandBar-primaryCommands",
  ".bolt-header-commandbar .ms-CommandBar",
  ".work-item-form-toolbar .ms-CommandBar",
  "[data-renderedregion='toolbar'] .ms-CommandBar",
  "[role='toolbar']",
];
const DESCRIPTION_EDITOR_SELECTORS = [
  "[aria-label='Description'][role='textbox'][contenteditable='true']",
  "textarea[aria-label='Description']",
  "iframe[title='Description']",
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

function findDescriptionEditor() {
  for (const selector of DESCRIPTION_EDITOR_SELECTORS) {
    const candidate = document.querySelector(selector);
    if (!candidate) {
      continue;
    }

    if (candidate instanceof HTMLIFrameElement) {
      if (candidate.contentDocument?.body) {
        console.log(`${LOG_PREFIX} Description editor found via iframe selector`, { selector });
        return candidate.contentDocument.body;
      }
      continue;
    }

    if (isVisible(candidate)) {
      console.log(`${LOG_PREFIX} Description editor found via direct selector`, {
        selector,
        tagName: candidate.tagName,
        className: candidate.className,
      });
      return candidate;
    }
  }

  for (const sectionButton of document.querySelectorAll("button[aria-label], button")) {
    if (!/Description/i.test(sectionButton.getAttribute("aria-label") || sectionButton.textContent || "")) {
      continue;
    }

    const sectionRoot = sectionButton.closest("section, [role='region'], div");
    if (!sectionRoot) {
      continue;
    }

    const nestedEditor = sectionRoot.querySelector(
      "[aria-label='Description'][role='textbox'][contenteditable='true'], textarea[aria-label='Description'], div[contenteditable='true'][role='textbox']"
    );
    if (nestedEditor && isVisible(nestedEditor)) {
      console.log(`${LOG_PREFIX} Description editor found via section fallback`, {
        tagName: nestedEditor.tagName,
        className: nestedEditor.className,
      });
      return nestedEditor;
    }
  }

  console.warn(`${LOG_PREFIX} Description editor not found.`);
  return null;
}

function findDescriptionSectionRoot() {
  const editor = findDescriptionEditor();
  if (!editor) {
    return null;
  }

  return editor.closest("section, [role='region'], .flex-column, .work-item-form-control, .work-item-control")
    || editor.parentElement;
}

function findDescriptionToolbarHost() {
  const sectionRoot = findDescriptionSectionRoot();
  if (!sectionRoot) {
    console.warn(`${LOG_PREFIX} Description section root not found.`);
    return null;
  }

  for (const selector of COMMAND_BAR_SELECTORS) {
    for (const candidate of sectionRoot.querySelectorAll(selector)) {
      if (!(candidate instanceof HTMLElement) || !isVisible(candidate)) {
        continue;
      }

      console.log(`${LOG_PREFIX} Description toolbar host found.`, {
        selector,
        tagName: candidate.tagName,
        className: candidate.className,
      });
      return candidate;
    }
  }

  console.warn(`${LOG_PREFIX} Description toolbar host not found in Description section.`);
  return null;
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);

  html = html.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_match, alt, url) => {
    return `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(alt)}">`;
  });

  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    return `<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`;
  });

  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  return html;
}

function splitMarkdownTableRow(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed.includes("|")) {
    return null;
  }

  const normalized = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = normalized.split("|").map((cell) => cell.trim());
  return cells.length > 0 ? cells : null;
}

function isMarkdownTableSeparator(line) {
  const cells = splitMarkdownTableRow(line);
  if (!cells || cells.length === 0) {
    return false;
  }

  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderMarkdownTable(headers, rows) {
  const headerCells = headers.map((cell, index) => cell || `Column ${index + 1}`);
  const chunks = [];

  for (const row of rows) {
    const pairs = row
      .map((cell, index) => {
        const label = headerCells[index];
        const value = cell || "—";
        return `<strong>${renderInlineMarkdown(label)}:</strong> ${renderInlineMarkdown(value)}`;
      })
      .join("<br>");

    chunks.push(`<p>${pairs}</p>`);
  }

  return chunks.join("");
}

function renderMarkdownToHtml(markdown) {
  const normalized = String(markdown ?? "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "<p><br></p>";
  }

  const lines = normalized.split("\n");
  const chunks = [];
  let paragraphLines = [];
  let listType = null;
  let listItems = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    chunks.push(`<p>${paragraphLines.map(renderInlineMarkdown).join("<br>")}</p>`);
    paragraphLines = [];
  };

  const flushList = () => {
    if (!listType || listItems.length === 0) {
      listType = null;
      listItems = [];
      return;
    }

    const tag = listType === "ol" ? "ol" : "ul";
    chunks.push(`<${tag}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${tag}>`);
    listType = null;
    listItems = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      flushParagraph();
      flushList();
      chunks.push("<hr>");
      continue;
    }

    const tableHeader = splitMarkdownTableRow(trimmed);
    const tableSeparator = lines[index + 1] ? lines[index + 1].trim() : "";
    if (tableHeader && tableHeader.length > 1 && isMarkdownTableSeparator(tableSeparator)) {
      flushParagraph();
      flushList();

      const tableRows = [];
      let nextIndex = index + 2;
      while (nextIndex < lines.length) {
        const nextLine = lines[nextIndex].trim();
        const nextRow = splitMarkdownTableRow(nextLine);
        if (!nextLine || !nextRow || nextRow.length < 2) {
          break;
        }

        tableRows.push(nextRow);
        nextIndex += 1;
      }

      if (tableRows.length > 0) {
        chunks.push(renderMarkdownTable(tableHeader, tableRows));
        index = nextIndex - 1;
        continue;
      }
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      chunks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (unorderedMatch) {
      flushParagraph();
      if (listType && listType !== "ul") {
        flushList();
      }
      listType = "ul";
      listItems.push(unorderedMatch[1]);
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      if (listType && listType !== "ol") {
        flushList();
      }
      listType = "ol";
      listItems.push(orderedMatch[1]);
      continue;
    }

    flushList();
    paragraphLines.push(trimmed);
  }

  flushParagraph();
  flushList();

  return chunks.join("");
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

function setRichTextContent(editor, html) {
  editor.innerHTML = html || "<p><br></p>";
}

function notifyFieldChanged(editor, text) {
  editor.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: text,
  }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));
}

function updateDescriptionEditor(editor, text) {
  console.log(`${LOG_PREFIX} Updating description editor`, {
    tagName: editor.tagName,
    contentEditable: editor.contentEditable,
    textLength: text.length,
  });

  if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
    editor.focus();
    editor.value = text;
    notifyFieldChanged(editor, text);
    console.log(`${LOG_PREFIX} Description updated via value assignment.`);
    return;
  }

  editor.focus();

  const doc = editor.ownerDocument;
  const html = renderMarkdownToHtml(text);
  if (typeof doc.execCommand === "function") {
    try {
      const selection = doc.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(editor);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const inserted = doc.execCommand("insertHTML", false, html);
      if (inserted) {
        notifyFieldChanged(editor, text);
        console.log(`${LOG_PREFIX} Description updated via execCommand insertHTML.`);
        return;
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} execCommand insertHTML failed, falling back to manual update.`, error);
    }
  }

  setRichTextContent(editor, html);
  notifyFieldChanged(editor, text);
  console.log(`${LOG_PREFIX} Description updated via manual HTML DOM update.`);
}

function requestAiRewrite({ text, title }, timeoutMs = 100000) {
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
      animation: wi-ai-icon-breathe 1.2s ease-in-out infinite;
    }

    .${AI_BUTTON_CLASS} .wi-ai-icon-spinner {
      opacity: 0;
    }

    .${AI_BUTTON_CLASS}[data-state="pending"] .wi-ai-icon-spinner {
      opacity: 1;
      transform-origin: 9px 9px;
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

    @keyframes wi-ai-icon-breathe {
      0%, 100% {
        transform: scale(0.92);
        opacity: 0.88;
      }

      50% {
        transform: scale(1.06);
        opacity: 1;
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
          <linearGradient id="wiNotifyAiSpinnerGradient" x1="4" y1="4" x2="14" y2="14" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#B58CFF" stop-opacity="0.15"></stop>
            <stop offset="0.55" stop-color="#6E45FF" stop-opacity="0.95"></stop>
            <stop offset="1" stop-color="#2E6BFF" stop-opacity="0.15"></stop>
          </linearGradient>
        </defs>
        <g class="wi-ai-icon-spinner">
          <path d="M9 1.8C12.98 1.8 16.2 5.02 16.2 9" stroke="url(#wiNotifyAiSpinnerGradient)" stroke-width="1.5" stroke-linecap="round"></path>
        </g>
        <g class="wi-ai-icon-core">
          <path d="M9 2.15C9.76 4.63 10.82 5.88 12.12 6.88C13.12 7.64 14.37 8.23 16.85 9C14.37 9.77 13.12 10.36 12.12 11.12C10.82 12.12 9.76 13.37 9 15.85C8.24 13.37 7.18 12.12 5.88 11.12C4.88 10.36 3.63 9.77 1.15 9C3.63 8.23 4.88 7.64 5.88 6.88C7.18 5.88 8.24 4.63 9 2.15Z" fill="url(#wiNotifyAiGradient)"></path>
          <path d="M9 4.35C9.48 5.74 10.17 6.5 10.97 7.12C11.63 7.63 12.43 8.02 13.96 8.53C12.43 9.04 11.63 9.43 10.97 9.94C10.17 10.56 9.48 11.32 9 12.71C8.52 11.32 7.83 10.56 7.03 9.94C6.37 9.43 5.57 9.04 4.04 8.53C5.57 8.02 6.37 7.63 7.03 7.12C7.83 6.5 8.52 5.74 9 4.35Z" fill="white" fill-opacity="0.18"></path>
        </g>
      </svg>
    </span>
  `;
}

function createAiButton() {
  ensureAiButtonStyles();
  const button = document.createElement("button");
  button.className = `${AI_BUTTON_CLASS} bolt-button bolt-button-secondary bolt-icon-button`;
  button.dataset.wiNotifyAiBuild = BUILD_MARK;
  button.dataset.state = "idle";
  button.type = "button";
  button.innerHTML = renderAiButtonContent(false);
  button.title = `Rewrite description with AI (${BUILD_MARK})`;

  button.addEventListener("click", async () => {
    console.log(`${LOG_PREFIX} AI Rewrite button clicked.`);
    const descriptionField = findDescriptionEditor();
    if (!descriptionField) {
      console.error(`${LOG_PREFIX} Click aborted: description editor not found.`);
      alert("Could not find the description editor.");
      return;
    }

    const originalText = getEditorText(descriptionField);
    const workItemTitle = findWorkItemTitle();
    console.log(`${LOG_PREFIX} Original description collected.`, {
      titleLength: workItemTitle.length,
      textLength: originalText.length,
      preview: originalText.slice(0, 200),
    });
    if (!originalText.trim()) {
      console.warn(`${LOG_PREFIX} Click aborted: description is empty.`);
      alert("Description field is empty. Please enter some text to rewrite.");
      return;
    }

    button.disabled = true;
    button.dataset.state = "pending";
    button.innerHTML = renderAiButtonContent(true);

    try {
      console.log(`${LOG_PREFIX} Sending rewriteDescription message to background.`, {
        titleLength: workItemTitle.length,
        textLength: originalText.length,
      });
      const response = await requestAiRewrite({
        text: originalText,
        title: workItemTitle,
      });
      console.log(`${LOG_PREFIX} Received response from background.`, response);

      if (response?.ok && typeof response.rewrittenText === "string") {
        updateDescriptionEditor(descriptionField, response.rewrittenText);
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
  // AI временно отключён: не вставляем кнопку, убираем уже вставленную.
  if (!AI_FEATURES_ENABLED) {
    document.querySelectorAll(`.${AI_BUTTON_CONTAINER_CLASS}`).forEach((node) => node.remove());
    return false;
  }

  const toolbarHost = findDescriptionToolbarHost();
  if (!toolbarHost) {
    return false;
  }

  if (toolbarHost.querySelector(`.${AI_BUTTON_CLASS}`)) {
    return true;
  }

  const buttonContainer = document.createElement("div");
  buttonContainer.className = AI_BUTTON_CONTAINER_CLASS;
  buttonContainer.appendChild(createAiButton());
  toolbarHost.insertBefore(buttonContainer, toolbarHost.firstChild);
  console.log(`${LOG_PREFIX} AI button mounted in Description toolbar.`);
  return true;
}

// ---------------------------------------------------------------------------
// Создание задачи на ревью из задачи на дизайн
// ---------------------------------------------------------------------------

const REVIEW_BUTTON_CLASS = "wi-create-review-button";
const REVIEW_BUTTON_CONTAINER_CLASS = "wi-create-review-container";
const REVIEW_TOAST_CLASS = "wi-review-toast";
const ADO_CONFIG_STORAGE_KEY = "adoConfig";
const CREATE_REVIEW_TASK_MESSAGE_TYPE = "create-review-task";
const CREATE_REVIEW_TASK_TIMEOUT_MS = 65000;
const REVIEW_TOOLBAR_SELECTORS = [
  // Классический TFS / Azure DevOps Server
  ".work-item-form-main-header .work-item-form-toolbar-container",
  ".work-item-form-headerContent .work-item-form-toolbar-container",
  ".work-item-form-toolbar-container",
  // Новый Bolt UI (dev.azure.com)
  ".work-item-form-header .bolt-header-commandbar .ms-CommandBar-primaryCommands",
  ".work-item-form-header .ms-CommandBar-primaryCommands",
  ".bolt-header-commandbar .ms-CommandBar-primaryCommands",
];

let reviewConfigCache = null;

function parseReviewDesignTypes(value) {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function getSourceWorkItemId() {
  const editMatch = location.href.match(/_workitems\/(?:edit|view)\/(\d+)/i);
  if (editMatch) {
    return Number(editMatch[1]);
  }

  try {
    const url = new URL(location.href);
    const fromQuery = url.searchParams.get("id") || url.searchParams.get("workitem");
    if (fromQuery && /^\d+$/.test(fromQuery)) {
      return Number(fromQuery);
    }
  } catch (_error) {
    // ignore
  }

  return null;
}

function getSourceWorkItemType() {
  const selectors = [
    ".work-item-form-header .work-item-type-icon",
    ".work-item-type-icon",
    "[class*='work-item-type-name']",
    "[class*='workitem-type-name']",
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (!element) {
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
  return Boolean(
    document.querySelector(".work-item-form, .witform-layout-resizable, [class*='work-item-form']"),
  );
}

function shouldShowReviewButton() {
  if (!isWorkItemFormPresent()) {
    return false;
  }

  // Без номера сохранённой задачи сценарий недоступен (в т.ч. на форме создания).
  if (getSourceWorkItemId() === null) {
    return false;
  }

  // FR-002 / Q-003: ограничение по типу исходной задачи, если задано в настройках.
  const allowedTypes = parseReviewDesignTypes(reviewConfigCache?.reviewDesignTypes);
  if (!allowedTypes.length) {
    return true;
  }

  const type = getSourceWorkItemType();
  if (!type) {
    // Тип не удалось определить — поведение по умолчанию: показывать.
    return true;
  }

  return allowedTypes.some((allowed) => allowed.toLowerCase() === type.toLowerCase());
}

function findReviewToolbarHost() {
  for (const selector of REVIEW_TOOLBAR_SELECTORS) {
    for (const candidate of document.querySelectorAll(selector)) {
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
  const originalText = label?.textContent ?? "Создать задачу на ревью";
  control.dataset.state = "pending";
  if (control instanceof HTMLButtonElement) {
    control.disabled = true;
  } else {
    control.classList.add("disabled");
    control.setAttribute("aria-disabled", "true");
  }
  if (label) {
    label.textContent = "Создаём…";
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
  label.textContent = "Design Review Task";

  return { icon, label };
}

/**
 * Классический TFS: пункт меню в том же ряду, что Save / Follow.
 * @returns {HTMLLIElement}
 */
function createReviewMenuItem() {
  ensureReviewIconFont();

  const item = document.createElement("li");
  item.className = `menu-item ${REVIEW_BUTTON_CONTAINER_CLASS}`;
  item.dataset.state = "idle";
  item.setAttribute("role", "menuitem");
  item.tabIndex = -1;
  item.title = "Создать связанную задачу типа Review из этой задачи на дизайн";
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

/** Bolt UI fallback: отдельная кнопка. */
function createReviewButton() {
  ensureReviewIconFont();

  const button = document.createElement("button");
  button.type = "button";
  button.className = `${REVIEW_BUTTON_CLASS} bolt-button bolt-button-secondary`;
  button.dataset.state = "idle";
  button.title = "Создать связанную задачу типа Review из этой задачи на дизайн";

  const { icon, label } = createReviewIconAndLabel();
  icon.className = "wi-create-review-icon";
  label.className = "wi-create-review-label";
  button.append(icon, label);
  button.addEventListener("click", () => {
    void handleCreateReviewClick(button);
  });
  return button;
}

function findClassicMenuBar() {
  const selectors = [
    ".work-item-form-toolbar-container .menu-bar",
    ".workitem-tool-bar .menu-bar",
    ".toolbar.workitem-tool-bar .menu-bar",
  ];

  for (const selector of selectors) {
    for (const candidate of document.querySelectorAll(selector)) {
      if (candidate instanceof HTMLElement && isVisible(candidate)) {
        return candidate;
      }
    }
  }

  return null;
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
    if (!(item instanceof HTMLElement)) {
      continue;
    }
    const text = (item.textContent || "").trim().toLowerCase();
    if (/\bsave\b/.test(text) || text.includes("сохранить")) {
      return item;
    }
  }

  return null;
}

/** Уже стоит сразу справа от Save внутри menu-bar. */
function isReviewButtonCorrectlyPlaced(node) {
  if (!(node instanceof HTMLElement)) {
    return false;
  }

  if (node.matches("li.menu-item")) {
    const prev = node.previousElementSibling;
    if (!(prev instanceof HTMLElement)) {
      return false;
    }
    return (
      prev.getAttribute("command") === "save-work-item"
      || prev.classList.contains("save-only")
      || prev.classList.contains("drop-down-save")
      || /\bsave\b/i.test(prev.textContent || "")
    );
  }

  return false;
}

/**
 * Ищет кнопку Save в Bolt-тулбаре.
 * @param {HTMLElement} host
 * @returns {HTMLElement|null}
 */
function findSaveToolbarControl(host) {
  const candidates = host.querySelectorAll(
    "button, a[role='button'], input[type='button'], .toolbar-item, [command-key], [data-command-key]",
  );

  for (const el of candidates) {
    if (!(el instanceof HTMLElement)) {
      continue;
    }

    const haystack = [
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("data-command-key"),
      el.getAttribute("command-key"),
      el.textContent,
    ]
      .map((part) => String(part ?? "").trim().toLowerCase())
      .join(" ");

    if (/\bsave\b/.test(haystack) || haystack.includes("сохранить")) {
      return el;
    }
  }

  return null;
}

function addReviewButton() {
  const existing = document.querySelectorAll(`.${REVIEW_BUTTON_CONTAINER_CLASS}`);

  if (!shouldShowReviewButton()) {
    existing.forEach((node) => node.remove());
    return false;
  }

  for (const node of existing) {
    if (isReviewButtonCorrectlyPlaced(node)) {
      return true;
    }
  }

  // Убираем старое/неверное размещение (раньше кнопка оказывалась слева из‑за float:right у тулбара).
  existing.forEach((node) => node.remove());

  // Классический TFS: вставляем li сразу после Save в menu-bar — тогда совпадают размер и шрифт.
  const menuBar = findClassicMenuBar();
  if (menuBar) {
    const item = createReviewMenuItem();
    const saveItem = findSaveMenuItem(menuBar);
    if (saveItem) {
      saveItem.after(item);
    } else {
      menuBar.appendChild(item);
    }
    console.log(`${LOG_PREFIX} Review menu item mounted after Save.`);
    return true;
  }

  // Bolt UI fallback.
  const host = findReviewToolbarHost();
  if (!host) {
    return false;
  }

  const container = document.createElement("div");
  container.className = REVIEW_BUTTON_CONTAINER_CLASS;
  container.appendChild(createReviewButton());

  const save = findSaveToolbarControl(host);
  if (save) {
    let anchor = save;
    while (anchor.parentElement && anchor.parentElement !== host) {
      anchor = anchor.parentElement;
    }
    if (anchor.parentElement === host) {
      anchor.after(container);
    } else {
      save.after(container);
    }
  } else {
    host.appendChild(container);
  }

  console.log(`${LOG_PREFIX} Review button mounted in work item form toolbar.`);
  return true;
}

function loadReviewConfigCache() {
  try {
    chrome.storage.local.get(ADO_CONFIG_STORAGE_KEY, (result) => {
      if (chrome.runtime.lastError) {
        return;
      }

      reviewConfigCache = result?.[ADO_CONFIG_STORAGE_KEY] ?? null;
      addReviewButton();
    });
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to load review config.`, error);
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[ADO_CONFIG_STORAGE_KEY]) {
    reviewConfigCache = changes[ADO_CONFIG_STORAGE_KEY].newValue ?? null;
    addReviewButton();
  }
});

// Observe the DOM for changes to dynamically add the button
const observer = new MutationObserver(() => {
  addAiButtonToDescriptionToolbar();
  addReviewButton();
});

observer.observe(document.body, { childList: true, subtree: true });

document.addEventListener("focusin", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const descriptionEditor = findDescriptionEditor();
  if (!descriptionEditor) {
    return;
  }

  if (target === descriptionEditor || descriptionEditor.contains(target)) {
    window.setTimeout(() => {
      addAiButtonToDescriptionToolbar();
    }, 0);
  }
});

// Initial check in case the toolbar is already present
addAiButtonToDescriptionToolbar();
loadReviewConfigCache();
addReviewButton();

void pingAiBackground()
  .then((response) => {
    console.log(`${LOG_PREFIX} ai-ping response received.`, response);
  })
  .catch((error) => {
    console.error(`${LOG_PREFIX} ai-ping failed on content-script startup.`, error);
  });
