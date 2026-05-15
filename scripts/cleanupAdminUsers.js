/**
 * Script to clean up admin records from users table
 * This will find users that look like admin accounts and optionally delete them
 * Usage: node scripts/cleanupAdminUsers.js
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

async function cleanupAdminUsers() {
  try {
    console.log('\n=== Cleanup Admin Records from Users Table ===\n');

    // Find potential admin users by common patterns
    const potentialAdmins = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: 'admin', mode: 'insensitive' } },
          { username: { contains: 'admin', mode: 'insensitive' } },
          { email: { contains: 'superadmin', mode: 'insensitive' } },
          { username: { contains: 'superadmin', mode: 'insensitive' } },
        ]
      },
      select: {
        id: true,
        email: true,
        username: true,
        createdAt: true,
        _count: {
          select: {
            bags: true,
            posts: true,
            postLikes: true,
            postComments: true,
          }
        }
      }
    });

    if (potentialAdmins.length === 0) {
      console.log('✅ No admin-like records found in users table.\n');
      process.exit(0);
    }

    console.log(`Found ${potentialAdmins.length} potential admin record(s) in users table:\n`);
    console.log('─'.repeat(80));

    potentialAdmins.forEach((user, index) => {
      console.log(`\n${index + 1}. ${user.username} (${user.email})`);
      console.log(`   ID: ${user.id}`);
      console.log(`   Created: ${user.createdAt.toLocaleString()}`);
      console.log(`   Activity:`);
      console.log(`     - Bags: ${user._count.bags}`);
      console.log(`     - Posts: ${user._count.posts}`);
      console.log(`     - Likes: ${user._count.postLikes}`);
      console.log(`     - Comments: ${user._count.postComments}`);
    });

    console.log('\n' + '─'.repeat(80));

    const action = await question('\nWhat would you like to do?\n1. Delete all listed users\n2. Delete specific users (by ID)\n3. Cancel\n\nEnter choice (1/2/3): ');

    if (action === '1') {
      // Delete all
      const confirm = await question(`\n⚠️  This will delete ${potentialAdmins.length} user(s) and ALL their data. Type 'DELETE' to confirm: `);
      
      if (confirm !== 'DELETE') {
        console.log('❌ Deletion cancelled');
        process.exit(0);
      }

      console.log('\nDeleting users...');
      
      for (const user of potentialAdmins) {
        await prisma.user.delete({ where: { id: user.id } });
        console.log(`✅ Deleted: ${user.username} (${user.email})`);
      }

      console.log(`\n✅ Successfully deleted ${potentialAdmins.length} user(s)\n`);

    } else if (action === '2') {
      // Delete specific
      const idsInput = await question('\nEnter user IDs to delete (comma-separated): ');
      const ids = idsInput.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

      if (ids.length === 0) {
        console.log('❌ No valid IDs provided');
        process.exit(0);
      }

      const usersToDelete = potentialAdmins.filter(u => ids.includes(u.id));

      if (usersToDelete.length === 0) {
        console.log('❌ No matching users found');
        process.exit(0);
      }

      console.log(`\nWill delete ${usersToDelete.length} user(s):`);
      usersToDelete.forEach(u => console.log(`  - ${u.username} (${u.email})`));

      const confirm = await question(`\n⚠️  Type 'DELETE' to confirm: `);
      
      if (confirm !== 'DELETE') {
        console.log('❌ Deletion cancelled');
        process.exit(0);
      }

      console.log('\nDeleting users...');
      
      for (const user of usersToDelete) {
        await prisma.user.delete({ where: { id: user.id } });
        console.log(`✅ Deleted: ${user.username} (${user.email})`);
      }

      console.log(`\n✅ Successfully deleted ${usersToDelete.length} user(s)\n`);

    } else {
      console.log('❌ Cancelled');
      process.exit(0);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    rl.close();
    await prisma.$disconnect();
  }
}

cleanupAdminUsers();
