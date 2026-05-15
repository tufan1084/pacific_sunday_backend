/**
 * Script to migrate user accounts to admin accounts
 * This copies a user from users table to admins table
 * Usage: node scripts/migrateUserToAdmin.js
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

async function migrateUserToAdmin() {
  try {
    console.log('\n=== Migrate User to Admin ===\n');

    const identifier = await question('Enter user email or username to migrate: ');

    // Find user
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { username: identifier }
        ]
      }
    });

    if (!user) {
      console.error('❌ User not found');
      process.exit(1);
    }

    console.log('\nUser found:');
    console.log(`ID: ${user.id}`);
    console.log(`Email: ${user.email}`);
    console.log(`Username: ${user.username}`);
    console.log(`Created: ${user.createdAt.toLocaleString()}`);

    // Check if admin with same email/username already exists
    const existingAdmin = await prisma.admin.findFirst({
      where: {
        OR: [
          { email: user.email },
          { username: user.username }
        ]
      }
    });

    if (existingAdmin) {
      console.error('\n❌ Admin with this email or username already exists');
      process.exit(1);
    }

    const roleInput = await question('\nEnter admin role (admin/superadmin) [default: admin]: ');
    const role = roleInput.trim() || 'admin';

    if (!['admin', 'superadmin'].includes(role)) {
      console.error('❌ Invalid role. Must be "admin" or "superadmin"');
      process.exit(1);
    }

    const deleteUser = await question('\nDelete user from users table after migration? (yes/no) [default: yes]: ');
    const shouldDelete = deleteUser.toLowerCase() !== 'no';

    console.log('\n⚠️  This will:');
    console.log(`  1. Create admin account: ${user.email} (${role})`);
    console.log(`  2. Copy password hash from user account`);
    if (shouldDelete) {
      console.log(`  3. DELETE user account and ALL associated data (bags, posts, etc.)`);
    } else {
      console.log(`  3. Keep user account in users table`);
    }

    const confirm = await question('\nType "MIGRATE" to confirm: ');

    if (confirm !== 'MIGRATE') {
      console.log('❌ Migration cancelled');
      process.exit(0);
    }

    // Create admin account
    const admin = await prisma.admin.create({
      data: {
        email: user.email,
        username: user.username,
        password: user.password, // Copy existing password hash
        role: role
      }
    });

    console.log('\n✅ Admin account created successfully!');
    console.log(`ID: ${admin.id}`);
    console.log(`Email: ${admin.email}`);
    console.log(`Username: ${admin.username}`);
    console.log(`Role: ${admin.role}`);

    // Delete user if requested
    if (shouldDelete) {
      await prisma.user.delete({ where: { id: user.id } });
      console.log('\n✅ User account deleted from users table');
    } else {
      console.log('\n⚠️  User account still exists in users table');
    }

    console.log('\n✅ Migration complete!\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    rl.close();
    await prisma.$disconnect();
  }
}

migrateUserToAdmin();
