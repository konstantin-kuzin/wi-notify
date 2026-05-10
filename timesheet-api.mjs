/**
 * TimeSheet API integration for popup write actions.
 *
 * Responsibilities:
 * - resolve current TimeSheet account/login;
 * - load current week timesheet model;
 * - ensure work item exists in TimeSheet tasks;
 * - append or increment effort for the selected day (empty Activity flow);
 * - persist effort via WorkItemEffortService and verify it was applied.
 */
const DEFAULT_TIMESHEET_ROOT = "https://hqrndtfsts.avp.ru/TimeSheet";

export async function addWorkItemEffortToCurrentWeek(options) {
  const root = normalizeRoot(options?.timesheetRoot || DEFAULT_TIMESHEET_ROOT);
  const login = String(options?.login ?? "").trim();
  const workItemId = Number(options?.workItemId);
  const hours = Number(options?.hours);
  const targetDate = parseTargetDate(options?.date);

  if (!Number.isInteger(workItemId) || workItemId <= 0) {
    throw new Error("Некорректный work item id для TimeSheet.");
  }

  if (!Number.isFinite(hours) || hours <= 0 || hours > 8) {
    throw new Error("Некорректное значение времени.");
  }

  const period = getWeekPeriodUtc(targetDate);
  const resolvedLogin = await resolveTimesheetLogin(root, login);
  const account = resolvedLogin.toLowerCase();
  const model = await getTimesheetModel(root, account, period.fromIso, period.toIso);
  const timesheet = getCurrentTimesheet(model);
  const dayKey = resolveDayKey(timesheet, targetDate);
  const beforeValue = getWorkItemDayValueForEmptyActivity(timesheet, workItemId, dayKey);
  const targetValue = roundToTwo(beforeValue + hours);

  const task = await ensureTaskExists(model, root, workItemId);
  const activity = pickActivityForSave(task);

  await saveWorkItemEffortRecord(root, {
    login: account,
    workItemId,
    hours: targetValue,
    activity,
    date: targetDate,
  });

  const afterValue = await verifySavedValueWithRetry({
    root,
    account,
    period,
    workItemId,
    dayKey,
    activity,
    retries: 6,
    delayMs: 450,
  });
  const expectedValue = targetValue;

  // Сервер иногда применяет запись с задержкой и/или внутренним округлением.
  // Считаем успехом любой рост значения за день по задаче.
  if (afterValue < expectedValue - 0.001) {
    throw new Error("TimeSheet не применил изменения. Сервер принял запрос, но не сохранил запись.");
  }

  return {
    account,
    dayKey,
    workItemId: String(workItemId),
    hours,
    date: formatDateInputValue(targetDate),
  };
}

function parseTargetDate(value) {
  if (value === undefined || value === null || value === "") {
    return new Date();
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("Некорректная дата для TimeSheet.");
    }
    return value;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) {
    throw new Error("Некорректная дата для TimeSheet.");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    throw new Error("Некорректная дата для TimeSheet.");
  }

  return date;
}

function getWorkItemDayTotal(timesheet, workItemId, dayKey) {
  const rows = Array.isArray(timesheet?.Rows) ? timesheet.Rows : [];
  return rows.reduce((sum, row) => {
    if (Number(row?.Id) !== Number(workItemId)) {
      return sum;
    }
    return sum + (Number(row?.Efforts?.[dayKey]?.Value) || 0);
  }, 0);
}

function getWorkItemDayValueForEmptyActivity(timesheet, workItemId, dayKey) {
  const rows = Array.isArray(timesheet?.Rows) ? timesheet.Rows : [];
  const row = rows.find(
    (entry) => Number(entry?.Id) === Number(workItemId) && !String(entry?.Activity ?? "").trim(),
  );
  return Number(row?.Efforts?.[dayKey]?.Value) || 0;
}

async function resolveTimesheetLogin(root, loginCandidate) {
  if (looksLikeTimesheetLogin(loginCandidate)) {
    return loginCandidate;
  }

  const currentUserResponse = await fetch(`${root}/api/UsersService/GetCurrentUser`, {
    credentials: "include",
    cache: "no-store",
  });

  if (!currentUserResponse.ok) {
    throw new Error("Не удалось определить аккаунт TimeSheet.");
  }

  const currentUser = await currentUserResponse.json();
  const fromTimesheet = String(
    currentUser?.Login
      ?? currentUser?.login
      ?? currentUser?.Account
      ?? currentUser?.account
      ?? "",
  ).trim();

  if (!looksLikeTimesheetLogin(fromTimesheet)) {
    throw new Error("Не удалось определить аккаунт TimeSheet.");
  }

  return fromTimesheet;
}

function looksLikeTimesheetLogin(value) {
  const login = String(value ?? "").trim();
  return Boolean(login && /\\/.test(login));
}

async function getTimesheetModel(root, account, fromIso, toIso) {
  const query = new URLSearchParams({
    account,
    from: fromIso,
    to: toIso,
  });
  const response = await fetch(`${root}/api/TimesheetService?${query.toString()}`, {
    credentials: "include",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`TimeSheet GET вернул HTTP ${response.status}.`);
  }

  return response.json();
}

