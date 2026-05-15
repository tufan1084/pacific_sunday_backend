/**
 * Script to create admin accounts
 * Usage: node scripts/createAdmin.js
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const readline = require('readline');

const prisma = new PrismaClient();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function createAdmin() {
  try {
    console.log('\n=== Create Admin Account ===\n');

    const email = await question('Enter admin email: ');
    const username = await question('Enter admin username: ');
    const password = await question('Enter admin password: ');
    const roleInput = await question('Enter role (admin/superadmin) [default: admin]: ');
    
    const role = roleInput.trim() || 'admin';
    
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
    console.log(`Created: ${admin.createdAt}`);

  } catch (error) {
    console.error('❌ Error creating admin:', error.message);
    process.exit(1);
  } finally {
    rl.close();
    await prisma.$disconnect();
  }
}

createAdmin();
