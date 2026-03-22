const startServer = async () => {
  // 1. Kiểm tra kết nối DB
  try {
    await db.query('SELECT NOW()');
    console.log('✅ Database connection OK');
  } catch (err) {
    console.error('❌ Cannot connect to database:', err.message);
    process.exit(1);
  }

  // 2. Tạo bảng
  try {
    await runMigrations();
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }

  // 3. Tạo admin
  await createDefaultAdmin();

  // 4. Seed data mẫu
  await seedData();  // ← đã có ở đây rồi!

  // 5. Start server
  app.listen(PORT, () => {
    console.log(`\n🚀 Mod Zone API running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/api/v1/auth/health\n`);
  });
};
