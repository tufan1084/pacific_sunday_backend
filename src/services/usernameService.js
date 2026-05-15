const { prisma } = require('../config/db');

/**
 * Generates an alphanumeric username from a given name
 * @param {string} fullName - User's full name
 * @returns {Promise<string>} - Unique username
 */
const generateUsername = async (fullName) => {
  const firstName = fullName.trim().split(/\s+/)[0].toLowerCase();
  const baseUsername = firstName.replace(/[^a-z0-9]/g, '');
  
  if (!baseUsername) {
    return await generateRandomUsername();
  }

  let username = baseUsername;
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const exists = await checkUsernameExists(username);
    
    if (!exists) {
      return username;
    }

    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    username = `${baseUsername}${randomSuffix}`;
    attempts++;
  }

  return await generateRandomUsername();
};

/**
 * Generates a completely random username
 * @returns {Promise<string>}
 */
const generateRandomUsername = async () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let username;
  let attempts = 0;
  
  do {
    username = 'user';
    for (let i = 0; i < 8; i++) {
      username += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    attempts++;
  } while (await checkUsernameExists(username) && attempts < 20);

  return username;
};

/**
 * Checks if a username already exists in the database
 * @param {string} username
 * @returns {Promise<boolean>}
 */
const checkUsernameExists = async (username) => {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true }
  });
  return !!user;
};

module.exports = {
  generateUsername,
  checkUsernameExists,
};
