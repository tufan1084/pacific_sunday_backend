const bcrypt = require('bcryptjs');
const { prisma } = require('../src/config/db');
const { generateUsername } = require('../src/services/usernameService');

async function createDevUser() {
  const email = 'souvagya.das@highoninnovation.com';
  const name = 'Souvagya Das';
  const mpin = '1234';
  const bagUid = 'DEV-UID-B001'; // DEV - Sunset Demo Bag

  // Check if user already exists
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`User already exists: ${email}`);
    await prisma.$disconnect();
    return;
  }

  const hashedMpin = await bcrypt.hash(mpin, 12);
  const username = await generateUsername(name);

  const user = await prisma.user.create({
    data: {
      email,
      username,
      mpin: hashedMpin,
      profile: {
        create: { name, country: 'India' }
      }
    }
  });

  // Link bag to user
  await prisma.bag.update({
    where: { uid: bagUid },
    data: {
      userId: user.id,
      registered: true,
      registeredAt: new Date(),
    }
  });

  // Create points wallet
  await prisma.userPointsWallet.create({
    data: { userId: user.id, balance: 0 }
  });

  console.log(`✅ User created: ${email}`);
  console.log(`   Username: ${username}`);
  console.log(`   M-PIN: ${mpin}`);
  console.log(`   Bag: ${bagUid} (DEV - Pacific Test Bag)`);

  await prisma.$disconnect();
}

createDevUser().catch((e) => {
  console.error('❌ Failed:', e.message);
  prisma.$disconnect();
  process.exit(1);
});
