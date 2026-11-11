const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { isIP } = require("node:net");
const { createHash, randomUUID } = require("node:crypto");

const host = process.env.TINYNEWBORN_MIGRATION_HOST || "127.0.0.1";
const port = Number(process.argv[2] || process.env.TINYNEWBORN_MIGRATION_PORT || 3005);
const databasePath = path.resolve(process.env.TINYNEWBORN_MIGRATION_DB_PATH || path.join(__dirname, "database.json"));
const types = new Set(["sleep", "feeding", "bottle", "diaper"]);
const EVENT_CATEGORY_CONFIG = {
  sleep: { kind: "period", start: "asleep", end: "awake", startLabel: "asleep", endLabel: "awake" }
};

if (!isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("Set TINYNEWBORN_MIGRATION_HOST to an IP address and TINYNEWBORN_MIGRATION_PORT to an integer between 0 and 65535.");
}

function loadDatabase() {
  const data = JSON.parse(fs.readFileSync(databasePath, "utf8"));
  if (!data.profile || !Array.isArray(data.logs)) throw new Error("Invalid database structure");
  return data;
}

function saveDatabase(data) {
  const temporary = databasePath + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(temporary, databasePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function nowParts() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  return {
    iso: now.toISOString(),
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`
  };
}

function makeId() {
  return `log-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function cleanNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function cleanMilkType(value, fallback = "formula") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "breast_milk" || normalized === "breastmilk") return "breast_milk";
  if (normalized === "formula") return "formula";
  return fallback;
}

function milkTypeLabel(milkType) {
  return milkType === "breast_milk" ? "Breast Milk" : "Formula";
}

function pairedConfig(type) {
  const config = EVENT_CATEGORY_CONFIG[type];
  return config?.kind === "period" ? config : null;
}

function logTime(log) {
  // One absolute event instant across browsers, native apps and server timezones.
  const instant = new Date(log.createdAt || log.timestamp || "").getTime();
  if (Number.isFinite(instant)) return instant;
  const [hour = "00", minute = "00"] = String(log.time || "00:00").split(":");
  const legacy = new Date(`${log.date || "1970-01-01"}T${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:00`).getTime();
  return Number.isFinite(legacy) ? legacy : 0;
}

function isActiveAt(logs, type, atTime, excludeId) {
  const config = pairedConfig(type);
  let active = false;
  logs
    .filter((log) => log.id !== excludeId && log.type === type && log.status && logTime(log) < atTime)
    .sort((a, b) => logTime(a) - logTime(b))
    .forEach((log) => {
      if (log.status === config.start) active = true;
      if (log.status === config.end) active = false;
    });
  return active;
}

function nextTimedStatus(logs, type, atTime, excludeId) {
  return logs
    .filter((log) => log.id !== excludeId && log.type === type && log.status && logTime(log) > atTime)
    .sort((a, b) => logTime(a) - logTime(b))[0] || null;
}

function validatePairedTransition(logs, candidate, excludeId, options = {}) {
  const config = pairedConfig(candidate.type);
  if (!config || !candidate.status) return "";

  const atTime = logTime(candidate);
  if (atTime > Date.now() + 30 * 1000) return "Time cannot be in the future.";

  if (logs.some((log) => log.id !== excludeId && log.type === candidate.type && log.status && logTime(log) === atTime)) {
    return "Another device already logged a transition at this time. Refresh and review the shared log.";
  }
  const activeBefore = isActiveAt(logs, candidate.type, atTime, excludeId);
  const isStart = candidate.status === config.start;
  const isEnd = candidate.status === config.end;

  if (isStart && activeBefore) return `Already ${config.startLabel}. Stop first to avoid overlapping time.`;
  if (isEnd && !activeBefore) return `Already ${config.endLabel}. Start first before stopping.`;

  const nextCandidate = nextTimedStatus(logs, candidate.type, atTime, excludeId);
  const next = options.ignoreFutureNext && nextCandidate && logTime(nextCandidate) > Date.now() + 30 * 1000
    ? null
    : nextCandidate;
  if (next && isStart && next.status === config.start) return `This would overlap with another ${config.startLabel} time.`;
  if (next && isEnd && next.status === config.end) return "This would create two stop events in a row.";
  return "";
}

function buildLog(input) {
  const stamp = nowParts();
  const inputCreatedAt = typeof input.createdAt === "string" ? new Date(input.createdAt)
    : input.date && input.time ? new Date(`${input.date}T${input.time}`) : null;
  const createdAt = inputCreatedAt && Number.isFinite(inputCreatedAt.getTime()) ? inputCreatedAt.toISOString() : stamp.iso;
  const base = {
    id: cleanText(input.id, makeId()),
    date: input.date || stamp.date,
    time: input.time || stamp.time,
    type: input.type,
    timestamp: createdAt,
    createdAt
  };

  if (input.type === "sleep") {
    return { ...base, status: input.status, notes: input.status === "asleep" ? "Baby fell asleep" : "Baby woke up" };
  }

  if (input.type === "feeding" && input.method === "breast") {
    return { ...base, method: "breast", side: input.side, notes: `Started on ${input.side} side` };
  }

  if (input.type === "bottle") {
    const milkType = cleanMilkType(input.milkType);
    const milkLabel = milkTypeLabel(milkType);
    return { ...base, ounces: cleanNumber(input.ounces, 0), milkType, notes: `${milkLabel} bottle feed` };
  }

  if (input.type === "diaper") {
    const isPoop = input.kind === "poop";
    const poopColorId = isPoop ? cleanText(input.poopColorId) : "";
    const consistency = isPoop ? cleanText(input.consistency) : "";
    return {
      ...base,
      pee: input.kind === "pee",
      poop: isPoop,
      ...(isPoop && poopColorId ? { poopColorId, poopColor: poopColorId } : {}),
      ...(isPoop && consistency ? { consistency, poopTexture: consistency } : {}),
      notes: cleanText(input.notes, isPoop ? "Poo diaper" : "Wee diaper")
    };
  }

  throw new Error("Unsupported log type");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(JSON.stringify(payload));
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value + "T");
}

