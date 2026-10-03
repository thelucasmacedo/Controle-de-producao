const STORAGE_KEY = "producaoCeramicaV1";
const MIGRATION_PREFIX = `${STORAGE_KEY}:migration:`;
const PRODUCT_BLOCKS = {
  "Bloquinho 9×19×19": 390,
  "Blocão 9×19×29": 234,
};
const PERIODS = {
  morning: { name: "Manhã", hours: "07:00–12:00" },
  afternoon: { name: "Tarde", hours: "13:00–17:00" },
};

function emptyRecord() {
  return {
    produto: "Bloquinho 9×19×19",
    meta: 75,
    inicio: Date.now(),
    paletes: [],
    paradas: [],
    ativa: null,
  };
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultPeriodForNow(date = new Date()) {
  return date.getHours() < 13 ? "morning" : "afternoon";
}

let d = emptyRecord();
let currentUserId = null;
let activeDate = localDateString();
let activePeriod = defaultPeriodForNow();
let canEdit = false;
let hasActiveRecord = false;
let historyRecords = { morning: null, afternoon: null };
const periodVersions = new Map();
let saveQueue = Promise.resolve(true);
let periodStatusNotice = null;
let migrationNotice = "";

const byId = (id) => document.getElementById(id);
const productInput = byId("produto");
const goalInput = byId("meta");
const historyDateInput = byId("historyDate");
const startPeriodInput = byId("startPeriod");
const homeScreen = byId("homeScreen");
const productionScreen = byId("productionScreen");
const homeButton = byId("homeBtn");

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function copyRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatDate(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString("pt-BR");
}

function setPeriodMessage(message, type = "info") {
  periodStatusNotice = message ? { message, type } : null;
  updatePeriodMessage();
}

function updatePeriodMessage() {
  const element = byId("periodStatus");
  if (!element) return;

  if (periodStatusNotice) {
    element.textContent = periodStatusNotice.message;
    element.className = `note period-status ${periodStatusNotice.type}-note`;
  } else if (!hasActiveRecord) {
    element.textContent = "Inicie a produção para criar o registro deste período.";
    element.className = "note period-status";
  } else if (canEdit) {
    element.textContent = "As alterações são salvas automaticamente na sua conta.";
    element.className = "note period-status success-note";
  } else {
    element.textContent = "Consulta somente leitura. O registro original foi preservado.";
    element.className = "note period-status";
  }
}

function updatePeriodHeading() {
  const period = PERIODS[activePeriod] || PERIODS.morning;
  byId("selectedPeriodName").textContent =
    `${period.name} · ${period.hours} · ${formatDate(activeDate)}`;
  updatePeriodMessage();
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      const error = new Error(
        "Sua sessão expirou. Entre novamente para continuar.",
      );
      error.status = response.status;
      throw error;
    }
    const error = new Error(
      body.error || "Não foi possível concluir a operação.",
    );
    error.status = response.status;
    throw error;
  }
  return body;
}

function save() {
  if (!currentUserId || !canEdit || !hasActiveRecord) {
    return Promise.resolve(false);
  }

  const userId = currentUserId;
  const date = activeDate;
  const period = activePeriod;
  const key = `${userId}:${date}:${period}`;
  const snapshot = JSON.stringify(d);
  const saveOperation = async () => {
    if (
      currentUserId !== userId ||
      activeDate !== date ||
      activePeriod !== period ||
      !canEdit
    ) {
      return false;
    }
    const expectedVersion = periodVersions.get(key);
    if (!expectedVersion) {
      canEdit = false;
      setPeriodMessage(
        "Não foi possível confirmar a versão do registro. Volte à tela inicial e abra o período novamente.",
        "error",
      );
      render();
      return false;
    }
    try {
      const result = await apiRequest(`/api/records/${date}/${period}`, {
        method: "PUT",
        headers: { "X-Record-Version": expectedVersion },
        body: snapshot,
      });
      if (result.updatedAt) periodVersions.set(key, result.updatedAt);
      if (
        currentUserId === userId &&
        activeDate === date &&
        activePeriod === period
      ) {
        setPeriodMessage("", "success");
      }
      return true;
    } catch (error) {
      if (
        currentUserId === userId &&
        activeDate === date &&
        activePeriod === period
      ) {
        if (error.status === 409) {
          canEdit = false;
          setPeriodMessage(
            "Outro dispositivo alterou este período. Nenhuma alteração foi gravada. Exporte o relatório, se precisar, e reabra o período para carregar a versão atual.",
            "error",
          );
          render();
          return false;
        }
        setPeriodMessage(error.message, "error");
      }
      return false;
    }
  };

  saveQueue = saveQueue.then(saveOperation, saveOperation);
  return saveQueue;
}

