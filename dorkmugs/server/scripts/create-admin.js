const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const readline = require('readline');

const prisma = new PrismaClient();

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function promptHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run this command in an interactive terminal to enter the password securely.');
  }

  return new Promise((resolve) => {
    const interface = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    process.stdout.write(prompt);
    interface._writeToOutput = () => {};
    interface.question('', (answer) => {
      process.stdout.write('\n');
      interface.close();
      resolve(answer);
    });
  });
}

async function main() {
  const email = argument('email', 'admin@gostick.gg').toLowerCase().trim();
  const name = argument('name', 'GoStick Admin').trim();
  const password = process.env.ADMIN_PASSWORD || await promptHidden('New admin password: ');
  const confirmation = process.env.ADMIN_PASSWORD || await promptHidden('Confirm admin password: ');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid --email value is required.');
  }
  if (!name) throw new Error('A non-empty --name value is required.');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('Password must be at least 12 characters with upper/lowercase and a number.');
  }

  const hash = await bcrypt.hash(password, 12);
  const admin = await prisma.user.upsert({
    where: { email },
    update: { name, password: hash, role: 'ADMIN' },
    create: { email, name, password: hash, role: 'ADMIN' },
    select: { id: true, email: true, name: true, role: true },
  });

  let legacyRemoved = 0;
  if (email !== 'admin@dorkmugs.com') {
    const result = await prisma.user.deleteMany({ where: { email: 'admin@dorkmugs.com' } });
    legacyRemoved = result.count;
  }

  console.log(JSON.stringify({ admin, legacyRemoved }));
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());