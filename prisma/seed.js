const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  console.log("Seeding dev data...\n");

  // ── Bag Type 1 ──
  const bagType1 = await prisma.bagType.upsert({
    where: { iykItemId: "DEV-ITEM-001" },
    update: {},
    create: {
      iykItemId: "DEV-ITEM-001",
      name: "DEV - Pacific Test Bag",
      description: "This is a fake development bag for testing. Not a real product.",
      imageUrl: "https://files.iyk.app/products/c8999b64-0fdf-4ecb-a448-2cb52a9728b1/45f3b2f3-c1f5-483f-b609-254526957b2b.png",
      collection: "Dev Collection Alpha",
      contractAddress: "0xDEV0000000000000000000000000000000000001",
      chainId: 99999,
      totalChips: 5,
      createdAt: new Date("2026-01-15T10:00:00Z"),
      syncedAt: new Date(),
    },
  });
  console.log(`Bag Type 1: ${bagType1.name} (id: ${bagType1.id})`);

  // ── Bag Type 2 ──
  const bagType2 = await prisma.bagType.upsert({
    where: { iykItemId: "DEV-ITEM-002" },
    update: {},
    create: {
      iykItemId: "DEV-ITEM-002",
      name: "DEV - Sunset Demo Bag",
      description: "Another fake bag for development purposes only. Do not ship.",
      imageUrl: "https://files.iyk.app/products/e0bf0830-be28-46d3-a8bf-ba9020054048/d0296174-cab3-4fac-9b6a-92013eefa50c.png",
      collection: "Dev Collection Beta",
      contractAddress: "0xDEV0000000000000000000000000000000000002",
      chainId: 99999,
      totalChips: 5,
      createdAt: new Date("2026-02-20T14:30:00Z"),
      syncedAt: new Date(),
    },
  });
  console.log(`Bag Type 2: ${bagType2.name} (id: ${bagType2.id})`);

  // ── 5 Bags for Type 1 ──
  const bags1 = [
    { uid: "DEV-UID-A001", tokenId: "DEV-TOKEN-101", registered: false, status: "ACTIVE", tapCount: 0, registeredAt: null, lastTappedAt: null },
    { uid: "DEV-UID-A002", tokenId: "DEV-TOKEN-102", registered: false, status: "ACTIVE", tapCount: 0, registeredAt: null, lastTappedAt: null },
    { uid: "DEV-UID-A003", tokenId: "DEV-TOKEN-103", registered: false, status: "ACTIVE", tapCount: 0, registeredAt: null, lastTappedAt: null },
    { uid: "DEV-UID-A004", tokenId: "DEV-TOKEN-104", registered: false, status: "ACTIVE", tapCount: 0, registeredAt: null, lastTappedAt: null },
    { uid: "DEV-UID-A005", tokenId: "DEV-TOKEN-105", registered: false, status: "ACTIVE", tapCount: 0, registeredAt: null, lastTappedAt: null },
  ];

  for (const bag of bags1) {
    await prisma.bag.upsert({
      where: { uid: bag.uid },
      update: {},
      create: {
        uid: bag.uid,
        bagTypeId: bagType1.id,
        tokenId: bag.tokenId,
        registered: bag.registered,
        status: bag.status,
        tapCount: bag.tapCount,
        registeredAt: bag.registeredAt,
        lastTappedAt: bag.lastTappedAt,
      },
    });
  }
  console.log(`  -> 5 bags created for "${bagType1.name}"`);

  // ── 5 Bags for Type 2 ──
  const bags2 = [
    { uid: "DEV-UID-B001", tokenId: "DEV-TOKEN-201", registered: false, status: "ACTIVE", tapCount: 0, registeredAt: null, lastTappedAt: null },
    { uid: "DEV-UID-B002", tokenId: "DEV-TOKEN-202", registered: false, status: "ACTIVE", tapCount: 0, registeredAt: null, lastTappedAt: null },
    { uid: "DEV-UID-B003", tokenId: "DEV-TOKEN-203", registered: false, status: "ACTIVE", tapCount: 0, registeredAt: null, lastTappedAt: null },
    { uid: "DEV-UID-B004", tokenId: "DEV-TOKEN-204", registered: false, status: "ACTIVE", tapCount: 0, registeredAt: null, lastTappedAt: null },
    { uid: "DEV-UID-B005", tokenId: "DEV-TOKEN-205", registered: false, status: "ACTIVE", tapCount: 0, registeredAt: null, lastTappedAt: null },
  ];

  for (const bag of bags2) {
    await prisma.bag.upsert({
      where: { uid: bag.uid },
      update: {},
      create: {
        uid: bag.uid,
        bagTypeId: bagType2.id,
        tokenId: bag.tokenId,
        registered: bag.registered,
        status: bag.status,
        tapCount: bag.tapCount,
        registeredAt: bag.registeredAt,
        lastTappedAt: bag.lastTappedAt,
      },
    });
  }
  console.log(`  -> 5 bags created for "${bagType2.name}"`);

  console.log("\nDev seed complete!");
}

main()
  .catch((e) => {
    console.error("Seed error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
