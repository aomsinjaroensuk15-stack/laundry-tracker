import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, initDb } from './db.js';
 
const __dirname = path.dirname(fileURLToPath(import.meta.url));
 
const PORT = process.env.PORT || 3000;
const DEFAULT_CYCLE_MINUTES = 40;
const OFFLINE_AFTER_MS = 60 * 1000; // ถือว่าเครื่อง offline ถ้าไม่ส่งข้อมูลมาเกิน 60 วิ
 
await initDb();
 
const app = express();
app.use(cors());
app.use(express.json());
 
// เสิร์ฟหน้า App (PWA) แบบ static ไปพร้อมกัน เพื่อความสะดวก — จะแยก deploy เองก็ได้
app.use(express.static(path.join(__dirname, '..', 'app')));
 
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
 
// แปลงข้อมูลเครื่อง (internal) ให้เป็นรูปแบบที่ปลอดภัยส่งออกให้ client (ไม่มี token หลุดออกไป)
function publicMachine(m, distanceKm) {
  const isOnline = Date.now() - (m.lastSeen || 0) < OFFLINE_AFTER_MS;
  const status = !isOnline ? 'offline' : m.isRunning ? 'running' : 'idle';
 
  let remainingMinutes = null;
  let progressPercent = null;
  if (status === 'running' && m.cycleStartedAt) {
    const elapsedMin = (Date.now() - m.cycleStartedAt) / 60000;
    remainingMinutes = Math.max(0, Math.round(m.cycleMinutes - elapsedMin));
    progressPercent = Math.min(100, Math.round((elapsedMin / m.cycleMinutes) * 100));
  }
 
  return {
    id: m.id,
    name: m.name,
    lat: m.lat,
    lon: m.lon,
    status,
    currentA: m.currentA ?? null,
    cycleMinutes: m.cycleMinutes,
    cycleStartedAt: m.cycleStartedAt ?? null, // ให้ client คำนวณ countdown ต่อเองแบบ real-time ได้
    remainingMinutes,
    progressPercent,
    lastSeen: m.lastSeen ?? null,
    ...(distanceKm !== undefined ? { distanceKm: Math.round(distanceKm * 100) / 100 } : {}),
  };
}
 
// ---------- ลงทะเบียนเครื่องซักผ้าใหม่ (ทำครั้งเดียวตอนติดตั้ง ESP32 แต่ละตัว) ----------
app.post('/api/machines/register', async (req, res) => {
  const { name, lat, lon, cycleMinutes } = req.body;
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return res.status(400).json({ error: 'ต้องระบุ lat และ lon เป็นตัวเลข' });
  }
 
  const machine = {
    id: nanoid(10),
    token: nanoid(32),
    name: name || 'เครื่องซักผ้า',
    lat,
    lon,
    cycleMinutes: cycleMinutes || DEFAULT_CYCLE_MINUTES,
    isRunning: false,
    currentA: null,
    cycleStartedAt: null,
    lastSeen: null,
    createdAt: Date.now(),
  };
 
  db.data.machines.push(machine);
  await db.write();
 
  // ส่งคืน token แค่ตอนลงทะเบียนครั้งเดียวเท่านั้น (เก็บไว้ใส่ในโค้ด ESP32)
  res.json({ id: machine.id, token: machine.token, name: machine.name });
});
 
// ---------- หาเครื่องซักผ้าใกล้พิกัดที่ให้มา ----------
app.get('/api/machines/nearby', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radiusKm = parseFloat(req.query.radius_km) || 5;
 
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.status(400).json({ error: 'ต้องระบุ lat และ lon' });
  }
 
  const results = db.data.machines
    .map((m) => ({ m, d: haversineKm(lat, lon, m.lat, m.lon) }))
    .filter(({ d }) => d <= radiusKm)
    .sort((a, b) => a.d - b.d)
    .map(({ m, d }) => publicMachine(m, d));
 
  res.json(results);
});
 
// ---------- ดูรายละเอียดเครื่องเดียว ----------
app.get('/api/machines/:id', (req, res) => {
  const machine = db.data.machines.find((m) => m.id === req.params.id);
  if (!machine) return res.status(404).json({ error: 'ไม่พบเครื่อง' });
  res.json(publicMachine(machine));
});
 
// ---------- เปลี่ยนชื่อ / ปรับเวลารอบซัก ----------
app.patch('/api/machines/:id', async (req, res) => {
  const machine = db.data.machines.find((m) => m.id === req.params.id);
  if (!machine) return res.status(404).json({ error: 'ไม่พบเครื่อง' });
 
  const { name, cycleMinutes } = req.body;
  if (typeof name === 'string' && name.trim()) machine.name = name.trim();
  if (typeof cycleMinutes === 'number' && cycleMinutes > 0) machine.cycleMinutes = cycleMinutes;
 
  await db.write();
  broadcast({ type: 'machine_update', machine: publicMachine(machine) });
  res.json(publicMachine(machine));
});
 
// ---------- ESP32 ส่งค่ากระแสไฟฟ้าเข้ามาตรงนี้ ----------
app.post('/api/machines/:id/telemetry', async (req, res) => {
  const machine = db.data.machines.find((m) => m.id === req.params.id);
  if (!machine) return res.status(404).json({ error: 'ไม่พบเครื่อง' });
 
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (token !== machine.token) {
    return res.status(401).json({ error: 'token ไม่ถูกต้อง' });
  }
 
  const { current_a, is_running } = req.body;
  machine.currentA = typeof current_a === 'number' ? current_a : machine.currentA;
  machine.lastSeen = Date.now();
 
  const wasRunning = machine.isRunning;
  machine.isRunning = !!is_running;
 
  if (!wasRunning && machine.isRunning) {
    machine.cycleStartedAt = Date.now(); // เพิ่งเริ่มรอบใหม่
  }
  if (!machine.isRunning) {
    machine.cycleStartedAt = null;
  }
 
  await db.write();
  broadcast({ type: 'machine_update', machine: publicMachine(machine) });
  res.json({ ok: true });
});
 
// ---------- WebSocket: ส่งอัปเดตแบบ real-time ให้ App ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
 
function broadcast(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(data);
  });
}
 
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', machines: db.data.machines.map((m) => publicMachine(m)) }));
});
 
server.listen(PORT, () => {
  console.log(`Laundry Tracker server running on port ${PORT}`);
});
