/**
 * Quick script to create admin account
 * Usage: node scripts/quickCreateAdmin.js <email> <username> <password> <role>
 * Example: node scripts/quickCreateAdmin.js admin@example.com admin Admin@123 superadmin
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function quickCreateAdmin() {
  try {
    const [,, email, username, password, role = 'admin'] = process.argv;

    if (!email || !username || !password) {
      console.error('Usage: node scripts/quickCreateAdmin.js <email> <username> <password> <role>');
      console.error('Example: node scripts/quickCreateAdmin.js admin@example.com admin Admin@123 superadmin');
      process.exit(1);
    }

    if (!['admin', 'superadmin'].includes(role)) {
      console.error('❌ Invalid role. Must be "admin" or "superadmin"');
      process.exit(1);
    }

    // Check if email already exists
    const existingEmail = await prisma.admin.findUnique({
      where: { email }
    });
    
    if (existingEmail) {
      console.error('❌ Admin with this email already exists');
      process.exit(1);
    }

    // Check if username already exists
    const existingUsername = await prisma.admin.findUnique({
      where: { username }
    });
    
    if (existingUsername) {
      console.error('❌ Admin with this username already exists');
      process.exit(1);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create admin
    const admin = await prisma.admin.create({
      data: {
        email,
        username,
        password: hashedPassword,
        role
      }
    });

    console.log('\n✅ Admin account created successfully!');
    console.log('\nDetails:');
    console.log(`ID: ${admin.id}`);
    console.log(`Email: ${admin.email}`);
    console.log(`Username: ${admin.username}`);
    console.log(`Role: ${admin.role}`);
    console.log(`Created: ${admin.createdAt}\n`);

  } catch (error) {
    console.error('❌ Error creating admin:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

quickCreateAdmin();
