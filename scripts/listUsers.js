/**
 * List all users in the users table
 * Usage: node scripts/listUsers.js
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function listUsers() {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        username: true,
        createdAt: true,
        _count: {
          select: {
            bags: true,
            posts: true,
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (users.length === 0) {
      console.log('\n📋 No users found in database.\n');
      return;
    }

    console.log(`\n📋 Found ${users.length} user(s) in users table:\n`);
    console.log('─'.repeat(100));

    users.forEach((user, index) => {
      const isLikelyAdmin = 
        user.email.toLowerCase().includes('admin') || 
        user.username.toLowerCase().includes('admin');

      console.log(`\n${index + 1}. ${user.username} ${isLikelyAdmin ? '⚠️  (Likely Admin)' : ''}`);
      console.log(`   ID: ${user.id}`);
      console.log(`   Email: ${user.email}`);
      console.log(`   Created: ${user.createdAt.toLocaleString()}`);
      console.log(`   Bags: ${user._count.bags} | Posts: ${user._count.posts}`);
    });

    console.log('\n' + '─'.repeat(100));
    console.log('\n💡 To delete a user, run: node scripts/deleteUser.js <email_or_id>');
    console.log('💡 Example: node scripts/deleteUser.js admin@example.com');
    console.log('💡 Example: node scripts/deleteUser.js 5\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

listUsers();
