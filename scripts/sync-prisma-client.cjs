(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");

  const sourceDir = path.resolve(__dirname, "../../../node_modules/.prisma/client");
  const targetDir = path.resolve(__dirname, "../node_modules/.prisma/client");

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Prisma source client not found: ${sourceDir}`);
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });

  console.log(`Synced Prisma client: ${sourceDir} -> ${targetDir}`);
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
