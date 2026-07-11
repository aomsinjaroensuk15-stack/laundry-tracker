import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
 
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
const dbFile = path.join(dataDir, 'db.json');
 
// lowdb ต้องการให้โฟลเดอร์ปลายทางมีอยู่ก่อนถึงจะเขียนไฟล์ได้
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
 
const defaultData = { machines: [] };
const adapter = new JSONFile(dbFile);
export const db = new Low(adapter, defaultData);
 
export async function initDb() {
  await db.read();
  db.data ||= defaultData;
  await db.write();
  }
