/**
 * Script to delete an admin account
 * Usage: node scripts/deleteAdmin.js
 */

const { PrismaClient } = require('@prisma/client');
const readline = require('readline');

const prisma = new PrismaClient();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function deleteAdmin() {
  try {
    console.log('\n=== Delete Admin Account ===\n');

    const identifier = await question('Enter admin email or username to delete: ');

    // Find admin by email or username
    const admin = await prisma.admin.findFirst({
      where: {
        OR: [
          { email: identifier },
          { username: identifier }
        ]
      }
    });

    if (!admin) {
      console.error('❌ Admin not found');
      process.exit(1);
    }

    console.log('\nAdmin found:');
    console.log(`ID: ${admin.id}`);
    console.log(`Email: ${admin.email}`);
    console.log(`Username: ${admin.username}`);
    console.log(`Role: ${admin.role}`);

    const confirm = await question('\nAre you sure you want to delete this admin? (yes/no): ');

    if (confirm.toLowerCase() !== 'yes') {
      console.log('❌ Deletion cancelled');
      process.exit(0);
    }

    await prisma.admin.delete({
      where: { id: admin.id }
    });

    console.log('\n✅ Admin account deleted successfully!');

  } catch (error) {
    console.error('❌ Error deleting admin:', error.message);
    process.exit(1);
  } finally {
    rl.close();
    await prisma.$disconnect();
  }
}

deleteAdmin();
