// Load local settings before application imports; deployment variables win.
const { loadEnvFile } = require('node:process');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
for (const file of [resolve(process.cwd(), '.env'), resolve(__dirname, '../.env')]) {
  if (existsSync(file)) loadEnvFile(file);
}
