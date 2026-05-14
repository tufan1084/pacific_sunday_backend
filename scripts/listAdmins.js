/**
 * Script to list all admin accounts
 * Usage: node scripts/listAdmins.js
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function listAdmins() {
  try {
    const admins = await prisma.admin.findMany({
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    if (admins.length === 0) {
      console.log('\n📋 No admin accounts found.\n');
      return;
    }

    console.log(`\n📋 Found ${admins.length} admin account(s):\n`);
    console.log('─'.repeat(80));
    
    admins.forEach((admin, index) => {
      console.log(`\n${index + 1}. ${admin.username} (${admin.role})`);
      console.log(`   ID: ${admin.id}`);
      console.log(`   Email: ${admin.email}`);
      console.log(`   Created: ${admin.createdAt.toLocaleString()}`);
      console.log(`   Updated: ${admin.updatedAt.toLocaleString()}`);
    });
    
    console.log('\n' + '─'.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error listing admins:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

listAdmins();
