const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  const email = "admin@gmail.com";
  const password = "admin@123";
  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: { password: hashedPassword },
    create: {
      email,
      username: "admin",
      password: hashedPassword,
      profile: {
        create: {
          name: "Admin",
          country: "US",
        },
      },
    },
  });

  console.log(`Admin user ready: ${user.email} (id: ${user.id})`);
}

main()
  .catch((e) => {
    console.error("Seed error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
