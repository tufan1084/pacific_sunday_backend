-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "golf_passports" (
    "id" SERIAL NOT NULL,
    "profileId" INTEGER NOT NULL,
    "fullName" TEXT,
    "nickname" TEXT,
    "handicap" TEXT,
    "bestScore" TEXT,
    "yearsPlaying" TEXT,
    "homeCourse" TEXT,
    "golfCountry" TEXT,
    "bio" TEXT,
    "photoUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "golf_passports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bags" (
    "id" SERIAL NOT NULL,
    "serial" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scans" (
    "id" SERIAL NOT NULL,
    "serial" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "scanTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_userId_key" ON "user_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "golf_passports_profileId_key" ON "golf_passports"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "bags_serial_key" ON "bags"("serial");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "golf_passports" ADD CONSTRAINT "golf_passports_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "user_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bags" ADD CONSTRAINT "bags_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scans" ADD CONSTRAINT "scans_serial_fkey" FOREIGN KEY ("serial") REFERENCES "bags"("serial") ON DELETE RESTRICT ON UPDATE CASCADE;

