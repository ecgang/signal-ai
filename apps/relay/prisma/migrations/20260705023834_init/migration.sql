-- CreateEnum
CREATE TYPE "AiMode" AS ENUM ('passive', 'active');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('admin', 'member');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "identityKey" BYTEA NOT NULL,
    "registrationId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replacedAt" TIMESTAMP(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signed_prekeys" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "keyId" INTEGER NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "signature" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signed_prekeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyber_prekeys" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "keyId" INTEGER NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "signature" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyber_prekeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "one_time_prekeys" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "keyId" INTEGER NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "one_time_prekeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "aiMode" "AiMode" NOT NULL DEFAULT 'passive',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "envelopes" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "recipientDeviceId" INTEGER NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "senderDeviceId" INTEGER NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_tokenHash_key" ON "users"("tokenHash");

-- CreateIndex
CREATE INDEX "devices_userId_deviceId_replacedAt_idx" ON "devices"("userId", "deviceId", "replacedAt");

-- CreateIndex
CREATE INDEX "signed_prekeys_deviceId_createdAt_idx" ON "signed_prekeys"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "kyber_prekeys_deviceId_createdAt_idx" ON "kyber_prekeys"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "one_time_prekeys_deviceId_idx" ON "one_time_prekeys"("deviceId");

-- CreateIndex
CREATE INDEX "memberships_conversationId_userId_removedAt_idx" ON "memberships"("conversationId", "userId", "removedAt");

-- CreateIndex
CREATE INDEX "envelopes_conversationId_recipientUserId_recipientDeviceId__idx" ON "envelopes"("conversationId", "recipientUserId", "recipientDeviceId", "seq");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signed_prekeys" ADD CONSTRAINT "signed_prekeys_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyber_prekeys" ADD CONSTRAINT "kyber_prekeys_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "one_time_prekeys" ADD CONSTRAINT "one_time_prekeys_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "envelopes" ADD CONSTRAINT "envelopes_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
