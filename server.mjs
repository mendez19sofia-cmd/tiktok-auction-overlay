import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { WebcastPushConnection } from "tiktok-live-connector";

const PORT = process.env.PORT || 3000;
const AUCTION_SECONDS = Number(process.env.AUCTION_SECONDS || 20);
const EXTEND_PER_10_COINS = Number(process.env.EXTEND_PER_10_COINS || 3);
const STREAM_DELAY_SECONDS = Number(process.env.STREAM_DELAY_SECONDS || 10);
const LIVE_USERNAME = process.env.TIKTOK_USER || "snakez16x";

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

app.use(express.static("public"));

let state = {
  round: 1,
  running: false,
  endsAt: null,
  bidders: new Map(),
};

function resetRound() {
  if (state.running) state.round += 1;
  state.running = true;
  state.bidders.clear();
  state.endsAt = Date.now() + AUCTION_SECONDS * 1000;
  tickLoop();
  broadcast();
}

function extendByCoins(coins) {
  const extra = Math.floor(coins / 10) * EXTEND_PER_10_COINS;
  if (extra > 0) state.endsAt += extra * 1000;
}

function snapshot() {
  const now = Date.now();
  const secondsLeft = Math.max(0, Math.ceil((state.endsAt - now) / 1000));
  const bidders = [...state.bidders.entries()]
    .map(([user, data]) => ({ user, ...data }))
    .sort((a, b) => b.coins - a.coins);

  return {
    round: state.round,
    running: state.running,
    secondsLeft,
    delaySeconds: STREAM_DELAY_SECONDS,
    bidders
  };
}

function broadcast() {
  io.emit("state", snapshot());
}

let ticking = false;
function tickLoop() {
  if (ticking) return;
  ticking = true;
  const loop = () => {
    if (!state.running) { ticking = false; return; }
    const now = Date.now();
    if (now >= state.endsAt) {
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

app.get("/gift", (req, res) => {
  const u = req.query.user || "demo_user";
  const c = Number(req.query.coins || 10);
  onGift({ username: u, coins: c });
  res.json({ ok: true });
});

app.get("/overlay", (req, res) => {
  res.sendFile(process.cwd() + "/public/overlay.html");
});

async function connectTikTok() {
  const tiktok = new WebcastPushConnection(LIVE_USERNAME, {
    enableExtendedGiftInfo: true
  });

  tiktok.on("streamEnd", () => {
    console.log("🔴 Live finalizado o conexión cerrada. Reintentando en 15s…");
    setTimeout(connectTikTok, 15000);
  });

  tiktok.on("disconnected", () => {
    console.log("⚠️ Desconectado. Reintento en 10s…");
    setTimeout(connectTikTok, 10000);
  });

  tiktok.on("gift", (data) => {
    try {
      const username = data?.uniqueId || data?.nickname || "viewer";
      let coins = 0;
      if (data?.giftType === 1) {
        if (!data?.repeatEnd) return;
        if (data?.gift && typeof data?.repeatCount === "number") {
          coins = (data.gift.diamondCost || 0) * data.repeatCount;
        } else if (typeof data?.diamondCount === "number") {
          coins = data.diamondCount;
        }
      } else {
        if (typeof data?.diamondCount === "number" && data.diamondCount > 0) {
          coins = data.diamondCount;
        } else if (data?.gift) {
          coins = data.gift.diamondCost || 0;
        }
      }
      if (coins > 0) onGift({ username, coins, raw: data });
    } catch (e) {
      console.error("Error parseando gift:", e);
    }
  });

  try {
    const room = await tiktok.connect();
    console.log(`✅ Conectado al Live de @${LIVE_USERNAME}`);
    console.log(`RoomId: ${room.roomIdStr} | Viewers: ${room.viewerCount}`);
  } catch (err) {
    console.error("❌ No se pudo conectar al Live:", err?.message || err);
    setTimeout(connectTikTok, 20000);
  }
}

server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  resetRound();
  connectTikTok();
});