function validationError(input, current) {
  if (input.date !== undefined && !validDate(input.date)) return "date must use YYYY-MM-DD.";
  if (input.time !== undefined && (typeof input.time !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(input.time))) return "time must use HH:mm or HH:mm:ss.";
  if (input.createdAt !== undefined && (typeof input.createdAt !== "string" ||
      !Number.isFinite(Date.parse(input.createdAt)))) return "createdAt must be a valid timestamp.";
  const type = current?.type || input.type;
  if (!types.has(type)) return "Use sleep, feeding, bottle, or diaper.";
  if (type === "sleep" && !["asleep", "awake"].includes(input.status ?? current?.status)) {
    return "Sleep status must be asleep or awake.";
  }
  if (type === "feeding" && ((input.method ?? current?.method) !== "breast" ||
      !["left", "right"].includes(input.side ?? current?.side))) return "Use breast feeding with side left or right.";
  if (type === "bottle") {
    const ounces = input.ounces ?? current?.ounces;
    if (!["number", "string"].includes(typeof ounces) || !Number.isFinite(Number(ounces)) || Number(ounces) <= 0) {
      return "Bottle ounces must be positive.";
    }
    if (input.milkType !== undefined && !cleanMilkType(input.milkType, "")) return "Use formula or breast_milk.";
  }
  if (type === "diaper" && (!current || input.kind !== undefined) && !["pee", "poop"].includes(input.kind)) {
    return "Diaper kind must be pee or poop.";
  }
  return "";
}

