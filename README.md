# 🧺 Laundry Tracker — ระบบติดตามเครื่องซักผ้าใกล้คุณ

ระบบ IoT สำหรับดูว่าเครื่องซักผ้าเครื่องไหนใกล้คุณ ว่างอยู่ไหม และเหลือเวลาอีกกี่นาทีถึงจะเสร็จ — ผ่าน ESP32 + เซนเซอร์วัดกระแสไฟฟ้า

## สถาปัตยกรรมระบบ

```
┌─────────────┐  HTTP POST (ทุก ~5 วิ)   ┌─────────────┐  WebSocket (real-time)   ┌─────────────┐
│   ESP32     │ ───────────────────────▶ │   Server    │ ───────────────────────▶ │  App (PWA)  │
│  + ACS712   │                           │ Express+WS  │ ◀─────────────────────── │  index.html │
└─────────────┘                           └─────────────┘   REST (scan/register)   └─────────────┘
                                                 │
                                           data/db.json
                                         (lowdb, ไฟล์ JSON)
```

- **ESP32 → Server**: ใช้ HTTP POST ธรรมดา เพราะเสถียรและ implement ง่ายบนไมโครคอนโทรลเลอร์ที่ทรัพยากรจำกัด (ไม่ต้องจัดการ reconnect ของ persistent connection)
- **Server → App**: ใช้ WebSocket เพื่ออัปเดตสถานะแบบ real-time โดยไม่ต้อง refresh หรือ poll เอง
- **Database**: ใช้ lowdb (เก็บเป็นไฟล์ JSON) เพื่อไม่ต้องพึ่ง native dependency ที่ compile ยากบน Termux — ย้ายไป Postgres/MongoDB ทีหลังได้ถ้าระบบโตขึ้น

## โครงสร้างไฟล์

```
laundry-tracker/
├── firmware/esp32_laundry_sensor/esp32_laundry_sensor.ino   # โค้ด ESP32
├── server/                                                   # Backend REST + WebSocket
│   ├── server.js
│   ├── db.js
│   └── package.json
└── app/                                                      # PWA (single-file)
    ├── index.html
    ├── manifest.json
    └── sw.js
```

## เริ่มต้นใช้งาน

### 1. Server

```bash
cd server
npm install
npm start
```

รันแล้วจะเปิดที่ `http://localhost:3000` และเสิร์ฟหน้า App ให้ด้วย (ผ่าน `app/` แบบ static ในตัว)

**Deploy ขึ้น cloud ฟรี** (แนะนำ Render หรือ Railway):
- Push repo นี้ขึ้น GitHub
- เชื่อม Render/Railway เข้ากับ repo, ตั้ง root directory เป็น `server`
- Build command: `npm install`, Start command: `npm start`
- **สำคัญ**: ต้องได้ URL แบบ `https://...` เพราะ Geolocation API บนมือถือจะทำงานได้ก็ต่อเมื่อหน้าเว็บโหลดผ่าน HTTPS (หรือ localhost) เท่านั้น

### 2. App (PWA)

ถ้า deploy server แบบเสิร์ฟ static ไปด้วย (ตามด้านบน) ก็เข้าผ่าน URL เดียวกับ server ได้เลย ไม่ต้อง deploy แยก

เปิดแอปครั้งแรก → กดปุ่มเฟือง (⚙) มุมขวาบน → ใส่ Server URL ของตัวเอง → บันทึก

### 3. ESP32 Firmware

1. เปิด `firmware/esp32_laundry_sensor/esp32_laundry_sensor.ino` ด้วย Arduino IDE (หรือ PlatformIO) — ต้องลง board package "esp32" และ library ที่มากับ core อยู่แล้ว (WiFi.h, HTTPClient.h)
2. ในแอป กด **"+ ลงทะเบียนเครื่องใหม่"** → จะได้ `MACHINE_ID` กับ `DEVICE_TOKEN` มา (ระบบจะใช้พิกัด GPS ปัจจุบันของมือถือตอนนั้นเป็นตำแหน่งเครื่อง)
3. แก้ค่าคงที่ในไฟล์ .ino: `WIFI_SSID`, `WIFI_PASSWORD`, `SERVER_HOST`, `MACHINE_ID`, `DEVICE_TOKEN`
4. ต่อวงจร ACS712 → ESP32 (ขา OUT ไปขา analog เช่น GPIO34), วัดค่ากระแสจริงตอนเครื่องว่าง vs ทำงาน แล้วปรับ `CURRENT_THRESHOLD_A` ให้เหมาะสมกับเครื่องจริง
5. Upload โค้ดเข้าบอร์ด

## API Reference

| Method | Endpoint | คำอธิบาย |
|---|---|---|
| POST | `/api/machines/register` | ลงทะเบียนเครื่องใหม่ `{name, lat, lon, cycleMinutes}` → คืน `{id, token}` |
| GET | `/api/machines/nearby?lat=&lon=&radius_km=` | หาเครื่องใกล้พิกัดที่ระบุ |
| GET | `/api/machines/:id` | ดูรายละเอียดเครื่องเดียว |
| PATCH | `/api/machines/:id` | เปลี่ยนชื่อ / เวลาต่อรอบ `{name, cycleMinutes}` |
| POST | `/api/machines/:id/telemetry` | ESP32 ใช้ส่งค่ากระแส `{current_a, is_running}` (ต้องแนบ `Authorization: Bearer <token>`) |
| WS | `/ws` | รับอัปเดตสถานะเครื่องแบบ real-time |

## ข้อจำกัด / สิ่งที่ประมาณค่าไว้

- **เวลาที่เหลือเป็นการประมาณ** ไม่ใช่ค่าจริงจากเครื่องซักผ้า เพราะเซนเซอร์กระแสไฟรู้แค่ "กำลังทำงานอยู่ไหม" ไม่รู้ว่าอยู่ขั้นตอนไหนของรอบซัก ระบบจะจับเวลาตั้งแต่กระแสเริ่มเกิน threshold แล้วลบด้วยเวลาต่อรอบที่ตั้งไว้ (`cycleMinutes`) — ความแม่นยำขึ้นกับว่าตั้งค่านี้ใกล้เคียงเครื่องจริงแค่ไหน
- **ยังไม่มีระบบ user account** — ใครก็เรียก API ได้ถ้ารู้ server URL (การลงทะเบียน/เปลี่ยนชื่อยังไม่มี auth) เหมาะกับใช้ส่วนตัวหรือกลุ่มเล็กๆ ก่อน ถ้าจะเปิดสาธารณะควรเพิ่ม auth ให้ endpoint ที่ไม่ใช่ของ ESP32 ด้วย
- **"offline"** หมายถึง ESP32 ไม่ได้ส่งข้อมูลมาเกิน 60 วิ (เช่น หลุด WiFi หรือไฟดับ)

## แนวทางต่อยอด

- เพิ่ม authentication ฝั่ง user (ป้องกันคนอื่นมาลงทะเบียน/แก้ชื่อเครื่องเรา)
- เก็บ log รอบซักที่ผ่านมา เพื่อคำนวณ `cycleMinutes` อัตโนมัติจากค่าเฉลี่ยจริง แทนตั้งมือ
- แสดงบนแผนที่ (Leaflet/Google Maps) แทน/เสริมจากรายการ list
- แจ้งเตือน push (Web Push API) ตอนเครื่องใกล้เสร็จ

