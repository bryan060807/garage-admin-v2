const fs = require("fs");
const path = require("path");
const { pool } = require("../src/db");

async function main() {
  if (!pool) {
    throw new Error("GARAGE_ADMIN_DATABASE_URL or DATABASE_URL is not configured");
  }

  const sql = fs.readFileSync(path.resolve(__dirname, "../../db/schema.sql"), "utf8");
  await pool.query(sql);
  await pool.end();
  console.log("Schema applied");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