async function saveWorkItemEffortRecord(root, payload) {
  const date = payload.date instanceof Date ? payload.date : new Date(payload.date);
  const body = {
    Activity: payload.activity || "",
    Date: date.toISOString(),
    ExplicitDate: {
      Year: date.getFullYear(),
      Month: date.getMonth() + 1,
      Day: date.getDate(),
    },
    Effort: Number(payload.hours),
    SystemId: Number(payload.workItemId),
    Login: String(payload.login),
  };

  const response = await fetch(`${root}/api/WorkItemEffortService/`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`WorkItemEffortService вернул HTTP ${response.status}.`);
  }
}

function getCurrentTimesheet(model) {
  const timesheets = Array.isArray(model?.Timesheets) ? model.Timesheets : [];
  const current = timesheets[0];

  if (!current) {
    throw new Error("В ответе TimeSheet нет недельного табеля.");
  }

  if (!Array.isArray(current.Rows)) {
    current.Rows = [];
  }

  return current;
}

function resolveDayKey(timesheet, date) {
  const columns = Array.isArray(timesheet?.Columns) ? timesheet.Columns : [];
  const preferred = formatDayKey(date);
  const byToday = columns.find((column) => column?.Key === preferred);

  if (byToday?.Key) {
    return byToday.Key;
  }

  const firstWorking = columns.find((column) => !column?.IsHoliday && column?.Key);
  if (firstWorking?.Key) {
    return firstWorking.Key;
  }

  const first = columns.find((column) => column?.Key);
  if (first?.Key) {
    return first.Key;
  }

  throw new Error("Не удалось определить день для записи времени.");
}

async function ensureTaskExists(model, root, workItemId) {
  const tasks = Array.isArray(model?.Tasks) ? model.Tasks : [];
  const existingTask = tasks.find((task) => Number(task?.Id) === workItemId);

  if (existingTask) {
    return existingTask;
  }

  const taskDetails = await fetchTaskDetails(root, workItemId);
  tasks.push(taskDetails);
  model.Tasks = tasks;
  return taskDetails;
}

async function fetchTaskDetails(root, workItemId) {
  const response = await fetch(`${root}/api/WorkItemService/${workItemId}`, {
    credentials: "include",
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Не удалось автодобавить задачу в TimeSheet (HTTP ${response.status}).`);
  }

  const data = await response.json();
  const id = Number(data?.Id ?? workItemId);
  const title = String(data?.Title ?? "").trim();

  if (!Number.isInteger(id) || id <= 0 || !title) {
    throw new Error("TimeSheet вернул некорректные данные задачи для автодобавления.");
  }

  return {
    Activities: Array.isArray(data?.Activities) ? data.Activities : [],
    Id: id,
    TeamProject: String(data?.TeamProject ?? ""),
    Title: title,
    Url: String(data?.Url ?? ""),
    WorkItemType: String(data?.WorkItemType ?? ""),
    CompletedWork: Number(data?.CompletedWork) || 0,
    OriginalEstimate: Number(data?.OriginalEstimate) || undefined,
    IsEffortable: data?.IsEffortable !== false,
    State: String(data?.State ?? ""),
    AreaPath: String(data?.AreaPath ?? ""),
    Iteration: String(data?.Iteration ?? ""),
    Product: String(data?.Product ?? ""),
    ProductLine: String(data?.ProductLine ?? ""),
    Relations: Array.isArray(data?.Relations) ? data.Relations : [],
  };
}

function pickActivityForSave(task) {
  // При ручном добавлении TimeSheet сохраняет запись с пустой активностью.
  // Делаем то же самое, чтобы не попадать в AutoTrack/Analysis.
  return "";
}

async function verifySavedValueWithRetry(params) {
  const retries = Number(params.retries) || 1;
  const delayMs = Number(params.delayMs) || 0;
  let lastValue = 0;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const model = await getTimesheetModel(
      params.root,
      params.account,
      params.period.fromIso,
      params.period.toIso,
    );
    const timesheet = getCurrentTimesheet(model);
    if (String(params.activity ?? "").trim()) {
      lastValue = getWorkItemDayTotal(timesheet, params.workItemId, params.dayKey);
    } else {
      lastValue = getWorkItemDayValueForEmptyActivity(timesheet, params.workItemId, params.dayKey);
    }

    if (attempt < retries - 1) {
      await delay(delayMs);
    }
  }

  return lastValue;
}

function getWeekPeriodUtc(date) {
  const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = localMidnight.getDay();
  const mondayShift = day === 0 ? -6 : 1 - day;
  const monday = new Date(localMidnight);
  monday.setDate(localMidnight.getDate() + mondayShift);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return {
    fromIso: toUtcMidnightIso(monday),
    toIso: toUtcMidnightIso(sunday),
  };
}

function toUtcMidnightIso(localDate) {
  return new Date(Date.UTC(
    localDate.getFullYear(),
    localDate.getMonth(),
    localDate.getDate(),
    0,
    0,
    0,
    0,
  )).toISOString();
}

function formatDayKey(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${day}.${month}.${year}`;
}

function formatDateInputValue(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${year}-${month}-${day}`;
}

function roundToTwo(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeRoot(root) {
  return String(root ?? DEFAULT_TIMESHEET_ROOT).replace(/\/+$/, "");
}