function isLegacyRecordValid(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.produto === "string" &&
    Number.isFinite(Number(value.meta)) &&
    Number.isFinite(Number(value.inicio)) &&
    Array.isArray(value.paletes) &&
    Array.isArray(value.paradas)
  );
}

async function importLegacyRecord() {
  if (!currentUserId) return "";

  const migrationKey = `${MIGRATION_PREFIX}${currentUserId}`;
  const status = localStorage.getItem(migrationKey);
  if (status === "imported" || status === "checked") return "";
  if (status === "conflict") {
    return "Os dados antigos deste aparelho foram mantidos porque já existe um registro online para aquele período.";
  }

  let legacy;
  try {
    legacy = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return "Os dados antigos deste aparelho não puderam ser lidos e continuam preservados.";
  }
  if (!legacy) {
    localStorage.setItem(migrationKey, "checked");
    return "";
  }
  if (!isLegacyRecordValid(legacy)) {
    return "Há dados antigos neste aparelho que não puderam ser importados; eles foram mantidos sem alteração.";
  }

  const startTime = new Date(Number(legacy.inicio));
  if (Number.isNaN(startTime.getTime())) {
    return "Há dados antigos neste aparelho com uma data inválida; eles foram mantidos sem alteração.";
  }
  const date = localDateString(startTime);
  const period = defaultPeriodForNow(startTime);

  try {
    const existing = await apiRequest(
      `/api/records?date=${encodeURIComponent(date)}`,
    );
    if (existing.periods[period]) {
      localStorage.setItem(migrationKey, "conflict");
      return `Os dados antigos de ${formatDate(date)} (${PERIODS[period].name}) foram mantidos neste aparelho porque já existe um registro online para o mesmo período.`;
    }

    const result = await apiRequest(`/api/records/${date}/${period}`, {
      method: "POST",
      body: JSON.stringify(legacy),
    });
    if (!result.created) {
      localStorage.setItem(migrationKey, "conflict");
      return `Os dados antigos de ${formatDate(date)} (${PERIODS[period].name}) foram mantidos neste aparelho porque já existe um registro online para o mesmo período.`;
    }

    localStorage.removeItem(STORAGE_KEY);
    localStorage.setItem(migrationKey, "imported");
    return `Dados antigos do aparelho importados para ${formatDate(date)} (${PERIODS[period].name}).`;
  } catch (error) {
    return `Os dados antigos continuam neste aparelho; a importação online não foi concluída: ${error.message}`;
  }
}

function displayHome() {
  productionScreen.classList.add("hidden");
  homeScreen.classList.remove("hidden");
  homeButton.classList.add("hidden");
  window.scrollTo({ top: 0, behavior: "auto" });
}

function displayProduction() {
  homeScreen.classList.add("hidden");
  productionScreen.classList.remove("hidden");
  homeButton.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "auto" });
}

async function openHistoryFromHome() {
  activeDate = localDateString();
  activePeriod = startPeriodInput.value;
  canEdit = false;
  hasActiveRecord = false;
  d = emptyRecord();
  productInput.value = d.produto;
  goalInput.value = d.meta;
  historyDateInput.value = activeDate;
  periodStatusNotice = null;
  updatePeriodHeading();
  render();
  displayProduction();
  await loadHistoryDay(activeDate);
}

