import express from "express";
import http from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PORT = Number(process.env.PORT || 3000);

const redisOpts = { maxRetriesPerRequest: null, enableReadyCheck: true };
const redis = new Redis(REDIS_URL, redisOpts);
const pubClient = new Redis(REDIS_URL, redisOpts);
const subClient = pubClient.duplicate();

for (const [name, client] of [["redis", redis], ["pub", pubClient], ["sub", subClient]]) {
  client.on("error", (err) => console.error(`[${name}] redis error:`, err.message));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
io.adapter(createAdapter(pubClient, subClient));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const rid = (n = 4) =>
  Array.from({ length: n }, () =>
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]
  ).join("");

const tok = () => crypto.randomBytes(16).toString("hex");

const defaultSettings = () => ({
  showByPerson: true,
  dropExtremes: false,
  format: "number",
});

const keys = {
  meta: (r) => `room:${r}:meta`,
  members: (r) => `room:${r}:members`,
  round: (r) => `room:${r}:round`,
  state: (r) => `room:${r}:state`,
};

async function loadRoom(roomId) {
  const meta = await redis.hgetall(keys.meta(roomId));
  if (!meta || !meta.hostToken) return null;
  const members = await redis.hgetall(keys.members(roomId));
  const round = await redis.hgetall(keys.round(roomId));
  const state = (await redis.get(keys.state(roomId))) || "collecting";
  const settings = meta.settings ? JSON.parse(meta.settings) : defaultSettings();
  return { meta, members, round, state, settings };
}

function summarize(round, settings) {
  const nums = Object.values(round)
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (nums.length === 0) return { count: 0, average: null, used: [], dropped: [] };
  let used = nums;
  let dropped = [];
  if (settings.dropExtremes && nums.length >= 3) {
    dropped = [nums[0], nums[nums.length - 1]];
    used = nums.slice(1, -1);
  }
  const sum = used.reduce((a, b) => a + b, 0);
  return {
    count: nums.length,
    average: used.length ? sum / used.length : null,
    used,
    dropped,
  };
}

async function publicState(roomId) {
  const r = await loadRoom(roomId);
  if (!r) return null;
  const memberIds = Object.keys(r.members);
  const submitted = {};
  for (const id of memberIds) submitted[id] = r.round[id] !== undefined;
  const revealed = r.state === "revealed";
  const out = {
    roomId,
    state: r.state,
    settings: r.settings,
    members: memberIds.map((id) => ({
      id,
      name: r.members[id],
      submitted: submitted[id],
      isHost: id === r.meta.hostId,
    })),
  };
  if (revealed) {
    const guesses = {};
    for (const id of memberIds) {
      if (r.round[id] !== undefined) guesses[id] = Number(r.round[id]);
    }
    out.guesses = guesses;
    out.summary = summarize(r.round, r.settings);
  }
  return out;
}

async function broadcast(roomId) {
  const s = await publicState(roomId);
  if (s) io.to(roomId).emit("state", s);
}

app.post("/api/rooms", async (req, res) => {
  const name = (req.body?.name || "Host").toString().slice(0, 40);
  let roomId;
  for (let i = 0; i < 5; i++) {
    roomId = rid();
    const exists = await redis.exists(keys.meta(roomId));
    if (!exists) break;
  }
  const hostId = crypto.randomUUID();
  const hostToken = tok();
  await redis.hset(keys.meta(roomId), {
    hostId,
    hostToken,
    settings: JSON.stringify(defaultSettings()),
    createdAt: Date.now().toString(),
  });
  await redis.hset(keys.members(roomId), hostId, name);
  await redis.set(keys.state(roomId), "collecting");
  // expire whole room after 24h of inactivity (refreshed on activity)
  const ttl = 60 * 60 * 24;
  await Promise.all([
    redis.expire(keys.meta(roomId), ttl),
    redis.expire(keys.members(roomId), ttl),
    redis.expire(keys.state(roomId), ttl),
  ]);
  res.json({ roomId, hostId, hostToken });
});

io.on("connection", (socket) => {
  let joined = null; // { roomId, memberId, isHost }

  socket.on("join", async ({ roomId, name, memberId, hostToken }, ack) => {
    roomId = (roomId || "").toUpperCase().trim();
    const r = await loadRoom(roomId);
    if (!r) return ack?.({ error: "room not found" });

    let id = memberId;
    let isHost = false;

    if (hostToken && hostToken === r.meta.hostToken) {
      id = r.meta.hostId;
      isHost = true;
    } else if (id && r.members[id]) {
      // returning member
    } else {
      id = crypto.randomUUID();
    }

    const displayName = (name || r.members[id] || "Anon").toString().slice(0, 40);
    await redis.hset(keys.members(roomId), id, displayName);

    joined = { roomId, memberId: id, isHost };
    socket.join(roomId);
    ack?.({ memberId: id, isHost });
    broadcast(roomId);
  });

  socket.on("submit", async ({ value }, ack) => {
    if (!joined) return ack?.({ error: "not joined" });
    const r = await loadRoom(joined.roomId);
    if (!r) return ack?.({ error: "room not found" });
    if (r.state !== "collecting") return ack?.({ error: "round is revealed" });
    const n = Number(value);
    if (!Number.isFinite(n)) return ack?.({ error: "invalid number" });
    await redis.hset(keys.round(joined.roomId), joined.memberId, String(n));
    ack?.({ ok: true });
    broadcast(joined.roomId);
  });

  socket.on("unsubmit", async (_, ack) => {
    if (!joined) return ack?.({ error: "not joined" });
    const r = await loadRoom(joined.roomId);
    if (!r) return ack?.({ error: "room not found" });
    if (r.state !== "collecting") return ack?.({ error: "round is revealed" });
    await redis.hdel(keys.round(joined.roomId), joined.memberId);
    ack?.({ ok: true });
    broadcast(joined.roomId);
  });

  socket.on("reveal", async (_, ack) => {
    if (!joined?.isHost) return ack?.({ error: "host only" });
    await redis.set(keys.state(joined.roomId), "revealed");
    ack?.({ ok: true });
    broadcast(joined.roomId);
  });

  socket.on("next", async (_, ack) => {
    if (!joined?.isHost) return ack?.({ error: "host only" });
    await redis.del(keys.round(joined.roomId));
    await redis.set(keys.state(joined.roomId), "collecting");
    ack?.({ ok: true });
    broadcast(joined.roomId);
  });

  socket.on("settings", async ({ settings }, ack) => {
    if (!joined?.isHost) return ack?.({ error: "host only" });
    const r = await loadRoom(joined.roomId);
    if (!r) return ack?.({ error: "room not found" });
    const allowedFormats = ["number", "dollars", "euros", "pounds", "percent"];
    const clean = {};
    if (typeof settings?.showByPerson === "boolean") clean.showByPerson = settings.showByPerson;
    if (typeof settings?.dropExtremes === "boolean") clean.dropExtremes = settings.dropExtremes;
    if (allowedFormats.includes(settings?.format)) clean.format = settings.format;
    const merged = { ...r.settings, ...clean };
    await redis.hset(keys.meta(joined.roomId), "settings", JSON.stringify(merged));
    ack?.({ ok: true });
    broadcast(joined.roomId);
  });

  socket.on("disconnect", () => {
    // keep membership so refreshes work; rooms expire via TTL
  });
});

server.listen(PORT, () => {
  console.log(`guess-room listening on :${PORT}, redis=${REDIS_URL}`);
});
