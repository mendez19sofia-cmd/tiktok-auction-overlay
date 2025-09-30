// --- Imports ---
import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { WebcastPushConnection } from "tiktok-live-connector";

const PORT = process.env.PORT || 3000;

// --- Config editable desde variables o defaults ---
const config = {
  auctionSeconds: Number(process.env.AUCTION_SECONDS || 20),
  extendPer10: Number(process.env.EXTEND_PER_10_COINS || 3),
  streamDelay: Number(process.env.STREAM_DELAY_SECONDS || 10),
  tiktokUser: process.env.TIKTOK_USER || "snakez16", // cámbialo al tuyo
};

// --- Estado de subasta ---
let state = {
  round: 1,
  running: false,
  endAt: null,
  bidders: new Map(),
};

// --- Express + HTTP + Socket.IO ---
const app = express();
app.use(express.json());
app.use(express.static("public")); // sirve archivos de /public

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

// --- Helpers ---
function resetRound() {
  if (state.running) state.round += 1;
  state.running = true;
  state.bidders.clear();
  state.endAt = Date.now() + config.auctionSeconds * 1000;
  tickLoop();
  broadcast();
}

function tickLoop() {
  const interval = setInterval(() => {
    if (!state.running) return clearInterval(interval);
    if (Date.now() >= state.endAt) {
      state.running = false;
      broadcast();
      clearInterval(interval);
    } else {
      broadcast();
    }
  }, 1000);
}

function broadcast() {
  io.emit("state", {
    round: state.round,
    running: state.running,
    endAt: state.endAt,
    bidders: Array.from(state.bidders.entries()).map(([user, coins]) => ({
      user,
      coins,
    })),
  });
}

// --- TikTok listener ---
if (config.tiktokUser) {
  const tiktokLive = new WebcastPushConnection(config.tiktokUser);
  tiktokLive.connect().then(() => {
    console.log(`✅ Conectado a TikTok Live: ${config.tiktokUser}`);
  });

  tiktokLive.on("gift", (data) => {
    const coins = data.giftDiamondCount;
    const user = data.uniqueId;
    const prev = state.bidders.get(user) || 0;
    state.bidders.set(user, prev + coins);

    // Extiende tiempo si aplica
    const extra =
      Math.floor(coins / 10) * config.extendPer10 * 1000;
    state.endAt += extra;

    broadcast();
  });
}

// --- Rutas HTTP ---
app.get("/", (req, res) => {
  res.send("TikTok Auction Overlay online | usa /overlay, /admin, /gift");
});

app.get("/admin", (req, res) => {
  res.sendFile(process.cwd() + "/public/admin.html");
});

app.get("/overlay", (req, res) => {
  res.sendFile(process.cwd() + "/public/overlay.html");
});

app.get("/gift", (req, res) => {
  res.sendFile(process.cwd() + "/public/gift.html");
});

// API config
app.get("/api/config", (req, res) => res.json(config));

app.post("/api/config", (req, res) => {
  if (req.body.auctionSeconds) config.auctionSeconds = req.body.auctionSeconds;
  if (req.body.extendPer10) config.extendPer10 = req.body.extendPer10;
  if (req.body.streamDelay) config.streamDelay = req.body.streamDelay;
  res.json({ ok: true, config });
});

// --- Socket.IO ---
io.on("connection", (socket) => {
  console.log("Cliente conectado");
  socket.emit("state", state);
});

// --- Start server ---
server.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on :${PORT}`);
  resetRound();
  connectTikTok();
});