async function initializeOnlineData() {
  const userId = currentUserId;
  if (!userId) return;

  byId("startStatus").textContent = "Carregando seus registros...";
  setPeriodMessage("Carregando os registros da sua conta...");
  historyDateInput.value = localDateString();

  try {
    migrationNotice = await importLegacyRecord();
    await loadHistoryDay(historyDateInput.value);
    byId("startStatus").textContent = migrationNotice;
    setPeriodMessage("", "success");
  } catch (error) {
    const message = `Não foi possível carregar os registros online: ${error.message}`;
    byId("startStatus").textContent = message;
    setPeriodMessage(message, "error");
  }
  render();
}

async function beginProduction() {
  if (!currentUserId) return;
  const startButton = byId("startProduction");
  startButton.disabled = true;
  byId("startStatus").textContent = "Abrindo o período...";
  periodStatusNotice = null;

  try {
    const previousSaveSucceeded = await saveQueue;
    if (!previousSaveSucceeded && canEdit && hasActiveRecord) {
      const retried = await save();
      if (!retried) {
        throw new Error(
          "As alterações pendentes não foram salvas. Tente novamente antes de abrir outro período.",
        );
      }
    }
    const date = localDateString();
    const period = startPeriodInput.value;
    let day = await apiRequest(
      `/api/records?date=${encodeURIComponent(date)}`,
    );
    const versionKey = `${currentUserId}:${date}:${period}`;
    let entry = day.periods[period];
    let record = entry?.payload || null;
    if (entry?.updatedAt) periodVersions.set(versionKey, entry.updatedAt);

    if (!record) {
      const fresh = emptyRecord();
      const inserted = await apiRequest(`/api/records/${date}/${period}`, {
        method: "POST",
        body: JSON.stringify(fresh),
      });
      if (inserted.created) {
        record = fresh;
        if (inserted.updatedAt) {
          periodVersions.set(versionKey, inserted.updatedAt);
        }
      } else {
        day = await apiRequest(
          `/api/records?date=${encodeURIComponent(date)}`,
        );
        entry = day.periods[period];
        record = entry?.payload || null;
        if (entry?.updatedAt) {
          periodVersions.set(versionKey, entry.updatedAt);
        }
      }
    }
    if (!record || !periodVersions.has(versionKey)) {
      throw new Error("O registro do período não foi localizado.");
    }

    activeDate = date;
    activePeriod = period;
    canEdit = true;
    hasActiveRecord = true;
    d = copyRecord(record);
    productInput.value = d.produto;
    goalInput.value = d.meta;
    byId("startStatus").textContent = migrationNotice;
    updatePeriodHeading();
    render();
    displayProduction();
    await loadHistoryDay(date);
  } catch (error) {
    const message = `Não foi possível iniciar o período: ${error.message}`;
    byId("startStatus").textContent = message;
    setPeriodMessage(message, "error");
  } finally {
    startButton.disabled = false;
  }
}

async function loadHistoryDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    byId("historyStatus").textContent = "Escolha uma data válida.";
    byId("exportDayBtn").disabled = true;
    return;
  }
  await saveQueue;
  byId("loadDayBtn").disabled = true;
  byId("historyStatus").textContent = "Consultando os períodos...";
  try {
    const result = await apiRequest(
      `/api/records?date=${encodeURIComponent(date)}`,
    );
    historyRecords = result.periods || { morning: null, afternoon: null };
    for (const period of ["morning", "afternoon"]) {
      const entry = historyRecords[period];
      const key = `${currentUserId}:${date}:${period}`;
      if (
        entry?.updatedAt &&
        (!canEdit ||
          activeDate !== date ||
          activePeriod !== period ||
          !periodVersions.has(key))
      ) {
        periodVersions.set(key, entry.updatedAt);
      }
    }
    historyDateInput.value = date;
    renderHistory(date);
  } catch (error) {
    byId("historyStatus").textContent = error.message;
    byId("historyStatus").className = "note period-status error-note";
    byId("daySummary").replaceChildren();
    byId("exportDayBtn").disabled = true;
  } finally {
    byId("loadDayBtn").disabled = false;
  }
}

