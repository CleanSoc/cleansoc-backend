import { get, closePool } from './src/db/index.js';
const r = await get("SELECT SUM(CASE WHEN media_types LIKE '%photo%' THEN 1 ELSE 0 END) AS mediaPhotos FROM posts");
console.log(JSON.stringify(r));
const r2 = await get("SELECT SUM(CASE WHEN media_types ILIKE '%photo%' THEN 1 ELSE 0 END) AS mediaPhotos FROM posts");
console.log('ILIKE:', JSON.stringify(r2));
await closePool();
