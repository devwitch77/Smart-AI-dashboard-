import dotenv from "dotenv";
dotenv.config();

import { generateToken, verifyToken, checkRole, hashPassword, comparePassword } from "./auth.js";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import pkg from "pg";
const { Pool } = pkg;

import aiRouter from "./aiRoutes.js";
import reportRoutes from "./reportRoutes.js";

const useDbUrl = !!process.env.DATABASE_URL;
const pool = new Pool(
  useDbUrl
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      }
    : {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASS,
        port: process.env.DB_PORT,
        ssl: { rejectUnauthorized: false },
      }
);

(async () => {
  try {
    const ping = await pool.query("SELECT NOW()");
    console.log("✅ DB connected:", ping.rows?.[0]?.now);
  } catch (e) {
    console.error("❌ DB connection error:", e);
  }
})();

const ensureUsers = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL
    )
  `);

  const defaults = [
    { email: "admin@facility.com",    password: "admin123",    role: "admin" },
    { email: "operator@facility.com", password: "operator123", role: "operator" },
    { email: "viewer@facility.com",   password: "viewer123",   role: "viewer" },
  ];

  for (const u of defaults) {
    const existing = await pool.query("SELECT 1 FROM users WHERE email=$1", [u.email]);
    if (existing.rows.length === 0) {
      const hashed = await hashPassword(u.password);
      await pool.query(
        "INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3)",
        [u.email, hashed, u.role]
      );
      console.log(`✅ Seeded user: ${u.email} (${u.role})`);
    }
  }
};
ensureUsers().catch(console.error);

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim());

app.use(
  cors({
    origin: (origin, cb) =>
      !origin || allowedOrigins.includes(origin)
        ? cb(null, true)
        : cb(new Error(`Not allowed by CORS: ${origin}`)),
    credentials: true,
  })
);
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/healthz", async (_req, res) => {
  try {
    const dbNow = await pool.query("SELECT NOW() as now");
    let ai = null;
    try {
      const { default: fetch } = await import("node-fetch");
      const base = (process.env.PY_AI_URL || "").replace(/\/+$/, "");
      const r = base ? await fetch(`${base}/ping`) : null;
      ai = r ? (r.ok ? await r.json() : { ok: false, status: r.status }) : { ok: false, missing: true };
    } catch {
      ai = { ok: false };
    }
    res.json({
      ok: true,
      db: { ok: true, now: dbNow.rows[0].now },
      ai,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.use("/api/ai", aiRouter);
app.use("/api/reports", reportRoutes);

app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const THRESHOLDS = {
  "Temperature Sensor 1": { min: 18, max: 28 },
  "Humidity Sensor 1": { min: 30, max: 60 },
  "CO2 Sensor 1": { min: 0, max: 800 },
  "Light Sensor 1": { min: 100, max: 700 },
};
const SENSOR_NAMES = Object.keys(THRESHOLDS);

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sensors (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      value NUMERIC NOT NULL,
      unit TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sensor_data (
      id SERIAL PRIMARY KEY,
      sensor_name TEXT NOT NULL,
      value NUMERIC NOT NULL,
      unit TEXT,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_sensor_data_name_time ON sensor_data (sensor_name, recorded_at DESC);`
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      sensor_name TEXT NOT NULL,
      value NUMERIC NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('low','high')),
      triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_alerts_time ON alerts (triggered_at DESC);`
  );
}

async function seedSensorsIfEmpty() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM sensors;`);
  if (rows[0].c > 0) return;

  const seeds = [
    { name: "Temperature Sensor 1", value: 22, unit: "°C" },
    { name: "Humidity Sensor 1", value: 45, unit: "%" },
    { name: "CO2 Sensor 1", value: 400, unit: "ppm" },
    { name: "Light Sensor 1", value: 500, unit: "lux" },
  ];

  for (const s of seeds) {
    await pool.query(
      `INSERT INTO sensors (name, value, unit, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value, unit=EXCLUDED.unit, updated_at=NOW();`,
      [s.name, s.value, s.unit]
    );
    await pool.query(
      `INSERT INTO sensor_data (sensor_name, value, unit, recorded_at)
       VALUES ($1,$2,$3,NOW());`,
      [s.name, s.value, s.unit]
    );
  }
  console.log("🌱 Seeded sensors table");
}