function blockCount(record) {
  if (!record || !PRODUCT_BLOCKS[record.produto]) return null;
  return record.paletes.length * PRODUCT_BLOCKS[record.produto];
}

function renderHistory(date) {
  const morning = historyRecords.morning?.payload || null;
  const afternoon = historyRecords.afternoon?.payload || null;
  const available = [morning, afternoon].filter(Boolean);
  const totalPallets = available.reduce(
    (sum, record) => sum + record.paletes.length,
    0,
  );
  const allBlockCountsKnown = available.every(
    (record) => blockCount(record) !== null,
  );
  const totalBlocks = available.reduce(
    (sum, record) => sum + (blockCount(record) || 0),
    0,
  );

  const periodsMarkup = ["morning", "afternoon"]
    .map((period) => {
      const record = historyRecords[period]?.payload || null;
      const periodInfo = PERIODS[period];
      const blocks = blockCount(record);
      return `
        <article class="period-card">
          <h3>${periodInfo.name} · ${periodInfo.hours}</h3>
          ${
            record
              ? `<p><strong>${record.paletes.length.toLocaleString("pt-BR")}</strong> paletes</p>
                 <p><strong>${blocks === null ? "—" : blocks.toLocaleString("pt-BR")}</strong> blocos</p>
                 <p>${escapeHTML(record.produto)}</p>`
              : '<p>Sem registro neste período.</p>'
          }
          <button class="small" type="button" data-open-period="${period}" ${record ? "" : "disabled"}>Ver detalhes</button>
        </article>`;
    })
    .join("");

  byId("daySummary").innerHTML = `
    ${
      available.length
        ? `<div class="day-total">Total do dia: <strong>${totalPallets.toLocaleString("pt-BR")} paletes</strong> · <strong>${allBlockCountsKnown ? totalBlocks.toLocaleString("pt-BR") : "—"} blocos</strong></div>`
        : ""
    }
    <div class="history-summary">${periodsMarkup}</div>`;
  byId("historyStatus").textContent = available.length
    ? `Registros de ${formatDate(date)}.`
    : `Nenhum registro encontrado em ${formatDate(date)}.`;
  byId("historyStatus").className = "note period-status";
  byId("exportDayBtn").disabled = available.length === 0;
}

async function openHistoricalPeriod(date, period) {
  if (canEdit && hasActiveRecord) {
    let saved = await saveQueue;
    if (!saved) saved = await save();
    if (!saved) return;
  }
  const record = historyRecords[period]?.payload;
  if (!record) return;
  activeDate = date;
  activePeriod = period;
  canEdit = false;
  hasActiveRecord = true;
  d = copyRecord(record);
  productInput.value = d.produto;
  goalInput.value = d.meta;
  periodStatusNotice = null;
  updatePeriodHeading();
  render();
  displayProduction();
}

function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString("pt-BR");
}

