// prisma/seed.js — creates initial admin user
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: '../.env' });

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@gostick.gg';
  const password = process.env.SEED_ADMIN_PASSWORD || '';
  const name = process.env.SEED_ADMIN_NAME || 'GoStick Admin';

  if (password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be explicitly set to at least 12 characters.');
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  const hash = await bcrypt.hash(password, 12);
  await prisma.user.upsert({
    where: { email },
    update: { password: hash, name, role: 'ADMIN' },
    create: { email, password: hash, name, role: 'ADMIN' },
  });

  console.log(`Admin user created or updated: ${email}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