function editLog(current, input) {
  const next = { ...current };
  for (const field of ["date", "time", "notes", "status", "side"]) {
    if (typeof input[field] !== "string") continue;
    if (field === "status" && current.type !== "sleep") continue;
    if (field === "side" && current.type !== "feeding") continue;
    next[field] = input[field];
  }
  if (input.createdAt || next.date !== current.date || next.time !== current.time) {
    const stamp = new Date(input.createdAt || next.date + "T" + next.time).toISOString();
    next.createdAt = next.timestamp = stamp;
  }
  if (current.type === "bottle") {
    if (input.ounces != null) next.ounces = Number(input.ounces);
    if (input.milkType) {
      next.milkType = cleanMilkType(input.milkType);
      if (input.notes === undefined) next.notes = milkTypeLabel(next.milkType) + " bottle feed";
    }
  }
  if (current.type === "diaper") {
    if (input.kind) {
      next.pee = input.kind === "pee";
      next.poop = input.kind === "poop";
    }
    for (const [field, alias] of [["poopColorId", "poopColor"], ["consistency", "poopTexture"]]) {
      if (!next.poop) {
        delete next[field];
        delete next[alias];
      } else if (typeof input[field] === "string") {
        next[field] = next[alias] = input[field].trim();
      }
    }
  }
  return next;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const method = req.method;
    const item = url.pathname.match(/^\/api\/logs\/([^/]+)\/?$/);
    const collection = url.pathname === "/api/logs";
    const profile = url.pathname === "/api/profile";

    if (!item && !collection && !profile) return sendJson(res, 404, { error: "Route not found" });
    const allowed = item ? ["PUT", "DELETE"] : collection ? ["GET", "POST"] : ["GET", "PUT"];
    if (!allowed.includes(method)) {
      res.setHeader("Allow", allowed.join(", "));
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    let id;
    let input;
    try {
      if (item) id = decodeURIComponent(item[1]);
      if (method === "PUT" || method === "POST") {
        input = await readBody(req);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a JSON object");
      }
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }

    // Load and commit synchronously after reading the body so requests cannot interleave writes.
    const data = loadDatabase();
    if (profile) {
      if (method === "PUT") {
        if (!validDate(input.birthday)) return sendJson(res, 400, { error: "birthday must use YYYY-MM-DD." });
        data.profile.birthday = input.birthday;
        saveDatabase(data);
      }
      return sendJson(res, 200, { profile: data.profile });
    }

    const visible = data.logs.filter(log => types.has(log.type));
    if (method === "GET") {
      let logs = visible;
      if (url.searchParams.has("days")) {
        const days = Math.max(1, Math.min(14, Math.round(cleanNumber(url.searchParams.get("days"), 2))));
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - days + 1);
        const latestSleep = visible.filter(log => log.type === "sleep").sort((a, b) => logTime(b) - logTime(a))[0];
        logs = visible.filter(log => logTime(log) >= +start || (log === latestSleep && log.status === "asleep"));
      }
      const etag = '"' + createHash("sha256").update(JSON.stringify(logs)).digest("hex") + '"';
      res.setHeader("ETag", etag);
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { "Cache-Control": "no-cache" });
        return res.end();
      }
      return sendJson(res, 200, logs);
    }

    if (method === "POST") {
      const existing = data.logs.find(log => log.id === cleanText(input.id));
      if (existing) {
        if (existing.type === input.type && types.has(existing.type)) return sendJson(res, 200, { log: existing });
        return sendJson(res, 409, { error: "Log ID already exists" });
      }
      const error = validationError(input);
      if (error) return sendJson(res, 400, { error });
      const log = buildLog(input);
      const conflict = validatePairedTransition(visible, log, undefined, {
        ignoreFutureNext: !input.date && !input.time && !input.createdAt
      });
      if (conflict) return sendJson(res, 409, { error: conflict });
      data.logs.push(log);
      saveDatabase(data);
      return sendJson(res, 201, { log });
    }

    const index = data.logs.findIndex(log => log.id === id && types.has(log.type));
    if (index < 0) return sendJson(res, 404, { error: "Log not found" });
    if (method === "DELETE") {
      data.logs.splice(index, 1);
      saveDatabase(data);
      return sendJson(res, 200, { deletedId: id });
    }

    const current = data.logs[index];
    const error = validationError(input, current);
    if (error) return sendJson(res, 400, { error });
    const log = editLog(current, input);
    const conflict = validatePairedTransition(visible, log, id);
    if (conflict) return sendJson(res, 409, { error: conflict });
    data.logs[index] = log;
    saveDatabase(data);
    return sendJson(res, 200, { log });
  } catch (error) {
    console.error(error.message);
    sendJson(res, 500, { error: "Server could not complete the request" });
  }
});

loadDatabase();
server.listen(port, host, () => {
  const address = host.includes(":") ? "[" + host + "]" : host;
  console.log("TinyNewborn API listening at http://" + address + ":" + server.address().port);
});