function render() {
  if (!d || !Array.isArray(d.paletes) || !Array.isArray(d.paradas)) {
    d = emptyRecord();
  }
  updatePeriodHeading();

  const now = Date.now();
  const totalDowntime =
    d.paradas.reduce((total, stop) => total + Number(stop.dur || 0), 0) +
    (d.ativa ? now - d.ativa.start : 0);
  const count = d.paletes.length;
  const blocksPerPallet = PRODUCT_BLOCKS[d.produto];
  byId("count").textContent = count.toLocaleString("pt-BR");
  byId("metaText").textContent = `de ${d.meta}`;
  byId("totalBlocks").textContent = blocksPerPallet
    ? (count * blocksPerPallet).toLocaleString("pt-BR")
    : "—";
  byId("blocksUnit").textContent = blocksPerPallet
    ? "blocos produzidos"
    : "sem conversão cadastrada para este produto";
  byId("downtime").textContent = formatTime(totalDowntime);

  const average =
    count > 1
      ? (d.paletes.at(-1).t - d.paletes[0].t) / (count - 1)
      : null;
  byId("avg").textContent = average ? formatTime(average) : "--";
  const progress = Math.min(100, (count / d.meta) * 100);
  byId("bar").style.width = `${progress}%`;
  byId("progressText").textContent = `${progress.toFixed(0)}% da meta`;

  const status = byId("status");
  const canChangeRecord = canEdit && hasActiveRecord;
  const readOnlyNote = byId("readonlyNote");
  productInput.disabled = !canChangeRecord;
  goalInput.disabled = !canChangeRecord;
  byId("addBtn").classList.toggle("hidden", !canChangeRecord);
  byId("stopBtn").classList.toggle(
    "hidden",
    !canChangeRecord || Boolean(d.ativa),
  );
  byId("resumeBtn").classList.toggle(
    "hidden",
    !canChangeRecord || !d.ativa,
  );
  readOnlyNote.classList.toggle("hidden", canChangeRecord || !hasActiveRecord);

  if (!hasActiveRecord) {
    status.className = "status paused";
    status.textContent = "⚪ NENHUM PERÍODO ABERTO";
  } else if (!canChangeRecord) {
    status.className = "status paused";
    status.textContent = "🔎 CONSULTA DO HISTÓRICO";
  } else if (d.ativa) {
    status.className = "status paused";
    status.textContent = `🔴 PARADA — ${d.ativa.local}`;
  } else {
    status.className = "status";
    status.textContent = "🟢 PRODUÇÃO EM ANDAMENTO";
  }

  byId("paletes").innerHTML = d.paletes
    .slice()
    .reverse()
    .slice(0, 15)
    .map(
      (p) =>
        `<tr><td><b>${p.n}</b></td><td>${formatClock(p.t)}</td><td>${p.interval ? formatTime(p.interval) : "—"}</td></tr>`,
    )
    .join("");
  byId("paradas").innerHTML = d.paradas
    .slice()
    .reverse()
    .map(
      (stop) =>
        `<tr><td>${formatClock(stop.start)}</td><td><span class="badge">${escapeHTML(stop.local)}</span></td><td>${formatTime(stop.dur)}</td><td>${escapeHTML(stop.comentario || "—")}</td></tr>`,
    )
    .join("");
  byId("rMeta").textContent = d.meta;
  byId("rProd").textContent = count;
  byId("rFalta").textContent = Math.max(0, d.meta - count);
  const longestStop = d.paradas.reduce(
    (longest, stop) => Math.max(longest, stop.dur),
    0,
  );
  byId("rMaior").textContent = longestStop ? formatTime(longestStop) : "--";
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\t\r=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(rows, filename) {
  const contents = rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
  const blob = new Blob([`\ufeff${contents}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function appendRecordRows(rows, record, period) {
  rows.push(
    [],
    [`PERÍODO ${PERIODS[period].name.toUpperCase()}`, PERIODS[period].hours],
    ["Produto", record.produto],
    ["Meta", record.meta],
    ["Paletes", record.paletes.length],
    [],
    ["PALETES", "Horário", "Intervalo"],
  );
  for (const pallet of record.paletes) {
    rows.push([
      pallet.n,
      new Date(pallet.t).toLocaleTimeString("pt-BR"),
      pallet.interval ? formatTime(pallet.interval) : "",
    ]);
  }
  rows.push([], ["PARADAS", "Início", "Fim", "Local", "Duração", "Comentário"]);
  for (const stop of record.paradas) {
    rows.push([
      "",
      new Date(stop.start).toLocaleString("pt-BR"),
      new Date(stop.end).toLocaleString("pt-BR"),
      stop.local,
      formatTime(stop.dur),
      stop.comentario || "",
    ]);
  }
}

function exportPeriod() {
  if (!hasActiveRecord) return;
  const rows = [
    ["RELATÓRIO DE PRODUÇÃO"],
    ["Data", formatDate(activeDate)],
  ];
  appendRecordRows(rows, d, activePeriod);
  downloadCsv(rows, `producao-${activeDate}-${activePeriod}.csv`);
}

function exportDay() {
  const date = historyDateInput.value;
  const rows = [["RELATÓRIO DIÁRIO DE PRODUÇÃO"], ["Data", formatDate(date)]];
  for (const period of ["morning", "afternoon"]) {
    const record = historyRecords[period]?.payload;
    if (record) appendRecordRows(rows, record, period);
  }
  downloadCsv(rows, `producao-${date}.csv`);
}

function addPallet() {
  if (!canEdit || !hasActiveRecord) return;
  if (d.ativa) {
    window.alert("Finalize a parada antes de produzir o próximo palete.");
    return;
  }
  const now = Date.now();
  const last = d.paletes.at(-1);
  d.paletes.push({
    n: d.paletes.length + 1,
    t: now,
    interval: last ? now - last.t : null,
  });
  render();
  void save();
}

function closeStopModal() {
  byId("modal").classList.add("hidden");
}

function confirmStop() {
  if (!canEdit || !hasActiveRecord || d.ativa) return;
  d.ativa = {
    start: Date.now(),
    local: byId("local").value,
    comentario: byId("comentario").value.trim(),
  };
  closeStopModal();
  render();
  void save();
}

function resumeProduction() {
  if (!canEdit || !hasActiveRecord || !d.ativa) return;
  const now = Date.now();
  d.paradas.push({
    ...d.ativa,
    end: now,
    dur: now - d.ativa.start,
  });
  d.ativa = null;
  render();
  void save();
}

function clearForSignedOut() {
  currentUserId = null;
  canEdit = false;
  hasActiveRecord = false;
  d = emptyRecord();
  periodStatusNotice = null;
  historyRecords = { morning: null, afternoon: null };
  periodVersions.clear();
  byId("daySummary").replaceChildren();
  byId("historyStatus").textContent = "Entre para consultar os registros.";
  byId("startStatus").textContent = "";
  displayHome();
  render();
}

byId("startPeriod").value = defaultPeriodForNow();
historyDateInput.value = localDateString();
productInput.value = d.produto;
goalInput.value = d.meta;
byId("startProduction").addEventListener("click", beginProduction);
byId("historyHomeBtn").addEventListener("click", () =>
  void openHistoryFromHome(),
);
homeButton.addEventListener("click", displayHome);
byId("loadDayBtn").addEventListener("click", () =>
  loadHistoryDay(historyDateInput.value),
);
byId("exportDayBtn").addEventListener("click", exportDay);
byId("exportPeriodBtn").addEventListener("click", exportPeriod);
byId("addBtn").addEventListener("click", addPallet);
byId("stopBtn").addEventListener("click", () => {
  if (!canEdit || !hasActiveRecord || d.ativa) return;
  byId("comentario").value = "";
  byId("modal").classList.remove("hidden");
});
byId("cancelModalBtn").addEventListener("click", closeStopModal);
byId("confirmStopBtn").addEventListener("click", confirmStop);
byId("resumeBtn").addEventListener("click", resumeProduction);
productInput.addEventListener("change", () => {
  if (!canEdit || !hasActiveRecord) return;
  d.produto = productInput.value;
  render();
  void save();
});
goalInput.addEventListener("change", () => {
  if (!canEdit || !hasActiveRecord) return;
  d.meta = Math.max(1, Number(goalInput.value) || 1);
  goalInput.value = d.meta;
  render();
  void save();
});
byId("daySummary").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-period]");
  if (!button || button.disabled) return;
  void openHistoricalPeriod(historyDateInput.value, button.dataset.openPeriod);
});
byId("historyDate").addEventListener("keydown", (event) => {
  if (event.key === "Enter") void loadHistoryDay(historyDateInput.value);
});

window.addEventListener("production-auth-ready", (event) => {
  currentUserId = event.detail?.userId || null;
  if (!currentUserId) return;
  void initializeOnlineData();
});
window.addEventListener("production-auth-cleared", clearForSignedOut);

function updateClock() {
  byId("clock").textContent = new Date().toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

updateClock();
render();
setInterval(() => {
  updateClock();
  render();
}, 1000);