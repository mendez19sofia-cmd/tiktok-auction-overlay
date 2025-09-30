import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { WebcastPushConnection } from "tiktok-live-connector";

const PORT = process.env.PORT || 3000;

// Config editable en runtime (también se inicializa desde Secrets de Fly)
const config = {
  auctionSeconds: Number(process.env.AUCTION_SECONDS || 20),
  extendPer10:   Number(process.env.EXTEND_PER_10_COINS || 3),
  streamDelay:   Number(process.env.STREAM_DELAY_SECONDS || 10),
  tiktokUser:    process.env.TIKTOK_USER || "snakez16x",
};

const app = express();
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

// ===== Estado de subasta
let state = {
  round: 1,
  running: false,
  endsAt: null,
  bidders: new Map(), // user -> { coins, lastGift }
};

function resetRound() {
  if (state.running) state.round += 1;
  state.running = true;
  state.bidders.clear();
  state.endsAt = Date.now() + config.auctionSeconds * 1000;
  tickLoop();
  broadcast();
}

function extendByCoins(coins) {
  const extra = Math.floor(coins / 10) * config.extendPer10;
  if (extra > 0) state.endsAt += extra * 1000;
}

function snapshot() {
  const now = Date.now();
  const secondsLeft = state.running ? Math.max(0, Math.ceil((state.endsAt - now) / 1000)) : 0;
  const bidders = [...state.bidders.entries()]
    .map(([user, data]) => ({ user, ...data }))
    .sort((a, b) => b.coins - a.coins);

  return {
    round: state.round,
    running: state.running,
    secondsLeft,
    delaySeconds: config.streamDelay,
    bidders,
    cfg: { auctionSeconds: config.auctionSeconds, extendPer10: config.extendPer10 }
  };
}

function broadcast() { io.emit("state", snapshot()); }

let ticking = false;
function tickLoop() {
  if (ticking) return; ticking = true;
  const loop = () => {
    if (!state.running) { ticking = false; return; }
    if (Date.now() >= state.endsAt) {
      state.running = false;
      const snap = snapshot();
      const winner = snap.bidders[0] || null;
      io.emit("round_end", { round: state.round, winner });
      setTimeout(resetRound, 3000);
      ticking = false;
      return;
    }
    broadcast();
    setTimeout(loop, 250);
  };
  loop();
}

function onGift({ username, coins, raw = null }) {
  if (!state.running) resetRound();
  const current = state.bidders.get(username) || { coins: 0, lastGift: null };
  current.coins += coins;
  current.lastGift = { coins, ts: Date.now(), raw };
  state.bidders.set(username, current);
  extendByCoins(coins);
  io.emit("gift", { user: username, coins });
  broadcast();
}

// ===== Rutas
app.get("/", (req, res) => {
  res.send("✅ TikTok Auction Overlay online | usa /overlay, /admin, /gift");
});

app.get("/overlay", (req, res) => {
  res.sendFile(process.cwd() + "/public/overlay.html");
});

app.get("/gift", (req, res) => {
  const u = req.query.user || "viewer";
  const c = Number(req.query.coins || 10);
  onGift({ username: u, coins: c });
  res.json({ ok: true });
});

// API de configuración runtime (la usa /admin)
app.get("/api/config", (req, res) => res.json(config));
app.post("/api/config", (req, res) => {
  const { auctionSeconds, extendPer10, streamDelay } = req.body || {};
  if (Number.isFinite(auctionSeconds) && auctionSeconds > 0) config.auctionSeconds = Math.floor(auctionSeconds);
  if (Number.isFinite(extendPer10)   && extendPer10   >= 0) config.extendPer10   = Math.floor(extendPer10);
  if (Number.isFinite(streamDelay)   && streamDelay   >= 0) config.streamDelay   = Math.floor(streamDelay);
  io.emit("config_updated", config);
  res.json({ ok: true, config });
});

// ===== Conexión a TikTok
async function connectTikTok() {
  const tiktok = new WebcastPushConnection(config.tiktokUser, { enableExtendedGiftInfo: true });

  tiktok.on("streamEnd", () => { console.log("🔴 Live finalizado. Reintentando en 15s…"); setTimeout(connectTikTok, 15000); });
  tiktok.on("disconnected", () => { console.log("⚠️ Desconectado. Reintento en 10s…"); setTimeout(connectTikTok, 10000); });

  tiktok.on("gift", (data) => {
    try {
      const username = data?.uniqueId || data?.nickname || "viewer";
      let coins = 0;
      if (data?.giftType === 1) {
        if (!data?.repeatEnd) return;
        if (data?.gift && typeof data?.repeatCount === "number") coins = (data.gift.diamondCost || 0) * data.repeatCount;
        else if (typeof data?.diamondCount === "number") coins = data.diamondCount;
      } else {
        if (typeof data?.diamondCount === "number" && data.diamondCount > 0) coins = data.diamondCount;
        else if (data?.gift) coins = data.gift.diamondCost || 0;
      }
      if (coins > 0) onGift({ username, coins, raw: data });
    } catch (e) { console.error("gift parse:", e); }
  });

  try {
    const room = await tiktok.connect();
    console.log(`✅ Conectado al Live de @${config.tiktokUser} | Room ${room.roomIdStr}`);
  } catch (err) {
    console.log("❌ No se pudo conectar al Live:", err?.message || err);
    setTimeout(connectTikTok, 20000);
  }
}

server.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
  resetRound();
  connectTikTok();
});
