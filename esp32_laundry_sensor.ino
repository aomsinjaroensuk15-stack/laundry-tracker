/*
  Laundry Tracker - ESP32 Sensor Node
  ------------------------------------
  อ่านค่ากระแสไฟฟ้าจาก ACS712 เพื่อตรวจจับว่าเครื่องซักผ้ากำลังทำงานอยู่หรือไม่
  แล้วส่งสถานะขึ้น server ทุกๆ TELEMETRY_INTERVAL_MS ผ่าน HTTP POST

  ก่อนใช้งานจริง:
  1. แก้ WIFI_SSID / WIFI_PASSWORD
  2. แก้ SERVER_HOST ให้ตรงกับ server ที่ deploy ไว้ (ดู README ของ server/)
  3. เอา MACHINE_ID / DEVICE_TOKEN มาจากตอนลงทะเบียนเครื่องผ่าน App (ปุ่ม "+ ลงทะเบียนเครื่องใหม่")
  4. ปรับ CURRENT_THRESHOLD_A ให้เหมาะกับเครื่องซักผ้าจริง (ทดลองวัดค่าตอนเครื่องว่าง vs กำลังทำงาน
     แล้วดูจาก Serial Monitor ก่อนตั้งค่าจริง)
*/

#include <WiFi.h>
#include <HTTPClient.h>

// ---------- ตั้งค่า WiFi ----------
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// ---------- ตั้งค่า Server ----------
const char* SERVER_HOST   = "https://your-server.example.com"; // ห้ามมี "/" ปิดท้าย
const char* MACHINE_ID    = "REPLACE_WITH_MACHINE_ID";
const char* DEVICE_TOKEN  = "REPLACE_WITH_DEVICE_TOKEN";

// ---------- ตั้งค่าเซนเซอร์ ACS712 ----------
const int   ACS712_PIN            = 34;      // analog pin ที่ต่อขา OUT ของ ACS712
const float ACS712_SENSITIVITY_MV = 100.0;   // mV ต่อ 1A: ACS712-20A=100, ACS712-30A=66, ACS712-5A=185
const float ADC_VREF               = 3.3;
const int   ADC_RESOLUTION         = 4095;   // ESP32 = 12-bit ADC
const float CURRENT_THRESHOLD_A    = 0.5;    // เกินค่านี้ = เครื่องกำลังทำงาน (ต้องทดลองปรับเอง)

const unsigned long TELEMETRY_INTERVAL_MS = 5000; // ส่งข้อมูลทุก 5 วิ
const int SAMPLE_COUNT = 200; // จำนวน sample ต่อรอบเพื่อคำนวณ RMS

// ---------- ตัวแปรภายใน ----------
unsigned long lastSendTime = 0;

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected: " + WiFi.localIP().toString());
}

// คำนวณค่ากระแส RMS จากการสุ่มอ่านค่า analog หลายๆ ครั้ง
// (สัญญาณจาก ACS712 เป็น AC แกว่งรอบจุดกึ่งกลาง ADC จึงต้อง sample เร็วๆ แล้วคำนวณ RMS แทนอ่านค่าเดียว)
float readCurrentRMS() {
  long sumSquares = 0;
  int midpoint = ADC_RESOLUTION / 2; // จุดกึ่งกลางของสัญญาณ (ที่กระแส = 0)

  for (int i = 0; i < SAMPLE_COUNT; i++) {
    int raw = analogRead(ACS712_PIN);
    int centered = raw - midpoint;
    sumSquares += (long)centered * (long)centered;
    delayMicroseconds(150);
  }

  float meanSquare = (float)sumSquares / SAMPLE_COUNT;
  float rmsRaw = sqrt(meanSquare);

  float rmsVoltage = (rmsRaw / ADC_RESOLUTION) * ADC_VREF * 1000.0; // mV
  float currentA = rmsVoltage / ACS712_SENSITIVITY_MV;

  return currentA;
}

void sendTelemetry(float currentA, bool isRunning) {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  HTTPClient http;
  String url = String(SERVER_HOST) + "/api/machines/" + MACHINE_ID + "/telemetry";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);

  String payload = String("{\"current_a\":") + String(currentA, 3) +
                    ",\"is_running\":" + (isRunning ? "true" : "false") + "}";

  int httpCode = http.POST(payload);
  Serial.printf("[telemetry] current=%.3fA running=%d -> HTTP %d\n", currentA, isRunning, httpCode);
  http.end();
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  connectWiFi();
}

void loop() {
  unsigned long now = millis();
  if (now - lastSendTime >= TELEMETRY_INTERVAL_MS) {
    lastSendTime = now;
    float currentA = readCurrentRMS();
    bool running = currentA >= CURRENT_THRESHOLD_A;
    sendTelemetry(currentA, running);
  }
}


