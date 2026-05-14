const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const name    = 'Tufan Mandal';
  const email   = 'tufan.mandal@highoninnovation.com';
  const mpin    = '1234';
  const bagUid  = 'DEV-UID-B002';

  // Check bag exists and is unregistered
  const bag = await prisma.bag.findUnique({ where: { uid: bagUid } });
  if (!bag) { console.error('Bag not found:', bagUid); process.exit(1); }
  if (bag.registered) { console.error('Bag already registered to userId:', bag.userId); process.exit(1); }

  // Check email not taken
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) { console.error('Email already in use'); process.exit(1); }

  // Hash mpin
  const hashedMpin = await bcrypt.hash(mpin, 10);

  // Generate username from name
  const baseUsername = name.toLowerCase().replace(/\s+/g, '').slice(0, 15);
  let username = baseUsername;
  let suffix = 1;
  while (await prisma.user.findUnique({ where: { username } })) {
    username = `${baseUsername}${suffix++}`;
  }

  // Create user with profile
  const user = await prisma.user.create({
    data: {
      email,
      username,
      mpin: hashedMpin,
      profile: {
        create: {
          name,
          country: null,
          golfPassport: { create: {} },
        },
      },
    },
    include: { profile: true },
  });

  // Create wallet separately
  await prisma.userPointsWallet.create({
    data: { userId: user.id, balance: 0, heldBalance: 0 },
  });

  // Link bag
  await prisma.bag.update({
    where: { uid: bagUid },
    data: {
      userId: user.id,
      registered: true,
      registeredAt: new Date(),
    },
  });

  console.log('✅ User created successfully!');
  console.log(`   Name     : ${name}`);
  console.log(`   Email    : ${email}`);
  console.log(`   Username : ${username}`);
  console.log(`   PIN      : ${mpin}`);
  console.log(`   Bag      : ${bagUid}`);
  console.log(`   User ID  : ${user.id}`);
}

main()
  .catch(e => { console.error('Error:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
