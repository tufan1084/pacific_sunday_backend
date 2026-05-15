const bcrypt = require('bcryptjs');
const { prisma } = require('../src/config/db');

async function setDefaultMpin() {
  const hashedMpin = await bcrypt.hash('1234', 12);

  const result = await prisma.user.updateMany({
    where: { mpin: null },
    data: { mpin: hashedMpin },
  });

  console.log(`Updated ${result.count} users with default M-PIN 1234`);
  await prisma.$disconnect();
}

setDefaultMpin().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
