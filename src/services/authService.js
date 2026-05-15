const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { prisma } = require('../config/db');
const logger = require('../config/logger');
const { generateUsername } = require('./usernameService');

const SALT_ROUNDS = 12;

/**
 * Hashes a plain-text password.
 * @param {string} password
 * @returns {Promise<string>}
 */
const hashPassword = async (password) => {
  return bcrypt.hash(password, SALT_ROUNDS);
};

const verifyPassword = async (password, hash) => {
  return bcrypt.compare(password, hash);
};

const hashMpin = async (mpin) => {
  return bcrypt.hash(mpin, SALT_ROUNDS);
};

const verifyMpin = async (mpin, hash) => {
  return bcrypt.compare(mpin, hash);
};

/**
 * Generates a signed JWT for a user.
 * @param {number} userId
 * @param {string} email
 * @returns {string}
 */
const generateToken = (userId, email) => {
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';

  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }

  return jwt.sign({ id: userId, email }, secret, { expiresIn });
};

/**
 * Verifies and decodes a JWT.
 * @param {string} token
 * @returns {object} Decoded payload
 */
const verifyToken = (token) => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error('JWT_SECRET is not configured');
  }

  return jwt.verify(token, secret);
};

/**
 * Finds a user by email or username.
 * @param {string} identifier - Email or username
 * @returns {Promise<object|null>}
 */
const findUserByEmailOrUsername = async (identifier) => {
  try {
    return await prisma.user.findFirst({ 
      where: {
        OR: [
          { email: { equals: identifier, mode: 'insensitive' } },
          { username: identifier }
        ]
      },
      include: { 
        profile: {
          include: {
            golfPassport: {
              select: {
                photoUrl: true,
              }
            }
          }
        }
      }
    });
  } catch (error) {
    logger.error(`Failed to find user by identifier: ${error.message}`);
    throw new Error('Failed to look up user');
  }
};

/**
 * Finds a user by email.
 * @param {string} email
 * @returns {Promise<object|null>}
 */
const findUserByEmail = async (email) => {
  try {
    return await prisma.user.findFirst({ 
      where: { email: { equals: email, mode: 'insensitive' } },
      include: { 
        profile: {
          include: {
            golfPassport: {
              select: {
                photoUrl: true,
              }
            }
          }
        }
      }
    });
  } catch (error) {
    logger.error(`Failed to find user by email: ${error.message}`);
    throw new Error('Failed to look up user');
  }
};

/**
 * Finds a user by ID, excluding the password field.
 * @param {number} id
 * @returns {Promise<object|null>}
 */
const findUserById = async (id) => {
  try {
    return await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        createdAt: true,
        profile: {
          select: {
            name: true,
            country: true,
            createdAt: true,
            golfPassport: {
              select: {
                photoUrl: true,
              }
            }
          }
        }
      },
    });
  } catch (error) {
    logger.error(`Failed to find user by id=${id}: ${error.message}`);
    throw new Error('Failed to look up user');
  }
};

// Same as findUserById but includes the mpin hash. Used by the login flow
// when we look the user up via nfcToken instead of email/username — the
// caller needs the hash to verify the PIN against.
const findUserByIdWithAuth = async (id) => {
  try {
    return await prisma.user.findUnique({
      where: { id },
      include: {
        profile: {
          include: {
            golfPassport: { select: { photoUrl: true } },
          },
        },
      },
    });
  } catch (error) {
    logger.error(`Failed to find user (auth) by id=${id}: ${error.message}`);
    throw new Error('Failed to look up user');
  }
};

/**
 * Creates a new user in the database.
 * @param {string} name
 * @param {string} email
 * @param {string|null} hashedPassword - Can be null for OAuth users
 * @param {string|null} country
 * @param {string|null} googleId - Google OAuth ID
 * @returns {Promise<object>}
 */
const createUser = async (name, email, hashedPassword = null, country = null, googleId = null, hashedMpin = null) => {
  try {
    const username = await generateUsername(name);
    
    const user = await prisma.user.create({
      data: { 
        email,
        username,
        password: hashedPassword,
        googleId,
        mpin: hashedMpin,
        profile: {
          create: {
            name,
            country
          }
        }
      },
      select: {
        id: true,
        email: true,
        username: true,
        createdAt: true,
        profile: {
          select: {
            name: true,
            country: true,
            createdAt: true,
            golfPassport: {
              select: {
                photoUrl: true,
              }
            }
          }
        }
      },
    });

    logger.info(`User created: id=${user.id}, email=${email}, username=${username}`);
    return user;
  } catch (error) {
    if (error.code === 'P2002') {
      throw new Error('A user with that email already exists');
    }
    logger.error(`Failed to create user: ${error.message}`);
    throw new Error('Failed to create user account');
  }
};

module.exports = {
  hashPassword,
  verifyPassword,
  hashMpin,
  verifyMpin,
  generateToken,
  verifyToken,
  findUserByEmail,
  findUserByEmailOrUsername,
  findUserById,
  findUserByIdWithAuth,
  createUser,
};