function toNumber(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}
function withinAlertRange(name, value) {
  const thr = THRESHOLDS[name];
  if (!thr) return null;
  if (value > thr.max) return "high";
  if (value < thr.min) return "low";
  return null;
}
async function getLatestSensors() {
  const { rows } = await pool.query(
    `SELECT id, name, value, unit, updated_at FROM sensors ORDER BY name ASC;`
  );
  return rows;
}

app.get("/api/sensors", async (_req, res) => {
  try {
    res.json(await getLatestSensors());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/alerts", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, sensor_name, value, status, triggered_at
       FROM alerts ORDER BY triggered_at DESC LIMIT 200;`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/readings", async (req, res) => {
  const hours = Math.max(1, Math.min(720, Number(req.query.hours) || 24));
  const sensor = req.query.sensor || null;
  try {
    let q = `
      SELECT sensor_name, value, unit, recorded_at
      FROM sensor_data
      WHERE recorded_at >= NOW() - INTERVAL '${hours} hours'
    `;
    const params = [];
    if (sensor) {
      q += ` AND sensor_name=$1`;
      params.push(sensor);
    }
    q += ` ORDER BY recorded_at ASC;`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

const ALERT_COOLDOWN_MS = 120000; // 2 minutes
const ALERT_MIN_DELTA = {
  temperature: 0.5,
  humidity: 2,
  co2: 50,
  light: 30,
};
function kindFromName(n) {
  n = (n || "").toLowerCase();
  if (n.includes("temp")) return "temperature";
  if (n.includes("humid")) return "humidity";
  if (n.includes("co2")) return "co2";
  if (n.includes("light")) return "light";
  return "other";
}

app.post("/api/reading", async (req, res) => {
  try {
    const { name, value, unit } = req.body;
    if (!name || value === undefined)
      return res.status(400).json({ error: "name and value required" });

    const val = toNumber(value);

    await pool.query(
      `INSERT INTO sensor_data (sensor_name, value, unit, recorded_at)
       VALUES ($1,$2,$3,NOW());`,
      [name, val, unit || null]
    );

    const up = await pool.query(
      `INSERT INTO sensors (name, value, unit, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value, unit=EXCLUDED.unit, updated_at=NOW()
       RETURNING *;`,
      [name, val, unit || null]
    );
    const latest = up.rows[0];

    io.emit("sensor-updated", latest);

    const status = withinAlertRange(name, val);
    if (status) {
      const { rows: lastRows } = await pool.query(
        `SELECT value, status, triggered_at
         FROM alerts
         WHERE sensor_name=$1
         ORDER BY triggered_at DESC
         LIMIT 1`,
        [name]
      );

      let shouldInsert = true;
      if (lastRows.length) {
        const last = lastRows[0];
        const lastTs = new Date(last.triggered_at).getTime();
        const now = Date.now();
        const sameStatus = last.status === status;
        const k = kindFromName(name);
        const minDelta = ALERT_MIN_DELTA[k] ?? 1;
        const smallDelta = Math.abs(Number(val) - Number(last.value)) < minDelta;
        const withinCooldown = now - lastTs < ALERT_COOLDOWN_MS;

        if (sameStatus && smallDelta && withinCooldown) {
          shouldInsert = false;
        }
      }

      if (shouldInsert) {
        await pool.query(
          `INSERT INTO alerts (sensor_name, value, status, triggered_at)
           VALUES ($1,$2,$3,NOW());`,
          [name, val, status]
        );
        io.emit("sensor-alert", {
          sensor: name,
          value: val,
          status,
          time: new Date(),
        });
      }
    }

    res.status(201).json(latest);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });
  try {
    const userRes = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });
    const valid = await comparePassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });
    const token = generateToken(user);
    res.json({ token, role: user.role, email: user.email });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete(
  "/api/alerts/clear",
  verifyToken,
  checkRole(["admin"]),
  async (_req, res) => {
    try {
      await pool.query("DELETE FROM alerts");
      io.emit("alerts-cleared");
      res.json({ message: "✅ All alerts cleared." });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

io.on("connection", async (socket) => {
  console.log("🔌 client connected:", socket.id);
  try {
    const sensors = await getLatestSensors();
    socket.emit("all-sensors", sensors);

    const { rows: alerts } = await pool.query(
      `SELECT sensor_name, value, status, triggered_at
       FROM alerts ORDER BY triggered_at DESC LIMIT 50;`
    );
    socket.emit(
      "all-alerts",
      alerts.map((a) => ({
        sensor: a.sensor_name,
        value: Number(a.value),
        status: a.status,
        time: new Date(a.triggered_at),
      }))
    );
  } catch (e) {
    console.error("socket init error:", e);
  }
  socket.on("disconnect", () =>
    console.log("🔌 client disconnected:", socket.id)
  );
});

function unitFor(name) {
  return name.includes("Temperature")
    ? "°C"
    : name.includes("Humidity")
    ? "%"
    : name.includes("CO2")
    ? "ppm"
    : name.includes("Light")
    ? "lux"
    : null;
}

function nextValue(name, last, thr) {
  const baseDrift =
    name.includes("Temperature") ? 1.2 :
    name.includes("Humidity")    ? 4   :
    name.includes("CO2")         ? 60  :
    name.includes("Light")       ? 80  : 1;

  const pSpike =
    name.includes("Temperature") ? 0.35 :
    name.includes("Humidity")    ? 0.25 :
    name.includes("CO2")         ? 0.25 :
    name.includes("Light")       ? 0.25 : 0.1;

  let candidate = last + (Math.random() * 2 - 1) * baseDrift;

  if (Math.random() < pSpike) {
    const towardsHigh = Math.random() < 0.5;
    candidate = towardsHigh
      ? thr.max + (Math.random() * baseDrift + baseDrift)
      : thr.min - (Math.random() * baseDrift + baseDrift);
  }

  const clampMin = thr.min - baseDrift * 6;
  const clampMax = thr.max + baseDrift * 6;
  candidate = Math.max(clampMin, Math.min(clampMax, candidate));
  return Number(candidate.toFixed(2));
}

async function simulateOnce() {
  for (const name of SENSOR_NAMES) {
    const thr = THRESHOLDS[name];

    let latest = (thr.min + thr.max) / 2;
    try {
      const { rows } = await pool.query(
        `SELECT value FROM sensors WHERE name=$1;`,
        [name]
      );
      if (rows.length) latest = Number(rows[0].value);
    } catch {}

    const candidate = nextValue(name, latest, thr);
    const unit = unitFor(name);

    try {
      await pool.query(
        `INSERT INTO sensor_data (sensor_name, value, unit, recorded_at)
         VALUES ($1,$2,$3,NOW());`,
        [name, candidate, unit]
      );
      const up = await pool.query(
        `INSERT INTO sensors (name, value, unit, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value, unit=EXCLUDED.unit, updated_at=NOW()
         RETURNING *;`,
        [name, candidate, unit]
      );
      const row = up.rows[0];
      io.emit("sensor-updated", row);

      const status = withinAlertRange(name, candidate);
      if (status) {
        const { rows: lastRows } = await pool.query(
          `SELECT value, status, triggered_at
           FROM alerts
           WHERE sensor_name=$1
           ORDER BY triggered_at DESC
           LIMIT 1`,
          [name]
        );
        let shouldInsert = true;
        if (lastRows.length) {
          const last = lastRows[0];
          const lastTs = new Date(last.triggered_at).getTime();
          const now = Date.now();
          const sameStatus = last.status === status;
          const k = kindFromName(name);
          const minDelta = ALERT_MIN_DELTA[k] ?? 1;
          const smallDelta = Math.abs(Number(candidate) - Number(last.value)) < minDelta;
          const withinCooldown = now - lastTs < ALERT_COOLDOWN_MS;
          if (sameStatus && smallDelta && withinCooldown) shouldInsert = false;
        }
        if (shouldInsert) {
          await pool.query(
            `INSERT INTO alerts (sensor_name, value, status, triggered_at)
             VALUES ($1,$2,$3,NOW());`,
            [name, candidate, status]
          );
          io.emit("sensor-alert", {
            sensor: name,
            value: candidate,
            status,
            time: new Date(),
          });
        }
      }
    } catch (e) {
      console.error("simulation error:", e);
    }
  }
}

async function boot() {
  await ensureSchema();
  await seedSensorsIfEmpty();

  const enableSim = process.env.ENABLE_SIM === "1";
  const tickMs = Number(process.env.SIM_INTERVAL_MS || 5000);

  if (enableSim) {
    console.log(`🧪 Simulator enabled (interval ${tickMs}ms)`);
    await simulateOnce();
    setInterval(simulateOnce, tickMs);
  } else {
    console.log("🧪 Simulator disabled");
  }
}
boot().catch((e) => console.error("❌ Boot error:", e));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

process.on("SIGTERM", async () => {
  console.log("⛔ Shutting down...");
  try { await pool.end(); } catch {}
  server.close(() => process.exit(0));
});
