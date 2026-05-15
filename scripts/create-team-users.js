const bcrypt = require('bcryptjs');
const { prisma } = require('../src/config/db');
const { generateUsername } = require('../src/services/usernameService');

const USERS = [
  { email: 'hg@highoninnovation.com',              name: 'Harshit Gupta',   country: 'India' },
  { email: 'tufan.mandal@highoninnovation.com',    name: 'Tufan Mandal',    country: 'India' },
  { email: 'souvagya.das@highoninnovation.com',    name: 'Souvagya Das',    country: 'India' },
  { email: 'shailendra.ram@highoninnovation.com',  name: 'Shailendra Ram',  country: 'India' },
];

const MPIN = '1234';

async function main() {
  const hashedMpin = await bcrypt.hash(MPIN, 12);

  for (const u of USERS) {
    const existing = await prisma.user.findUnique({ where: { email: u.email } });
    if (existing) {
      console.log(`⚠️  Already exists: ${u.email}`);
      continue;
    }

    const username = await generateUsername(u.name);

    const user = await prisma.user.create({
      data: {
        email: u.email,
        username,
        mpin: hashedMpin,
        profile: { create: { name: u.name, country: u.country } },
      },
    });

    await prisma.userPointsWallet.create({
      data: { userId: user.id, balance: 0 },
    });

    console.log(`✅ Created: ${u.email}  |  username: ${username}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('❌ Failed:', e.message);
  prisma.$disconnect();
  process.exit(1);
});
