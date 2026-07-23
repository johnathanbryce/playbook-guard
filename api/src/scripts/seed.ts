// CLI entry: `npm run db:seed`. Loads the playbook into Postgres, then exits.
import { seed } from "../services/seed";
import { pool } from "../db/client";

seed()
  .then(({ version, ruleCount }) => {
    console.log(`seeded playbook v${version} (${ruleCount} rules)`);
  })
  .catch((err) => {
    console.error("seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
