require('dotenv').config();
const bcrypt = require('bcryptjs');
const { prisma } = require('../src/config/db');
const { generateUsername } = require('../src/services/usernameService');

async function main() {
  const name = 'Test User';
  const email = 'test@example.com';
  const mpin = '123456';
  const country = 'US';

  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) {
    console.log('User already exists:', existing.id);
    return;
  }

  const hashedMpin = await bcrypt.hash(mpin, 12);
  const username = await generateUsername(name);

  const user = await prisma.user.create({
    data: {
      email,
      username,
      mpin: hashedMpin,
      profile: { create: { name, country } },
    },
    select: { id: true, email: true, username: true },
  });

  console.log('User created:', user);
}

main().catch(console.error).finally(() => prisma.$disconnect());
