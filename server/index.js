import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Pool } from "pg";
import { clerkMiddleware, getAuth } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
  idleTimeoutMillis: 30_000,
});

app.set("trust proxy", 1);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(express.json({ limit: "1mb" }));
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function validPeriod(value) {
  return value === "morning" || value === "afternoon";
}

function requireAuth(req, res, next) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Faça login para continuar." });
  req.authUserId = userId;
  next();
}

function numberInRange(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error("Dados numéricos inválidos.");
  }
  return number;
}

const allowedProducts = new Set([
  "Bloquinho 9×19×19",
  "Blocão 9×19×29",
  "Lajota",
  "Outro",
]);
const allowedStops = new Set([
  "Caixão alimentador",
  "Esteira 1",
  "Separador de pedra",
  "Esteira 2",
  "Laminador 1",
  "Esteira 3",
  "Misturador",
  "Esteira 4",
  "Laminador 2",
  "Esteira 5",
  "Maromba",
  "Boquilha",
  "Cortador",
  "Esteira de retorno",
  "Mesas",
  "Torre",
  "Centralizador torre",
  "Dispensa",
  "Puxador",
  "Transbordador 1",
  "Transbordador 2",
  "Empilhadeira",
  "Pá carregadeira",
  "Falha sistema elétrico",
]);

function normalizePayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Registro inválido.");
  }
  if (!allowedProducts.has(input.produto)) throw new Error("Produto inválido.");
  if (!Array.isArray(input.paletes) || input.paletes.length > 10_000) {
    throw new Error("Lista de paletes inválida.");
  }
  if (!Array.isArray(input.paradas) || input.paradas.length > 2_000) {
    throw new Error("Lista de paradas inválida.");
  }

  const paletes = input.paletes.map((item) => ({
    n: numberInRange(item?.n, { min: 1, max: 10_000_000 }),
    t: numberInRange(item?.t, { min: 0 }),
    interval:
      item?.interval == null
        ? null
        : numberInRange(item.interval, { min: 0 }),
  }));

  const normalizeStop = (item, active = false) => {
    if (!item || !allowedStops.has(item.local)) {
      throw new Error("Local da parada inválido.");
    }
    const stop = {
      start: numberInRange(item.start, { min: 0 }),
      local: item.local,
      comentario:
        typeof item.comentario === "string"
          ? item.comentario.slice(0, 2_000)
          : "",
    };
    if (!active) {
      stop.end = numberInRange(item.end, { min: stop.start });
      stop.dur = numberInRange(item.dur, { min: 0 });
    }
    return stop;
  };

  const inicio = numberInRange(input.inicio, { min: 0 });
  return {
    produto: input.produto,
    meta: Math.trunc(numberInRange(input.meta, { min: 1, max: 10_000_000 })),
    inicio,
    encerramento:
      input.encerramento == null
        ? null
        : numberInRange(input.encerramento, { min: inicio }),
    paletes,
    paradas: input.paradas.map((item) => normalizeStop(item)),
    ativa: input.ativa == null ? null : normalizeStop(input.ativa, true),
  };
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false, error: "Banco de dados indisponível." });
  }
});

app.get("/api/records", requireAuth, async (req, res) => {
  const date = req.query.date;
  if (!validDate(date)) {
    return res.status(400).json({ error: "Informe uma data válida." });
  }
  try {
    const result = await pool.query(
      `SELECT period, payload, updated_at::text AS "updatedAt"
       FROM production_periods
       WHERE owner_id = $1 AND production_date = $2::date`,
      [req.authUserId, date],
    );
    const periods = { morning: null, afternoon: null };
    for (const row of result.rows) {
      periods[row.period] = {
        payload: row.payload,
        updatedAt: row.updatedAt,
      };
    }
    res.json({ date, periods });
  } catch {
    res.status(500).json({ error: "Não foi possível consultar os registros." });
  }
});

app.put("/api/records/:date/:period", requireAuth, async (req, res) => {
  const { date, period } = req.params;
  if (!validDate(date) || !validPeriod(period)) {
    return res.status(400).json({ error: "Data ou período inválido." });
  }
  let payload;
  try {
    payload = normalizePayload(req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const expectedVersion = req.get("X-Record-Version");
    if (!expectedVersion) {
      return res.status(428).json({
        error: "Atualize o registro antes de salvar alterações.",
      });
    }
    const result = await pool.query(
      `UPDATE production_periods
       SET payload = $4::jsonb,
           updated_at = GREATEST(NOW(), updated_at + INTERVAL '1 microsecond')
       WHERE owner_id = $1
         AND production_date = $2::date
         AND period = $3
         AND updated_at = $5::timestamptz
       RETURNING updated_at::text AS "updatedAt"`,
      [
        req.authUserId,
        date,
        period,
        JSON.stringify(payload),
        expectedVersion,
      ],
    );
    if (result.rowCount !== 1) {
      return res.status(409).json({
        error:
          "Este período foi alterado em outro dispositivo. Reabra-o para carregar a versão atual.",
      });
    }
    res.json({ saved: true, updatedAt: result.rows[0].updatedAt });
  } catch {
    res.status(500).json({ error: "Não foi possível salvar o registro online." });
  }
});

app.post("/api/records/:date/:period", requireAuth, async (req, res) => {
  const { date, period } = req.params;
  if (!validDate(date) || !validPeriod(period)) {
    return res.status(400).json({ error: "Data ou período inválido." });
  }
  let payload;
  try {
    payload = normalizePayload(req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    const result = await pool.query(
      `INSERT INTO production_periods
         (owner_id, production_date, period, payload, updated_at)
       VALUES ($1, $2::date, $3, $4::jsonb, NOW())
       ON CONFLICT (owner_id, production_date, period) DO NOTHING
       RETURNING period, updated_at::text AS "updatedAt"`,
      [req.authUserId, date, period, JSON.stringify(payload)],
    );
    res.status(result.rowCount ? 201 : 200).json({
      created: result.rowCount === 1,
      updatedAt: result.rows[0]?.updatedAt ?? null,
    });
  } catch {
    res.status(500).json({ error: "Não foi possível importar o registro." });
  }
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Rota da API não encontrada." });
});

const httpServer = createHttpServer(app);
const port = Number(process.env.PORT || 5000);

if (process.env.NODE_ENV === "production") {
  const distDirectory = path.join(projectRoot, "dist");
  app.use(express.static(distDirectory, { index: false }));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDirectory, "index.html"));
  });
} else {
  const vite = await createViteServer({
    configFile: path.join(projectRoot, "vite.config.js"),
    server: { middlewareMode: true, ws: { server: httpServer } },
  });
  app.use(vite.middlewares);
}

try {
  await pool.query("SELECT 1");
  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`Production app listening on port ${port}`);
  });
} catch {
  console.error("Could not connect to the configured PostgreSQL database.");
  process.exit(1);
}