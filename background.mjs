import {
  ADO_CONFIG_KEY,
  loadAdoConfig,
  validateAdoConfig,
} from "./ado-config.mjs";
import {
  fetchConnectionIdentity,
  fetchWorkItemsByIds,
  logAdoError,
  mapWorkItemToItem,
  queryAssignedWorkItemIds,
  resolveStateCategoriesByType,
  resolveWorkItemTypeIcons,
  sortWorkItemsNewestFirst,
} from "./ado-api.mjs";

const ALARM_NAME = "refresh-work-items";
const CHECK_INTERVAL_MINUTES = 10;
const REFRESH_MESSAGE_TYPE = "manual-refresh";
const STORAGE_KEY = "wiState";

const DEFAULT_STATE = {
  items: [],
  count: 0,
  lastCheckedAt: null,
  lastSuccessAt: null,
  lastTrigger: null,
  lastError: null,
  previousItemIds: [],
  currentUserDisplayName: "",
};

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap({ refresh: true, trigger: "install" });
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap({ refresh: true, trigger: "startup" });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) {
    return;
  }

  void restoreBadgeFromState().then(() => refreshWorkItems("alarm"));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[ADO_CONFIG_KEY]) {
    return;
  }

  void refreshWorkItems("config-change");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== REFRESH_MESSAGE_TYPE) {
    return undefined;
  }

  void restoreBadgeFromState();

  void refreshWorkItems("manual")
    .then((state) => {
      sendResponse({ ok: true, state });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

void bootstrap({ refresh: false, trigger: "service-worker-load" });

async function restoreBadgeFromState() {
  const state = await getStoredState();
  await updateBadge(state.count, !!state.lastError);
}

async function bootstrap({ refresh, trigger }) {
  await ensureAlarm();

  const state = await getStoredState();
  await updateBadge(state.lastError ? 0 : state.count, !!state.lastError);

  if (refresh || !state.lastSuccessAt) {
    await refreshWorkItems(trigger);
  }
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(ALARM_NAME);

  if (alarm) {
    return;
  }

  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: CHECK_INTERVAL_MINUTES,
  });
}

async function refreshWorkItems(trigger) {
  const previousState = await getStoredState();
  const checkedAt = new Date().toISOString();
  const config = await loadAdoConfig();
  const validationErrors = validateAdoConfig(config);

  if (validationErrors.length > 0) {
    const nextState = {
      ...previousState,
      count: 0,
      lastCheckedAt: checkedAt,
      lastTrigger: trigger,
      lastError: `${validationErrors.join(" ")} Откройте настройки расширения.`,
    };

    logAdoError("config", new Error(nextState.lastError));
    await updateBadge(0, true);
    await saveState(nextState);
    return nextState;
  }

  try {
    const identity = await fetchConnectionIdentity(config);
    const ids = await queryAssignedWorkItemIds(config);
    const workItems = ids.length ? await fetchWorkItemsByIds(config, ids) : [];
    const stateCategoriesByType = await resolveStateCategoriesByType(
      config,
      workItems.map((item) => item?.fields?.["System.WorkItemType"]),
    );
    const typeIconsByName = await resolveWorkItemTypeIcons(
      config,
      workItems.map((item) => item?.fields?.["System.WorkItemType"]),
    );

    const items = sortWorkItemsNewestFirst(
      workItems
        .map((workItem) => mapWorkItemToItem(
          workItem,
          config,
          stateCategoriesByType,
          typeIconsByName,
        ))
        .filter(Boolean),
    );

    const nextState = {
      items,
      count: items.length,
      lastCheckedAt: checkedAt,
      lastSuccessAt: checkedAt,
      lastTrigger: trigger,
      lastError: null,
      previousItemIds: items.map((item) => item.id),
      currentUserDisplayName: identity.displayName || identity.uniqueName || "",
    };

    await saveState(nextState);
    await updateBadge(nextState.count, false);

    const newItems = items.filter(
      (item) => !previousState.previousItemIds?.includes(item.id),
    );

    if (newItems.length > 0) {
      void showNotification(newItems);
    }

    return nextState;
  } catch (error) {
    logAdoError("refreshWorkItems", error);
    const nextState = {
      ...previousState,
      count: 0,
      lastCheckedAt: checkedAt,
      lastTrigger: trigger,
      lastError: error instanceof Error ? error.message : String(error),
    };

    await updateBadge(0, true);
    await saveState(nextState);
    return nextState;
  }
}

async function getStoredState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return {
    ...DEFAULT_STATE,
    ...(stored[STORAGE_KEY] ?? {}),
  };
}

async function saveState(state) {
  await chrome.storage.local.set({
    [STORAGE_KEY]: state,
  });
}

async function updateBadge(count, isError) {
  const text = isError ? "" : (count > 0 ? String(count) : "");

  await chrome.action.setBadgeBackgroundColor({ color: isError ? "#a00000" : "#0b5cab" });
  await chrome.action.setBadgeText({ text });

  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  }

  if (isError) {
    await chrome.action.setIcon({
      path: {
        16: "icons/icon-16-error.png",
        32: "icons/icon-32-error.png",
      },
    });
    return;
  }

  await chrome.action.setIcon({
    path: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
    },
  });
}

async function showNotification(newItems) {
  const count = newItems.length;
  const title = count === 1
    ? "Новый work item"
    : `Новых work items: ${count}`;

  const messages = newItems
    .slice(0, 3)
    .map((item) => `#${item.id} ${item.title}`);

  if (newItems.length > 3) {
    messages.push(`…и ещё ${newItems.length - 3}`);
  }

  await chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title,
    message: messages.join("\n"),
    priority: 1,
    requireInteraction: false,
  });
}
