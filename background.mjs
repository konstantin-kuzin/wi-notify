import {
  ADO_CONFIG_KEY,
  loadAdoConfig,
  resolveRefreshIntervalMinutes,
  validateAdoConfig,
} from "./ado-config.mjs";
import {
  createWorkItemComment,
  fetchConnectionIdentity,
  fetchWorkItemComments,
  fetchWorkItemTypeStates,
  fetchWorkItemsByIds,
  logAdoError,
  mapWorkItemToItem,
  queryAssignedWorkItemIds,
  queryAssignedWorkItemIdsForSearch,
  resolveStateCategoriesByType,
  resolveWorkItemTypeIcons,
  sortWorkItemsNewestFirst,
  updateWorkItemState,
} from "./ado-api.mjs";
import { addWorkItemEffortToCurrentWeek } from "./timesheet-api.mjs";

const ALARM_NAME = "refresh-work-items";
const REFRESH_MESSAGE_TYPE = "manual-refresh";
const SEARCH_CATALOG_MESSAGE_TYPE = "search-assigned-catalog";
const GET_STATE_OPTIONS_MESSAGE_TYPE = "get-status-options";
const UPDATE_WORK_ITEM_STATE_MESSAGE_TYPE = "update-work-item-status";
const ADD_TO_TIMESHEET_MESSAGE_TYPE = "add-to-timesheet";
const GET_COMMENTS_MESSAGE_TYPE = "get-comments";
const ADD_COMMENT_MESSAGE_TYPE = "add-comment";
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

  void ensureAlarm();
  void refreshWorkItems("config-change");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === REFRESH_MESSAGE_TYPE) {
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
  }

  if (message?.type === SEARCH_CATALOG_MESSAGE_TYPE) {
    void (async () => {
      try {
        const config = await loadAdoConfig();
        const validationErrors = validateAdoConfig(config);

        if (validationErrors.length > 0) {
          sendResponse({
            ok: false,
            error: `${validationErrors.join(" ")} Откройте настройки расширения.`,
          });
          return;
        }

        const searchText = typeof message.query === "string" ? message.query : "";
        const items = await fetchAssignedWorkItemsForSearchQuery(config, searchText);
        sendResponse({ ok: true, items });
      } catch (error) {
        logAdoError("searchCatalog", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return true;
  }

  if (message?.type === GET_STATE_OPTIONS_MESSAGE_TYPE) {
    void (async () => {
      try {
        const config = await loadAdoConfig();
        const validationErrors = validateAdoConfig(config);

        if (validationErrors.length > 0) {
          sendResponse({
            ok: false,
            error: `${validationErrors.join(" ")} Откройте настройки расширения.`,
          });
          return;
        }

        const workItemType = typeof message.workItemType === "string"
          ? message.workItemType
          : "";
        const states = await fetchWorkItemTypeStates(config, workItemType);
        sendResponse({ ok: true, states });
      } catch (error) {
        logAdoError("getStatusOptions", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return true;
  }

  if (message?.type === UPDATE_WORK_ITEM_STATE_MESSAGE_TYPE) {
    void (async () => {
      try {
        const config = await loadAdoConfig();
        const validationErrors = validateAdoConfig(config);

        if (validationErrors.length > 0) {
          sendResponse({
            ok: false,
            error: `${validationErrors.join(" ")} Откройте настройки расширения.`,
          });
          return;
        }

        const workItemId = Number(message.workItemId);
        const nextState = typeof message.nextState === "string" ? message.nextState : "";
        const workItemType = typeof message.workItemType === "string" ? message.workItemType : "";

        await updateWorkItemState(config, workItemId, nextState);

        const stateOptions = await fetchWorkItemTypeStates(config, workItemType);
        const matched = stateOptions.find(
          (stateOption) => stateOption.name.toLowerCase() === nextState.trim().toLowerCase(),
        );
        const nextCategory = matched?.category || inferStateCategoryFromName(nextState);

        const previousState = await getStoredState();
        const nextItems = Array.isArray(previousState.items)
          ? previousState.items.map((item) => {
            if (String(item.id) !== String(workItemId)) {
              return item;
            }

            return {
              ...item,
              state: nextState.trim(),
              stateCategory: nextCategory || item.stateCategory || "active",
              updatedAt: new Date().toISOString(),
            };
          })
          : [];
        const nextStorageState = {
          ...previousState,
          items: nextItems,
          count: nextItems.length,
        };

        await saveState(nextStorageState);
        sendResponse({
          ok: true,
          workItemId: String(workItemId),
          nextState: nextState.trim(),
          nextCategory,
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        logAdoError("updateWorkItemStatus", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return true;
  }

  if (message?.type === ADD_TO_TIMESHEET_MESSAGE_TYPE) {
    void (async () => {
      try {
        const config = await loadAdoConfig();
        const validationErrors = validateAdoConfig(config);

        if (validationErrors.length > 0) {
          sendResponse({
            ok: false,
            error: `${validationErrors.join(" ")} Откройте настройки расширения.`,
          });
          return;
        }

        const identity = await fetchConnectionIdentity(config);
        const login = String(identity.uniqueName ?? "").trim();
        const workItemId = Number(message.workItemId);
        const hours = Number(message.hours);

        const result = await addWorkItemEffortToCurrentWeek({
          login,
          workItemId,
          hours,
        });

        sendResponse({
          ok: true,
          ...result,
        });
      } catch (error) {
        logAdoError("addToTimesheet", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return true;
  }

  if (message?.type === GET_COMMENTS_MESSAGE_TYPE) {
    void (async () => {
      try {
        const config = await loadAdoConfig();
        const validationErrors = validateAdoConfig(config);

        if (validationErrors.length > 0) {
          sendResponse({
            ok: false,
            error: `${validationErrors.join(" ")} Откройте настройки расширения.`,
          });
          return;
        }

        const workItemId = Number(message.workItemId);
        const comments = await fetchWorkItemComments(config, workItemId);
        sendResponse({ ok: true, workItemId: String(message.workItemId), comments });
      } catch (error) {
        logAdoError("getComments", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return true;
  }

  if (message?.type === ADD_COMMENT_MESSAGE_TYPE) {
    void (async () => {
      try {
        const config = await loadAdoConfig();
        const validationErrors = validateAdoConfig(config);

        if (validationErrors.length > 0) {
          sendResponse({
            ok: false,
            error: `${validationErrors.join(" ")} Откройте настройки расширения.`,
          });
          return;
        }

        const workItemId = Number(message.workItemId);
        const text = typeof message.text === "string" ? message.text : "";

        await createWorkItemComment(config, workItemId, text);

        const comments = await fetchWorkItemComments(config, workItemId);
        sendResponse({ ok: true, workItemId: String(message.workItemId), comments });
      } catch (error) {
        logAdoError("addComment", error);
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return true;
  }

  return undefined;
});

function inferStateCategoryFromName(state) {
  const normalized = String(state ?? "").toLowerCase();

  if (!normalized) {
    return "active";
  }

  if (/(closed|done|completed|complete|removed)/i.test(normalized)) {
    return "closed";
  }

  if (/(resolved|ready for testing|fixed)/i.test(normalized)) {
    return "resolved";
  }

  if (/(new|proposed|approved|triaged)/i.test(normalized)) {
    return "proposed";
  }

  return "active";
}

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
  const config = await loadAdoConfig();
  const periodInMinutes = resolveRefreshIntervalMinutes(config);
  const alarm = await chrome.alarms.get(ALARM_NAME);

  if (alarm?.periodInMinutes === periodInMinutes) {
    return;
  }

  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes,
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
          {},
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

/**
 * Поиск по WIQL на сервере (Contains + id), затем детали work item — вне iteration из настроек.
 */
async function fetchAssignedWorkItemsForSearchQuery(config, searchText) {
  const ids = await queryAssignedWorkItemIdsForSearch(config, searchText);
  const workItems = ids.length ? await fetchWorkItemsByIds(config, ids) : [];
  const stateCategoriesByType = await resolveStateCategoriesByType(
    config,
    workItems.map((item) => item?.fields?.["System.WorkItemType"]),
  );
  const typeIconsByName = await resolveWorkItemTypeIcons(
    config,
    workItems.map((item) => item?.fields?.["System.WorkItemType"]),
  );

  const mapped = workItems
    .map((workItem) => mapWorkItemToItem(
      workItem,
      config,
      stateCategoriesByType,
      typeIconsByName,
      { includeClosed: true },
    ))
    .filter(Boolean);

  mapped.sort((left, right) => {
    const lt = Date.parse(left.createdAt ?? "") || 0;
    const rt = Date.parse(right.createdAt ?? "") || 0;
    if (rt !== lt) {
      return rt - lt;
    }

    return Number(right.id) - Number(left.id);
  });

  return mapped;
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
